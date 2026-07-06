/**
 * Integration — /v1/orderbook/featured must exclude an offer whose OWN
 * expires_at has already passed, even while its featured BID is still active.
 *
 * The indexer keeps a stored order status of 'live' until a cancel op or a
 * periodic sweep and enforces expiry at QUERY TIME (exactly as /v1/orderbook
 * does). Before cp427 the featured query filtered `o.status = 'live'` but NOT
 * `o.expires_at > NOW()`, so a featured slot whose underlying offer had
 * expired kept showing until the paid bid window closed (up to 168h later).
 * This pins the `o.expires_at > NOW()` guard added to featuredOrderbook.ts.
 *
 * Gated on INTEGRATION_ENABLED (needs a real Postgres; CI provides one — the
 * sandbox cannot, so this suite is skipped there and runs in the CI
 * integration job).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { featuredRoute } from '../../src/api/featuredOrderbook';

const OPERATOR = 'op-featured-test';

/** Insert a verified, stored-live order with an explicit expires_at.
 *  `expiresAtSql` is a raw SQL expression (e.g. "NOW() + INTERVAL '2 day'")
 *  so each case can place the deadline in the past or the future. */
async function seedOrder(
	fx: IntegrationFixture,
	account: string,
	permlink: string,
	expiresAtSql: string
): Promise<void> {
	await fx.db.query(
		`INSERT INTO orders (
			account, permlink, side, asset, fiat_currency,
			price_model, payment_methods, status, fee_status, fee_method,
			created_at, updated_at, expires_at
		) VALUES ($1, $2, 'sell', 'BTC', 'USD',
		          '{}'::jsonb, ARRAY['cash'], 'live', 'verified', 'blurt',
		          NOW(), NOW(), ${expiresAtSql})`,
		[account, permlink]
	);
}

/** Insert a featured bid that is ACTIVE right now: effective in the past,
 *  bid-expiry in the future, not cancelled. bidder MUST equal the order's
 *  author (the featureBid handler enforces this; the featured query JOINs on
 *  o.account = w.bidder AND o.permlink = w.order_permlink). */
async function seedActiveBid(
	fx: IntegrationFixture,
	bidder: string,
	orderPermlink: string,
	perHour: number,
	trx: string
): Promise<void> {
	await fx.db.query(
		`INSERT INTO featured_slot_bids (
			bidder, order_permlink, hours_requested, blurt_paid, blurt_per_hour,
			effective_at, expires_at, trx_id, block_num, block_time_at, cancelled
		) VALUES ($1, $2, 24, $3, $4,
		          NOW() - INTERVAL '1 hour', NOW() + INTERVAL '23 hour', $5, 1, NOW() - INTERVAL '1 hour', FALSE)`,
		[bidder, orderPermlink, perHour, perHour, trx]
	);
}

describe.skipIf(!INTEGRATION_ENABLED)('featured orderbook — expiry exclusion — integration', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx.teardown();
	});
	beforeEach(async () => {
		await fx.db.query('DELETE FROM featured_slot_bids');
		await fx.db.query('DELETE FROM orders');
	});

	async function fetchFeaturedPermlinks(): Promise<string[]> {
		const app = featuredRoute(fx.db, OPERATOR);
		const res = await app.request('/');
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			featured: Array<{ order: { account: string; permlink: string } }>;
		};
		return body.featured.map((f) => f.order.permlink);
	}

	it('a live offer (future expires_at) with an active bid IS featured', async () => {
		await seedOrder(fx, 'alice', 'live-1', "NOW() + INTERVAL '2 day'");
		await seedActiveBid(fx, 'alice', 'live-1', 50, 'trx-live-1');
		expect(await fetchFeaturedPermlinks()).toContain('live-1');
	});

	it('THE FIX: an EXPIRED offer (past expires_at) with a still-active bid is NOT featured', async () => {
		await seedOrder(fx, 'bob', 'exp-1', "NOW() - INTERVAL '1 minute'");
		await seedActiveBid(fx, 'bob', 'exp-1', 80, 'trx-exp-1');
		expect(await fetchFeaturedPermlinks()).not.toContain('exp-1');
	});

	it('mixed: the live offer survives; the higher-paying but EXPIRED offer is filtered out', async () => {
		await seedOrder(fx, 'alice', 'live-2', "NOW() + INTERVAL '1 day'");
		await seedActiveBid(fx, 'alice', 'live-2', 40, 'trx-live-2');
		// Higher per-hour bid, but the underlying offer has expired.
		await seedOrder(fx, 'bob', 'exp-2', "NOW() - INTERVAL '5 minute'");
		await seedActiveBid(fx, 'bob', 'exp-2', 90, 'trx-exp-2');
		const permlinks = await fetchFeaturedPermlinks();
		expect(permlinks).toContain('live-2');
		expect(permlinks).not.toContain('exp-2');
	});

	it('boundary: an offer expiring one minute from now is still featured', async () => {
		await seedOrder(fx, 'carol', 'edge-1', "NOW() + INTERVAL '1 minute'");
		await seedActiveBid(fx, 'carol', 'edge-1', 60, 'trx-edge-1');
		expect(await fetchFeaturedPermlinks()).toContain('edge-1');
	});
});
