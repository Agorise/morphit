/**
 * Unit test — GET /v1/featured carries the order-card trust signals (Ken).
 *
 * Featured cards render through the SAME shared `OrderCard` as the orderbook,
 * but the featured endpoint's row carried no reputation/identity columns — so
 * the 🌱 new-trader sprout, the ⭐ reputation score, the trade count and the
 * truncated posting key silently vanished on exactly the cards a stranger is
 * most likely to click. A card that shows a score in the orderbook and nothing
 * in the featured strip teaches users the signal is unreliable.
 *
 * The db is stubbed: what's under test is the SELECT/JOIN shape and the
 * row → OrderRecord mapping, not Postgres.
 */

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { featuredRoute, type FeaturedRow } from '$api/featuredOrderbook';
import { feedbackAggregateJoin, accountsJoin } from '$api/reputationJoin';
import type { Database } from '$db/pool';

/** One winning featured slot, as the joined query would return it.
 *
 *  cp473 — typed as `FeaturedRow`, not an untyped literal. Previously a column
 *  added to the real query could be missing here with nothing failing (the
 *  mapper produced `undefined`, JSON.stringify dropped the key, and the test
 *  asserted only the fields it already knew about). `Partial<FeaturedRow>`
 *  overrides also mean a typo'd key like `is_new_trder` is now a compile error
 *  rather than a silently-ignored no-op. */
function row(overrides: Partial<FeaturedRow> = {}): FeaturedRow {
	return {
		account: 'alice',
		permlink: 'order-1',
		side: 'buy',
		asset: 'BLURT',
		asset_network: null,
		fiat_currency: 'MXN',
		amount_min: '500',
		amount_max: '3000',
		price_model: { kind: 'spread', percent: 0 },
		location_region: null,
		payment_methods: ['cash_in_person'],
		accepted_assets: null,
		specific_barter_title: null,
		terms: 'terms',
		status: 'live',
		// v1.8.16 — inline poster identity columns (profileJoin), now emitted in
		// the wire mapping. The LEFT JOIN always returns them (null when no
		// profile row), so they are required on FeaturedRow; a mock without them
		// no longer typechecks.
		display_name: 'Alice',
		profile_json_metadata: { profile: { name: 'Alice' } },
		engagement_24h: 2,
		created_at: new Date('2026-07-07T00:00:00Z'),
		updated_at: new Date('2026-07-08T00:00:00Z'),
		expires_at_order: new Date('2026-08-08T00:00:00Z'),
		fee_status: 'verified',
		fee_method: 'blurt',
		// reputation columns
		feedback_count: 12,
		trade_count: 7,
		weighted_rating: '4.50',
		last_feedback_at: new Date('2026-07-01T00:00:00Z'),
		is_new_trader: false,
		first_trade_complete_at: new Date('2026-01-15T00:00:00Z'),
		posting_pubkey: 'BLT5vw111111111111111111111111111111111117Bjw',
		// bid columns
		hours_requested: 24,
		blurt_paid: '100.000',
		blurt_per_hour: '4.167',
		effective_at: new Date('2026-07-08T00:00:00Z'),
		expires_at_bid: new Date('2026-07-09T00:00:00Z'),
		...overrides
	};
}

function mount(rows: ReturnType<typeof row>[]) {
	// Typed params so `query.mock.calls[0][0|1]` is a real tuple under tsc
	// (vitest is happy either way; `npx tsc --noEmit` is not).
	const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
		rows,
		rowCount: rows.length
	}));
	const db = { query } as unknown as Database;
	const app = new Hono();
	app.route('/v1/featured', featuredRoute(db, 'morphit'));
	return { app, query };
}

