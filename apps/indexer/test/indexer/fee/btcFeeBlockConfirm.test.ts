/**
 * v1.20.0 (MK-H2, V3-6) — a block holding an op that moves the BTC fee-address
 * numbering (or the treasury pin) is applied only if two independent RPC
 * operators serve the same transactions at those positions. Since v1.21.14 the
 * chat and inbox ops too (full chat audit, S-H2).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';

import {
	BlockNotConfirmedError,
	CHAT_QUORUM_WAIT_MS,
	confirmFeeRelevantTransactions,
	MAX_UNCONFIRMED_ATTEMPTS,
	positionsKey,
	_resetBlockConfirmForTest
} from '$indexer/fee/btcFeeBlockConfirm';
import type { BlockHeader, BlurtClient } from '$blurt/client';

const XPUB =
	'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';

function orderTrx(signer: string, permlink: string, extra: Record<string, unknown> = {}) {
	return {
		ref_block_num: 1,
		ref_block_prefix: 2,
		expiration: '2026-09-27T12:00:00',
		signatures: ['sig'],
		operations: [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: [signer],
					id: 'morphit_order_v1',
					json: JSON.stringify({ permlink, fee_method: 'btc', ...extra })
				}
			]
		]
	};
}
const block = (trxs: unknown[], ids: string[]): BlockHeader =>
	({
		timestamp: '2026-09-27T12:00:00',
		transactions: trxs,
		transaction_ids: ids
	}) as unknown as BlockHeader;

/** A pin with an xpub in force. */
const pinnedDb = {
	query: async () => ({
		rows: [{ treasury: { btc: { address: 'bc1q', satoshis: 1000, xpub: XPUB } } }]
	})
} as unknown as pg.PoolClient;
const noPinDb = { query: async () => ({ rows: [] }) } as unknown as pg.PoolClient;

/** `operators` exist in the pool; `reachable` of them answered their last call. */
function chain(
	served: BlockHeader | null,
	operators = 3,
	calls: string[] = [],
	reachable = operators
): BlurtClient {
	return {
		operatorCount: () => operators,
		reachableOperatorCount: () => reachable,
		condenserAgreed: async (
			method: string,
			params: unknown[],
			keyOf: (b: BlockHeader) => string | null
		) => {
			calls.push(`${method}:${String(params[0])}`);
			if (served === null) return null;
			const key = keyOf(served);
			return key === null ? null : { value: served, key };
		}
	} as unknown as BlurtClient;
}

