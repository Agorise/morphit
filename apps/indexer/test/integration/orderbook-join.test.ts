/**
 * Integration test — /v1/orderbook SQL behavior.
 *
 * Exercises the feedback-aware orderbook query shipped with the
 * "reputation filters + 4-trade sprout" work. Instead of
 * spinning up the full HTTP server, we run SQL that mirrors
 * what src/api/orderbook.ts builds and verify row shape + order
 * against a real Postgres.
 *
 * The query-mirror approach is fragile — if src/api/orderbook.ts
 * changes, the constants below have to change too. A drift here
 * means the integration coverage silently becomes stale. Keep
 * them paired.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AssetTicker } from '@morphit/asset-registry';

import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

/** Mirror of the base SELECT + FROM built in src/api/orderbook.ts.
 *  Callers append WHERE clauses + ORDER BY + LIMIT as needed.
 *
 *  Per Finding G2.1, the feedback aggregate filters out rows with
 *  NULL order_permlink — only trade-bound feedback drives the
 *  reputation signal.  The R2 sock-puppet detection and this
 *  G2.1 filter compose: WHERE order_permlink IS NOT NULL AND
 *  not in suspicious_reciprocity AND not in related_accounts.
 *  The R2 NOT EXISTS clauses are omitted from this mirror because
 *  the test harness doesn't seed those tables; in production
 *  they're present too. */
const ORDERBOOK_BASE = `
	SELECT o.account, o.permlink, o.fee_method,
	       COALESCE(f.c, 0)::int AS feedback_count,
	       CASE WHEN f.r IS NOT NULL THEN f.r::text ELSE NULL END AS weighted_rating,
	       (COALESCE(f.c, 0) < 4) AS is_new_trader
	FROM orders o
	LEFT JOIN (
	  SELECT subject, COUNT(*)::int AS c, AVG(rating)::numeric AS r
	    FROM feedback
	   WHERE order_permlink IS NOT NULL
	   GROUP BY subject
	) f ON f.subject = o.account
	WHERE o.status = 'live' AND o.fee_status = 'verified'
`;

/** Insert a feedback row for a given subject. The UNIQUE
 *  (reviewer, subject, order_permlink) constraint means we need
 *  distinct reviewers (or distinct permlinks) per feedback — we
 *  vary the reviewer name since that's the simplest choice. */
async function seedFeedback(
	fx: IntegrationFixture,
	subject: string,
	ratings: readonly number[]
): Promise<void> {
	for (let i = 0; i < ratings.length; i++) {
		await fx.db.query(
			`INSERT INTO feedback
			 (reviewer, subject, rating, comment, order_permlink, created_at, source_trx_id)
			 VALUES ($1, $2, $3, '', $4, NOW(), $5)`,
			[`reviewer-${i}`, subject, ratings[i], `order-${i}`, `trx-${subject}-${i}`]
		);
	}
}

async function seedOrder(
	fx: IntegrationFixture,
	account: string,
	permlink: string,
	opts: {
		side?: 'buy' | 'sell';
		asset?: AssetTicker;
		fiat?: string;
		fee_method?: string;
	} = {}
): Promise<void> {
	await fx.db.query(
		`INSERT INTO orders (
			account, permlink, side, asset, fiat_currency,
			price_model, payment_methods, status, fee_status, fee_method,
			created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5,
		          '{}'::jsonb, ARRAY['cash'], 'live', 'verified', $6,
		          NOW(), NOW())`,
		[
			account,
			permlink,
			opts.side ?? 'buy',
			opts.asset ?? 'BTC',
			opts.fiat ?? 'USD',
			opts.fee_method ?? 'blurt'
		]
	);
}

