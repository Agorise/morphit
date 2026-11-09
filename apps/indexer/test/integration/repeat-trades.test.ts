/**
 * v1.23.5 — repeat trades between the same two people count toward ratings,
 * on real Postgres through the real review and completion handlers.
 *
 * An earlier review counts at half weight when its trade is PROVEN (both
 * reviewed each other citing that order, both admitted by the same order,
 * which its owner completed naming the other, both reviews within 7 days of
 * the completion) and SPACED (72 hours from the reviewer's other counted
 * reviews of that trader). The latest review still counts fully. The profile summary,
 * the orderbook card, the receipt and the review list agree. Signals B and D
 * ignore proven trades, and so does the review gate from the v1.23.5
 * activation time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import feedbackHandler from '../../src/indexer/handlers/feedback';
import orderCompleteHandler from '../../src/indexer/handlers/orderComplete';
import { feedbackByAccountRoute } from '../../src/api/feedback';
import { reputationReceiptRoute } from '../../src/api/reputationReceipt';
import { orderbookRoute } from '../../src/api/orderbook';
import { reciprocityEverHeld } from '../../src/indexer/signalVerdicts';
import {
	healNamingTimes,
	healOrderAccounts,
	provenTradeSql
} from '../../src/indexer/reputation/repeatTrades';
import { redoReviewSignals } from '../../src/indexer/reviewSignalsRedo';
import {
	CONSENSUS_V2_ACTIVATION_TIME,
	CONSENSUS_V3_ACTIVATION_TIME
} from '../../src/indexer/consensusActivation';
import type { Poller } from '../../src/indexer/poller';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { makeCtx } from '../testutils/context';

const poller = { getStatus: () => ({ indexedBlock: 1 }) } as unknown as Poller;
const H = 3_600_000;
const D = 24 * H;

describe.skipIf(!INTEGRATION_ENABLED)('repeat trades count toward ratings (v1.23.5)', () => {
	let fx: IntegrationFixture;
	let trx = 0;

	/** A verified two-way conversation (the review and partner-name gate). */
	async function chat(a: string, b: string, at: Date): Promise<void> {
		for (let i = 0; i < 4; i++) {
			const [from, to] = i % 2 === 0 ? [a, b] : [b, a];
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
				 VALUES ($1, $2, 'eA==', '{}'::jsonb, $3, $4)`,
				[from, to, new Date(at.getTime() + i * 10 * 60_000), `chat-${a}-${b}-${at.getTime()}-${i}`]
			);
		}
	}
	async function order(owner: string, permlink: string, at: Date): Promise<void> {
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                     status, created_at, updated_at, fee_status, fee_method)
			 VALUES ($1, $2, 'sell', 'BLURT', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
			         'live', $3, $3, 'verified', 'blurt')`,
			[owner, permlink, at]
		);
	}
	const op = (signer: string, at: Date, payload: Record<string, unknown>) =>
		makeCtx({ signer, blockTime: at, payload, trxId: String(++trx).padStart(40, '0') });
	const complete = (owner: string, permlink: string, partner: string | null, at: Date) =>
		fx.db.withTx((c) =>
			orderCompleteHandler(
				op(owner, at, partner === null ? { permlink } : { permlink, counterparty: partner }),
				c
			)
		);
	const review = (reviewer: string, subject: string, rating: number, permlink: string, at: Date) =>
		fx.db.withTx((c) =>
			feedbackHandler(op(reviewer, at, { subject, rating, order_permlink: permlink }), c)
		);
	/** One whole trade on owner's order: completed naming the partner, then
	 *  both reviews (partner→owner gets `rating`). */
	async function trade(
		owner: string,
		partner: string,
		permlink: string,
		at: Date,
		rating: number,
		back = 5
	): Promise<void> {
		await order(owner, permlink, new Date(at.getTime() - H));
		expect(await complete(owner, permlink, partner, at)).toEqual({ ok: true });
		expect(await review(partner, owner, rating, permlink, new Date(at.getTime() + H))).toEqual({
			ok: true
		});
		expect(await review(owner, partner, back, permlink, new Date(at.getTime() + 2 * H))).toEqual({
			ok: true
		});
	}
	const redoDue = (due: boolean) =>
		fx.db.query(
			`INSERT INTO indexer_state (id, last_applied_block, chain_id, review_signals_redo_due)
			 VALUES (1, 1, 'test', $1)
			 ON CONFLICT (id) DO UPDATE SET review_signals_redo_due = $1`,
			[due]
		);
	const row = async (reviewer: string, permlink: string) =>
		(
			await fx.db.query<{
				order_account: string | null;
				review_weight: number | null;
				proven: boolean;
			}>(
				`SELECT f.order_account, f.review_weight, ${provenTradeSql('f')} AS proven
				   FROM feedback f
				  WHERE f.reviewer = $1 AND f.order_permlink = $2`,
				[reviewer, permlink]
			)
		).rows[0];

	// From the consensus v2 activation time on (BLURT orders posted before it
	// prove no trade: pinnableOrderSql). Some trades are dated after today (only
	// a test can do that: a review's time is its block's); the rating
	// comparisons below allow a small difference for the time decay.
	const T = Date.parse('2026-11-02T12:00:00Z');
	const at = (days: number, hours = 0) => new Date(T + days * D + hours * H);

	beforeAll(async () => {
		fx = await setupWithMigrations();
		await chat('alice', 'bob', at(-1));
		await chat('alice', 'carol', at(-1));
		// bob trades with alice again and again: day 0, day 1 (too soon), day 4
		// and day 8 (his latest). His 1★ of day 1 must not count.
		await trade('alice', 'bob', 'ab1', at(0), 5);
		await trade('alice', 'bob', 'ab2', at(1), 1);
		await trade('alice', 'bob', 'ab3', at(4), 3);
		await trade('alice', 'bob', 'ab4', at(8), 5);
		// carol: one trade (a new partner, full weight).
		await trade('alice', 'carol', 'ac1', at(2), 4);
		// carol again, but alice never names her: not proven. It is carol's
		// latest, so it counts fully; ac1, proven and 8 days earlier, at half.
		await order('alice', 'ac2', at(10));
		expect(await complete('alice', 'ac2', null, at(10, 1))).toEqual({ ok: true });
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
			 VALUES ('carol', 'alice', 'eA==', '{}'::jsonb, $1, 'ac2-tag', 'ac2')`,
			[at(10, 1.5)]
		);
		expect(await review('carol', 'alice', 2, 'ac2', at(10, 2))).toEqual({ ok: true });
		expect(await review('alice', 'carol', 5, 'ac2', at(10, 3))).toEqual({ ok: true });
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	it('records the admitting order and works out the weights as each review and completion arrives', async () => {
		// bob's reviews of alice: days 0 (spaced), 1 (a day after: not spaced),
		// 4 and 8 (his latest).
		expect(await row('bob', 'ab1')).toEqual({
			order_account: 'alice',
			review_weight: 0.5,
			proven: true
		});
		expect(await row('alice', 'ab1')).toEqual({
			order_account: 'alice',
			review_weight: 0.5,
			proven: true
		});
		expect(await row('bob', 'ab2')).toEqual({
			order_account: 'alice',
			review_weight: 0,
			proven: true
		});
		expect(await row('bob', 'ab3')).toMatchObject({ review_weight: 0.5, proven: true });
		expect(await row('bob', 'ab4')).toMatchObject({ review_weight: 1, proven: true });
		// No partner named: not proven (each one's latest review: it counts fully).
		expect(await row('carol', 'ac2')).toMatchObject({ review_weight: 1, proven: false });
		expect(await row('alice', 'ac2')).toMatchObject({ review_weight: 1, proven: false });
		expect(await row('carol', 'ac1')).toMatchObject({ review_weight: 0.5, proven: true });
	});

	it('a partner named later, within a week of the completion, proves the trade then (G7)', async () => {
		expect(await complete('alice', 'ac2', 'carol', at(11))).toEqual({ ok: true });
		expect(await row('carol', 'ac2')).toMatchObject({ review_weight: 1, proven: true });
		expect(await row('alice', 'ac2')).toMatchObject({ review_weight: 1, proven: true });
		const named = await fx.db.query<{ at: Date }>(
			`SELECT counterparty_named_at AS at FROM orders WHERE permlink = 'ac2'`
		);
		expect(named.rows[0]!.at.toISOString()).toBe(at(11).toISOString());
		const first = await fx.db.query<{ at: Date }>(
			`SELECT counterparty_named_at AS at FROM orders WHERE permlink = 'ab1'`
		);
		expect(first.rows[0]!.at.toISOString()).toBe(at(0).toISOString());
	});

	it('naming a partner on an order completed long ago proves nothing (no reputation from old orders)', async () => {
		// uma's orders, completed naming nobody two months ago; months later
		// she names a fresh partner on each and they review each other.
		await chat('uma', 'sid', at(60));
		for (const [i, d] of [70, 74].entries()) {
			await order('uma', `old${i}`, at(-61));
			expect(await complete('uma', `old${i}`, null, at(-60))).toEqual({ ok: true });
			expect(await complete('uma', `old${i}`, 'sid', at(d))).toEqual({ ok: true });
			expect(await review('sid', 'uma', 5, `old${i}`, at(d, 1))).toEqual({ ok: true });
			expect(await review('uma', 'sid', 5, `old${i}`, at(d, 2))).toEqual({ ok: true });
		}
		expect(await row('sid', 'old0')).toMatchObject({ proven: false, review_weight: 0 });
		const rec = await reputationReceiptRoute(fx.db).request('/uma/reputation-receipt');
		const receipt = (await rec.json()) as {
			rows: { reviewer: string; order_permlink: string; review_weight: number }[];
		};
		expect(
			receipt.rows
				.filter((r) => r.reviewer === 'sid')
				.map((r) => [r.order_permlink, r.review_weight])
		).toEqual([
			['old0', 0],
			['old1', 1]
		]);
	});

	it('the profile, the receipt and the orderbook card agree: bob counts 1 + ½ + ½, carol 1 + ½', async () => {
		const res = await feedbackByAccountRoute(fx.db).request('/alice/feedback');
		const body = (await res.json()) as {
			summary: { count: number; weighted_rating: number };
			items: {
				reviewer: string;
				order_permlink: string;
				suppressed: boolean;
				order_account: string;
			}[];
		};
		// bob: ab4 (latest, 1), ab3 (½), ab1 (½); not ab2 (1 day after ab1).
		// carol: ac2 (latest, unproven, 1), ac1 (proven, ½).
		expect(body.summary.count).toBe(5);
		const kept = body.items
			.filter((i) => !i.suppressed)
			.map((i) => `${i.reviewer}:${i.order_permlink}`)
			.sort();
		expect(kept).toEqual(['bob:ab1', 'bob:ab3', 'bob:ab4', 'carol:ac1', 'carol:ac2']);
		expect(body.items.every((i) => i.order_account === 'alice')).toBe(true);

		const rec = await reputationReceiptRoute(fx.db).request(
			`/alice/reputation-receipt?as_of=${encodeURIComponent(at(12).toISOString())}`
		);
		const receipt = (await rec.json()) as {
			summary: {
				count_included: number;
				count_weighted: number;
				weighted_rating: number;
				reputation_score: number;
			};
			rows: { reviewer: string; order_permlink: string; review_weight: number; proven: boolean }[];
		};
		expect(receipt.summary.count_included).toBe(5);
		expect(receipt.summary.count_weighted).toBe(3.5);
		const w = Object.fromEntries(
			receipt.rows.map((r) => [`${r.reviewer}:${r.order_permlink}`, r.review_weight])
		);
		expect(w['bob:ab1']).toBe(0.5);
		expect(w['bob:ab2']).toBe(0);
		expect(w['bob:ab3']).toBe(0.5);
		expect(w['bob:ab4']).toBe(1);
		expect(w['carol:ac1']).toBe(0.5);
		expect(w['carol:ac2']).toBe(1);
		// The same rule in SQL and in the receipt: the profile's rating equals
		// the receipt's (decay at the request time; the ratings are days apart,
		// so a few hours between the two reads move it far less than 0.01).
		expect(Math.abs(body.summary.weighted_rating - receipt.summary.weighted_rating)).toBeLessThan(
			0.011
		);
		// Without the decay: (5·½ + 3·½ + 5·1 + 4·½ + 2·1) / 3.5 = 3.71.
		expect(receipt.summary.weighted_rating).toBeGreaterThan(3.65);
		expect(receipt.summary.weighted_rating).toBeLessThan(3.8);

		await order('alice', 'live1', at(12));
		const ob = await orderbookRoute(fx.db, poller, 'op').request('/');
		const card = (
			(await ob.json()) as {
				items: {
					account: string;
					feedback_count: number;
					weighted_rating: number;
					reputation_score: number;
				}[];
			}
		).items.find((i) => i.account === 'alice')!;
		expect(card.feedback_count).toBe(5);
		expect(Math.abs(card.weighted_rating - body.summary.weighted_rating)).toBeLessThan(0.011);
		// The score counts the weight (3.5), not the 5 reviews.
		const rec2 = await reputationReceiptRoute(fx.db).request('/alice/reputation-receipt');
		const now = (await rec2.json()) as { summary: { reputation_score: number } };
		expect(Math.abs(card.reputation_score - now.summary.reputation_score)).toBeLessThan(0.011);
	});

	it('an earlier spaced trade less than 3 days before the latest does not count', async () => {
		await chat('pia', 'olga', at(29));
		await trade('pia', 'olga', 'po1', at(30), 5);
		await trade('pia', 'olga', 'po2', at(31), 4);
		const rec = await reputationReceiptRoute(fx.db).request('/pia/reputation-receipt');
		const receipt = (await rec.json()) as {
			rows: { order_permlink: string; review_weight: number; proven: boolean }[];
		};
		expect(receipt.rows.map((r) => [r.order_permlink, r.review_weight, r.proven])).toEqual([
			['po1', 0, true],
			['po2', 1, true]
		]);
		const res = await feedbackByAccountRoute(fx.db).request('/pia/feedback');
		const body = (await res.json()) as { summary: { count: number; weighted_rating: number } };
		expect(body.summary.count).toBe(1);
		expect(body.summary.weighted_rating).toBe(4);
		// The orderbook card (the window-function form of the same rule).
		await order('pia', 'pia-live', at(32));
		const ob = await orderbookRoute(fx.db, poller, 'op').request('/');
		const card = (
			(await ob.json()) as {
				items: { account: string; feedback_count: number; weighted_rating: number }[];
			}
		).items.find((i) => i.account === 'pia')!;
		expect(card.feedback_count).toBe(1);
		expect(card.weighted_rating).toBe(4);
	});

	it('an unproven review in between does not use up the 72 hours (spaced from the last counted one)', async () => {
		await chat('vic', 'wil', at(79));
		await trade('vic', 'wil', 'vw0', at(80), 5);
		// day 83: wil reviews, vic never reviews back — not proven.
		await order('vic', 'vw1', at(83, -1));
		expect(await complete('vic', 'vw1', 'wil', at(83))).toEqual({ ok: true });
		expect(await review('wil', 'vic', 1, 'vw1', at(83, 1))).toEqual({ ok: true });
		await trade('vic', 'wil', 'vw2', at(84), 4);
		await trade('vic', 'wil', 'vw3', at(88), 5);
		const rec = await reputationReceiptRoute(fx.db).request('/vic/reputation-receipt');
		const receipt = (await rec.json()) as {
			rows: { order_permlink: string; review_weight: number; proven: boolean }[];
		};
		expect(receipt.rows.map((r) => [r.order_permlink, r.review_weight, r.proven])).toEqual([
			['vw0', 0.5, true],
			['vw1', 0, false],
			['vw2', 0.5, true],
			['vw3', 1, true]
		]);
	});

	it('both reviews must come within 7 days of the completion, each of them', async () => {
		await chat('tess', 'ugo', at(89));
		// ts0: ugo reviews at once, tess only 9 days after the completion.
		await order('tess', 'ts0', at(90, -1));
		expect(await complete('tess', 'ts0', 'ugo', at(90))).toEqual({ ok: true });
		expect(await review('ugo', 'tess', 5, 'ts0', at(90, 1))).toEqual({ ok: true });
		expect(await review('tess', 'ugo', 5, 'ts0', at(99))).toEqual({ ok: true });
		// ts1: the other way round — tess at once, ugo 9 days after.
		await order('tess', 'ts1', at(100, -1));
		expect(await complete('tess', 'ts1', 'ugo', at(100))).toEqual({ ok: true });
		expect(await review('tess', 'ugo', 5, 'ts1', at(100, 1))).toEqual({ ok: true });
		expect(await review('ugo', 'tess', 5, 'ts1', at(109))).toEqual({ ok: true });
		// ts2: both within the week (6 days after): proven.
		await order('tess', 'ts2', at(110, -1));
		expect(await complete('tess', 'ts2', 'ugo', at(110))).toEqual({ ok: true });
		expect(await review('ugo', 'tess', 5, 'ts2', at(110, 1))).toEqual({ ok: true });
		expect(await review('tess', 'ugo', 5, 'ts2', at(116))).toEqual({ ok: true });
		for (const p of ['ts0', 'ts1']) {
			expect(await row('ugo', p)).toMatchObject({ proven: false });
			expect(await row('tess', p)).toMatchObject({ proven: false });
		}
		expect(await row('ugo', 'ts2')).toMatchObject({ proven: true });
		expect(await row('tess', 'ts2')).toMatchObject({ proven: true });
	});

	it('as of a moment, only the other review and the completion from by then prove a trade', async () => {
		// Read by the one-time flag redo, which judges each old review as of its
		// own time (live, nothing later than the block is in the database).
		const provenAsOf = async (reviewer: string, permlink: string, asOf: Date) =>
			(
				await fx.db.query<{ p: boolean }>(
					`SELECT ${provenTradeSql('f', { asOf: '$3' })} AS p FROM feedback f
					  WHERE f.reviewer = $1 AND f.order_permlink = $2`,
					[reviewer, permlink, asOf]
				)
			).rows[0]!.p;
		// ab1: completed at day 0, bob's review at 1 h, alice's back at 2 h.
		expect(await provenAsOf('bob', 'ab1', at(0, 1.5))).toBe(false);
		expect(await provenAsOf('bob', 'ab1', at(0, 2))).toBe(true);
		// Both reviews before the completion that names the partner (day 121):
		// not proven as of between them, proven from the completion.
		await chat('vera', 'walt', at(119));
		await order('vera', 'vw-late', at(119));
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
			 VALUES ('walt', 'vera', 'eA==', '{}'::jsonb, $1, 'vw-late-chat', 'vw-late')`,
			[at(119, 1)]
		);
		expect(await review('walt', 'vera', 5, 'vw-late', at(120))).toEqual({ ok: true });
		expect(await review('vera', 'walt', 5, 'vw-late', at(120, 1))).toEqual({ ok: true });
		expect(await complete('vera', 'vw-late', 'walt', at(121))).toEqual({ ok: true });
		expect(await provenAsOf('walt', 'vw-late', at(120, 2))).toBe(false);
		expect(await provenAsOf('walt', 'vw-late', at(121))).toBe(true);
	});

	it('both parties own an order under the permlink: both reviews pin the one they traded on', async () => {
		await chat('quin', 'rae', at(33));
		// rae's own order under the same permlink, which they also discussed (so
		// it, too, admits a review of this pair): both orders qualify.
		await order('rae', 'dup', at(33));
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
			 VALUES ('quin', 'rae', 'eA==', '{}'::jsonb, $1, 'dup-chat', 'dup')`,
			[at(33, 1)]
		);
		await trade('quin', 'rae', 'dup', at(34), 5);
		expect(await row('rae', 'dup')).toMatchObject({ order_account: 'quin', proven: true });
		expect(await row('quin', 'dup')).toMatchObject({ order_account: 'quin', proven: true });
	});

	it('a one-sided pile of reviews still counts once (the v1.22 attack)', async () => {
		// mallory reviews alice on order after order; alice never reviews back.
		await chat('alice', 'mallory', at(-1));
		for (let g = 1; g <= 4; g++) {
			await order('alice', `m${g}`, at(20 + g * 4));
			await complete('alice', `m${g}`, 'mallory', at(20 + g * 4, 1));
			expect(await review('mallory', 'alice', 1, `m${g}`, at(20 + g * 4, 2))).toEqual({ ok: true });
		}
		const rec = await reputationReceiptRoute(fx.db).request('/alice/reputation-receipt');
		const receipt = (await rec.json()) as {
			rows: { reviewer: string; review_weight: number }[];
		};
		const mallory = receipt.rows
			.filter((r) => r.reviewer === 'mallory')
			.map((r) => r.review_weight);
		expect(mallory).toEqual([0, 0, 0, 1]);
		// The list (newest first): her earlier ones do not count (suppressed),
		// but the pair is not flagged — reviewing one back is what would prove
		// it (the review-back reminder keys off pair_flagged).
		const res = await feedbackByAccountRoute(fx.db).request('/alice/feedback');
		const items = (
			(await res.json()) as {
				items: { reviewer: string; suppressed: boolean; pair_flagged: boolean }[];
			}
		).items.filter((i) => i.reviewer === 'mallory');
		expect(items.map((i) => [i.suppressed, i.pair_flagged])).toEqual([
			[false, false],
			[true, false],
			[true, false],
			[true, false]
		]);
	});

	it('Signal B ignores proven trades; unproven mutual 5★ reviews are still flagged', async () => {
		const flagged = async (a: string, b: string) =>
			(
				await fx.db.query(
					`SELECT 1 FROM suspicious_reciprocity WHERE account_a = $1 AND account_b = $2`,
					[a, b]
				)
			).rowCount === 1;
		// erin & frank: 3 proven trades in a week, nobody else reviewed.
		await chat('erin', 'frank', at(40));
		for (const [i, d] of [41, 43, 45].entries()) await trade('erin', 'frank', `ef${i}`, at(d), 5);
		expect(await flagged('erin', 'frank')).toBe(false);
		// gina & hank: the same reviews, but no completion names anyone (they
		// cite the orders they discussed in chat, so the reviews apply).
		await chat('gina', 'hank', at(40));
		for (const [i, d] of [41, 43, 45].entries()) {
			await order('gina', `gh${i}`, at(d));
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
				 VALUES ('hank', 'gina', 'eA==', '{}'::jsonb, $1, $2, $3)`,
				[at(d, 0.5), `gh-chat-${i}`, `gh${i}`]
			);
			expect(await complete('gina', `gh${i}`, null, at(d, 1))).toEqual({ ok: true });
			expect(await review('hank', 'gina', 5, `gh${i}`, at(d, 2))).toEqual({ ok: true });
			expect(await review('gina', 'hank', 5, `gh${i}`, at(d, 3))).toEqual({ ok: true });
		}
		expect(await flagged('gina', 'hank')).toBe(true);
	});

	it('Signal D ignores proven trades', async () => {
		const concentrated = async (reviewer: string) =>
			(await fx.db.query(`SELECT 1 FROM review_concentration WHERE reviewer = $1`, [reviewer]))
				.rowCount === 1;
		// ivan reviews only judy, five proven trades in a month.
		await chat('ivan', 'judy', at(50));
		for (const [i, d] of [51, 55, 59, 63, 67].entries())
			await trade('judy', 'ivan', `ij${i}`, at(d), 5);
		expect(await concentrated('ivan')).toBe(false);
	});

	it('a pair flagged under the new rule too: one proven trade, then three unproven mutual 5★ in a week', async () => {
		await chat('kai', 'lia', at(199));
		await trade('kai', 'lia', 'kl0', at(200), 5);
		for (const [i, d] of [201, 202, 203].entries()) {
			await order('kai', `kl${i + 1}`, at(d));
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
				 VALUES ('lia', 'kai', 'eA==', '{}'::jsonb, $1, $2, $3)`,
				[at(d, 0.5), `kl-chat-${i}`, `kl${i + 1}`]
			);
			expect(await complete('kai', `kl${i + 1}`, null, at(d, 1))).toEqual({ ok: true });
			expect(await review('lia', 'kai', 5, `kl${i + 1}`, at(d, 2))).toEqual({ ok: true });
			expect(await review('kai', 'lia', 5, `kl${i + 1}`, at(d, 3))).toEqual({ ok: true });
		}
		expect(await row('lia', 'kl0')).toMatchObject({ proven: true });
		expect(
			(
				await fx.db.query(
					`SELECT 1 FROM suspicious_reciprocity WHERE account_a = 'kai' AND account_b = 'lia'`
				)
			).rowCount
		).toBe(1);
	});

	it('a review back that comes late proves the other’s earlier review at once', async () => {
		await chat('pip', 'quo', at(209));
		for (const [i, d] of [210, 214].entries()) {
			await order('pip', `pq${i}`, at(d, -1));
			expect(await complete('pip', `pq${i}`, 'quo', at(d))).toEqual({ ok: true });
			expect(await review('quo', 'pip', 5, `pq${i}`, at(d, 1))).toEqual({ ok: true });
		}
		expect(await row('quo', 'pq0')).toMatchObject({ review_weight: 0, proven: false });
		// pip reviews the first trade back, five days after it.
		expect(await review('pip', 'quo', 5, 'pq0', at(215))).toEqual({ ok: true });
		expect(await row('quo', 'pq0')).toMatchObject({ review_weight: 0.5, proven: true });
	});

	it('both parties own an order under the permlink and the reviews name different ones: not proven', async () => {
		await chat('nia', 'oto', at(219));
		await order('nia', 'no1', at(220));
		await order('oto', 'no1', at(220));
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
			 VALUES ('oto', 'nia', 'eA==', '{}'::jsonb, $1, 'no1-chat', 'no1')`,
			[at(220, 0.5)]
		);
		// oto reviews before any completion (nia's order admits it), then
		// completes his own order naming nia, which admits nia's review.
		expect(await review('oto', 'nia', 5, 'no1', at(220, 1))).toEqual({ ok: true });
		expect(await complete('oto', 'no1', 'nia', at(220, 2))).toEqual({ ok: true });
		expect(await review('nia', 'oto', 5, 'no1', at(220, 3))).toEqual({ ok: true });
		expect(await row('oto', 'no1')).toMatchObject({ order_account: 'nia', proven: false });
		expect(await row('nia', 'no1')).toMatchObject({ order_account: 'oto', proven: false });
	});

	it('flags raised by an older version are raised again under the new rule; the others are kept', async () => {
		// As an older version would have left them: the proven pairs flagged too.
		await fx.db.query(
			`INSERT INTO suspicious_reciprocity (account_a, account_b, mutual_review_count, avg_rating)
			 VALUES ('erin', 'frank', 6, 5) ON CONFLICT DO NOTHING`
		);
		await fx.db.query(
			`INSERT INTO review_concentration (reviewer, dominant_subject, concentration_pct, review_count, window_days)
			 VALUES ('ivan', 'judy', 100, 5, 30) ON CONFLICT DO NOTHING`
		);
		const flags = async () =>
			(
				await fx.db.query<{ p: string }>(
					`SELECT account_a || '|' || account_b || '|' || detected_at::text AS p
					   FROM suspicious_reciprocity ORDER BY 1`
				)
			).rows.map((x) => x.p);
		const before = await flags();
		// Not due (no older version has applied blocks): nothing is touched.
		await redoDue(false);
		expect(await redoReviewSignals(fx.db)).toBeNull();
		expect(await flags()).toEqual(before);
		await redoDue(true);
		const r = (await redoReviewSignals(fx.db))!;
		expect(r.pairs).toBeGreaterThanOrEqual(1);
		expect(r.reviewers).toBeGreaterThanOrEqual(1);
		const after = await flags();
		expect(after.some((p) => p.startsWith('gina|hank|'))).toBe(true);
		expect(after.some((p) => p.startsWith('kai|lia|'))).toBe(true);
		expect(after.some((p) => p.startsWith('erin|frank|'))).toBe(false);
		// Everything else exactly as it was.
		expect(after).toEqual(before.filter((p) => !p.startsWith('erin|frank|')));
		expect(
			(await fx.db.query(`SELECT 1 FROM review_concentration WHERE reviewer = 'ivan'`)).rowCount
		).toBe(0);
		// Done: not due again until an older version applies blocks.
		expect(await redoReviewSignals(fx.db)).toBeNull();
		// Run again anyway: the same flags.
		await redoDue(true);
		await redoReviewSignals(fx.db);
		expect(await flags()).toEqual(after);
	});

	it('the redo raises what live indexing raises, partners named late included', async () => {
		// ann and ben: five trades 4 days apart, each completed naming nobody,
		// the partner named on all five on day 157 (only the last within the
		// week). ben reviews only ann: Signal D flags him as each review lands.
		await chat('ann', 'ben', at(139));
		const ps = ['q1', 'q2', 'q3', 'q4', 'q5'];
		for (const [i, p] of ps.entries()) {
			const d = 140 + i * 4;
			await order('ann', p, at(d));
			expect(await complete('ann', p, null, at(d, 1))).toEqual({ ok: true });
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
				 VALUES ('ann', 'ben', 'eA==', '{}'::jsonb, $1, $2, $3)`,
				[at(d, 1.5), `q-tag-${p}`, p]
			);
			expect(await review('ben', 'ann', 5, p, at(d, 2))).toEqual({ ok: true });
			expect(await review('ann', 'ben', 5, p, at(d, 3))).toEqual({ ok: true });
		}
		for (const p of ps) await complete('ann', p, 'ben', at(157));
		const rc = async () =>
			(
				await fx.db.query<{ r: string }>(
					`SELECT reviewer || '|' || dominant_subject || '|' || detected_at::text AS r
					   FROM review_concentration WHERE reviewer IN ('ann', 'ben') ORDER BY 1`
				)
			).rows.map((x) => x.r);
		const live = await rc();
		expect(live.length).toBeGreaterThan(0);
		// q5 is proven now, so the redo looks at both flags again.
		await redoDue(true);
		const r = (await redoReviewSignals(fx.db))!;
		expect(r.reviewers).toBeGreaterThanOrEqual(1);
		expect(await rc()).toEqual(live);
	});

	it('the gate never refuses what the old rule accepted: a proven review of someone else is still other activity', async () => {
		const V3 = Date.parse(CONSENSUS_V3_ACTIVATION_TIME);
		const t = (days: number, hours = 0) => new Date(V3 + days * D + hours * H);
		// xena has one proven trade with yuri, zack one with wes.
		await chat('xena', 'yuri', t(1));
		await chat('zack', 'wes', t(1));
		await chat('xena', 'zack', t(1));
		await trade('xena', 'yuri', 'xy', t(2), 5);
		await trade('zack', 'wes', 'zw', t(2), 5);
		// Then xena and zack review each other 5★ three times in a week, on
		// orders they discussed but nobody named anyone on (not proven).
		for (let i = 0; i < 4; i++) {
			const p = `xz${i}`;
			await order('xena', p, t(3 + i));
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
				 VALUES ('zack', 'xena', 'eA==', '{}'::jsonb, $1, $2, $3)`,
				[t(3 + i, 0.5), `xz-chat-${i}`, p]
			);
			expect(await complete('xena', p, null, t(3 + i, 1))).toEqual({ ok: true });
			expect(await review('zack', 'xena', 5, p, t(3 + i, 2))).toEqual({ ok: true });
			expect(await review('xena', 'zack', 5, p, t(3 + i, 3))).toEqual({ ok: true });
		}
		const asOf = t(7);
		expect(await reciprocityEverHeld(fx.db, { a: 'xena', b: 'zack', asOf })).toBe(false);
		expect(
			await reciprocityEverHeld(fx.db, { a: 'xena', b: 'zack', asOf, ignoreProven: true })
		).toBe(false);
	});

	it('the review gate ignores proven trades from the activation time, not before', async () => {
		const V3 = Date.parse(CONSENSUS_V3_ACTIVATION_TIME);
		const run = async (a: string, b: string, start: number): Promise<unknown[]> => {
			await chat(a, b, new Date(start - D));
			const results: unknown[] = [];
			for (let i = 0; i < 4; i++) {
				const t = start + i * D;
				await order(a, `${a}-${i}`, new Date(t - H));
				await complete(a, `${a}-${i}`, b, new Date(t));
				results.push(await review(b, a, 5, `${a}-${i}`, new Date(t + H)));
				results.push(await review(a, b, 5, `${a}-${i}`, new Date(t + 2 * H)));
			}
			return results;
		};
		// Before the activation time (the old rule): once the pair holds three
		// 5★ each way in a week, the fourth completion cannot name the partner
		// (the same gate), so neither review of that trade can cite the order.
		const before = await run('kim', 'lou', V3 - 10 * D);
		expect(before.slice(0, 6).every((r) => (r as { ok: boolean }).ok)).toBe(true);
		expect(before.slice(6)).toEqual([
			{ ok: false, reason: 'order_permlink_not_found_or_unverified' },
			{ ok: false, reason: 'order_permlink_not_found_or_unverified' }
		]);
		const named = await fx.db.query<{ completed_counterparty: string | null }>(
			`SELECT completed_counterparty FROM orders WHERE permlink = 'kim-3'`
		);
		expect(named.rows[0]!.completed_counterparty).toBeNull();
		// From it: proven trades are no ring evidence, every review applies.
		const after = await run('max', 'ned', V3 + D);
		expect(after.every((r) => (r as { ok: boolean }).ok)).toBe(true);
		// The verdict itself, at one moment: held when proven trades count, not
		// when they are ignored.
		const asOf = new Date(V3 + 5 * D);
		expect(await reciprocityEverHeld(fx.db, { a: 'max', b: 'ned', asOf })).toBe(true);
		expect(await reciprocityEverHeld(fx.db, { a: 'max', b: 'ned', asOf, ignoreProven: true })).toBe(
			false
		);
	});

	it('old paid orders cannot be recycled: a fee-free order under the same permlink proves nothing', async () => {
		const V3 = Date.parse(CONSENSUS_V3_ACTIVATION_TIME);
		const t = (days: number, hours = 0) => new Date(V3 + days * D + hours * H);
		// abe's old paid orders: one cancelled, two completed with real trades
		// with someone else.
		const old = async (permlink: string, status: string, partner: string | null) =>
			fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method, completed_at,
				                     completed_counterparty, counterparty_named_at)
				 VALUES ('abe', $1, 'sell', 'BLURT', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
				         $2, $3, $3, 'verified', 'blurt', CASE WHEN $2 = 'completed' THEN $3::timestamptz END,
				         $4, CASE WHEN $4::text IS NULL THEN NULL ELSE $3::timestamptz END)`,
				[permlink, status, t(-15), partner]
			);
		await old('old1', 'cancelled', null);
		await old('old2', 'completed', 'cleo');
		await old('old3', 'completed', 'cleo');
		await chat('abe', 'bea', t(20));
		for (const [i, p] of ['old1', 'old2', 'old3'].entries()) {
			const d = 21 + i * 3;
			// The pair tags the old order in chat, and bea posts a fee-free order
			// under the same permlink and completes it naming abe.
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
				 VALUES ('abe', 'bea', 'eA==', '{}'::jsonb, $1, $2, $3)`,
				[t(d), `recycle-${p}`, p]
			);
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method)
				 VALUES ('bea', $1, 'sell', 'BLURT', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
				         'live', $2, $2, 'missing', 'blurt')`,
				[p, t(d, 1)]
			);
			expect(await complete('bea', p, 'abe', t(d, 1.5))).toEqual({ ok: true });
			expect(await review('bea', 'abe', 5, p, t(d, 2))).toEqual({ ok: true });
			expect(await review('abe', 'bea', 5, p, t(d, 2.5))).toEqual({ ok: true });
		}
		for (const p of ['old1', 'old2', 'old3']) {
			// Admitted by abe's paid order, which was not completed naming bea.
			expect(await row('bea', p)).toMatchObject({ order_account: 'abe', proven: false });
			expect(await row('abe', p)).toMatchObject({ order_account: 'abe', proven: false });
		}
		const w = await fx.db.query<{ k: number }>(
			`SELECT review_weight AS k FROM feedback WHERE reviewer = 'bea' ORDER BY created_at`
		);
		expect(w.rows.map((r) => Number(r.k))).toEqual([0, 0, 1]);
		// The ring check treats them as before v1.23.5: three mutual 5★ in a
		// week, and nothing proven to leave out.
		const asOf = t(28);
		expect(await reciprocityEverHeld(fx.db, { a: 'abe', b: 'bea', asOf })).toBe(true);
		expect(await reciprocityEverHeld(fx.db, { a: 'abe', b: 'bea', asOf, ignoreProven: true })).toBe(
			true
		);
	});

	it('the gate leaves out only proven trades whose reviews come from the activation time on', async () => {
		const V3 = Date.parse(CONSENSUS_V3_ACTIVATION_TIME);
		const t = (days: number, hours = 0) => new Date(V3 + days * D + hours * H);
		// gus and hal: three proven trades in the week before the activation
		// time (each paid, completed naming the other, both reviewed back).
		await chat('gus', 'hal', t(-8));
		for (const [i, d] of [-6, -4, -2].entries()) await trade('gus', 'hal', `gh-pre${i}`, t(d), 5);
		expect(await row('hal', 'gh-pre0')).toMatchObject({ proven: true });
		const asOf = t(0, 12);
		// Proven for the display (Signals B and D, the weights)…
		expect(
			(
				await fx.db.query(
					`SELECT 1 FROM suspicious_reciprocity WHERE account_a = 'gus' AND account_b = 'hal'`
				)
			).rowCount
		).toBe(0);
		// …but the gate judges them as before: the pattern held.
		expect(await reciprocityEverHeld(fx.db, { a: 'gus', b: 'hal', asOf })).toBe(true);
		expect(await reciprocityEverHeld(fx.db, { a: 'gus', b: 'hal', asOf, ignoreProven: true })).toBe(
			true
		);
		// ida and jon: three trades completed just before the activation time,
		// ida's reviews before it, jon's after. Every trade has a review from
		// before it, so the gate counts none as proven: held, as before.
		await chat('ida', 'jon', t(-2));
		for (let i = 0; i < 3; i++) {
			await order('ida', `ij-x${i}`, t(0, -10 + i));
			expect(await complete('ida', `ij-x${i}`, 'jon', t(0, -9 + i))).toEqual({ ok: true });
			expect(await review('ida', 'jon', 5, `ij-x${i}`, t(0, -5 + i))).toEqual({ ok: true });
		}
		for (let i = 0; i < 3; i++)
			expect(await review('jon', 'ida', 5, `ij-x${i}`, t(0, 1 + i))).toEqual({ ok: true });
		expect(await row('jon', 'ij-x0')).toMatchObject({ proven: true });
		const later = t(0, 6);
		expect(await reciprocityEverHeld(fx.db, { a: 'ida', b: 'jon', asOf: later })).toBe(true);
		expect(
			await reciprocityEverHeld(fx.db, { a: 'ida', b: 'jon', asOf: later, ignoreProven: true })
		).toBe(true);
	});

	it('two nodes, a BTC fee verified on one and not yet on the other: the same records, the same verdicts', async () => {
		const V3 = Date.parse(CONSENSUS_V3_ACTIVATION_TIME);
		const t = (days: number, hours = 0) => new Date(V3 + (60 + days) * D + hours * H);
		const listing = (owner: string, permlink: string, when: Date, method: string, status: string) =>
			fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method)
				 VALUES ($1, $2, 'sell', 'BLURT', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
				         'live', $3, $3, $4, $5)`,
				[owner, permlink, when, status, method]
			);
		const results: Record<string, unknown> = {};
		// Each pair plays one node: the BTC-fee order of the first account is
		// verified on the "fast" node and still pending on the "slow" one; the
		// second owns a BLURT-fee order under the same permlink.
		for (const [a, b, btc] of [
			['faa', 'fbb', 'verified'],
			['saa', 'sbb', 'pending_external']
		] as const) {
			await chat(a, b, t(-1));
			for (let k = 1; k <= 4; k++) {
				const p = `${a}-p${k}`;
				const when = t(k - 1);
				await listing(a, p, new Date(when.getTime() - 2 * H), 'btc', btc);
				await listing(b, p, new Date(when.getTime() - 2 * H), 'blurt', 'verified');
				await fx.db.query(
					`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
					 VALUES ($1, $2, 'eA==', '{}'::jsonb, $3, $4, $5)`,
					[a, b, new Date(when.getTime() - H), `${p}-tag`, p]
				);
				results[`${a}-complete-${k}`] = await complete(a, p, b, when);
				results[`${b}-review-${k}`] = await review(b, a, 5, p, new Date(when.getTime() + H));
				results[`${a}-review-${k}`] = await review(a, b, 5, p, new Date(when.getTime() + 2 * H));
			}
		}
		const pins = async (reviewer: string) =>
			(
				await fx.db.query<{ p: string }>(
					`SELECT order_account AS p FROM feedback WHERE reviewer = $1 ORDER BY created_at`,
					[reviewer]
				)
			).rows.map((r) => r.p);
		// The BLURT-fee order on both: an order whose fee each node judges when
		// it gets to it is never the one recorded.
		for (const k of [1, 2, 3]) {
			expect(results[`fbb-review-${k}`]).toEqual({ ok: true });
			expect(results[`faa-complete-${k}`]).toEqual({ ok: true });
		}
		expect((await pins('fbb')).slice(0, 3)).toEqual(['fbb', 'fbb', 'fbb']);
		expect((await pins('sbb')).slice(0, 3)).toEqual(['sbb', 'sbb', 'sbb']);
		for (const k of [1, 2, 3, 4]) {
			expect(results[`sbb-review-${k}`]).toEqual(results[`fbb-review-${k}`]);
			expect(results[`saa-review-${k}`]).toEqual(results[`faa-review-${k}`]);
			expect(results[`saa-complete-${k}`]).toEqual(results[`faa-complete-${k}`]);
		}
	});

	it('a node that ran an older version for a while (no naming times recorded): the same verdicts', async () => {
		const V3 = Date.parse(CONSENSUS_V3_ACTIVATION_TIME);
		const results: Record<string, unknown> = {};
		for (const [c, d, rolled] of [
			['raa', 'rbb', false],
			['xaa', 'xbb', true]
		] as const) {
			await chat(c, d, new Date(V3 - 4 * D));
			for (let k = 1; k <= 3; k++) {
				await order(c, `${c}-q${k}`, new Date(V3 - 3 * D));
				// d's own order under the same permlink, which they discussed: two
				// orders admit the reviews, the one completed naming the other first.
				await order(d, `${c}-q${k}`, new Date(V3 - 3 * D));
				await fx.db.query(
					`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
					 VALUES ($1, $2, 'eA==', '{}'::jsonb, $3, $4, $5)`,
					[c, d, new Date(V3 - 3 * D + H), `${c}-q${k}-tag`, `${c}-q${k}`]
				);
				expect(await complete(c, `${c}-q${k}`, d, new Date(V3 - 2 * D + k * H))).toEqual({
					ok: true
				});
				if (rolled)
					await fx.db.query(
						`UPDATE orders SET counterparty_named_at = NULL WHERE account = $1 AND permlink = $2`,
						[c, `${c}-q${k}`]
					);
			}
			for (let k = 1; k <= 3; k++) {
				results[`${d}-r-${k}`] = await review(d, c, 5, `${c}-q${k}`, new Date(V3 + k * H));
				results[`${c}-r-${k}`] = await review(
					c,
					d,
					5,
					`${c}-q${k}`,
					new Date(V3 + k * H + 30 * 60_000)
				);
			}
			await order(c, `${c}-q4`, new Date(V3 + 5 * H));
			results[`${c}-complete-4`] = await complete(c, `${c}-q4`, d, new Date(V3 + 6 * H));
			results[`${d}-r-4`] = await review(d, c, 5, `${c}-q4`, new Date(V3 + 7 * H));
		}
		for (const k of ['r-1', 'r-2', 'r-3', 'r-4']) {
			expect(results[`xbb-${k}`]).toEqual(results[`rbb-${k}`]);
			expect(results[`xaa-${k}`]).toEqual(results[`raa-${k}`]);
		}
		expect(results['xaa-complete-4']).toEqual(results['raa-complete-4']);
		// Three proven trades are no ring evidence: the fourth goes through.
		expect(results['raa-complete-4']).toEqual({ ok: true });
		expect(results['rbb-r-4']).toEqual({ ok: true });
		// Both nodes record c's order, the one completed naming d, for both reviews.
		const pinned = await fx.db.query<{ p: string }>(
			`SELECT reviewer || ':' || order_account AS p FROM feedback
			  WHERE order_permlink LIKE 'xaa-q_' AND order_permlink <> 'xaa-q4' ORDER BY created_at`
		);
		expect(pinned.rows.map((r) => r.p)).toEqual([
			'xbb:xaa',
			'xaa:xaa',
			'xbb:xaa',
			'xaa:xaa',
			'xbb:xaa',
			'xaa:xaa'
		]);
		// At its next start the node fills the times in.
		expect(await healNamingTimes(fx.db)).toBe(3);
		const times = await fx.db.query<{ a: Date; b: Date }>(
			`SELECT x.counterparty_named_at AS a, r.counterparty_named_at AS b
			   FROM orders x JOIN orders r ON r.account = 'raa' AND r.permlink = replace(x.permlink, 'xaa-', 'raa-')
			  WHERE x.account = 'xaa' AND x.permlink LIKE 'xaa-q_' AND x.permlink <> 'xaa-q4'`
		);
		for (const row of times.rows) expect(row.a.toISOString()).toBe(row.b.toISOString());
	});

	it('what a review from the activation time on recorded is final: start-up never fills it in', async () => {
		const V3 = Date.parse(CONSENSUS_V3_ACTIVATION_TIME);
		const t = (days: number, hours = 0) => new Date(V3 + (90 + days) * D + hours * H);
		const listing = (owner: string, permlink: string, when: Date, method: string) =>
			fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method)
				 VALUES ($1, $2, 'sell', 'BLURT', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
				         'live', $3, $3, 'verified', $4)`,
				[owner, permlink, when, method]
			);
		await chat('hfa', 'hfb', t(-1));
		// Only hfa's BTC-fee order admits hfb's review: none recorded.
		await listing('hfa', 'hf1', t(0), 'btc');
		await listing('hfb', 'hf1', t(0), 'blurt');
		expect(await complete('hfa', 'hf1', 'hfb', t(0, 1))).toEqual({ ok: true });
		expect(await review('hfb', 'hfa', 5, 'hf1', t(0, 2))).toEqual({ ok: true });
		expect(await row('hfb', 'hf1')).toMatchObject({ order_account: null, proven: false });
		// Later hfb completes his own order naming hfa, which would now admit it.
		expect(await complete('hfb', 'hf1', 'hfa', t(0, 3))).toEqual({ ok: true });
		await healOrderAccounts(fx.db);
		expect(await row('hfb', 'hf1')).toMatchObject({ order_account: null });
		// A BLURT order posted before the consensus v2 activation time is never
		// the one recorded (its fee may still be raised by the re-check).
		const V2 = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
		await listing('hfa', 'hf2', new Date(V2 - D), 'blurt');
		expect(await complete('hfa', 'hf2', 'hfb', t(1))).toEqual({ ok: true });
		expect(await review('hfb', 'hfa', 5, 'hf2', t(1, 1))).toEqual({ ok: true });
		expect(await row('hfb', 'hf2')).toMatchObject({ order_account: null, proven: false });
	});
});
