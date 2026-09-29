/**
 * A posting key rotated on chain must stop verifying HERE too.
 *
 * WHY THIS IS A SECURITY TEST. `accounts.posting_pubkey` was written at first
 * observation and never updated — account creates COALESCE it, the backfill only
 * fills NULLs, and nothing read `account_update`. That was cosmetic until
 * v1.18.0's federated fast path began verifying pushed chat messages against
 * the column. From then on:
 *
 *   • a STOLEN key kept verifying after its owner rotated it away — which the
 *     chain itself refuses, so the fast path was strictly more permissive than
 *     the chain it fronts; and
 *   • the owner's own messages, signed with the new key, stopped verifying.
 *
 * Everything below drives the REAL `applyBlock` with a real `account_update`, and
 * asks the REAL fast-path verifier what it now accepts. A test of the SQL alone
 * would miss the second half of the fix entirely — see the last case.
 *
 * Skips without TEST_DATABASE_URL, like every other integration suite here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { applyBlock } from '../../src/indexer/dispatcher';
import {
	verifyPushedChatOp,
	postingKeyLookupFromDb,
	_resetSeenForTest,
	_resetKeyRefreshForTest
} from '../../src/indexer/chatFastFederation';
import { reconcilePostingKeys, type AccountKeySource } from '../../src/indexer/postingKeyBackfill';
import { federationChatFastRoute } from '../../src/api/federationChatFast';
import { chatEventBus } from '../../src/indexer/chatEventBus';
import { runMigrations } from '../../src/db/migrations';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const ACCOUNT = 'alice';
const keyA = PrivateKey.fromSeed('rotation-test-key-A');
const keyB = PrivateKey.fromSeed('rotation-test-key-B');
const keyC = PrivateKey.fromSeed('rotation-test-key-C');
const pubA = keyA.createPublic().toString();
const pubB = keyB.createPublic().toString();
const pubC = keyC.createPublic().toString();

let tagSeq = 0;
/** A chat op signed by `key`, in the shape the browser puts on the wire. */
function chatSignedWith(key: typeof keyA, sender: string = ACCOUNT): unknown {
	const payload = {
		recipient: 'bob',
		ciphertext: Buffer.from('m').toString('base64'),
		header: {
			client_tag: `rot-${++tagSeq}-${Date.now()}`,
			ephemeral_pub: Buffer.from('ephemeral-public-key-32-bytes!!!').toString('base64'),
			nonce: Buffer.from('nonce-24-bytes-padding!!').toString('base64')
		}
	};
	return cryptoUtils.signTransaction(
		{
			ref_block_num: 1000 + tagSeq,
			ref_block_prefix: 5678,
			expiration: new Date(Date.now() + 45_000).toISOString().slice(0, 19),
			operations: [
				[
					'custom_json',
					{
						required_auths: [],
						required_posting_auths: [sender],
						id: 'morphit_chat_v1',
						json: JSON.stringify(payload)
					}
				]
			],
			extensions: []
		} as unknown as Parameters<typeof cryptoUtils.signTransaction>[0],
		[key]
	);
}

/** An `account_update` op exactly as a block carries it. `posting` is optional
 *  on the chain, so passing null builds an update that changes other fields
 *  only. */
function accountUpdate(account: string, postingPub: string | null): [string, unknown] {
	return [
		'account_update',
		{
			account,
			...(postingPub === null
				? {}
				: { posting: { weight_threshold: 1, account_auths: [], key_auths: [[postingPub, 1]] } }),
			memo_key: pubA,
			json_metadata: '',
			posting_json_metadata: ''
		}
	];
}

