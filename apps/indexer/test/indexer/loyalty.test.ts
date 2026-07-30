/**
 * Tests for loyalty milestone tracking.
 *
 * Uses the shared mockClient to assert the exact sequence of
 * SQL the module emits, since the per-milestone queue entries
 * must carry cumulative (not incremental) BP amounts.
 */

import { describe, expect, it } from 'vitest';
import type pg from 'pg';

import { trackVerifiedBlurtFee, LOYALTY_MILESTONES } from '$indexer/loyalty';
import { makeMockClient } from '../testutils/mockClient';

/** Shortcut — arguments to trackVerifiedBlurtFee with sensible defaults.
 *  Part 111: `orderOperatorTag` and `instanceOperatorTag` default to
 *  the same value ('morphit') so existing tests that don't override
 *  exercise the "served-by-us, queue payouts" path.  Tests of the
 *  federation-scope gate should override one of them. */
function args(
	overrides: {
		account?: string;
		amount?: number;
		blockNum?: number;
		blockTime?: Date;
		orderOperatorTag?: string | null;
		instanceOperatorTag?: string | undefined;
	} = {}
) {
	return {
		account: overrides.account ?? 'alice',
		amount: overrides.amount ?? 75,
		blockNum: overrides.blockNum ?? 12_345,
		blockTime: overrides.blockTime ?? new Date('2026-04-19T12:00:00Z'),
		orderOperatorTag: overrides.orderOperatorTag === undefined ? 'morphit' : overrides.orderOperatorTag,
		instanceOperatorTag: overrides.instanceOperatorTag === undefined ? 'morphit' : overrides.instanceOperatorTag
	};
}

describe('trackVerifiedBlurtFee — guard conditions', () => {
	it('no-op for zero amount', async () => {
		const mock = makeMockClient();
		const a = args({ amount: 0 });
		await trackVerifiedBlurtFee(mock.client, a.account, a.amount, a.blockNum, a.blockTime, a.orderOperatorTag, a.instanceOperatorTag);
		expect(mock.queries).toHaveLength(0);
	});

	it('no-op for negative amount', async () => {
		const mock = makeMockClient();
		const a = args({ amount: -10 });
		await trackVerifiedBlurtFee(mock.client, a.account, a.amount, a.blockNum, a.blockTime, a.orderOperatorTag, a.instanceOperatorTag);
		expect(mock.queries).toHaveLength(0);
	});
});

describe('trackVerifiedBlurtFee — below first milestone', () => {
	it('75 BLURT fee, no prior total → UPSERT only, no milestones', async () => {
		const mock = makeMockClient([
			{
				match: 'INSERT INTO account_loyalty',
				rows: [{ previous_total: '0', new_total: '75' }],
				rowCount: 1
			},
			// G6 fix: welcome INSERT now wrapped in SAVEPOINT.
			{ match: /^SAVEPOINT first_fee_welcome_sp$/ },
			// Welcome-fee already fired earlier (by ADR-0011 §F.11
			// refactor): unique violation.
			{
				match: 'INSERT INTO account_loyalty_milestones',
				throwError: Object.assign(new Error('duplicate'), { code: '23505' })
			},
			{ match: /^ROLLBACK TO SAVEPOINT first_fee_welcome_sp$/ },
			{ match: /^RELEASE SAVEPOINT first_fee_welcome_sp$/ }
		]);
		const a = args({ amount: 75 });
		await trackVerifiedBlurtFee(mock.client, a.account, a.amount, a.blockNum, a.blockTime, a.orderOperatorTag, a.instanceOperatorTag);
		// UPSERT + SAVEPOINT + welcome INSERT (throws) + ROLLBACK + RELEASE = 5.
		expect(mock.queries).toHaveLength(5);
	});

	it('subsequent 20 BLURT fee (prior=75, new=95) → UPSERT only, still no cross', async () => {
		const mock = makeMockClient([
			{
				match: 'INSERT INTO account_loyalty',
				rows: [{ previous_total: '75', new_total: '95' }],
				rowCount: 1
			},
			{ match: /^SAVEPOINT first_fee_welcome_sp$/ },
			{
				match: 'INSERT INTO account_loyalty_milestones',
				throwError: Object.assign(new Error('duplicate'), { code: '23505' })
			},
			{ match: /^ROLLBACK TO SAVEPOINT first_fee_welcome_sp$/ },
			{ match: /^RELEASE SAVEPOINT first_fee_welcome_sp$/ }
		]);
		const a = args({ amount: 20 });
		await trackVerifiedBlurtFee(mock.client, a.account, a.amount, a.blockNum, a.blockTime, a.orderOperatorTag, a.instanceOperatorTag);
		expect(mock.queries).toHaveLength(5);
	});
});

