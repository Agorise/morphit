/**
 * A review counts once on a profile, and both review lists agree with the
 * score, on real Postgres.
 *
 * The profile summary joined the cited order on (permlink, either party), so a
 * reviewer who also owned an order under that permlink — an unpaid one costs
 * nothing — had his review counted twice: a 1-star attack weighed double on
 * the victim's headline rating, while the orderbook card counted it once. The
 * "reviews given" list also showed a concentration-flagged review, and a review
 * citing no order, as ordinary, though neither counts on the subject's profile.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { feedbackByAccountRoute } from '../../src/api/feedback';
import { FEEDBACK_EXCLUSIONS_SQL } from '../../src/api/reputationJoin';

type Summary = { count: number | string; weighted_rating: string | number | null };
type Item = { reviewer: string; subject: string; suppressed: boolean };

describe.skipIf(!INTEGRATION_ENABLED)('a review counts once, everywhere', () => {
	let fx: IntegrationFixture;
	let app: Hono;

	const order = (account: string, fee: string) =>
		fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                     status, created_at, updated_at, fee_status)
			 VALUES ($1, 'deal1', 'sell', 'BLURT', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
			         'live', NOW(), NOW(), $2)`,
			[account, fee]
		);
	const review = (reviewer: string, rating: number, permlink: string | null, trx: string) =>
		fx.db.query(
			`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
			 VALUES ($1, 'alice', $2, $3, NOW(), $4)`,
			[reviewer, rating, permlink, trx]
		);
	const profile = async (): Promise<{ summary: Summary; items: Item[] }> =>
		(await (await app.request('/alice/feedback')).json()) as { summary: Summary; items: Item[] };
	const given = async (who: string): Promise<Item[]> =>
		((await (await app.request(`/${who}/feedback-given`)).json()) as { items: Item[] }).items;
	const orderbookCount = async (): Promise<number> =>
		(
			await fx.db.query<{ c: number }>(
				`SELECT COUNT(*)::int AS c FROM feedback fb ${FEEDBACK_EXCLUSIONS_SQL} AND fb.subject = 'alice'`
			)
		).rows[0]!.c;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		app = feedbackByAccountRoute(fx.db);
		await order('alice', 'verified');
		await review('carol', 5, 'deal1', 't1');
		await review('mallory', 1, 'deal1', 't2');
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	it('a reviewer owning an unpaid order under the cited permlink does not count twice', async () => {
		const before = await profile();
		expect(Number(before.summary.count)).toBe(2);
		await order('mallory', 'missing');
		const after = await profile();
		expect(Number(after.summary.count), 'the profile counted the 1-star review twice').toBe(2);
		expect(after.summary.weighted_rating).toEqual(before.summary.weighted_rating);
		expect(Number(after.summary.count)).toBe(await orderbookCount());
	});

	it('the "reviews given" list marks what the subject\'s profile does not count', async () => {
		await fx.db.query(
			`INSERT INTO review_concentration (reviewer, dominant_subject, concentration_pct, review_count, window_days)
			 VALUES ('carol', 'alice', 100, 1, 30)`
		);
		await review('dave', 5, null, 't3');
		const received = await profile();
		const flag = (items: Item[], reviewer: string) =>
			items.find((i) => i.reviewer === reviewer)!.suppressed;
		expect(flag(received.items, 'carol')).toBe(true);
		expect(flag(received.items, 'dave')).toBe(true);
		expect(
			flag(await given('carol'), 'carol'),
			'concentration-flagged review shown as counted'
		).toBe(true);
		expect(flag(await given('dave'), 'dave'), 'review citing no order shown as counted').toBe(true);
		expect(flag(await given('mallory'), 'mallory')).toBe(false);
	});
});