describe.skipIf(!INTEGRATION_ENABLED)('a rotated posting key stops verifying', () => {
	let fx: IntegrationFixture;
	let blockNum = 90_000_000;

	/** Run one block through the REAL dispatcher, on a client pinned to the
	 *  fixture's schema. */
	async function apply(ops: [string, unknown][]): Promise<void> {
		const client: pg.PoolClient = await fx.pool.connect();
		try {
			await client.query(`SET search_path TO "${fx.schema}"`);
			await client.query('BEGIN');
			await applyBlock(
				client,
				++blockNum,
				{
					timestamp: new Date().toISOString().slice(0, 19),
					transaction_ids: ops.map((_, i) => `trx-${blockNum}-${i}`),
					transactions: ops.map((op) => ({ operations: [op] }))
				} as unknown as Parameters<typeof applyBlock>[2],
				{} as Parameters<typeof applyBlock>[3],
				{ feeRecipient: 'morphit' } as unknown as Parameters<typeof applyBlock>[4],
				{} as Parameters<typeof applyBlock>[5],
				{} as Parameters<typeof applyBlock>[6],
				(async () => null) as unknown as Parameters<typeof applyBlock>[7]
			);
			await client.query('COMMIT');
		} catch (e) {
			await client.query('ROLLBACK');
			throw e;
		} finally {
			client.release();
		}
	}

	const column = async (name = ACCOUNT): Promise<string | null> => {
		const r = await fx.db.query<{ posting_pubkey: string | null }>(
			'SELECT posting_pubkey FROM accounts WHERE name = $1',
			[name]
		);
		return r.rows[0]?.posting_pubkey ?? null;
	};

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	beforeEach(async () => {
		_resetSeenForTest();
		_resetKeyRefreshForTest();
		await fx.db.query('DELETE FROM accounts');
		await fx.db.query(
			`INSERT INTO accounts
			     (name, creator, created_block_num, created_block_time, created_trx_id, posting_pubkey)
			   VALUES ($1, 'genesis', 1, now(), 'seed', $2)`,
			[ACCOUNT, pubA]
		);
	});

	it('an account_update that changes the posting authority updates the column', async () => {
		expect(await column(), 'fixture starts on key A').toBe(pubA);
		await apply([accountUpdate(ACCOUNT, pubB)]);
		expect(await column(), 'the rotation must be recorded').toBe(pubB);
	});

	/**
	 * THE PROPERTY. After rotation the fast path must accept the NEW key and
	 * refuse the OLD one — the old one being, in the case that motivates this,
	 * the key that was stolen.
	 */
	it('after rotation the fast path accepts the new key and REFUSES the old one', async () => {
		await apply([accountUpdate(ACCOUNT, pubB)]);
		// No chain refresher: the verdict has to come from the durable column
		// alone, which is the whole point of keeping it current.
		const lookup = postingKeyLookupFromDb(fx.db);

		const withNew = await verifyPushedChatOp({ trx: chatSignedWith(keyB) }, lookup);
		expect(withNew.ok, 'the owner, signing with the key they rotated TO, must verify').toBe(true);

		const withOld = await verifyPushedChatOp({ trx: chatSignedWith(keyA) }, lookup);
		expect(
			withOld.ok,
			'a message signed with the ROTATED-AWAY key verified — a stolen key would keep working ' +
				'after its owner revoked it, which the chain itself refuses'
		).toBe(false);
	});

	it('an account_update that leaves posting alone does NOT touch the column', async () => {
		await apply([accountUpdate(ACCOUNT, null)]);
		expect(
			await column(),
			'a memo-key or metadata update carries no posting authority and must not clear or change it'
		).toBe(pubA);
	});

	it('several rotations in one block end on the LAST', async () => {
		await apply([accountUpdate(ACCOUNT, pubB), accountUpdate(ACCOUNT, pubC)]);
		expect(await column(), 'op order is the chain order; last writer wins').toBe(pubC);
	});

	it('rotations across blocks end on the latest', async () => {
		await apply([accountUpdate(ACCOUNT, pubB)]);
		await apply([accountUpdate(ACCOUNT, pubC)]);
		expect(await column()).toBe(pubC);
	});

	/**
	 * v1.18.0 review (R2) — the two authority shapes `key_auths[0][0]` got wrong.
	 * Each is driven through the REAL dispatcher and then asked of the REAL fast
	 * path, because the property is "a key the chain would refuse does not
	 * verify", not "the column holds some value".
	 */
	it('an update that moves posting authority OFF keys stops the old key verifying', async () => {
		// How an owner kills a leaked key without minting a new one: posting
		// authority handed to another account, no keys at all.
		await apply([
			[
				'account_update',
				{
					account: ACCOUNT,
					posting: { weight_threshold: 1, account_auths: [['guardian', 1]], key_auths: [] },
					memo_key: pubA,
					json_metadata: '',
					posting_json_metadata: ''
				}
			]
		]);
		const lookup = postingKeyLookupFromDb(fx.db);
		const withOld = await verifyPushedChatOp({ trx: chatSignedWith(keyA) }, lookup);
		expect(
			withOld.ok,
			'the chain no longer accepts key A for this account, so the fast path must not either'
		).toBe(false);
	});

	it('a 2-of-2 authority is not satisfied by one of its keys', async () => {
		await apply([
			[
				'account_update',
				{
					account: ACCOUNT,
					posting: {
						weight_threshold: 2,
						account_auths: [],
						key_auths: [
							[pubA, 1],
							[pubB, 1]
						]
					},
					memo_key: pubA,
					json_metadata: '',
					posting_json_metadata: ''
				}
			]
		]);
		const lookup = postingKeyLookupFromDb(fx.db);
		for (const [label, key] of [
			['A', keyA],
			['B', keyB]
		] as const) {
			const v = await verifyPushedChatOp({ trx: chatSignedWith(key) }, lookup);
			expect(
				v.ok,
				`key ${label} alone carries half the threshold; the chain refuses it, so must the fast path`
			).toBe(false);
		}
	});

	it('an update for an account we have no row for creates nothing', async () => {
		await apply([accountUpdate('stranger', pubB)]);
		expect(
			await column('stranger'),
			'an update carries no create metadata; the backfill and the chain re-read cover these'
		).toBeNull();
	});

	/**
	 * THE HALF A TEST OF THE SQL WOULD MISS. The fast path keeps an in-memory
	 * correction cache for keys re-read from the chain, consulted AHEAD of the
	 * column. While the column was write-once that precedence was right. Once the
	 * column is kept current, a cached correction can be OLDER than the column —
	 * and the case where that happens is the one rotation exists for.
	 *
	 *   1. owner rotates A → B; the fast path sees a B-signed message, re-reads
	 *      the chain, and caches B
	 *   2. owner rotates B → C because B has leaked
	 *   3. the durable indexer records C
	 *
	 * Without invalidation the cached B is consulted first for up to thirty
	 * minutes, so a message signed with the leaked B still verifies.
	 */
	it('a cached correction does not outrank a durable rotation past it', async () => {
		// 1. The fast path learns B from a chain re-read while the column is A.
		const refresher = async (): Promise<string | null> => pubB;
		const lookupWithRefresh = postingKeyLookupFromDb(fx.db, refresher);
		const learned = await verifyPushedChatOp({ trx: chatSignedWith(keyB) }, lookupWithRefresh);
		expect(learned.ok, 'setup: the fast path must have learned and cached B').toBe(true);

		// 2 + 3. The owner rotates away from B, and the durable indexer records C.
		await apply([accountUpdate(ACCOUNT, pubB)]);
		await apply([accountUpdate(ACCOUNT, pubC)]);
		expect(await column()).toBe(pubC);

		// A lookup with no refresher, so the only sources are the cache and the
		// column. The leaked B must no longer verify.
		const lookup = postingKeyLookupFromDb(fx.db);
		const leaked = await verifyPushedChatOp({ trx: chatSignedWith(keyB) }, lookup);
		expect(
			leaked.ok,
			'the LEAKED key still verified after the owner rotated away from it — the cached ' +
				'correction outranked a durable record that had moved past it'
		).toBe(false);

		const current = await verifyPushedChatOp({ trx: chatSignedWith(keyC) }, lookup);
		expect(current.ok, 'and the key the owner rotated TO must verify').toBe(true);
	});
});

