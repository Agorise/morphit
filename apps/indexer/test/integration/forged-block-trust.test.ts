/**
 * ONE RPC endpoint decides a block's content.
 *
 * The poller and the head tailer read each block from a single endpoint, and
 * nothing re-checked the signatures inside it. A hostile endpoint in the pool
 * could therefore:
 *
 *   1. serve a HEAD block holding an unsigned chat op "from @alice": the tailer
 *      showed it live in every open chatroom (and could push-notify it);
 *   2. serve an unsigned provisional order cancel: every open orderbook hid
 *      the order;
 *   3. serve an unsigned `account_update` moving @alice's posting key to the
 *      attacker's: the dispatcher stored it CONFIRMED (posting_key_reconciled
 *      = TRUE), so the fast path trusted it with no chain read, and the
 *      attacker's pushed chat verified as @alice's federation-wide.
 *
 * Real Postgres, the real dispatcher `applyBlock`, the real head tailer, the
 * real intake lookup (with an HONEST quorum refresher standing in for the
 * chain), real signatures. Full block verification (header/merkle/witness) is
 * a separate design decision; these are the bounded fixes.
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
import { HeadTailer } from '../../src/indexer/headTailer';
import { chatEventBus } from '../../src/indexer/chatEventBus';
import { orderbookEventBus } from '../../src/indexer/orderbookEventBus';
import { keepReconcilingPostingKeys } from '../../src/indexer/postingKeyBackfill';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const real = PrivateKey.fromSeed('e1-alice-real');
const attacker = PrivateKey.fromSeed('e1-attacker');
const realPub = real.createPublic().toString();
const attackerPub = attacker.createPublic().toString();

let seq = 0;
function chatOp(sender: string): [string, unknown] {
	return [
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: [sender],
			id: 'morphit_chat_v1',
			json: JSON.stringify({
				recipient: 'bob',
				ciphertext: Buffer.from('hi').toString('base64'),
				header: { client_tag: `e1-${++seq}`, ephemeral_pub: 'AAAA', nonce: 'AAAA' }
			})
		}
	];
}
function unsignedTrx(op: [string, unknown]) {
	return {
		ref_block_num: 1,
		ref_block_prefix: 2,
		expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
		operations: [op],
		extensions: [],
		signatures: [] as string[]
	};
}
function signedTrx(op: [string, unknown], key: typeof real) {
	return cryptoUtils.signTransaction(unsignedTrx(op) as never, [key]) as unknown as ReturnType<
		typeof unsignedTrx
	>;
}
function block(trxs: ReturnType<typeof unsignedTrx>[]) {
	return {
		timestamp: new Date().toISOString().slice(0, 19),
		transaction_ids: trxs.map((_, i) => `e1-trx-${seq}-${i}`),
		transactions: trxs
	};
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'E1 — a single endpoint cannot forge what the fast path trusts',
	() => {
		let fx: IntegrationFixture;
		let blockNum = 91_000_000;

		async function apply(b: ReturnType<typeof block>): Promise<void> {
			const client: pg.PoolClient = await fx.pool.connect();
			try {
				await client.query(`SET search_path TO "${fx.schema}"`);
				await client.query('BEGIN');
				await applyBlock(
					client,
					++blockNum,
					b as never,
					{} as never,
					{ feeRecipient: 'morphit' } as never,
					{} as never,
					{} as never,
					(async () => null) as never
				);
				await client.query('COMMIT');
			} catch (e) {
				await client.query('ROLLBACK');
				throw e;
			} finally {
				client.release();
			}
		}

		async function tailerEmits(
			b: ReturnType<typeof block>
		): Promise<{ chat: string[]; orders: string[] }> {
			const chat: string[] = [];
			const orders: string[] = [];
			const offChat = chatEventBus.onFast((ev) => chat.push(ev.sender));
			const offOrders = orderbookEventBus.onProvisional((ev) => orders.push(ev.orderId));
			try {
				const tailer = new HeadTailer({} as never, fx.db, {} as never);
				await (tailer as unknown as { scanBlock(b: unknown): Promise<void> }).scanBlock(b);
			} finally {
				offChat();
				offOrders();
			}
			return { chat, orders };
		}

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
				`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id,
			                       posting_pubkey, posting_key_reconciled)
			 VALUES ('alice','genesis',1,now(),'s1',$1,TRUE), ('bob','genesis',1,now(),'s2',NULL,TRUE)`,
				[realPub]
			);
		});

		it('the head tailer does NOT show an unsigned chat op a node put in a head block', async () => {
			const { chat } = await tailerEmits(block([unsignedTrx(chatOp('alice'))]));
			expect(chat, 'an unsigned "@alice" message was shown live').toEqual([]);
		});

		it('…nor one signed by somebody else’s key', async () => {
			const { chat } = await tailerEmits(block([signedTrx(chatOp('alice'), attacker)]));
			expect(chat).toEqual([]);
		});

		it('…but still shows one @alice really signed (the fast path is not switched off)', async () => {
			const { chat } = await tailerEmits(block([signedTrx(chatOp('alice'), real)]));
			expect(chat).toEqual(['alice']);
		});

		it('a genuinely signed but long-EXPIRED transaction replayed in a head block is not shown live', async () => {
			const old = cryptoUtils.signTransaction(
				{ ...unsignedTrx(chatOp('alice')), expiration: '2025-03-01T12:00:00' } as never,
				[real]
			) as unknown as ReturnType<typeof unsignedTrx>;
			expect((await tailerEmits(block([old]))).chat).toEqual([]);
			const cancel: [string, unknown] = [
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: ['alice'],
					id: 'morphit_order_cancel_v1',
					json: JSON.stringify({ permlink: 'sell-blurt-1' })
				}
			];
			const oldCancel = cryptoUtils.signTransaction(
				{ ...unsignedTrx(cancel), expiration: '2025-03-01T12:00:00' } as never,
				[real]
			) as unknown as ReturnType<typeof unsignedTrx>;
			expect((await tailerEmits(block([oldCancel]))).orders).toEqual([]);
		});

		it('a "head" block whose time is far from now is not shown live, however it is signed', async () => {
			const at = '2025-03-01T12:00:00';
			const trx = cryptoUtils.signTransaction(
				{ ...unsignedTrx(chatOp('alice')), expiration: '2025-03-01T12:01:00' } as never,
				[real]
			) as unknown as ReturnType<typeof unsignedTrx>;
			expect((await tailerEmits({ ...block([trx]), timestamp: at })).chat).toEqual([]);
		});

		it('a transaction the durable path already stored is not shown live again', async () => {
			const trx = signedTrx(chatOp('alice'), real);
			const b = block([trx]);
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
				 VALUES ('alice', 'bob', 'x', '{}'::jsonb, now(), $1)`,
				// Stored under the id the chain gives it — its content's; the id a
				// node lists in the block is not consulted (VT1-9).
				[cryptoUtils.generateTrxId(trx as never)]
			);
			expect((await tailerEmits(b)).chat).toEqual([]);
		});

		it('an unsigned provisional order cancel hides nothing', async () => {
			const cancel: [string, unknown] = [
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: ['alice'],
					id: 'morphit_order_cancel_v1',
					json: JSON.stringify({ permlink: 'sell-blurt-1' })
				}
			];
			expect((await tailerEmits(block([unsignedTrx(cancel)]))).orders).toEqual([]);
			expect((await tailerEmits(block([signedTrx(cancel, real)]))).orders).toEqual([
				'alice/sell-blurt-1'
			]);
		});

		it('a forged account_update is NOT stored confirmed, and the attacker’s push as @alice is refused', async () => {
			await apply(
				block([
					unsignedTrx([
						'account_update',
						{
							account: 'alice',
							posting: { weight_threshold: 1, account_auths: [], key_auths: [[attackerPub, 1]] },
							memo_key: attackerPub,
							json_metadata: ''
						}
					])
				])
			);
			const row = (
				await fx.db.query<{ posting_key_reconciled: boolean }>(
					`SELECT posting_key_reconciled FROM accounts WHERE name = 'alice'`
				)
			).rows[0];
			expect(row?.posting_key_reconciled, 'a single-source key was stored as chain-confirmed').toBe(
				false
			);
			// The intake's lookup as main.ts builds it: an honest quorum refresher.
			const lookup = postingKeyLookupFromDb(fx.db, async () => realPub, {
				durableIsCurrent: () => true
			});
			const v = await verifyPushedChatOp({ trx: signedTrx(chatOp('alice'), attacker) }, lookup);
			expect(v.ok, 'an attacker-signed push was accepted as @alice').toBe(false);
			// And the owner's real key still works.
			const good = await verifyPushedChatOp({ trx: signedTrx(chatOp('alice'), real) }, lookup);
			expect(good.ok).toBe(true);
		});

		it('the reconcile keeps running after boot: a rotation recorded at runtime is confirmed against the chain', async () => {
			await fx.db.query(`UPDATE accounts SET posting_key_reconciled = FALSE WHERE name = 'alice'`);
			const chain = {
				getAccountsAgreed: async (names: readonly string[]) =>
					new Map(
						names.map((n) => [
							n,
							{
								name: n,
								posting: { weight_threshold: 1, account_auths: [], key_auths: [[realPub, 1]] }
							}
						])
					)
			};
			const passes: number[] = [];
			let stop: () => void = () => undefined;
			let rotatedAfterDone = false;
			await new Promise<void>((resolve) => {
				stop = keepReconcilingPostingKeys(
					fx.db,
					chain as never,
					{
						firstDelayMs: 1,
						steadyDelayMs: 1,
						pauseMs: 0,
						onPass: (p: { checked: number }) => {
							passes.push(p.checked);
							// The first pass confirms everything (remaining 0). THEN a
							// rotation is recorded at runtime, as the dispatcher now
							// records one: unconfirmed.
							if (passes.length === 1) {
								void fx.db
									.query(`UPDATE accounts SET posting_key_reconciled = FALSE WHERE name = 'alice'`)
									.then(() => {
										rotatedAfterDone = true;
									});
							} else if (rotatedAfterDone && p.checked > 0) {
								resolve();
							}
						}
					} as never
				);
			});
			stop();
			const row = (
				await fx.db.query<{ posting_key_reconciled: boolean }>(
					`SELECT posting_key_reconciled FROM accounts WHERE name = 'alice'`
				)
			).rows[0];
			expect(row?.posting_key_reconciled).toBe(true);
		});
	}
);
