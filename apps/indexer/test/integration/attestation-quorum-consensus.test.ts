/**
 * The fee-attestation quorum is a pure function of the chain (from the
 * consensus activation time).
 *
 * Before: it left out attestors listed in `related_accounts` — the Signal A
 * detector's output, which this node's operator shapes (a local clearance keeps
 * a pair out of it), this node's own relay setting shapes (`excludeCreators`),
 * and this node's hourly timer fills. Two nodes fed the same blocks could
 * disagree on whether an order's listing fee was confirmed by attestation.
 *
 * Now: from CONSENSUS_V2_ACTIVATION_TIME (by the newest attestation's BLOCK
 * time) "related" comes from signalVerdicts.relatedEverHeld — chain-derived
 * accounts and operators rows only — and the attestor gate uses the
 * federation-wide phase, not each node's setting. Before that time every node
 * keeps exactly its old verdicts.
 *
 * Real handlers, real Postgres, two nodes (two schemas) with the same chain
 * rows and different local views. Skips without TEST_DATABASE_URL.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import feeAttestHandler from '../../src/indexer/handlers/feeAttest';
import { BitcoinExplorerFeeVerifier } from '../../src/indexer/fee/bitcoinExplorerVerifier';
import { recheckExternalFees } from '../../src/indexer/fee/externalFeeRecheck';
import { countIndependentAttestors } from '../../src/indexer/fee/attestationQuorum';
import { detectRelatedAccounts } from '../../src/indexer/signals';
import { relatedEverHeld } from '../../src/indexer/signalVerdicts';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, makeCtx } from '../testutils/context';

const ACTIVATION = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
const at = (iso: string) => new Date(iso);
/** Account creation, first activity, an order: all long before activation. */
const CREATED = at('2026-08-01T00:00:00Z');
const FIRST = (min: number) => new Date(Date.parse('2026-08-02T10:00:00Z') + min * 60_000);
const POSTED = at('2026-10-20T12:00:00Z');
/** Attestation blocks: one before the activation time, one after. */
const PRE = { time: new Date(ACTIVATION - 6 * 86_400_000), block: 1000 };
const POST = { time: new Date(ACTIVATION + 86_400_000), block: 2000 };

const FEE_ADDR = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const SATS = 416;
/** Both explorers down: no answer, so the re-check re-derives the quorum. */
const downVerifier = () =>
	new BitcoinExplorerFeeVerifier(
		{
			feeAddress: FEE_ADDR,
			explorerUrls: ['https://blockstream.info/api', 'https://mempool.space/api'],
			minConfirmations: 1,
			requestTimeoutMs: 2000,
			minSuccessfulResponses: 1
		},
		(async () => new Response('down', { status: 503 })) as unknown as typeof fetch
	);

type Fx = IntegrationFixture;

async function reset(fx: Fx): Promise<void> {
	await fx.db.query(
		`TRUNCATE accounts, operators, orders, fee_attestations, feedback, related_accounts,
		          moderation_flag_clearances, ops, account_loyalty CASCADE`
	);
}

/** The event-log row the dispatcher writes for an applied op. Positions only
 *  need to be unique and in time order per signer. */
let position = 100;
async function logApplied(
	fx: Fx,
	signer: string,
	time: Date,
	opId = 'morphit_profile_v1',
	block = position++
): Promise<void> {
	await fx.db.query(
		`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
		 VALUES ($1, $2, 0, $3, $4, $5, $6, '{}'::jsonb, 'applied')`,
		[block, position++, time, `t${position}`.padEnd(40, '0'), signer, opId]
	);
}

/** An account the chain created, and — like the dispatcher — its first
 *  applied Morphit op both in the event log and in accounts.first_activity_at
 *  (the detector's input). */
async function account(
	fx: Fx,
	name: string,
	creator: string,
	first: Date | null,
	createdBlock = 5
): Promise<void> {
	await fx.db.query(
		`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id, first_activity_at)
		 VALUES ($1, $2, $3, $4, 'trx-' || $1, $5)`,
		[name, creator, createdBlock, CREATED, first]
	);
	if (first !== null) await logApplied(fx, name, first);
}