describe.skipIf(!INTEGRATION_ENABLED)('orderbook SQL — reputation + sprout — integration', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});

	afterAll(async () => {
		if (fx) await fx.teardown();
	});

	beforeEach(async () => {
		await truncateAll(fx);
	});

	// ── Sprout-window semantics ─────────────────────────────

	it('zero feedback → is_new_trader=true, count=0, rating=null', async () => {
		await seedOrder(fx, 'freshface', 'p1');

		const res = await fx.db.query<{
			feedback_count: number;
			weighted_rating: string | null;
			is_new_trader: boolean;
		}>(`${ORDERBOOK_BASE} ORDER BY o.updated_at DESC`);

		expect(res.rows).toHaveLength(1);
		expect(res.rows[0]!.feedback_count).toBe(0);
		expect(res.rows[0]!.weighted_rating).toBeNull();
		expect(res.rows[0]!.is_new_trader).toBe(true);
	});

	it('1-3 feedback rows → still in sprout window', async () => {
		await seedOrder(fx, 'greenling', 'p1');
		await seedFeedback(fx, 'greenling', [5, 4, 5]);

		const res = await fx.db.query<{
			feedback_count: number;
			is_new_trader: boolean;
		}>(`${ORDERBOOK_BASE}`);

		expect(res.rows[0]!.feedback_count).toBe(3);
		expect(res.rows[0]!.is_new_trader).toBe(true);
	});

	it('exactly 4 feedback rows → sprout closes (is_new_trader=false)', async () => {
		await seedOrder(fx, 'justover', 'p1');
		await seedFeedback(fx, 'justover', [5, 5, 5, 5]);

		const res = await fx.db.query<{
			feedback_count: number;
			is_new_trader: boolean;
		}>(`${ORDERBOOK_BASE}`);

		expect(res.rows[0]!.feedback_count).toBe(4);
		expect(res.rows[0]!.is_new_trader).toBe(false);
	});

	// ── Weighted rating projection ──────────────────────────

	it('weighted_rating reflects average of received feedback', async () => {
		await seedOrder(fx, 'avguser', 'p1');
		// Ratings 4, 5, 5, 5 → avg 4.75
		await seedFeedback(fx, 'avguser', [4, 5, 5, 5]);

		const res = await fx.db.query<{
			weighted_rating: string | null;
		}>(`${ORDERBOOK_BASE}`);

		expect(res.rows[0]!.weighted_rating).not.toBeNull();
		// The NUMERIC returns as a text-formatted number; parse +
		// compare with tolerance for the arbitrary precision.
		const r = Number(res.rows[0]!.weighted_rating!);
		expect(r).toBeCloseTo(4.75, 2);
	});

	// ── min_trades filter ───────────────────────────────────

	it('min_trades=5 filter excludes accounts with <5 feedback', async () => {
		await seedOrder(fx, 'lowfb', 'p1');
		await seedFeedback(fx, 'lowfb', [5, 5]);
		await seedOrder(fx, 'highfb', 'p2');
		await seedFeedback(fx, 'highfb', [4, 4, 5, 5, 5, 5]);

		// Apply the same COALESCE predicate the endpoint builds.
		const res = await fx.db.query<{
			account: string;
		}>(`${ORDERBOOK_BASE} AND COALESCE(f.c, 0) >= 5`);

		const accounts = res.rows.map((r) => r.account).sort();
		expect(accounts).toEqual(['highfb']);
	});

	// ── Sort modes ──────────────────────────────────────────

	it('sort=trades orders by feedback count DESC', async () => {
		await seedOrder(fx, 'few', 'p1');
		await seedFeedback(fx, 'few', [5]);
		await seedOrder(fx, 'medium', 'p2');
		await seedFeedback(fx, 'medium', [5, 5, 5]);
		await seedOrder(fx, 'lots', 'p3');
		await seedFeedback(fx, 'lots', [4, 4, 4, 4, 4, 5]);

		const res = await fx.db.query<{
			account: string;
			feedback_count: number;
		}>(
			`${ORDERBOOK_BASE}
				 ORDER BY COALESCE(f.c, 0) DESC, o.updated_at DESC, o.account ASC, o.permlink ASC`
		);

		expect(res.rows.map((r) => r.account)).toEqual(['lots', 'medium', 'few']);
	});

	it('sort=rating orders by avg rating DESC NULLS LAST', async () => {
		await seedOrder(fx, 'mid', 'p1');
		await seedFeedback(fx, 'mid', [3, 4]); // avg 3.5
		await seedOrder(fx, 'top', 'p2');
		await seedFeedback(fx, 'top', [5, 5, 5]); // avg 5.0
		await seedOrder(fx, 'nofb', 'p3'); // avg null — last

		const res = await fx.db.query<{
			account: string;
			weighted_rating: string | null;
		}>(
			`${ORDERBOOK_BASE}
				 ORDER BY f.r DESC NULLS LAST, COALESCE(f.c, 0) DESC, o.updated_at DESC, o.account ASC, o.permlink ASC`
		);

		expect(res.rows.map((r) => r.account)).toEqual(['top', 'mid', 'nofb']);
	});

	// ── Back-compat regression guard ────────────────────────

	it('fee_method column default still applied for minimal-spec order inserts', async () => {
		// An order inserted without specifying fee_method should
		// carry the column default 'blurt' — back-compat with
		// ADR-0009 orders. This locks the migration invariant and
		// guards against a future ALTER TABLE accidentally
		// dropping the default.
		await fx.db.query(
			`INSERT INTO orders (
					account, permlink, side, asset, fiat_currency,
					price_model, payment_methods, status, fee_status,
					created_at, updated_at
				) VALUES ('legacy', 'old-p', 'buy', 'BTC', 'USD',
				          '{}'::jsonb, ARRAY['cash'], 'live', 'verified',
				          NOW(), NOW())`
		);

		const res = await fx.db.query<{ fee_method: string }>(
			`SELECT fee_method FROM orders WHERE account = 'legacy'`
		);
		expect(res.rows[0]!.fee_method).toBe('blurt');
	});

	// ── Mixed-population regression ─────────────────────────

	it('mixed accounts in one query: each row gets its own feedback stats', async () => {
		await seedOrder(fx, 'new-user', 'p1');
		await seedOrder(fx, 'veteran', 'p2');
		await seedFeedback(fx, 'veteran', [5, 5, 5, 5, 5, 5]);

		const res = await fx.db.query<{
			account: string;
			feedback_count: number;
			is_new_trader: boolean;
		}>(`${ORDERBOOK_BASE} ORDER BY o.account ASC`);

		expect(res.rows).toHaveLength(2);

		const byAccount = Object.fromEntries(res.rows.map((r) => [r.account, r]));
		expect(byAccount['new-user']!.feedback_count).toBe(0);
		expect(byAccount['new-user']!.is_new_trader).toBe(true);
		expect(byAccount['veteran']!.feedback_count).toBe(6);
		expect(byAccount['veteran']!.is_new_trader).toBe(false);
	});

	// ─── G2.1: only trade-bound feedback drives reputation ──
	//
	// Pre-fix, the orderbook aggregate counted every feedback
	// row regardless of whether it cited an order_permlink.  A
	// real human signing vague positive feedback for a
	// stranger they never traded with (no permlink) would
	// pump that stranger's feedback_count and weighted_rating.
	// Post-§F.12 G1.1, untethered feedback no longer triggers
	// the welcome bonus; G2.1 extends the policy: it also
	// doesn't drive the orderbook ranking signal.
	it('G2.1: feedback with NULL order_permlink is excluded from aggregate', async () => {
		await seedOrder(fx, 'alice', 'p1');
		// 3 trade-bound feedback rows.
		await seedFeedback(fx, 'alice', [5, 4, 5]);
		// 5 untethered (no order_permlink) feedback rows from
		// distinct reviewers — would inflate count to 8 if
		// not filtered.
		for (let i = 0; i < 5; i++) {
			await fx.db.query(
				`INSERT INTO feedback
					 (reviewer, subject, rating, comment, order_permlink, created_at, source_trx_id)
					 VALUES ($1, 'alice', 5, '', NULL, NOW(), $2)`,
				[`untethered-reviewer-${i}`, `trx-untethered-${i}`]
			);
		}

		const res = await fx.db.query<{
			feedback_count: number;
			weighted_rating: string | null;
			is_new_trader: boolean;
		}>(`${ORDERBOOK_BASE} AND o.account = 'alice'`);

		expect(res.rows).toHaveLength(1);
		// Only the 3 trade-bound rows count.
		expect(res.rows[0]!.feedback_count).toBe(3);
		// Average of 5, 4, 5 = 4.6...; the untethered 5s would
		// have skewed it higher if not excluded.
		expect(Number(res.rows[0]!.weighted_rating!)).toBeCloseTo(14 / 3, 3);
		// 3 trade-bound feedback rows: still in the sprout
		// window (< 4).  The untethered rows would have closed
		// the sprout (count=8) if not filtered.
		expect(res.rows[0]!.is_new_trader).toBe(true);
	});

	it('G2.1: account with ONLY untethered feedback shows as new trader', async () => {
		await seedOrder(fx, 'bob', 'p1');
		// 10 untethered feedback rows. Pre-fix this would
		// have made bob look established (count=10, sprout
		// closed). Post-fix, count=0 and sprout still open.
		for (let i = 0; i < 10; i++) {
			await fx.db.query(
				`INSERT INTO feedback
					 (reviewer, subject, rating, comment, order_permlink, created_at, source_trx_id)
					 VALUES ($1, 'bob', 5, '', NULL, NOW(), $2)`,
				[`fake-friend-${i}`, `trx-fake-${i}`]
			);
		}

		const res = await fx.db.query<{
			feedback_count: number;
			weighted_rating: string | null;
			is_new_trader: boolean;
		}>(`${ORDERBOOK_BASE} AND o.account = 'bob'`);

		expect(res.rows).toHaveLength(1);
		expect(res.rows[0]!.feedback_count).toBe(0);
		expect(res.rows[0]!.weighted_rating).toBeNull();
		expect(res.rows[0]!.is_new_trader).toBe(true);
	});
});
