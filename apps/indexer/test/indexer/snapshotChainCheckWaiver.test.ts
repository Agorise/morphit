/**
 * After a fast-sync restore, the Tier-2 chain check samples
 * waiver_trade_transfers (v70) too: a row is evidence a review can be admitted
 * on, so a snapshot could plant one. Each sampled row must be, in a block read
 * with agreement, the transfer at its recorded position, in the recorded
 * transaction, from its sender to its recipient, of its amount (at least the
 * minimum), at its block time — and its recipient must hold a waiver order
 * posted by then.
 */
import { describe, expect, it } from 'vitest';

import { checkSnapshotAgainstChain, type WaiverRow } from '../../src/indexer/snapshotChainCheck';
import {
	agreedReader,
	block,
	FakeNode,
	transfer,
	trx,
	type FakeBlock
} from '../testutils/fakeChain';

const T = new Date('2026-11-02T09:12:30Z');
const chainBlock: FakeBlock = block(70181390, T, [
	trx([transfer('someone', 'else', '1.000 BLURT')]),
	trx([transfer('dave', 'erin', '2750.125 BLURT'), transfer('dave', 'x', '2.000 BLURT')])
]);
const honestRow: WaiverRow = {
	recipient: 'erin',
	sender: 'dave',
	block_num: '70181390',
	trx_in_block: 1,
	op_in_trx: 0,
	block_time: T,
	trx_id: chainBlock.transaction_ids[1]!,
	amount_blurt: '2750.125'
};

function dbWith(row: WaiverRow, ownerHoldsWaiver = true, atV70 = true, seen: string[] = []) {
	return {
		query: async (sql: string) => {
			seen.push(sql);
			if (/to_regclass/.test(sql)) return { rows: [{ t: 'waiver_trade_transfers' }] };
			if (/FROM schema_migrations WHERE version = 70/.test(sql))
				return { rows: atV70 ? [{}] : [], rowCount: atV70 ? 1 : 0 };
			if (/COUNT\(\*\)::text AS n FROM waiver_trade_transfers/.test(sql))
				return { rows: [{ n: '1' }] };
			if (/FROM waiver_trade_transfers ORDER BY/.test(sql)) return { rows: [row] };
			if (/fee_method = 'waived_first_buy'/.test(sql))
				return { rows: ownerHoldsWaiver ? [{}] : [], rowCount: ownerHoldsWaiver ? 1 : 0 };
			if (/MIN\(block_num\)/.test(sql)) return { rows: [{ lo: null, hi: null }] };
			if (/COUNT\(\*\)::text AS n/.test(sql)) return { rows: [{ n: '0' }] };
			return { rows: [] };
		}
	};
}

const node = new FakeNode(new Map([[70181390, chainBlock]]));
const honest = (m: string, p: readonly unknown[]): unknown => node.call(m, p);

async function check(
	row: WaiverRow,
	opts: {
		operators?: Array<(m: string, p: readonly unknown[]) => unknown>;
		quorum?: number;
		owner?: boolean;
		atV70?: boolean;
		seen?: string[];
		said?: string[];
	} = {}
) {
	const reader = agreedReader(opts.operators ?? [honest, honest], opts.quorum ?? 2);
	const r = await checkSnapshotAgainstChain({
		db: dbWith(row, opts.owner ?? true, opts.atV70 ?? true, opts.seen) as never,
		chain: {
			getBlock: async () => {
				throw new Error('a waiver row must be read with agreement, not from one node');
			},
			condenserAgreed: reader.condenserAgreed,
			trustedQuorumSize: reader.trustedQuorumSize
		},
		startBlock: 1,
		samples: 8,
		randomInt: () => 0,
		say: (line: string) => void opts.said?.push(line)
	});
	return { ...r, calls: reader.calls };
}

