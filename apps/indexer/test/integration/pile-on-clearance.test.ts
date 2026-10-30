/**
 * Signal C (one-way pile-on) honours an operator's clearance of one
 * (subject, attacker) pair (review, 2026-10-29).
 *
 * `morphit-ops moderation` → Clear takes the attacker out of the stored
 * pile-on row at once, but the detector ignored moderation_flag_clearances
 * for this signal: the next detection day put the cleared attacker straight
 * back. Signals A, B and D already honoured theirs. The flag tables are
 * display only — the review and trade gates never read them.
 *
 * Skips without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { detectOneWayPileOn } from '../../src/indexer/signals';

describe.skipIf(!INTEGRATION_ENABLED)('Signal C: a cleared pile-on pair stays cleared', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	}, 60_000);
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
	});

	const DAY1 = new Date('2026-09-10T12:00:00Z');
	const DAY2 = new Date('2026-09-11T12:00:00Z');
	const SUBJECT = 'pat-target';
	const ATTACKERS = ['ann-pile', 'ben-pile', 'cal-pile', 'dee-pile'];

	/** Four fresh accounts, first active within a day of each other, each
	 *  giving the subject one 1-star review — a pile-on by every rule. */
	const seed = async (): Promise<void> => {
		for (const [i, a] of ATTACKERS.entries()) {
			await fx.db.query(
				`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id, first_activity_at)
				 VALUES ($1, 'some-creator', $2, $3, $4, $3)`,
				[a, 1000 + i, new Date(DAY1.getTime() - 5 * 86_400_000 + i * 3_600_000), `trx-acct-${i}`]
			);
			const permlink = `order-pile-${i}`;
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model,
				                     payment_methods, status, fee_status, created_at, updated_at)
				 VALUES ($1, $2, 'buy', 'BLURT', 'MXN', '{}'::jsonb, $3, 'live', 'verified', $4, $4)
				 ON CONFLICT (account, permlink) DO NOTHING`,
				[SUBJECT, permlink, [], DAY1]
			);
			await fx.db.query(
				`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
				 VALUES ($1, $2, 1, $3, $4, $5)`,
				[a, SUBJECT, permlink, new Date(DAY1.getTime() - 3_600_000), `trx-fb-${i}`]
			);
		}
	};

	const attackersOn = async (day: Date): Promise<string[]> => {
		const r = await fx.db.query<{ reviewer: string }>(
			`SELECT e->>'reviewer' AS reviewer
			   FROM one_way_pile_on o, jsonb_array_elements(o.attacking_reviewers) e
			  WHERE o.subject = $1 AND o.detection_date = ($2::timestamptz AT TIME ZONE 'UTC')::date
			  ORDER BY 1`,
			[SUBJECT, day]
		);
		return r.rows.map((x) => x.reviewer);
	};

	it('without a clearance, every attacker is listed on each detection day', async () => {
		await seed();
		await detectOneWayPileOn(fx.db, { asOf: DAY1 });
		expect(await attackersOn(DAY1)).toEqual(ATTACKERS);
		await detectOneWayPileOn(fx.db, { asOf: DAY2 });
		expect(await attackersOn(DAY2)).toEqual(ATTACKERS);
	});

	it('a cleared attacker is not listed again on the next detection day', async () => {
		await seed();
		await detectOneWayPileOn(fx.db, { asOf: DAY1 });
		const [lo, hi] = ['ann-pile', SUBJECT].sort();
		await fx.db.query(
			`INSERT INTO moderation_flag_clearances (signal, account_a, account_b, watermark, note)
			 VALUES ('pile_on', $1, $2, NULL, 'test')`,
			[lo, hi]
		);
		await detectOneWayPileOn(fx.db, { asOf: DAY2 });
		expect(await attackersOn(DAY2)).toEqual(['ben-pile', 'cal-pile', 'dee-pile']);
	});
});
