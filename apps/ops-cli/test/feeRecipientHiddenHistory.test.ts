/**
 * The newest register op in an operator's chain history, read on a
 * hidden-only node (v1.21.18).
 *
 * WHAT WENT WRONG. latestChainRegistration asked this node's indexer for 1000
 * history entries at a time, with the 20 s every hidden-only read had. The
 * indexer relays it over Tor/I2P, where 10 entries took 33.7 s and 100 never
 * came within 240 s (morphitlat, v1.21.16): the read always ran out, so the
 * fees-account checks of `status`, `register` and the upgrade heal could never
 * use the chain on such a node.
 *
 * NOW. Over Tor/I2P: pages of 10 entries, 90 s each, two pages. A register op
 * older than that is "could not check" (the read throws, as before), never
 * "not registered".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import {
	slowIndexer,
	underSimulatedTime,
	useSimulatedTimers,
	type PagedHistory
} from './helpers/slowTorIndexer.ts';

const { latestChainRegistration, HISTORY_PAGE_SIZE } = await import(
	'../src/lib/operatorFeeRecipient.ts'
);

const ACCOUNT = 'alice';

/** A register op by `account`, as a history entry. */
const registerEntry = (seq: number, json: object): [number, unknown] => [
	seq,
	{
		trx_id: `${seq}`.padStart(40, 'a'),
		block: 64_000_000 + seq,
		op: [
			'custom_json',
			{
				id: 'morphit_operator_register_v1',
				json: JSON.stringify(json),
				required_auths: [],
				required_posting_auths: [ACCOUNT]
			}
		]
	}
];

/** The operator's history 0..top: an entry at every odd position (the chain's
 *  fee for each op takes the other), large ops (about 3.9 KB, as @morphit's
 *  are), a register op at `registerAt`. */
function operatorHistory(top: number, registerAt: number | null): PagedHistory {
	const entries: Array<[number, unknown]> = [];
	for (let seq = 1; seq <= top; seq += 2) {
		entries.push(
			seq === registerAt
				? registerEntry(seq, { tag: 'a-node', fee_recipient: 'alice-fees' })
				: [
						seq,
						{
							trx_id: randomBytes(20).toString('hex'),
							block: 64_000_000 + seq,
							op: [
								'custom_json',
								{
									id: 'morphit_chat_v1',
									json: JSON.stringify({ note: 'x'.repeat(3_600) }),
									required_auths: [],
									required_posting_auths: [ACCOUNT]
								}
							]
						}
					]
		);
	}
	return { top, entries, blocks: {} };
}

describe('the register op over Tor/I2P', () => {
	it('reads small pages, and gives each the time a Tor/I2P answer takes', async () => {
		const asked: Array<{ params: readonly unknown[]; timeout: number | undefined }> = [];
		const h = operatorHistory(99, 85);
		const read = (async (
			_m: string,
			params: readonly unknown[],
			deps: { hiddenReadTimeoutMs?: number }
		) => {
			asked.push({ params, timeout: deps.hiddenReadTimeoutMs });
			const [, from, limit] = params as [string, number, number];
			const hi = from === -1 ? h.top : from;
			return h.entries.filter(([s]) => s >= hi - limit && s <= hi);
		}) as never;
		const r = await latestChainRegistration(ACCOUNT, { hiddenOnly: () => true }, read);
		expect(r).toMatchObject({ found: true, feeRecipient: 'alice-fees' });
		expect(asked.map((a) => a.params)).toEqual([
			[ACCOUNT, -1, 10],
			[ACCOUNT, 88, 10]
		]);
		for (const a of asked) expect(a.timeout).toBeGreaterThanOrEqual(90_000);
	});

	it('a register op older than the pages read is "could not check", not "not registered"', async () => {
		const h = operatorHistory(999, 101);
		const read = (async (_m: string, params: readonly unknown[]) => {
			const [, from, limit] = params as [string, number, number];
			const hi = from === -1 ? h.top : from;
			return h.entries.filter(([s]) => s >= hi - limit && s <= hi);
		}) as never;
		await expect(
			latestChainRegistration(ACCOUNT, { hiddenOnly: () => true }, read)
		).rejects.toThrow();
	});

	it('a history that ends before the pages do, without one, is "not registered"', async () => {
		const h = operatorHistory(9, null);
		const read = (async (_m: string, params: readonly unknown[]) => {
			const [, from, limit] = params as [string, number, number];
			const hi = from === -1 ? h.top : from;
			return h.entries.filter(([s]) => s >= Math.max(0, hi - limit) && s <= hi);
		}) as never;
		expect(await latestChainRegistration(ACCOUNT, { hiddenOnly: () => true }, read)).toEqual({
			found: false
		});
	});

	it('a clearnet node keeps its 1000-entry pages', async () => {
		const asked: Array<readonly unknown[]> = [];
		const read = (async (_m: string, params: readonly unknown[]) => {
			asked.push(params);
			return [];
		}) as never;
		await latestChainRegistration(ACCOUNT, { hiddenOnly: () => false }, read);
		expect(asked).toEqual([[ACCOUNT, -1, HISTORY_PAGE_SIZE]]);
	});
});

describe('the register op through a slow Tor/I2P indexer', () => {
	beforeEach(() => useSimulatedTimers());
	afterEach(() => vi.useRealTimers());

	it('is found on a hidden-only node', async () => {
		const idx = await slowIndexer({ history: operatorHistory(1_201, 1_185) });
		try {
			const r = await underSimulatedTime(
				latestChainRegistration(ACCOUNT, { hiddenOnly: () => true, indexerBases: [idx.base] })
			);
			expect(r).toMatchObject({ found: true, feeRecipient: 'alice-fees' });
		} finally {
			await idx.close();
		}
	});
});