/**
 * F37 — THE ACCOUNTS THAT ROTATED BEFORE THE UPGRADE.
 *
 * F27 makes the dispatcher record rotations from the upgrade on. Every row
 * written before it still holds the key it was first seen with, and the
 * account that matters most is the one whose owner rotated away from a LEAKED
 * key before the upgrade: that leaked key is what the column holds, and the fast
 * path verifies against the column. Migration v61 marks every such row
 * unconfirmed; the backfill confirms them against the chain; until then the
 * fast path asks the chain rather than trust the row.
 */
describe.skipIf(!INTEGRATION_ENABLED)('keys recorded before the upgrade', () => {
	let fx: IntegrationFixture;
	let blockNum = 91_000_000;

	async function apply(ops: [string, unknown][]): Promise<void> {
		const client: pg.PoolClient = await fx.pool.connect();
		try {
			await client.query(`SET search_path TO "${fx.schema}"`);
			await client.query('BEGIN');
			await applyBlock(
				client,
				++blockNum,
				{
					timestamp: new Date().toISOString().slice(0, 19),
					transaction_ids: ops.map((_, i) => `trx-${blockNum}-${i}`),
					transactions: ops.map((op) => ({ operations: [op] }))
				} as unknown as Parameters<typeof applyBlock>[2],
				{} as Parameters<typeof applyBlock>[3],
				{ feeRecipient: 'morphit' } as unknown as Parameters<typeof applyBlock>[4],
				{} as Parameters<typeof applyBlock>[5],
				{} as Parameters<typeof applyBlock>[6],
				(async () => null) as unknown as Parameters<typeof applyBlock>[7]
			);
			await client.query('COMMIT');
		} catch (e) {
			await client.query('ROLLBACK');
			throw e;
		} finally {
			client.release();
		}
	}

	const row = async (name = ACCOUNT) => {
		const r = await fx.db.query<{ posting_pubkey: string | null; posting_key_reconciled: boolean }>(
			'SELECT posting_pubkey, posting_key_reconciled FROM accounts WHERE name = $1',
			[name]
		);
		return r.rows[0] ?? null;
	};
	/** A chain that answers get_accounts from a table, as the backfill calls it. */
	/** One posting authority, as the chain returns it. */
	const auth = (key: string | null) => ({
		// weight_threshold included because the chain always sends it, and the
		// stored-key rule (signingPostingKey) refuses a shape without one.
		posting: { weight_threshold: 1, key_auths: key === null ? [] : [[key, 1] as [string, number]] }
	});
	const chain = (keys: Record<string, string | null>): AccountKeySource => ({
		getAccounts: async (names) =>
			new Map(names.filter((n) => n in keys).map((n) => [n, auth(keys[n] ?? null)]))
	});

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		_resetSeenForTest();
		_resetKeyRefreshForTest();
		await fx.db.query('DELETE FROM accounts');
		// A row as a pre-v1.18.0 indexer wrote it: the leaked key A, and no
		// opinion about the flag — so the migration's DEFAULT decides it.
		await fx.db.query(
			`INSERT INTO accounts
			     (name, creator, created_block_num, created_block_time, created_trx_id, posting_pubkey)
			   VALUES ($1, 'genesis', 1, now(), 'seed', $2)`,
			[ACCOUNT, pubA]
		);
	});

	it('the migration leaves every existing row unconfirmed', async () => {
		expect((await row())?.posting_key_reconciled).toBe(false);
	});

	/** The fixture builds from schema.sql, where the column already exists, so
	 *  the case above never runs the MIGRATION — and the migration is the only
	 *  way an upgrading node gets the column. So: take the database back to
	 *  before v61, with a row already in it, and boot the real runner. */
	it('UPGRADE PATH: the real migration runner leaves a pre-existing row unconfirmed', async () => {
		await fx.db.query('ALTER TABLE accounts DROP COLUMN posting_key_reconciled');
		await fx.db.query('DELETE FROM schema_migrations WHERE version = 61');
		const r = await runMigrations(fx.db);
		expect(r.applied, 'setup: v61 must be the migration that ran').toEqual([61]);
		expect(await row()).toEqual({ posting_pubkey: pubA, posting_key_reconciled: false });
	});

	/** THE HOLE, shown before it is closed: a row taken as confirmed. */
	it('control: were the stale row trusted, the leaked key would verify', async () => {
		await fx.db.query('UPDATE accounts SET posting_key_reconciled = TRUE WHERE name = $1', [
			ACCOUNT
		]);
		const lookup = postingKeyLookupFromDb(fx.db, async () => pubB);
		const leaked = await verifyPushedChatOp({ trx: chatSignedWith(keyA) }, lookup);
		expect(leaked.ok, 'setup: this is the hole the flag exists to close').toBe(true);
	});

	it('THE FIX: an unconfirmed row is not trusted — the chain is asked, and the leaked key refused', async () => {
		const lookup = postingKeyLookupFromDb(fx.db, async () => pubB);
		const leaked = await verifyPushedChatOp({ trx: chatSignedWith(keyA) }, lookup);
		expect(
			leaked.ok,
			'a key the owner rotated away from BEFORE the upgrade still verified from the stale row'
		).toBe(false);
		_resetSeenForTest();
		const owner = await verifyPushedChatOp({ trx: chatSignedWith(keyB) }, lookup);
		expect(owner.ok, 'and the owner, on the key the chain names, verifies').toBe(true);
	});

	it('no chain answer means no fast verdict — never a fall back to the stale row', async () => {
		const lookup = postingKeyLookupFromDb(fx.db, async () => {
			throw new Error('rpc unreachable');
		});
		const leaked = await verifyPushedChatOp({ trx: chatSignedWith(keyA) }, lookup);
		expect(leaked.ok).toBe(false);
	});

	it('the backfill confirms the row against the chain, and corrects it', async () => {
		const r = await reconcilePostingKeys(fx.db, chain({ [ACCOUNT]: pubB }), { pauseMs: 0 });
		expect(r).toEqual({ checked: 1, corrected: 1, remaining: 0 });
		expect(await row()).toEqual({ posting_pubkey: pubB, posting_key_reconciled: true });
		// Now the column alone (no refresher) gives the right verdicts.
		const lookup = postingKeyLookupFromDb(fx.db);
		expect((await verifyPushedChatOp({ trx: chatSignedWith(keyA) }, lookup)).ok).toBe(false);
		expect((await verifyPushedChatOp({ trx: chatSignedWith(keyB) }, lookup)).ok).toBe(true);
	});

	it('a matching key is confirmed as it is', async () => {
		const r = await reconcilePostingKeys(fx.db, chain({ [ACCOUNT]: pubA }), { pauseMs: 0 });
		expect(r).toEqual({ checked: 1, corrected: 0, remaining: 0 });
		expect(await row()).toEqual({ posting_pubkey: pubA, posting_key_reconciled: true });
	});

	it('a chain that names no single key clears the stored one', async () => {
		await reconcilePostingKeys(fx.db, chain({ [ACCOUNT]: null }), { pauseMs: 0 });
		expect(
			await row(),
			'a stored key the chain no longer vouches for is the leak; NULL sends the message by chain'
		).toEqual({ posting_pubkey: null, posting_key_reconciled: true });
	});

	it('an unanswered batch stays unconfirmed, and is counted', async () => {
		const r = await reconcilePostingKeys(
			fx.db,
			{
				getAccounts: async () => {
					throw new Error('rpc unreachable');
				}
			},
			{ pauseMs: 0 }
		);
		expect(r).toEqual({ checked: 0, corrected: 0, remaining: 1 });
		expect((await row())?.posting_key_reconciled).toBe(false);
	});

	it('a rotation the dispatcher records mid-read is not overwritten by the older read', async () => {
		const racing: AccountKeySource = {
			getAccounts: async (names) => {
				// The block stream moves on while the chain read is in flight.
				await apply([accountUpdate(ACCOUNT, pubC)]);
				return new Map(names.map((n) => [n, auth(pubB)]));
			}
		};
		const r = await reconcilePostingKeys(fx.db, racing, { pauseMs: 0 });
		expect(r.checked, 'the older read must not be written over the rotation').toBe(0);
		// v1.20.0 (E1): the rotation is recorded UNCONFIRMED; the next pass asks
		// the chain about pubC itself.
		expect(await row()).toEqual({ posting_pubkey: pubC, posting_key_reconciled: false });
		const next = await reconcilePostingKeys(fx.db, chain({ [ACCOUNT]: pubC }), { pauseMs: 0 });
		expect(next).toEqual({ checked: 1, corrected: 0, remaining: 0 });
		expect(await row()).toEqual({ posting_pubkey: pubC, posting_key_reconciled: true });
	});

	it('a key the dispatcher records is NOT trusted on one endpoint’s word — the chain is asked (v1.20.0, E1)', async () => {
		await apply([accountUpdate(ACCOUNT, pubB)]);
		expect((await row())?.posting_key_reconciled).toBe(false);
		let asked = 0;
		const lookup = postingKeyLookupFromDb(fx.db, async () => {
			asked++;
			return pubB;
		});
		expect((await verifyPushedChatOp({ trx: chatSignedWith(keyB) }, lookup)).ok).toBe(true);
		expect(asked, 'the quorum refresher must vouch for a block-recorded key').toBe(1);
	});

	const accountCreate = (name: string, posting: string): [string, unknown] => [
		'account_create',
		{
			fee: '3.000 BLURT',
			creator: 'morphit-relay',
			new_account_name: name,
			owner: { weight_threshold: 1, account_auths: [], key_auths: [[pubA, 1]] },
			active: { weight_threshold: 1, account_auths: [], key_auths: [[pubA, 1]] },
			posting: { weight_threshold: 1, account_auths: [], key_auths: [[posting, 1]] },
			memo_key: pubA,
			json_metadata: ''
		}
	];

	// v1.20.0 (E1 residual). A create op is ONE endpoint's word, exactly like an
	// account_update: a hostile node serving a forged block could otherwise plant
	// a confirmed key for a new account, and the fast path trusts a confirmed row
	// with no chain read.
	it('an account created through the block stream is NOT born confirmed — the chain is asked', async () => {
		await apply([accountCreate('newbie', pubC)]);
		expect(
			await row('newbie'),
			'a create-derived key was stored confirmed on one endpoint’s word'
		).toEqual({ posting_pubkey: pubC, posting_key_reconciled: false });
		let asked = 0;
		const lookup = postingKeyLookupFromDb(fx.db, async () => {
			asked++;
			return pubC;
		});
		expect(await lookup('newbie')).toBe(pubC);
		expect(asked, 'the quorum refresher must vouch for a create-derived key').toBe(1);
		// The steady reconcile confirms it against the chain.
		// (The fixture's pre-upgrade row for ACCOUNT is pending too.)
		const r = await reconcilePostingKeys(fx.db, chain({ newbie: pubC, [ACCOUNT]: pubA }), {
			pauseMs: 0
		});
		expect(r).toEqual({ checked: 2, corrected: 0, remaining: 0 });
		expect(await row('newbie')).toEqual({ posting_pubkey: pubC, posting_key_reconciled: true });
	});

	it('a replayed account_create cannot re-arm a key the reconcile disowned', async () => {
		// The chain said this account has no single posting key (authority moved
		// to another account): the reconcile wrote NULL, confirmed. A rewind of
		// the poller — the documented way to re-process a block — replays the
		// create op, whose key is the one the owner disowned.
		await fx.db.query(
			`INSERT INTO accounts
			     (name, creator, created_block_num, created_block_time, created_trx_id,
			      posting_pubkey, posting_key_reconciled)
			   VALUES ('newbie', 'morphit-relay', 1, now(), 'seed', NULL, TRUE)`
		);
		await apply([accountCreate('newbie', pubC)]);
		expect(await row('newbie'), 'a replayed create refilled a disowned key').toEqual({
			posting_pubkey: null,
			posting_key_reconciled: true
		});
	});

	it('a create op never touches a row that already holds a key', async () => {
		await fx.db.query(
			`INSERT INTO accounts
			     (name, creator, created_block_num, created_block_time, created_trx_id,
			      posting_pubkey, posting_key_reconciled)
			   VALUES ('newbie', 'morphit-relay', 1, now(), 'seed', $1, TRUE)`,
			[pubB]
		);
		await apply([accountCreate('newbie', pubC)]);
		expect(await row('newbie')).toEqual({ posting_pubkey: pubB, posting_key_reconciled: true });
	});
});