describe('trackVerifiedBlurtFee — first milestone cross', () => {
	it('prior=75, new=120 crosses 100 → milestone insert + cumulative + queue', async () => {
		const mock = makeMockClient([
			{
				match: 'INSERT INTO account_loyalty',
				rows: [{ previous_total: '75', new_total: '120' }],
				rowCount: 1
			},
			// G6: welcome INSERT now wrapped in SAVEPOINT.
			{ match: /^SAVEPOINT first_fee_welcome_sp$/ },
			{
				match: 'INSERT INTO account_loyalty_milestones',
				throwError: Object.assign(new Error('duplicate'), { code: '23505' })
			},
			{ match: /^ROLLBACK TO SAVEPOINT first_fee_welcome_sp$/ },
			{ match: /^RELEASE SAVEPOINT first_fee_welcome_sp$/ },
			// G6: milestone INSERT also wrapped in SAVEPOINT.
			{ match: /^SAVEPOINT loyalty_ms_100_sp$/ },
			// Real milestone insert at threshold=100.
			{ match: 'INSERT INTO account_loyalty_milestones', rowCount: 1 },
			{ match: /^RELEASE SAVEPOINT loyalty_ms_100_sp$/ },
			{
				match: 'SUM(bp_rewarded)',
				rows: [{ cumulative_bp: '10' }],
				rowCount: 1
			},
			{ match: 'INSERT INTO relay_pending_transfers', rowCount: 1 }
		]);
		const a = args({ amount: 45 });
		await trackVerifiedBlurtFee(mock.client, a.account, a.amount, a.blockNum, a.blockTime, a.orderOperatorTag, a.instanceOperatorTag);

		// UPSERT + welcome SP/INSERT/RBK/REL (4) +
		// ms-100 SP/INSERT/REL (3) + SUM + queue = 10.
		expect(mock.queries).toHaveLength(10);
		// Real milestone insert: position 6 (0=UPSERT, 1=SP, 2=welcome,
		// 3=RBK, 4=REL, 5=SP-ms, 6=ms-INSERT).  References threshold 100, bp 10.
		const msInsert = mock.queries[6]!;
		expect(msInsert.params[1]).toBe(100);
		expect(msInsert.params[2]).toBe(10);
		// Queue insert (last): cumulative BP returned (10).
		const queueInsert = mock.queries[9]!;
		expect(queueInsert.params[0]).toBe('alice');
		expect(queueInsert.params[1]).toBe(10);
		expect(queueInsert.params[2]).toBe('loyalty_milestone_100');
	});
});

describe('trackVerifiedBlurtFee — multi-milestone cross (edge)', () => {
	it('prior=90, new=550 crosses 100 AND 500 → two milestone triggers with cumulative increments', async () => {
		// This scenario: user goes from near-milestone-1 to past
		// milestone-2 in a single huge payment. Both milestones
		// must fire, and the SECOND queue entry must carry the
		// CUMULATIVE BP (10 + 50 = 60), not just 50.
		const mock = makeMockClient([
			{
				match: 'INSERT INTO account_loyalty',
				rows: [{ previous_total: '90', new_total: '550' }],
				rowCount: 1
			},
			// Welcome SAVEPOINT + collision + cleanup.
			{ match: /^SAVEPOINT first_fee_welcome_sp$/ },
			{
				match: 'INSERT INTO account_loyalty_milestones',
				throwError: Object.assign(new Error('duplicate'), { code: '23505' })
			},
			{ match: /^ROLLBACK TO SAVEPOINT first_fee_welcome_sp$/ },
			{ match: /^RELEASE SAVEPOINT first_fee_welcome_sp$/ },
			// Milestone 100 SAVEPOINT + INSERT + RELEASE.
			{ match: /^SAVEPOINT loyalty_ms_100_sp$/ },
			{ match: 'INSERT INTO account_loyalty_milestones', rowCount: 1 },
			{ match: /^RELEASE SAVEPOINT loyalty_ms_100_sp$/ },
			{
				match: 'SUM(bp_rewarded)',
				rows: [{ cumulative_bp: '10' }],
				rowCount: 1
			},
			{ match: 'INSERT INTO relay_pending_transfers', rowCount: 1 },
			// Milestone 500 SAVEPOINT + INSERT + RELEASE.
			{ match: /^SAVEPOINT loyalty_ms_500_sp$/ },
			{ match: 'INSERT INTO account_loyalty_milestones', rowCount: 1 },
			{ match: /^RELEASE SAVEPOINT loyalty_ms_500_sp$/ },
			{
				match: 'SUM(bp_rewarded)',
				rows: [{ cumulative_bp: '60' }],
				rowCount: 1
			},
			{ match: 'INSERT INTO relay_pending_transfers', rowCount: 1 }
		]);
		const a = args({ amount: 460 });
		await trackVerifiedBlurtFee(mock.client, a.account, a.amount, a.blockNum, a.blockTime, a.orderOperatorTag, a.instanceOperatorTag);

		// UPSERT (1) + welcome 4 (SP/INS/RBK/REL) +
		// ms-100 5 (SP/INS/REL/SUM/QUEUE) +
		// ms-500 5 (SP/INS/REL/SUM/QUEUE) = 15.
		expect(mock.queries).toHaveLength(15);
		// First queue insert (after milestone-100): cumulative = 10.
		expect(mock.queries[9]!.params[1]).toBe(10);
		expect(mock.queries[9]!.params[2]).toBe('loyalty_milestone_100');
		// Second queue insert (after milestone-500): cumulative = 60.
		expect(mock.queries[14]!.params[1]).toBe(60);
		expect(mock.queries[14]!.params[2]).toBe('loyalty_milestone_500');
	});
});