describe('confirming fee-relevant transactions (V3-6)', () => {
	// The gate keeps per-process outage state (review A, F1): each test starts clean.
	beforeEach(() => _resetBlockConfirmForTest());
	const honest = block([orderTrx('alice', 'a1')], ['aa']);
	const forged = block([orderTrx('ghost', 'g1'), orderTrx('alice', 'a1')], ['ff', 'aa']);

	it('applies a block whose address-mode order transactions two operators confirm', async () => {
		expect(await confirmFeeRelevantTransactions(pinnedDb, chain(honest), 101, honest)).toBe(
			'confirmed'
		);
	});

	it('refuses a block with an injected order op, every time it comes back', async () => {
		for (let i = 0; i < MAX_UNCONFIRMED_ATTEMPTS + 2; i++) {
			await expect(
				confirmFeeRelevantTransactions(pinnedDb, chain(honest), 102, forged)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
		}
	});

	it('does not ask anyone for blocks without such ops, or before any xpub pin', async () => {
		const calls: string[] = [];
		const plain = block([orderTrx('alice', 'a1', { external_tx_id: 'a'.repeat(64) })], ['aa']);
		expect(await confirmFeeRelevantTransactions(pinnedDb, chain(null, 3, calls), 103, plain)).toBe(
			'none'
		);
		expect(await confirmFeeRelevantTransactions(noPinDb, chain(null, 3, calls), 103, honest)).toBe(
			'none'
		);
		expect(calls).toEqual([]);
	});

	it('always confirms a release op (it can move the pin)', async () => {
		const rel = block(
			[
				{
					operations: [
						[
							'custom_json',
							{ id: 'morphit_release_v1', required_posting_auths: ['morphit'], json: '{}' }
						]
					]
				}
			],
			['rr']
		);
		const other = block(
			[
				{
					operations: [
						[
							'custom_json',
							{ id: 'morphit_release_v1', required_posting_auths: ['morphit'], json: '{"x":1}' }
						]
					]
				}
			],
			['rr']
		);
		await expect(
			confirmFeeRelevantTransactions(noPinDb, chain(other), 104, rel)
		).rejects.toBeInstanceOf(BlockNotConfirmedError);
	});

	it('a pool of ONE operator has nothing to compare with: applies single-source', async () => {
		expect(await confirmFeeRelevantTransactions(pinnedDb, chain(null, 1), 105, forged)).toBe(
			'single_source'
		);
	});

	it('one reachable operator out of several is not a quorum: retried, never applied single-source', async () => {
		for (let i = 0; i < MAX_UNCONFIRMED_ATTEMPTS + 2; i++) {
			await expect(
				confirmFeeRelevantTransactions(pinnedDb, chain(null, 3, [], 1), 107, forged)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
		}
	});

	it('when no two operators agree, the block is retried for as long as it takes', async () => {
		for (let i = 0; i < MAX_UNCONFIRMED_ATTEMPTS * 3; i++) {
			await expect(
				confirmFeeRelevantTransactions(pinnedDb, chain(null), 106, honest)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
		}
		expect(await confirmFeeRelevantTransactions(pinnedDb, chain(honest), 106, honest)).toBe(
			'confirmed'
		);
	});

	it('always confirms an rpc-directory op (it adds quorum operators to the pool)', async () => {
		const dirTrx = (json: string) => ({
			operations: [
				['custom_json', { id: 'morphit_rpc_v1', required_posting_auths: ['morphit'], json }]
			]
		});
		const served = block([dirTrx('{"v":1}')], ['dd']);
		const chainSays = block([dirTrx('{"v":1,"nodes":[]}')], ['dd']);
		await expect(
			confirmFeeRelevantTransactions(noPinDb, chain(chainSays), 108, served)
		).rejects.toBeInstanceOf(BlockNotConfirmedError);
		expect(await confirmFeeRelevantTransactions(noPinDb, chain(served), 108, served)).toBe(
			'confirmed'
		);
	});

	describe('chat and inbox ops (v1.21.14 full chat audit, S-H2)', () => {
		const chatTrx = (id: string, signer: string, json: string, sigs: string[] = ['sig']) => ({
			ref_block_num: 1,
			ref_block_prefix: 2,
			expiration: '2026-10-21T12:00:00',
			signatures: sigs,
			operations: [
				['custom_json', { required_auths: [], required_posting_auths: [signer], id, json }]
			]
		});
		const ids = [
			'morphit_chat_v1',
			'morphit_chat_read_v1',
			'morphit_chat_folders_v1',
			'morphit_chat_identity_v1',
			'morphit_stranger_fee_v1',
			'morphit_block_v1'
		];
		for (const id of ids) {
			it(`${id}: a transaction the operators do not serve is never applied`, async () => {
				const real = block([chatTrx('morphit_order_cancel_v1', 'x', '{}')], ['o1']);
				const forged = block(
					[chatTrx('morphit_order_cancel_v1', 'x', '{}'), chatTrx(id, 'bob', '{"a":1}')],
					['o1', 'f1']
				);
				await expect(
					confirmFeeRelevantTransactions(noPinDb, chain(real), 200, forged)
				).rejects.toBeInstanceOf(BlockNotConfirmedError);
			});
			it(`${id}: a transaction two operators serve is applied`, async () => {
				const b = block([chatTrx(id, 'bob', '{"a":1}')], ['c1']);
				expect(await confirmFeeRelevantTransactions(noPinDb, chain(b), 201, b)).toBe('confirmed');
			});
		}
		it('a real chat transaction served with its signatures stripped is not applied', async () => {
			const real = block([chatTrx('morphit_chat_v1', 'bob', '{"a":1}')], ['c1']);
			const stripped = block([chatTrx('morphit_chat_v1', 'bob', '{"a":1}', [])], ['c1']);
			await expect(
				confirmFeeRelevantTransactions(noPinDb, chain(real), 202, stripped)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
		});
		it('until two operators agree, a chat block waits', async () => {
			const b = block([chatTrx('morphit_chat_v1', 'bob', '{"a":1}')], ['c1']);
			await expect(
				confirmFeeRelevantTransactions(noPinDb, chain(null, 3, [], 1), 203, b)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
		});
		it('a chat-only block waits for two operators for a bounded time, then is applied (logged)', async () => {
			const b = block([chatTrx('morphit_chat_read_v1', 'bob', '{"a":1}')], ['c1']);
			const t0 = 1_000_000_000_000;
			const lone = chain(null, 3, [], 1);
			for (const dt of [0, 60_000, CHAT_QUORUM_WAIT_MS - 1]) {
				await expect(
					confirmFeeRelevantTransactions(noPinDb, lone, 205, b, t0 + dt)
				).rejects.toBeInstanceOf(BlockNotConfirmedError);
			}
			expect(
				await confirmFeeRelevantTransactions(noPinDb, lone, 205, b, t0 + CHAT_QUORUM_WAIT_MS)
			).toBe('single_source');
		});
		it('a forged chat block is never applied, however long it keeps coming back', async () => {
			const real = block([chatTrx('morphit_order_cancel_v1', 'x', '{}')], ['o1']);
			const forged = block(
				[chatTrx('morphit_order_cancel_v1', 'x', '{}'), chatTrx('morphit_chat_v1', 'bob', '{}')],
				['o1', 'f1']
			);
			const t0 = 2_000_000_000_000;
			for (const dt of [0, CHAT_QUORUM_WAIT_MS, 10 * CHAT_QUORUM_WAIT_MS]) {
				await expect(
					confirmFeeRelevantTransactions(noPinDb, chain(real), 206, forged, t0 + dt)
				).rejects.toBeInstanceOf(BlockNotConfirmedError);
			}
		});
		it('a block with a chat op AND a release op is never applied single-source', async () => {
			const rel = {
				ref_block_num: 1,
				ref_block_prefix: 2,
				expiration: '2026-10-21T12:00:00',
				signatures: ['sig'],
				operations: [
					[
						'custom_json',
						{
							required_auths: ['morphit'],
							required_posting_auths: [],
							id: 'morphit_release_v1',
							json: '{}'
						}
					]
				]
			};
			const b = block([chatTrx('morphit_chat_v1', 'bob', '{}'), rel], ['c1', 'r1']);
			const t0 = 3_000_000_000_000;
			const lone = chain(null, 3, [], 1);
			for (const dt of [0, CHAT_QUORUM_WAIT_MS, 10 * CHAT_QUORUM_WAIT_MS]) {
				await expect(
					confirmFeeRelevantTransactions(noPinDb, lone, 207, b, t0 + dt)
				).rejects.toBeInstanceOf(BlockNotConfirmedError);
			}
		});
		it('a chat op and a numbered BTC order in ONE transaction: never single-source (review 2, finding 7)', async () => {
			const both = {
				ref_block_num: 1,
				ref_block_prefix: 2,
				expiration: '2026-10-21T12:00:00',
				signatures: ['sig'],
				operations: [
					...chatTrx('morphit_chat_v1', 'mallory', '{}').operations,
					...orderTrx('mallory', 'm1').operations
				]
			};
			const b = block([both], ['cb']);
			const t0 = 4_000_000_000_000;
			const lone = chain(null, 3, [], 1);
			for (const dt of [0, CHAT_QUORUM_WAIT_MS, 10 * CHAT_QUORUM_WAIT_MS]) {
				await expect(
					confirmFeeRelevantTransactions(pinnedDb, lone, 208, b, t0 + dt)
				).rejects.toBeInstanceOf(BlockNotConfirmedError);
			}
		});
		it('content two operators once proved forged is never applied on one word later (review 2, finding 7)', async () => {
			const real = block([chatTrx('morphit_order_cancel_v1', 'x', '{}')], ['o1']);
			const forged = block(
				[
					chatTrx('morphit_order_cancel_v1', 'x', '{}'),
					chatTrx('morphit_chat_v1', 'bob', '{"f":1}')
				],
				['o1', 'f1']
			);
			const t0 = 5_000_000_000_000;
			await expect(
				confirmFeeRelevantTransactions(noPinDb, chain(real), 209, forged, t0)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
			// Later only one operator answers, serving the same forged content.
			const lone = chain(null, 3, [], 1);
			for (const dt of [1, CHAT_QUORUM_WAIT_MS + 1, 10 * CHAT_QUORUM_WAIT_MS]) {
				await expect(
					confirmFeeRelevantTransactions(noPinDb, lone, 209, forged, t0 + dt)
				).rejects.toBeInstanceOf(BlockNotConfirmedError);
			}
		});
		it('a block with no Morphit chat op asks nobody', async () => {
			const calls: string[] = [];
			const b = block([chatTrx('morphit_profile_v1', 'bob', '{}')], ['p1']);
			expect(await confirmFeeRelevantTransactions(noPinDb, chain(null, 3, calls), 204, b)).toBe(
				'none'
			);
			expect(calls).toEqual([]);
		});
	});

	describe('an outage of all but one operator (v1.21.14 review A, F1)', () => {
		// Each chat block used to wait CHAT_QUORUM_WAIT_MS of its own, one after
		// another (the poller is serial): N chat blocks cost N × 10 minutes and every
		// order, trade and bid behind them waited too, so a node with one reachable
		// operator fell further behind every hour. The wait is now one budget per
		// outage: once a chat-only block has waited it, later chat-only blocks are
		// applied at once until two operators agree again.
		const chatTrx = (id: string, signer: string) => ({
			ref_block_num: 1,
			ref_block_prefix: 2,
			expiration: '2026-10-21T12:00:00',
			signatures: ['sig'],
			operations: [
				['custom_json', { required_auths: [], required_posting_auths: [signer], id, json: '{}' }]
			]
		});
		const chatBlock = (n: number) => block([chatTrx('morphit_chat_v1', `u${n}`)], [`c${n}`]);
		beforeEach(() => _resetBlockConfirmForTest());

		it('after one full wait, the next chat-only blocks are applied without waiting again', async () => {
			const t0 = 6_000_000_000_000;
			const lone = chain(null, 3, [], 1);
			await expect(
				confirmFeeRelevantTransactions(noPinDb, lone, 300, chatBlock(300), t0)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
			expect(
				await confirmFeeRelevantTransactions(
					noPinDb,
					lone,
					300,
					chatBlock(300),
					t0 + CHAT_QUORUM_WAIT_MS
				)
			).toBe('single_source');
			// The very next chat blocks, a moment later: no second ten-minute wait.
			for (let n = 301; n < 306; n++)
				expect(
					await confirmFeeRelevantTransactions(
						noPinDb,
						lone,
						n,
						chatBlock(n),
						t0 + CHAT_QUORUM_WAIT_MS + (n - 300) * 3000
					)
				).toBe('single_source');
		});

		it('while the outage lasts, the pool is asked again at most once a minute, not for every block', async () => {
			const t0 = 7_000_000_000_000;
			const calls: string[] = [];
			const lone = chain(null, 3, calls, 1);
			await expect(
				confirmFeeRelevantTransactions(noPinDb, lone, 400, chatBlock(400), t0)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
			await confirmFeeRelevantTransactions(
				noPinDb,
				lone,
				400,
				chatBlock(400),
				t0 + CHAT_QUORUM_WAIT_MS
			);
			const before = calls.length;
			for (let n = 401; n < 421; n++)
				await confirmFeeRelevantTransactions(
					noPinDb,
					lone,
					n,
					chatBlock(n),
					t0 + CHAT_QUORUM_WAIT_MS + (n - 400) * 1000
				);
			expect(calls.length - before).toBeLessThanOrEqual(1);
		});

		it('a re-probe that fails again does not start a new wait', async () => {
			const t0 = 7_500_000_000_000;
			const lone = chain(null, 3, [], 1);
			await expect(
				confirmFeeRelevantTransactions(noPinDb, lone, 450, chatBlock(450), t0)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
			await confirmFeeRelevantTransactions(
				noPinDb,
				lone,
				450,
				chatBlock(450),
				t0 + CHAT_QUORUM_WAIT_MS
			);
			// Blocks over five minutes, one every 3 s: several re-probes fail.
			for (let n = 451; n < 551; n++)
				expect(
					await confirmFeeRelevantTransactions(
						noPinDb,
						lone,
						n,
						chatBlock(n),
						t0 + CHAT_QUORUM_WAIT_MS + (n - 450) * 3000
					)
				).toBe('single_source');
		});

		it('once two operators agree again, the next chat block waits again', async () => {
			const t0 = 8_000_000_000_000;
			const lone = chain(null, 3, [], 1);
			await expect(
				confirmFeeRelevantTransactions(noPinDb, lone, 500, chatBlock(500), t0)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
			await confirmFeeRelevantTransactions(
				noPinDb,
				lone,
				500,
				chatBlock(500),
				t0 + CHAT_QUORUM_WAIT_MS
			);
			// The pool is back: a quorum read succeeds.
			const b = chatBlock(501);
			expect(
				await confirmFeeRelevantTransactions(
					noPinDb,
					chain(b),
					501,
					b,
					t0 + CHAT_QUORUM_WAIT_MS + 120_000
				)
			).toBe('confirmed');
			// A new outage starts its own wait.
			await expect(
				confirmFeeRelevantTransactions(
					noPinDb,
					lone,
					502,
					chatBlock(502),
					t0 + CHAT_QUORUM_WAIT_MS + 180_000
				)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
		});

		it('blocks with release or numbered BTC ops still never go single-source during an outage', async () => {
			const t0 = 9_000_000_000_000;
			const lone = chain(null, 3, [], 1);
			await expect(
				confirmFeeRelevantTransactions(noPinDb, lone, 600, chatBlock(600), t0)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
			await confirmFeeRelevantTransactions(
				noPinDb,
				lone,
				600,
				chatBlock(600),
				t0 + CHAT_QUORUM_WAIT_MS
			);
			const withOrder = block([orderTrx('alice', 'a1')], ['aa']);
			await expect(
				confirmFeeRelevantTransactions(
					pinnedDb,
					lone,
					601,
					withOrder,
					t0 + CHAT_QUORUM_WAIT_MS + 1000
				)
			).rejects.toBeInstanceOf(BlockNotConfirmedError);
		});
	});

	it('keys on content regardless of JSON key order', () => {
		const a = block([{ b: 1, a: [1, { d: 2, c: 3 }] }], ['x']);
		const b = block([{ a: [1, { c: 3, d: 2 }], b: 1 }], ['x']);
		expect(positionsKey(a, [0])).toBe(positionsKey(b, [0]));
	});
});