/**
 * v1.18.0 review — R3 and D6, against the real database and the real route.
 *
 * R3: the intake has ONE worker, and it used to await a chain read inline for
 * any sender whose stored key it could not trust. Every message behind that one
 * waited for the RPC pool — seconds over Tor, tens of seconds on a bad day —
 * while the route went on answering 202 and admitting more.
 *
 * D6: a durable record far behind the chain head cannot vouch for a key, because
 * a rotation inside the gap is not in it yet.
 */
describe.skipIf(!INTEGRATION_ENABLED)('the intake never waits on the chain', () => {
	let fx: IntegrationFixture;
	const CAROL = 'carol';

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		_resetSeenForTest();
		_resetKeyRefreshForTest();
		await fx.db.query('DELETE FROM accounts');
		// alice: a row from before the upgrade, not yet confirmed — the chain must
		// be asked. carol: confirmed, her stored key is the answer.
		await fx.db.query(
			`INSERT INTO accounts
			     (name, creator, created_block_num, created_block_time, created_trx_id,
			      posting_pubkey, posting_key_reconciled)
			   VALUES ($1, 'genesis', 1, now(), 'seed', $2, FALSE),
			          ($3, 'genesis', 1, now(), 'seed', $4, TRUE)`,
			[ACCOUNT, pubA, CAROL, pubC]
		);
	});

	const tagOf = (trx: unknown): string =>
		(
			JSON.parse(
				(trx as { operations: [string, { json: string }][] }).operations[0]?.[1].json ?? '{}'
			) as { header: { client_tag: string } }
		).header.client_tag;

	async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
		const until = performance.now() + ms;
		while (!cond() && performance.now() < until) await new Promise((r) => setImmediate(r));
		return cond();
	}

	it('a sender whose key needs the chain does not hold up the message behind it', async () => {
		// A chain read that does not answer until the test says so — standing in
		// for an RPC pool working through its timeouts.
		let release: (key: string) => void = () => undefined;
		const answer = new Promise<string>((r) => {
			release = r;
		});
		let asked = 0;
		const intake = federationChatFastRoute(fx.db, async () => {
			asked++;
			return answer;
		});

		const delivered: string[] = [];
		const off = chatEventBus.onFast((ev) => {
			if (ev.clientTag !== null) delivered.push(ev.clientTag);
		});
		try {
			const waiting = chatSignedWith(keyB); // alice, on the key the chain will name
			const behind = chatSignedWith(keyC, CAROL);
			const res = await intake.app.request('/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ trxs: [waiting, behind] })
			});
			expect(res.status).toBe(202);

			expect(
				await waitFor(() => delivered.includes(tagOf(behind)), 2_000),
				"carol's message sat behind alice's chain read — one slow RPC call held the whole queue"
			).toBe(true);
			expect(asked, "setup: alice's key must actually have been sent to the chain").toBe(1);
			expect(
				delivered.includes(tagOf(waiting)),
				"setup: alice's message cannot have been delivered before her key was known"
			).toBe(false);

			// And the message that waited is not dropped: once the chain answers, it
			// is verified against that answer and delivered.
			release(pubB);
			expect(
				await waitFor(() => delivered.includes(tagOf(waiting)), 2_000),
				'the message that needed the chain was lost instead of delivered once the key arrived'
			).toBe(true);
		} finally {
			off();
		}
	});

	it('a durable record far behind the chain does not vouch for a stored key', async () => {
		await fx.db.query('UPDATE accounts SET posting_key_reconciled = TRUE WHERE name = $1', [
			ACCOUNT
		]);
		// Control: with the durable record current, the stored key is the answer.
		const current = postingKeyLookupFromDb(fx.db, async () => pubB, {
			durableIsCurrent: () => true
		});
		expect(
			(await verifyPushedChatOp({ trx: chatSignedWith(keyA) }, current)).ok,
			'setup: a confirmed row on a current indexer is trusted'
		).toBe(true);

		_resetSeenForTest();
		_resetKeyRefreshForTest();
		const lagging = postingKeyLookupFromDb(fx.db, async () => pubB, {
			durableIsCurrent: () => false
		});
		expect(
			(await verifyPushedChatOp({ trx: chatSignedWith(keyA) }, lagging)).ok,
			'a key rotated away while this indexer was catching up still verified from the column'
		).toBe(false);
		_resetSeenForTest();
		expect(
			(await verifyPushedChatOp({ trx: chatSignedWith(keyB) }, lagging)).ok,
			'and the key the chain names does'
		).toBe(true);
	});
});
