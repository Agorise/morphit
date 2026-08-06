/**
 * Integration test — trackVerifiedBlurtFee concurrency + correctness.
 *
 * The Phase 4c cumulative-tracking path combines UPSERT, a
 * subsequent INSERT, and a SUM aggregate. Unit tests (with a
 * mocked query client) prove the SQL string is right. This
 * test runs against real Postgres to catch:
 *
 *   - Lost writes under concurrent UPSERT on the same account
 *   - Double-rewards if the UNIQUE constraint doesn't catch
 *     a re-insertion
 *   - Wrong cumulative BP in queued delegations when multiple
 *     milestones fire in rapid succession
 *
 * Gated with INTEGRATION_ENABLED so `npm test` still passes on
 * developer machines without a postgres running.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { trackVerifiedBlurtFee } from '../../src/indexer/loyalty';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

const BLOCK_TIME = new Date('2026-04-19T12:00:00Z');
const BLOCK_NUM = 12_345;

/** Run trackVerifiedBlurtFee inside a fresh transaction for
 *  the given account + amount. Mirrors how the real order
 *  handler calls it (wrapped in the block-level txn). */
async function paySingleFee(
	fx: IntegrationFixture,
	account: string,
	amountBlurt: number
): Promise<void> {
	await fx.db.withTx(async (client) => {
		await trackVerifiedBlurtFee(client, account, amountBlurt, BLOCK_NUM, BLOCK_TIME, 'morphit', 'morphit');
	});
}

