/**
 * a free first-buy waiver order must not be a review
 * citation, and must not trigger the relay-paid welcome bonus.
 *
 * rv6 A4: the waiver order is inserted with fee_status='verified' at zero cost,
 * and the review handler's citation check accepted it. So a fresh sock (free
 * relay signup) could post its waiver order, chat with a target, then
 *   - be reviewed citing that free order → the relay of whichever instance the
 *     sock named in operator_tag queues 10 BLURT + 10 BP to the sock, and
 *   - review the target citing its OWN free order → a 5★ with no listing cost.
 * Runs the real order and feedback handlers against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import orderHandler from '../../src/indexer/handlers/order';
import feedbackHandler from '../../src/indexer/handlers/feedback';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx } from '../testutils/context';

const NOW = new Date('2026-09-24T12:00:00Z');

describe.skipIf(!INTEGRATION_ENABLED)('M3 — waiver orders are not review citations', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		if (fx) await fx.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		// A substantiated two-way conversation, so the provable-counterparty
		// gate is satisfied and only the citation rule decides.
		for (const [a, b] of [
			['sock1', 'mallory'],
			['alice', 'bob']
		]) {
			const t0 = new Date(NOW.getTime() - 3600_000);
			const rows: Array<[string, string, number]> = [
				[a!, b!, 0],
				[b!, a!, 5],
				[a!, b!, 10],
				[b!, a!, 20]
			];
			for (const [s, r, min] of rows) {
				await fx.db.query(
					`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
					 VALUES ($1, $2, 'x', '{}'::jsonb, $3, $4)`,
					[s, r, new Date(t0.getTime() + min * 60_000), `${s}-${r}-${min}`]
				);
			}
		}
		const w = await fx.db.withTx((c) =>
			orderHandler(
				makeCtx({
					signer: 'sock1',
					blockTime: NOW,
					payload: {
						permlink: 'buy-blurt-usd-w',
						side: 'buy',
						asset: 'BLURT',
						fiat_currency: 'USD',
						amount_min: 1,
						amount_max: 2,
						price_model: { kind: 'spread', percent: 0 },
						payment_methods: ['cash'],
						fee_method: 'waived_first_buy',
						operator_tag: 'morphit'
					}
				}),
				c
			)
		);
		expect(w).toEqual({ ok: true });
	});

	async function review(signer: string, subject: string, permlink: string, trx: string) {
		return fx.db.withTx((c) =>
			feedbackHandler(
				makeCtx({
					signer,
					blockTime: NOW,
					trxId: trx.padEnd(40, '0'),
					payload: { subject, rating: 5, order_permlink: permlink }
				}),
				c
			)
		);
	}
	async function bonusRecipients(): Promise<string[]> {
		const q = await fx.db.query<{ recipient: string }>(
			`SELECT recipient FROM relay_pending_transfers ORDER BY kind`
		);
		return q.rows.map((r) => r.recipient);
	}

	it("a review citing the subject's waiver order is refused and queues no welcome bonus", async () => {
		const r = await review('mallory', 'sock1', 'buy-blurt-usd-w', '1');
		expect(r.ok).toBe(false);
		expect(await bonusRecipients()).toEqual([]);
		const fb = await fx.db.query(`SELECT 1 FROM feedback`);
		expect(fb.rowCount).toBe(0);
	});

	it("a review citing the reviewer's OWN waiver order is refused", async () => {
		const r = await review('sock1', 'mallory', 'buy-blurt-usd-w', '2');
		expect(r.ok).toBe(false);
	});

	it("a reviewer's paid order sharing the waiver's permlink does not make the relay pay the sock", async () => {
		// mallory owns a PAID order at the same permlink as sock1's waiver order,
		// so the citation is valid via mallory's order — but the bonus lookup used
		// to read sock1's free waiver order and its sock-chosen operator_tag.
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model,
			                     payment_methods, status, created_at, updated_at,
			                     fee_status, fee_method, operator_tag)
			 VALUES ('mallory', 'buy-blurt-usd-w', 'sell', 'BLURT', 'USD', '{}'::jsonb, ARRAY['cash'],
			         'live', $1, $1, 'verified', 'blurt', 'other')`,
			[NOW]
		);
		expect(await review('mallory', 'sock1', 'buy-blurt-usd-w', '4')).toEqual({ ok: true });
		expect(await bonusRecipients()).toEqual([]);
	});

	it('a review citing a PAID order still works and still pays the first-trade bonus', async () => {
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model,
			                     payment_methods, status, created_at, updated_at,
			                     fee_status, fee_method, operator_tag)
			 VALUES ('bob', 'sell-paid', 'sell', 'BLURT', 'USD', '{}'::jsonb, ARRAY['cash'],
			         'completed', $1, $1, 'verified', 'blurt', 'morphit')`,
			[NOW]
		);
		expect(await review('alice', 'bob', 'sell-paid', '3')).toEqual({ ok: true });
		expect(await bonusRecipients()).toEqual(['bob', 'bob']);
	});
});