describe('trackVerifiedBlurtFee — idempotent replay', () => {
	it('milestone already recorded (unique violation) → no queue insert, no throw', async () => {
		const mock = makeMockClient([
			{
				match: 'INSERT INTO account_loyalty',
				rows: [{ previous_total: '75', new_total: '120' }],
				rowCount: 1
			},
			// Welcome-fee already fired.
			{ match: /^SAVEPOINT first_fee_welcome_sp$/ },
			{
				match: 'INSERT INTO account_loyalty_milestones',
				throwError: Object.assign(new Error('duplicate'), { code: '23505' })
			},
			{ match: /^ROLLBACK TO SAVEPOINT first_fee_welcome_sp$/ },
			{ match: /^RELEASE SAVEPOINT first_fee_welcome_sp$/ },
			// Milestone 100 SAVEPOINT + INSERT (collides) + ROLLBACK + RELEASE.
			{ match: /^SAVEPOINT loyalty_ms_100_sp$/ },
			{
				match: 'INSERT INTO account_loyalty_milestones',
				throwError: Object.assign(new Error('duplicate'), { code: '23505' })
			},
			{ match: /^ROLLBACK TO SAVEPOINT loyalty_ms_100_sp$/ },
			{ match: /^RELEASE SAVEPOINT loyalty_ms_100_sp$/ }
		]);
		const a = args({ amount: 45 });
		await expect(
			trackVerifiedBlurtFee(mock.client, a.account, a.amount, a.blockNum, a.blockTime, a.orderOperatorTag, a.instanceOperatorTag)
		).resolves.not.toThrow();
		// UPSERT + welcome 4 + ms-100 4 = 9 queries, no queue.
		expect(mock.queries).toHaveLength(9);
	});

	it('non-unique error from milestone insert → propagates', async () => {
		const mock = makeMockClient([
			{
				match: 'INSERT INTO account_loyalty',
				rows: [{ previous_total: '75', new_total: '120' }],
				rowCount: 1
			},
			{ match: /^SAVEPOINT first_fee_welcome_sp$/ },
			{
				match: 'INSERT INTO account_loyalty_milestones',
				throwError: Object.assign(new Error('DB down'), { code: '08006' })
			},
			// G6 cleanup runs before the re-throw.
			{ match: /^ROLLBACK TO SAVEPOINT first_fee_welcome_sp$/ },
			{ match: /^RELEASE SAVEPOINT first_fee_welcome_sp$/ }
		]);
		const a = args({ amount: 45 });
		await expect(
			trackVerifiedBlurtFee(mock.client, a.account, a.amount, a.blockNum, a.blockTime, a.orderOperatorTag, a.instanceOperatorTag)
		).rejects.toThrow('DB down');
	});
});

describe('LOYALTY_MILESTONES — shape sanity', () => {
	it('is strictly increasing by threshold', () => {
		for (let i = 1; i < LOYALTY_MILESTONES.length; i++) {
			expect(LOYALTY_MILESTONES[i]!.thresholdBlurt).toBeGreaterThan(
				LOYALTY_MILESTONES[i - 1]!.thresholdBlurt
			);
		}
	});

	it('matches ADR-0011 schedule', () => {
		expect(LOYALTY_MILESTONES).toEqual([
			{ thresholdBlurt: 100, bpReward: 10 },
			{ thresholdBlurt: 500, bpReward: 50 },
			{ thresholdBlurt: 2_000, bpReward: 200 },
			{ thresholdBlurt: 10_000, bpReward: 1_000 }
		]);
	});
});