describe.skipIf(!INTEGRATION_ENABLED)('trackVerifiedBlurtFee — integration', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});

	afterAll(async () => {
		if (fx) await fx.teardown();
	});

	beforeEach(async () => {
		if (fx) await truncateAll(fx);
	});

	// ─── Scenario 1: sequential baseline ────────────────────

	it('sequential 100x10 BLURT reaches milestones 100 and 500', async () => {
		// 100 orders of 10 BLURT = 1000 cumulative. Crosses the
		// 100 and 500 milestones (but not 2000).
		for (let i = 0; i < 100; i++) {
			await paySingleFee(fx, 'alice', 10);
		}

		const loy = await fx.db.query<{ cumulative_blurt_paid: string }>(
			`SELECT cumulative_blurt_paid::text FROM account_loyalty
				  WHERE account = $1`,
			['alice']
		);
		expect(loy.rows[0]?.cumulative_blurt_paid).toBe('1000');

		const ms = await fx.db.query<{ milestone_blurt: string; bp_rewarded: string }>(
			`SELECT milestone_blurt::text, bp_rewarded::text
				   FROM account_loyalty_milestones
				  WHERE account = $1
				    AND milestone_blurt > 0  -- exclude welcome sentinel
				  ORDER BY milestone_blurt ASC`,
			['alice']
		);
		expect(ms.rows).toHaveLength(2);
		expect(ms.rows[0]!.milestone_blurt).toBe('100');
		expect(ms.rows[0]!.bp_rewarded).toBe('10');
		expect(ms.rows[1]!.milestone_blurt).toBe('500');
		expect(ms.rows[1]!.bp_rewarded).toBe('50');

		const queue = await fx.db.query<{ amount_bp: string; reason: string }>(
			`SELECT amount_bp::text, reason FROM relay_pending_transfers
				  WHERE recipient = $1 AND kind = 'delegation'
				    AND reason LIKE 'loyalty_milestone_%'  -- exclude welcome
				  ORDER BY created_at ASC, id ASC`,
			['alice']
		);
		// Two queue rows: one at each milestone with the
		// CUMULATIVE target.  Welcome bonus (1 BP) is included
		// in the cumulative because account_loyalty_milestones
		// table has it (sentinel row).
		expect(queue.rows).toHaveLength(2);
		// 100 milestone: cumulative = welcome_1 + 100_bp_10 = 11
		expect(queue.rows[0]!.amount_bp).toBe('11');
		expect(queue.rows[0]!.reason).toBe('loyalty_milestone_100');
		// 500 milestone: cumulative = 1 + 10 + 50 = 61
		expect(queue.rows[1]!.amount_bp).toBe('61');
		expect(queue.rows[1]!.reason).toBe('loyalty_milestone_500');
	});

	// ─── Scenario 2: concurrent same-account ────────────────

	it('100 concurrent 10-BLURT fees on same account: no lost writes, no duplicate milestones', async () => {
		// Fire all 100 calls via Promise.all — each runs in its
		// own transaction via fx.db.withTx. Postgres row-lock on
		// the UPSERT serializes them; we verify that every
		// contribution lands and exactly one row per milestone
		// lands in account_loyalty_milestones.
		const ops: Promise<void>[] = [];
		for (let i = 0; i < 100; i++) {
			ops.push(paySingleFee(fx, 'bob', 10));
		}
		await Promise.all(ops);

		const loy = await fx.db.query<{ cumulative_blurt_paid: string }>(
			`SELECT cumulative_blurt_paid::text FROM account_loyalty
				  WHERE account = $1`,
			['bob']
		);
		// Critical: every fee must contribute; no lost writes.
		expect(loy.rows[0]?.cumulative_blurt_paid).toBe('1000');

		// Critical: exactly ONE row per milestone, even though
		// the fee that crossed each threshold could theoretically
		// have been "detected" by multiple concurrent workers.
		const ms = await fx.db.query<{ milestone_blurt: string }>(
			`SELECT milestone_blurt::text FROM account_loyalty_milestones
				  WHERE account = $1
				    AND milestone_blurt > 0  -- exclude welcome sentinel
				  ORDER BY milestone_blurt`,
			['bob']
		);
		expect(ms.rows.map((r) => r.milestone_blurt)).toEqual(['100', '500']);

		// Critical: queue rows match; BP totals correct.
		const queue = await fx.db.query<{ amount_bp: string; reason: string }>(
			`SELECT amount_bp::text, reason FROM relay_pending_transfers
				  WHERE recipient = $1 AND kind = 'delegation'
				    AND reason LIKE 'loyalty_milestone_%'  -- exclude welcome
				  ORDER BY reason`,
			['bob']
		);
		expect(queue.rows).toHaveLength(2);
		const reasons = queue.rows.map((r) => r.reason).sort();
		expect(reasons).toEqual(['loyalty_milestone_100', 'loyalty_milestone_500']);
		// 500 milestone: cumulative = welcome_1 + 100_10 + 500_50 = 61.
		const at500 = queue.rows.find((r) => r.reason === 'loyalty_milestone_500')!;
		expect(at500.amount_bp).toBe('61');
	});

	// ─── Scenario 3: isolation across accounts ─────────────

	it('concurrent fees to different accounts: no cross-contamination', async () => {
		// 10 accounts, each getting 20 × 10 BLURT = 200 cumulative.
		// All 200 fee calls dispatched in parallel.
		const accounts = Array.from({ length: 10 }, (_, i) => `user_${i}`);
		const ops: Promise<void>[] = [];
		for (const acct of accounts) {
			for (let i = 0; i < 20; i++) {
				ops.push(paySingleFee(fx, acct, 10));
			}
		}
		await Promise.all(ops);

		for (const acct of accounts) {
			const loy = await fx.db.query<{ cumulative_blurt_paid: string }>(
				`SELECT cumulative_blurt_paid::text FROM account_loyalty
					  WHERE account = $1`,
				[acct]
			);
			expect(loy.rows[0]?.cumulative_blurt_paid).toBe('200');
			// Only the 100-BLURT milestone should have fired for each
			// (excluding the welcome sentinel, which is also there).
			const ms = await fx.db.query<{ milestone_blurt: string }>(
				`SELECT milestone_blurt::text FROM account_loyalty_milestones
					  WHERE account = $1
					    AND milestone_blurt > 0  -- exclude welcome sentinel
					  ORDER BY milestone_blurt`,
				[acct]
			);
			expect(ms.rows).toHaveLength(1);
			expect(ms.rows[0]!.milestone_blurt).toBe('100');
		}
	});

	// ─── Scenario 4: replay safety ─────────────────────────

	it('invoking with an amount that re-crosses a milestone does not double-reward', async () => {
		// Cross 100 cleanly: one 150-BLURT payment.
		await paySingleFee(fx, 'carol', 150);

		// Now a "replay" — conceptually the same event again.
		// The UPSERT adds another 150 (cumulative → 300), which
		// does NOT re-cross milestone 100 because previous_total
		// is already >= 100. Milestone table stays at 1 row.
		await paySingleFee(fx, 'carol', 150);

		const ms = await fx.db.query<{ milestone_blurt: string }>(
			`SELECT milestone_blurt::text FROM account_loyalty_milestones
				  WHERE account = $1
				    AND milestone_blurt > 0  -- exclude welcome sentinel
				`,
			['carol']
		);
		expect(ms.rows).toHaveLength(1);
		expect(ms.rows[0]!.milestone_blurt).toBe('100');

		const loy = await fx.db.query<{ cumulative_blurt_paid: string }>(
			`SELECT cumulative_blurt_paid::text FROM account_loyalty
				  WHERE account = $1`,
			['carol']
		);
		expect(loy.rows[0]?.cumulative_blurt_paid).toBe('300');
	});

	// ─── Scenario 5: multi-milestone single call ───────────

	it('single huge payment crossing two milestones queues both with correct cumulative BP', async () => {
		// 600 BLURT in one shot crosses 100 AND 500 in a single
		// trackVerifiedBlurtFee call. The SUM(bp_rewarded) in
		// the second iteration must see the 100-milestone row
		// that was just inserted.
		await paySingleFee(fx, 'dave', 600);

		const ms = await fx.db.query<{ milestone_blurt: string }>(
			`SELECT milestone_blurt::text FROM account_loyalty_milestones
				  WHERE account = $1
				    AND milestone_blurt > 0  -- exclude welcome sentinel
				  ORDER BY milestone_blurt`,
			['dave']
		);
		expect(ms.rows.map((r) => r.milestone_blurt)).toEqual(['100', '500']);

		const queue = await fx.db.query<{ amount_bp: string; reason: string }>(
			`SELECT amount_bp::text, reason FROM relay_pending_transfers
				  WHERE recipient = $1 AND kind = 'delegation'
				    AND reason LIKE 'loyalty_milestone_%'  -- exclude welcome
				  ORDER BY id`,
			['dave']
		);
		expect(queue.rows).toHaveLength(2);
		// First insert (100 milestone): cumulative BP = welcome_1 + 100_10 = 11.
		expect(queue.rows[0]!.reason).toBe('loyalty_milestone_100');
		expect(queue.rows[0]!.amount_bp).toBe('11');
		// Second insert (500 milestone): cumulative BP = 1 + 10 + 50 = 61.
		expect(queue.rows[1]!.reason).toBe('loyalty_milestone_500');
		expect(queue.rows[1]!.amount_bp).toBe('61');
	});
});