describe('GET /v1/featured — order-card trust signals', () => {
	it('returns the reputation score, trade count, sprout flag and posting key', async () => {
		const { app } = mount([row()]);
		const res = await app.request('/v1/featured');
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			featured: { order: Record<string, unknown> }[];
			max_slots: number;
		};
		const order = body.featured[0]!.order;

		expect(order.feedback_count).toBe(12);
		// cp473 — the trade count this test's TITLE always claimed to cover but
		// never asserted. It is a DIFFERENT number from feedback_count on
		// purpose: the card renders "7 trades · ★4.50 (12)".
		expect(order.trade_count).toBe(7);
		expect(order.weighted_rating).toBe(4.5);
		// Composite score, computed by the SAME function the orderbook uses.
		expect(typeof order.reputation_score).toBe('number');
		expect(order.reputation_score).toBeGreaterThan(0);
		expect(order.is_new_trader).toBe(false);
		expect(order.first_trade_at).toBe('2026-01-15T00:00:00.000Z');
		expect(order.posting_pubkey).toBe('BLT5vw111111111111111111111111111111111117Bjw');
		// v1.8.16 (Ken) — the featured payload must carry inline poster identity so
		// the homepage card is correct on FIRST paint (no @account+identicon swap).
		// These were SELECTed since v1.8.13 but silently dropped from the wire
		// mapping until now; assert both so a regression turns this test red.
		expect(order.display_name).toBe('Alice');
		expect(order.profile_json_metadata).toEqual({ profile: { name: 'Alice' } });
	});

	it('flags a new trader (the 🌱 sprout) and reports a null score with no feedback', async () => {
		const { app } = mount([
			row({
				feedback_count: 0,
				trade_count: 0,
				weighted_rating: null,
				last_feedback_at: null,
				is_new_trader: true,
				first_trade_complete_at: null
			})
		]);
		const res = await app.request('/v1/featured');
		const body = (await res.json()) as { featured: { order: Record<string, unknown> }[] };
		const order = body.featured[0]!.order;

		expect(order.is_new_trader).toBe(true);
		expect(order.feedback_count).toBe(0);
		expect(order.trade_count).toBe(0);
		expect(order.weighted_rating).toBeNull();
		expect(order.reputation_score).toBeNull();
		expect(order.first_trade_at).toBeNull();
	});

	it('cp473 — a veteran with real trades but NO reviews is not sprouted, and shows the trade count', async () => {
		// The case the pre-cp473 featured strip got exactly backwards: it derived
		// the sprout from the FEEDBACK count, so 5 completed trades with nobody
		// bothering to leave stars read as "new trader" — and the trade count was
		// absent from the payload entirely, so the card said nothing at all.
		const { app } = mount([
			row({
				feedback_count: 0,
				trade_count: 5,
				weighted_rating: null,
				last_feedback_at: null,
				is_new_trader: false,
				first_trade_complete_at: new Date('2026-02-01T00:00:00Z')
			})
		]);
		const res = await app.request('/v1/featured');
		const body = (await res.json()) as { featured: { order: Record<string, unknown> }[] };
		const order = body.featured[0]!.order;

		expect(order.trade_count).toBe(5);
		expect(order.is_new_trader).toBe(false);
		// Ratings stay a separate number: no stars means no average, and the
		// card must NOT invent one from the trades.
		expect(order.feedback_count).toBe(0);
		expect(order.weighted_rating).toBeNull();
		expect(order.reputation_score).toBeNull();
	});

	it('tolerates an account row with no posting key yet', async () => {
		const { app } = mount([row({ posting_pubkey: null })]);
		const res = await app.request('/v1/featured');
		const body = (await res.json()) as { featured: { order: Record<string, unknown> }[] };
		expect(body.featured[0]!.order.posting_pubkey).toBeNull();
	});

	it('uses the SHARED sock-puppet-filtered aggregate, not a private copy', async () => {
		const { app, query } = mount([row()]);
		await app.request('/v1/featured');
		const sql = query.mock.calls[0]![0] as unknown as string;

		// Every exclusion the orderbook applies must apply here too, or the
		// featured strip would publish sock-puppet-inflated reputation.
		for (const needle of [
			'suspicious_reciprocity',
			'related_accounts',
			'one_way_pile_on',
			'review_concentration',
			'order_permlink IS NOT NULL'
		]) {
			expect(sql).toContain(needle);
		}
		// And it must be literally the shared fragment — scoped to the <=3 winning
		// bidders, because /v1/featured is polled by every homepage visitor and
		// aggregating the whole feedback table to return three rows is real cost
		// for no benefit. Scoping only ADDS a restriction; it can never relax an
		// exclusion, which the loop above independently verifies.
		expect(sql).toContain(feedbackAggregateJoin('o', 'SELECT bidder FROM winning_bids'));
		expect(sql).toContain(accountsJoin('o', 'a'));
		expect(sql).toContain('AND fb.subject IN (SELECT bidder FROM winning_bids)');
		expect(sql).toContain('AND cm.recipient IN (SELECT bidder FROM winning_bids)');
	});

	it('carries asset_network so a featured USDT order can show its network chip', async () => {
		const { app } = mount([row({ asset: 'USDT', asset_network: 'trc20' })]);
		const res = await app.request('/v1/featured');
		const body = (await res.json()) as { featured: { order: Record<string, unknown> }[] };
		// A multi-network asset without its network is a lose-your-funds ambiguity.
		expect(body.featured[0]!.order.asset_network).toBe('trc20');
	});

	it('returns a COMPLETE OrderRecord (created_at + engagement_24h, not just reputation)', async () => {
		const { app } = mount([row()]);
		const res = await app.request('/v1/featured');
		const body = (await res.json()) as { featured: { order: Record<string, unknown> }[] };
		const order = body.featured[0]!.order;
		expect(order.created_at).toBe('2026-07-07T00:00:00.000Z');
		expect(order.engagement_24h).toBe(2);
	});

	it('still reports the bid and caps at MAX_SLOTS = 3', async () => {
		const { app, query } = mount([row()]);
		const res = await app.request('/v1/featured');
		const body = (await res.json()) as {
			featured: { bid: Record<string, unknown> }[];
			max_slots: number;
		};
		expect(body.max_slots).toBe(3);
		expect(body.featured[0]!.bid.hours_requested).toBe(24);
		expect(query.mock.calls[0]![1]).toEqual([3, 'morphit']);
	});
});
