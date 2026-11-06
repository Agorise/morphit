/**
 * v1.23.2 — "Sent as expected" in seconds, not about a minute.
 *
 * A Blurt node finds a transaction with get_transaction only once its block is
 * irreversible (~45 s behind the head), so the check sat on "Verifying…" for
 * about a minute. The sender's broadcast reports the block the transfer went
 * into; the funds-sent receipt now carries it, and the check reads that block
 * (there within one block, ~3 s). A wrong or forged block number can bypass
 * nothing: the transaction must be IN that block, else the old lookup runs.
 *
 * Review: a block that is not irreversible yet could still be dropped by a
 * fork, so such an answer is `provisional` — shown at once, never cached, and
 * not enough to release the other coin in a two-leg trade (blurtLegCheck).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const relay = vi.hoisted(() => ({
	calls: [] as { method: string; params: unknown[] }[],
	blocks: new Map<number, unknown>(),
	txs: new Map<string, unknown>(),
	lib: 0
}));
vi.mock('$net/chainRelay', () => {
	class ChainRelayError extends Error {}
	return {
		ChainRelayError,
		chainRelay: async (method: string, params: unknown[]) => {
			relay.calls.push({ method, params });
			if (method === 'get_block') return relay.blocks.get(params[0] as number) ?? null;
			if (method === 'get_transaction') {
				// As the instance's relay answers: a node asserts "Unknown Transaction"
				// for one not final yet, which the relay turns into a 502.
				const tx = relay.txs.get(params[0] as string);
				if (tx === undefined) throw new ChainRelayError('could not reach the Blurt network');
				return tx;
			}
			if (method === 'get_dynamic_global_properties') {
				return { head_block_number: relay.lib + 15, last_irreversible_block_num: relay.lib };
			}
			throw new Error('unexpected ' + method);
		}
	};
});

import { _clearVerifyCache, verifyBlurtTransfer } from './blurtVerify';

const TXID = '165f16823c7b68f02d389a195ee10c73b37d25cf';
const OTHER = 'a'.repeat(40);
const transfer = (amount = '2743.000 BLURT') => ({
	ref_block_num: 1,
	ref_block_prefix: 1,
	expiration: '2026-11-06T17:00:00',
	operations: [['transfer', { from: 'kencode', to: 'josiemoto', amount, memo: '' }]],
	extensions: [],
	signatures: []
});
const block = (ids: string[], txs: unknown[]) => ({
	previous: '0',
	timestamp: '2026-11-06T16:58:24',
	witness: 'w',
	transactions: txs,
	transaction_ids: ids
});
const expectArgs = (blockNum?: number, amount = 2743) => ({
	recipient: 'josiemoto',
	sender: 'kencode',
	amountBlurt: amount,
	memo: '',
	...(blockNum !== undefined ? { block: blockNum } : {})
});

beforeEach(() => {
	_clearVerifyCache();
	relay.calls.length = 0;
	relay.blocks.clear();
	relay.txs.clear();
	relay.lib = 70_000_000; // every block below is final unless a test says otherwise
});

describe('verifyBlurtTransfer: the block the broadcast reported (v1.23.2)', () => {
	it('verified straight from that block, before get_transaction would know the transaction', async () => {
		relay.blocks.set(65088600, block([OTHER, TXID], [transfer('1.000 BLURT'), transfer()]));
		const r = await verifyBlurtTransfer(TXID, expectArgs(65088600));
		expect(r).toEqual({ kind: 'verified' });
		expect(relay.calls.map((c) => c.method)).toEqual([
			'get_block',
			'get_dynamic_global_properties'
		]);
	});

	it('review: a block not irreversible yet → verified but provisional, not cached; final once it is', async () => {
		relay.lib = 65088590;
		relay.blocks.set(65088600, block([TXID], [transfer()]));
		expect(await verifyBlurtTransfer(TXID, expectArgs(65088600))).toEqual({
			kind: 'verified',
			provisional: true
		});
		relay.calls.length = 0;
		relay.lib = 65088600;
		expect(await verifyBlurtTransfer(TXID, expectArgs(65088600))).toEqual({ kind: 'verified' });
		expect(relay.calls.length).toBe(2); // asked again: the provisional answer was not cached
		relay.calls.length = 0;
		expect(await verifyBlurtTransfer(TXID, expectArgs(65088600))).toEqual({ kind: 'verified' });
		expect(relay.calls.length).toBe(0); // the final one is
	});

	it('review: the irreversible block cannot be read → provisional, never final', async () => {
		relay.lib = Number.NaN;
		relay.blocks.set(65088600, block([TXID], [transfer()]));
		expect(await verifyBlurtTransfer(TXID, expectArgs(65088600))).toEqual({
			kind: 'verified',
			provisional: true
		});
	});

	it('the transfer in that block must still match: a wrong amount is a mismatch', async () => {
		relay.blocks.set(65088601, block([TXID], [transfer('1.000 BLURT')]));
		const r = await verifyBlurtTransfer(TXID, expectArgs(65088601));
		expect(r).toMatchObject({ kind: 'mismatch', field: 'amount' });
	});

	it('a block that does not hold the transaction proves nothing: the old lookup decides', async () => {
		relay.blocks.set(65088602, block([OTHER], [transfer()]));
		const r = await verifyBlurtTransfer(TXID, expectArgs(65088602));
		expect(r.kind).toBe('rpc_error'); // not final (or not there): try again
		expect(relay.calls.map((c) => c.method)).toEqual(['get_block', 'get_transaction']);
	});

	it('a block the node has not got yet: the old lookup is asked (review), and nothing transient is cached', async () => {
		const first = await verifyBlurtTransfer(TXID, expectArgs(65088603));
		expect(first.kind).toBe('rpc_error');
		expect(relay.calls.map((c) => c.method)).toEqual(['get_block', 'get_transaction']);
		relay.blocks.set(65088603, block([TXID], [transfer()]));
		const second = await verifyBlurtTransfer(TXID, expectArgs(65088603));
		expect(second.kind).toBe('verified');
	});

	it('review: a receipt naming a block that never comes still verifies once the transaction is final', async () => {
		relay.txs.set(TXID, { ...transfer(), transaction_id: TXID, block_num: 65088605 });
		const r = await verifyBlurtTransfer(TXID, expectArgs(99_999_999));
		expect(r).toEqual({ kind: 'verified' });
	});

	it('without a block number (older receipts) it works as before', async () => {
		relay.txs.set(TXID, { ...transfer(), transaction_id: TXID, block_num: 65088604 });
		const r = await verifyBlurtTransfer(TXID, expectArgs());
		expect(r.kind).toBe('verified');
		expect(relay.calls.map((c) => c.method)).toEqual(['get_transaction']);
	});
});