async function operator(fx: Fx, account: string, block: number): Promise<void> {
	await fx.db.query(
		`INSERT INTO operators (account, tag, display_name, registered_in_block)
		 VALUES ($1, $1, $1, $2)`,
		[account, block]
	);
}

/** A BTC order posted before activation, waiting for its fee
 *  (pending_external: the explorers could not answer). */
async function order(fx: Fx, poster: string, permlink: string): Promise<void> {
	await fx.db.query(
		`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
		                     status, created_at, updated_at, fee_status, fee_method, external_tx_id)
		 VALUES ($1, $2, 'sell', 'BTC', 'USD', '{"kind":"spread","percent":0}'::jsonb, ARRAY['cash'],
		         'live', $3, $3, 'pending_external', 'btc', $4)`,
		[poster, permlink, POSTED, createHash('sha256').update(permlink).digest('hex')]
	);
}

/** The morphit_fee_attest_v1 handler, as the dispatcher runs it, then the
 *  first-activity write the dispatcher makes after an applied op. */
async function attest(
	fx: Fx,
	attestor: string,
	poster: string,
	permlink: string,
	blk: { time: Date; block: number },
	phase: 'launch' | 'steady' = 'launch'
): Promise<{ ok: boolean; reason?: string }> {
	const r = await fx.db.withTx(async (c) => {
		const res = await feeAttestHandler(
			makeCtx({
				signer: attestor,
				blockTime: blk.time,
				blockNum: blk.block,
				trxId: `${attestor}-${permlink}`.padEnd(40, '0').slice(0, 40),
				payload: { order_account: poster, order_permlink: permlink },
				config: fakeConfig({ attestationPhase: phase })
			}),
			c
		);
		if (res.ok) {
			// What the dispatcher writes after an applied op: the event-log row
			// and, on an account's first op, its first activity.
			await c.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
				 VALUES ($1, $2, 0, $3, $4, $5, 'morphit_fee_attest_v1', '{}'::jsonb, 'applied')`,
				[blk.block, position++, blk.time, `t${position}`.padEnd(40, '0'), attestor]
			);
			await c.query(
				`UPDATE accounts SET first_activity_at = $2 WHERE name = $1 AND first_activity_at IS NULL`,
				[attestor, blk.time]
			);
		}
		return res;
	});
	return r as { ok: boolean; reason?: string };
}

async function feeStatus(fx: Fx, permlink: string): Promise<string> {
	const r = await fx.db.query<{ fee_status: string }>(
		`SELECT fee_status FROM orders WHERE permlink = $1`,
		[permlink]
	);
	return r.rows[0]!.fee_status;
}

/**
 * The same chain rows on every node:
 *   - pat (creator `factory`, a custom onboarding pipeline) and sock1 (same
 *     creator, first Morphit op 2 minutes later): related by Signal A;
 *   - quinn and rex, created by `relay-x` (an instance relay that never
 *     registered as an operator), first ops 1 minute apart: related too;
 *   - alice, bob, dave: created by a registered operator's relay, so never
 *     related to anyone by creator.
 */
async function seedChain(fx: Fx): Promise<void> {
	await reset(fx);
	await operator(fx, 'relay-reg', 10);
	await account(fx, 'pat', 'factory', FIRST(0));
	await account(fx, 'sock1', 'factory', FIRST(2));
	await account(fx, 'quinn', 'relay-x', FIRST(30));
	await account(fx, 'rex', 'relay-x', FIRST(31));
	for (const [i, n] of ['alice', 'bob', 'dave'].entries()) {
		await account(fx, n, 'relay-reg', FIRST(60 + i));
	}
	await order(fx, 'pat', 'sell-btc-one');
	await order(fx, 'quinn', 'sell-btc-two');
}

/**
 * This node's local view, which must not matter:
 *   'cleared'  — the operator cleared (pat, sock1) as "not related", and the
 *                node runs Signal A with its own relay `relay-x` excluded;
 *   'plain'    — no clearance, a different relay setting.
 */
async function localView(fx: Fx, view: 'cleared' | 'plain'): Promise<void> {
	if (view === 'cleared') {
		await fx.db.query(
			`INSERT INTO moderation_flag_clearances (signal, account_a, account_b, note)
			 VALUES ('related', 'pat', 'sock1', 'operator: same household, not a sock')`
		);
	}
	await detectRelatedAccounts(fx.db, {
		excludeCreators: view === 'cleared' ? ['relay-x'] : ['some-other-relay']
	});
}

async function runNode(
	fx: Fx,
	view: 'cleared' | 'plain',
	blk: { time: Date; block: number }
): Promise<Record<string, string>> {
	await seedChain(fx);
	await localView(fx, view);
	await attest(fx, 'sock1', 'pat', 'sell-btc-one', blk);
	await attest(fx, 'alice', 'pat', 'sell-btc-one', blk);
	await attest(fx, 'rex', 'quinn', 'sell-btc-two', blk);
	await attest(fx, 'bob', 'quinn', 'sell-btc-two', blk);
	return {
		one: await feeStatus(fx, 'sell-btc-one'),
		two: await feeStatus(fx, 'sell-btc-two')
	};
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'fee-attestation quorum: a pure function of the chain',
	() => {
		let a: Fx;
		let b: Fx;
		beforeAll(async () => {
			a = await setupWithMigrations();
			b = await setupWithMigrations();
		}, 60_000);
		afterAll(async () => {
			for (const fx of [a, b]) await fx?.teardown();
		});

		it('from activation: a local clearance or another relay setting does not change fee_status', async () => {
			const nodeA = await runNode(a, 'cleared', POST);
			const nodeB = await runNode(b, 'plain', POST);
			// Every node: sock1 is related to pat and rex to quinn, by the chain's
			// rows, whatever the operator cleared or the node's relay is.
			expect(nodeA).toEqual({ one: 'pending_external', two: 'pending_external' });
			expect(nodeB).toEqual(nodeA);
			// The local views did differ (what the display reads).
			const flags = async (fx: Fx) =>
				(await fx.db.query(`SELECT account_a, account_b FROM related_accounts ORDER BY 1, 2`)).rows;
			expect(await flags(a)).toEqual([]);
			expect(await flags(b)).toEqual([
				{ account_a: 'pat', account_b: 'sock1' },
				{ account_a: 'quinn', account_b: 'rex' }
			]);
			// A genuinely independent second attestor still confirms, on both.
			for (const fx of [a, b]) {
				await attest(fx, 'dave', 'pat', 'sell-btc-one', POST);
				expect(await feeStatus(fx, 'sell-btc-one')).toBe('verified_by_attestation');
			}
			// The re-check job re-derives the same verdicts (explorers silent).
			for (const fx of [a, b]) {
				await recheckExternalFees({
					db: fx.db,
					verifiers: { btc: downVerifier() },
					amounts: { btcSatoshis: SATS },
					now: new Date(POST.time.getTime() + 3_600_000)
				});
				const checked = await fx.db.query(
					`SELECT 1 FROM orders WHERE permlink = 'sell-btc-one' AND fee_rechecked_at IS NOT NULL`
				);
				expect(checked.rowCount).toBe(1);
				expect(await feeStatus(fx, 'sell-btc-one')).toBe('verified_by_attestation');
			}
		});

		it('before activation: each node keeps its old verdict (the detector table, as before)', async () => {
			const nodeA = await runNode(a, 'cleared', PRE);
			const nodeB = await runNode(b, 'plain', PRE);
			// Exactly the old behaviour, disagreement included: history keeps the
			// verdicts every node already recorded.
			expect(nodeA).toEqual({ one: 'verified_by_attestation', two: 'verified_by_attestation' });
			expect(nodeB).toEqual({ one: 'pending_external', two: 'pending_external' });
		});

		it('the verdict at intake is the one every later re-derivation reaches', async () => {
			await seedChain(a);
			// xan: same creator as pia, never active on Morphit before — its first
			// Morphit op is this attestation, in the same block as the verdict.
			await account(a, 'pia', 'factory3', null);
			await account(a, 'xan', 'factory3', null);
			await order(a, 'pia', 'sell-btc-three');
			const blk = {
				time: new Date(Date.parse('2026-08-02T12:01:00Z') + 92 * 86_400_000),
				block: 3000
			};
			// pia's first op: 3 minutes before the attestation block.
			const piaFirst = new Date(blk.time.getTime() - 3 * 60_000);
			await a.db.query(`UPDATE accounts SET first_activity_at = $1 WHERE name = 'pia'`, [piaFirst]);
			await logApplied(a, 'pia', piaFirst, 'morphit_order_v1', blk.block - 60);
			expect(await attest(a, 'alice', 'pia', 'sell-btc-three', blk)).toEqual({ ok: true });
			expect(await attest(a, 'xan', 'pia', 'sell-btc-three', blk)).toEqual({ ok: true });
			const atIntake = await feeStatus(a, 'sell-btc-three');
			const countAtIntake = await countIndependentAttestors(a.db, 'pia', 'sell-btc-three');
			// xan is related to pia (its attestation stood in for its first op).
			expect(atIntake).toBe('pending_external');
			expect(countAtIntake).toBe(1);

			// Later in the SAME block, after the attestation: factory3 registers as
			// an operator, and pia and alice trade three five-star reviews each way.
			await operator(a, 'factory3', blk.block);
			for (let i = 0; i < 3; i++) {
				await a.db.query(
					`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
				 VALUES ('pia', 'alice', 5, $1, $2, $3), ('alice', 'pia', 5, $1, $2, $4)`,
					[`o${i}`, blk.time, `t-pa-${i}`, `t-ap-${i}`]
				);
			}
			// The re-check job, reading after the block: the same count.
			expect(await countIndependentAttestors(a.db, 'pia', 'sell-btc-three')).toBe(countAtIntake);

			// From the NEXT block on, those rows count: a new attestation there is
			// judged with factory3 registered (xan no longer related) and pia and
			// alice a reciprocal pair (alice no longer counts).
			const next = { time: new Date(blk.time.getTime() + 3000), block: blk.block + 1 };
			expect(await attest(a, 'bob', 'pia', 'sell-btc-three', next)).toEqual({ ok: true });
			expect(await countIndependentAttestors(a.db, 'pia', 'sell-btc-three')).toBe(2); // xan, bob
		});

		it('from activation the attestor gate is the federation phase, not the node setting', async () => {
			// carol: 60 days old, never paid a fee — qualifies under 'launch' (age
			// alone), not under 'steady' (age AND loyalty).
			for (const [fx, phase] of [
				[a, 'launch'],
				[b, 'steady']
			] as const) {
				await seedChain(fx);
				await account(fx, 'carol', 'relay-reg', FIRST(90));
				const pre = await attest(fx, 'carol', 'pat', 'sell-btc-one', PRE, phase);
				// Before activation each node used its own setting, as it always did.
				expect(pre.ok).toBe(phase === 'launch');
				await fx.db.query(`DELETE FROM fee_attestations`);
				const post = await attest(fx, 'carol', 'pat', 'sell-btc-one', POST, phase);
				expect(post).toEqual({ ok: true });
			}
		});
	}
);

describe.skipIf(!INTEGRATION_ENABLED)('relatedEverHeld matches the Signal A detector', () => {
	let fx: Fx;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	}, 60_000);
	afterAll(async () => {
		await fx?.teardown();
	});

	it('on representative cases, with no clearance and no relay setting', async () => {
		await reset(fx);
		// A registered operator's relay, the canonical (reserved) relay, an
		// unknown creator ('' placeholder rows) and plain custom creators.
		await operator(fx, 'relay-reg', 10);
		const rows: [string, string, number | null][] = [
			['a1', 'cli', 0],
			['a2', 'cli', 3], // 3 min after a1: related
			['a3', 'cli', 8], // 5 min after a2 exactly: related; 8 after a1: not
			['a4', 'cli', 30],
			['a5', 'cli', null], // never active
			['b1', 'cli2', 0], // another creator, same minute as a1: not related to a1
			['b2', 'cli2', 5.0 + 1 / 60], // 301 s after b1: not related
			['r1', 'relay-reg', 0],
			['r2', 'relay-reg', 1],
			['m1', 'morphit-relay', 0],
			['m2', 'morphit-relay', 1],
			['u1', '', 0],
			['u2', '', 1]
		];
		for (const [n, c, m] of rows) await account(fx, n, c, m === null ? null : FIRST(m));
		await detectRelatedAccounts(fx.db, {});
		const flagged = new Set(
			(
				await fx.db.query<{ a: string; b: string }>(
					`SELECT account_a AS a, account_b AS b FROM related_accounts`
				)
			).rows.map((r) => `${r.a}|${r.b}`)
		);
		expect([...flagged].sort()).toEqual(['a1|a2', 'a2|a3']);
		const names = rows.map((r) => r[0]).sort();
		const asOf = new Date('2027-01-01T00:00:00Z');
		for (let i = 0; i < names.length; i++) {
			for (let j = i + 1; j < names.length; j++) {
				const [x, y] = [names[i]!, names[j]!];
				const pure = await relatedEverHeld(fx.db, { a: x, b: y, asOf, asOfBlock: 1_000_000 });
				const swapped = await relatedEverHeld(fx.db, { a: y, b: x, asOf, asOfBlock: 1_000_000 });
				expect(pure, `${x} ~ ${y}`).toBe(flagged.has(`${x}|${y}`));
				expect(swapped, `${y} ~ ${x}`).toBe(pure);
			}
		}
	});

	it('judges at its point on the chain: activity up to it, registrations before its block', async () => {
		await reset(fx);
		await account(fx, 'p1', 'late-relay', FIRST(0));
		await account(fx, 'p2', 'late-relay', FIRST(2));
		const asOf = FIRST(2);
		// Both first ops at or before asOf: related.
		expect(await relatedEverHeld(fx.db, { a: 'p1', b: 'p2', asOf, asOfBlock: 500 })).toBe(true);
		// A moment before p2's first op: not yet.
		expect(await relatedEverHeld(fx.db, { a: 'p1', b: 'p2', asOf: FIRST(1), asOfBlock: 500 })).toBe(
			false
		);
		// late-relay registers in block 500: from block 501 its users are not related.
		await operator(fx, 'late-relay', 500);
		expect(await relatedEverHeld(fx.db, { a: 'p1', b: 'p2', asOf, asOfBlock: 500 })).toBe(true);
		expect(await relatedEverHeld(fx.db, { a: 'p1', b: 'p2', asOf, asOfBlock: 501 })).toBe(false);
		// An account with no first op yet, standing in its own op's time.
		await account(fx, 'p3', 'cli', null);
		await account(fx, 'p4', 'cli', FIRST(0));
		expect(await relatedEverHeld(fx.db, { a: 'p3', b: 'p4', asOf, asOfBlock: 1 })).toBe(false);
		expect(
			await relatedEverHeld(fx.db, { a: 'p3', b: 'p4', asOf, asOfBlock: 1, aActiveAt: FIRST(2) })
		).toBe(true);
	});

	it('takes first activity from the event log, which a re-judged op leaves the same on every node', async () => {
		await reset(fx);
		// q1's first op was REJECTED when this node first indexed it (an older
		// rule), so accounts.first_activity_at recorded its next op, 30 minutes
		// later; a re-judge job (reconcileUpgrade, blurtFeeReverify, …) has
		// since flipped that first op to applied, and does not touch the
		// column. A node that replayed the same blocks applied the op at once
		// and recorded it. Both nodes' event logs say the same.
		await account(fx, 'q2', 'cli3', FIRST(2));
		await fx.db.query(
			`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id, first_activity_at)
			 VALUES ('q1', 'cli3', 5, $1, 'trx-q1', $2)`,
			[CREATED, FIRST(30)]
		);
		await logApplied(fx, 'q1', FIRST(0), 'morphit_stranger_fee_v1');
		await logApplied(fx, 'q1', FIRST(30));
		const asOf = FIRST(60);
		expect(await relatedEverHeld(fx.db, { a: 'q1', b: 'q2', asOf, asOfBlock: 1 })).toBe(true);
		// The node that replayed: its column holds the first op. Same answer.
		await fx.db.query(`UPDATE accounts SET first_activity_at = $1 WHERE name = 'q1'`, [FIRST(0)]);
		expect(await relatedEverHeld(fx.db, { a: 'q1', b: 'q2', asOf, asOfBlock: 1 })).toBe(true);
		// A rejected op is not activity.
		await fx.db.query(
			`UPDATE ops SET status = 'rejected' WHERE signer = 'q1' AND op_id = 'morphit_stranger_fee_v1'`
		);
		expect(await relatedEverHeld(fx.db, { a: 'q1', b: 'q2', asOf, asOfBlock: 1 })).toBe(false);
	});
});