describe('Tier-2 snapshot check: waiver_trade_transfers rows', () => {
	it('a row that is the transfer on chain is verified, from an agreed block', async () => {
		const r = await check(honestRow);
		expect(r).toMatchObject({ verdict: 'verified', sampled: 1, verified: 1, failures: [] });
		expect(r.calls).toEqual([{ method: 'get_block', params: [70181390], minAgree: 2 }]);
	});

	const FORGED: Array<[string, Partial<WaiverRow>]> = [
		['another amount', { amount_blurt: '9999.000' }],
		['another sender', { sender: 'mallory' }],
		['another recipient', { recipient: 'mallory' }],
		['another place in the block', { trx_in_block: 0 }],
		['another transaction', { trx_id: chainBlock.transaction_ids[0]! }],
		['another time', { block_time: new Date(T.getTime() + 3000) }]
	];
	for (const [what, change] of FORGED) {
		it(`a row with ${what} quarantines the snapshot`, async () => {
			const r = await check({ ...honestRow, ...change });
			expect(r.verdict).toBe('quarantine');
			expect(r.failures).toHaveLength(1);
		});
	}

	it('a row below the minimum quarantines it, even when the transfer is real', async () => {
		const small = block(70181391, T, [trx([transfer('dave', 'erin', '49.500 BLURT')])]);
		const n = new FakeNode(new Map([[70181391, small]]));
		const op = (m: string, p: readonly unknown[]): unknown => n.call(m, p);
		const r = await check(
			{
				...honestRow,
				block_num: '70181391',
				trx_in_block: 0,
				trx_id: small.transaction_ids[0]!,
				amount_blurt: '49.500'
			},
			{ operators: [op, op] }
		);
		expect(r.verdict).toBe('quarantine');
	});

	it('a snapshot older than schema v70: the rows left from this node are not its to be judged by', async () => {
		// A pre-v70 dump drops and recreates only its own tables, so this
		// node's own rows survive — here one whose owner's order the snapshot
		// does not hold. The v70 migration empties the table on the next start.
		const seen: string[] = [];
		const said: string[] = [];
		const r = await check(honestRow, { owner: false, atV70: false, seen, said });
		expect(r.failures).toEqual([]);
		expect(r.sampled).toBe(0);
		expect(r.calls).toEqual([]);
		expect(seen.some((q) => /FROM waiver_trade_transfers/.test(q))).toBe(false);
		expect(said.join('\n')).toMatch(/predates schema v70/);
	});

	it('a row stamped before the consensus activation time quarantines it, even when the transfer is real', async () => {
		const early = new Date('2026-10-31T23:59:57Z');
		const old = block(70181390, early, [trx([transfer('dave', 'erin', '2750.125 BLURT')])]);
		const n = new FakeNode(new Map([[70181390, old]]));
		const op = (m: string, p: readonly unknown[]): unknown => n.call(m, p);
		const r = await check(
			{
				...honestRow,
				trx_in_block: 0,
				trx_id: old.transaction_ids[0]!,
				block_time: early
			},
			{ operators: [op, op] }
		);
		expect(r.verdict).toBe('quarantine');
		expect(r.failures[0]).toMatch(/activation/);
	});

	it('a row whose recipient holds no waiver order by then quarantines it', async () => {
		const r = await check(honestRow, { owner: false });
		expect(r.verdict).toBe('quarantine');
	});

	it('one node serving the block at another time, beside an honest one: unread, not judged on its word', async () => {
		const liar = (m: string, p: readonly unknown[]): unknown => ({
			...(node.call(m, p) as FakeBlock),
			timestamp: '2026-11-02T18:07:00'
		});
		const r = await check(honestRow, { operators: [liar, honest] });
		expect(r).toMatchObject({ verdict: 'inconclusive', unreachable: 1, failures: [] });
		// A second honest node decides it.
		expect((await check(honestRow, { operators: [liar, honest, honest] })).verdict).toBe(
			'verified'
		);
	});

	it('one node serving an altered transaction (same id claimed), beside an honest one: unread', async () => {
		const liar = (m: string, p: readonly unknown[]): unknown => {
			const b = JSON.parse(JSON.stringify(node.call(m, p))) as FakeBlock;
			(b.transactions[1]!.operations[0]![1] as { amount: string }).amount = '1.000 BLURT';
			return b;
		};
		const r = await check(honestRow, { operators: [liar, honest] });
		expect(r).toMatchObject({ verdict: 'inconclusive', unreachable: 1, failures: [] });
	});
});
