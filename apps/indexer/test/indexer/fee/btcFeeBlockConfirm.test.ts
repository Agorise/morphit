/**
 * v1.20.0 (MK-H2, V3-6) — a block holding an op that moves the BTC fee-address
 * numbering (or the treasury pin) is applied only if two independent RPC
 * operators serve the same transactions at those positions.
 */
import { describe, expect, it } from 'vitest';
import type pg from 'pg';

import {
	BlockNotConfirmedError,
	confirmFeeRelevantTransactions,
	MAX_UNCONFIRMED_ATTEMPTS,
	positionsKey
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

	it('keys on content regardless of JSON key order', () => {
		const a = block([{ b: 1, a: [1, { d: 2, c: 3 }] }], ['x']);
		const b = block([{ a: [1, { c: 3, d: 2 }], b: 1 }], ['x']);
		expect(positionsKey(a, [0])).toBe(positionsKey(b, [0]));
	});
});
