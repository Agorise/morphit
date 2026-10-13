/**
 * The snapshot's chain check says how far along it is.
 *
 * 2026-10-12, a fresh VPS: after "snapshot check: 43 sampled ops …" nothing
 * moved for minutes — no count, no spinner — while it read each block from the
 * chain, and the operator could not tell working from stuck.
 */
import { describe, expect, it } from 'vitest';
import { checkSnapshotAgainstChain } from '../../src/indexer/snapshotChainCheck';

const op = (block: number) => ({
	block_num: String(block),
	trx_in_block: 0,
	op_in_trx: 0,
	signer: 'alice',
	op_id: 'morphit_feedback_v1',
	permlink: null
});

const db = {
	query: async (sql: string, params: unknown[] = []) => {
		if (/ORDER BY block_num DESC/.test(sql)) return { rows: [op(300), op(200)] };
		if (/MIN\(block_num\)/.test(sql)) return { rows: [{ lo: '100', hi: '300' }] };
		if (/FROM orders/.test(sql)) return { rows: [{ n: '0' }] };
		if (/COUNT\(\*\)::text AS n FROM accounts/.test(sql)) return { rows: [{ n: '2' }] };
		if (/FROM accounts/.test(sql))
			return {
				rows: [{ name: `acct${params[0]}`, created_block_num: '400', created_trx_id: 'x' }]
			};
		if (/FROM ops/.test(sql)) return { rows: [op(100)] };
		return { rows: [] };
	}
};

describe('progress of the snapshot chain check', () => {
	it('reports each read before it is made, as "k of n", ops then accounts', async () => {
		const fetched: number[] = [];
		const seen: string[] = [];
		await checkSnapshotAgainstChain({
			db: db as never,
			chain: {
				getBlock: async (n: number) => {
					fetched.push(n);
					// The progress for this read was reported before it started.
					expect(seen.length).toBe(fetched.length);
					return null;
				}
			},
			startBlock: 1,
			samples: 8,
			randomInt: (max: number) => max - 1,
			say: () => {},
			progress: (s: string) => void seen.push(s)
		});
		expect(seen.length).toBe(fetched.length);
		const blocks = seen.filter((s) => s.startsWith('block'));
		const accounts = seen.filter((s) => s.startsWith('account'));
		expect(blocks.length + accounts.length).toBe(seen.length);
		blocks.forEach((s, i) => expect(s).toBe(`block ${i + 1} of ${blocks.length}`));
		expect(accounts).toEqual(['account 1 of 2', 'account 2 of 2']);
	});
});
