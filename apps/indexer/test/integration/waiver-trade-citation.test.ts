/**
 * A review may cite a first-buy WAIVER order once its trade is proven on chain
 * (reviewCitation.ts, waiverTradeTransfers.ts): the order was completed naming
 * the other party, and that party sent the owner at least 50.000 BLURT in one
 * transfer stamped at or after the consensus activation time (and no earlier
 * than the order's block), up to and including the review's block.
 *
 * The kind of case that started it (made-up accounts, blocks and amounts):
 * erin's first order (a fee-waived BLURT buy) was traded with dave, who sent
 * her the BLURT; she completed the order naming dave, and both reviewed each
 * other citing it. Every review was refused, because a waiver order was never
 * a citation. That transfer predates the activation time, so it does not count
 * either: the trade counts once dave sends her at least 50 BLURT in one
 * transfer again from 1 November on.
 *
 * Real dispatcher (applyBlock, so the transfers are recorded by the block
 * walk), real handlers, real Postgres. Also: a genesis replay and a node that
 * upgraded before the activation time hold the same evidence, the fast
 * notification path admits no more than the durable handler, a waiver citation
 * never pays the welcome bonus, and GET /v1/feedback/status says what happened
 * to each review (resend_from, waiting_for_transfer).
 *
 * Skips without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyBlock } from '../../src/indexer/dispatcher';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';
import { HeadTailer } from '../../src/indexer/headTailer';
import { reviewCitesFeePaidOrder, waiverTradeOfThePair } from '../../src/indexer/reviewCitation';
import { blurtTransfersOfBlock } from '../../src/indexer/waiverTradeTransfers';
import {
	FEEDBACK_STATUS_SQL,
	feedbackStatusRoute,
	publicReason
} from '../../src/api/feedbackStatus';
import type { Config } from '../../src/config';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';
import {
	block,
	customJson,
	transfer,
	trx,
	type ChainOp,
	type FakeBlock
} from '../testutils/fakeChain';

const AT = new Date(CONSENSUS_V2_ACTIVATION_TIME);
const PERMLINK = 'order-q4k8wz2m7rtd';
/** erin's waiver order op. */
const WAIVER_ORDER = {
	permlink: PERMLINK,
	side: 'buy',
	asset: 'BLURT',
	fiat_currency: 'EUR',
	amount_min: 20,
	amount_max: null,
	price_model: { kind: 'spread', percent: 0 },
	location_region: null,
	payment_methods: ['pay_xmr', 'pay_btc'],
	terms: null,
	expires_at: '2026-10-26T00:00:00.000Z',
	fee_method: 'waived_first_buy',
	operator_tag: 'morphit-relay',
	lang: 'en'
};
const ORDER_TIME = new Date('2026-10-12T09:38:15Z');
/** `s` seconds after the activation time. */
const after = (s: number): Date => new Date(AT.getTime() + s * 1000);

const order = (signer: string, payload = WAIVER_ORDER): ChainOp =>
	customJson(signer, 'morphit_order_v1', payload);
const complete = (signer: string, counterparty: string, permlink = PERMLINK): ChainOp =>
	customJson(signer, 'morphit_order_complete_v1', { permlink, counterparty });
const review = (signer: string, subject: string, permlink = PERMLINK): ChainOp =>
	customJson(signer, 'morphit_feedback_v1', { subject, rating: 5, order_permlink: permlink });

describe.skipIf(!INTEGRATION_ENABLED)('reviews citing a proven first-buy waiver trade', () => {
	let fx: IntegrationFixture;
	let other: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		other = await setupWithMigrations();
	}, 120_000);
	afterAll(async () => {
		await fx?.teardown();
		await other?.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		await truncateAll(other);
	});

	async function apply(
		num: number,
		b: FakeBlock,
		cfg: Partial<Config> = {},
		into: IntegrationFixture = fx
	): Promise<void> {
		const c = await into.pool.connect();
		try {
			await c.query(`SET search_path TO "${into.schema}"`);
			await c.query('BEGIN');
			await applyBlock(
				c,
				num,
				b as never,
				mockBlurt({}),
				fakeConfig(cfg),
				{},
				{},
				((a: number) => a) as never
			);
			await c.query('COMMIT');
		} catch (err) {
			await c.query('ROLLBACK');
			throw err;
		} finally {
			c.release();
		}
	}

	/** One block per op list, at `time`. */
	async function at(
		num: number,
		time: Date,
		txs: ChainOp[][],
		cfg: Partial<Config> = {}
	): Promise<void> {
		await apply(num, block(num, time, txs.map(trx)), cfg);
	}

	async function verdicts(num: number): Promise<string[]> {
		const r = await fx.db.query<{ s: string }>(
			`SELECT op_id || ':' || status || ':' || COALESCE(reject_reason, '') AS s
			   FROM ops WHERE block_num = $1 ORDER BY trx_in_block, op_in_trx`,
			[num]
		);
		return r.rows.map((x) => x.s);
	}

	async function reviewVerdict(num: number): Promise<string> {
		const v = await verdicts(num);
		return v.filter((s) => s.startsWith('morphit_feedback_v1:')).join(',');
	}

	/** A substantiated conversation (≥2 each way over ≥15 minutes). */
	async function chat(a: string, b: string, start: Date): Promise<void> {
		const steps: Array<[string, string, number]> = [
			[a, b, 0],
			[b, a, 5],
			[a, b, 10],
			[b, a, 30]
		];
		for (const [s, r, min] of steps) {
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
				 VALUES ($1, $2, 'eA==', '{}'::jsonb, $3, $4)`,
				[s, r, new Date(start.getTime() + min * 60_000), `chat-${s}-${r}-${start.getTime()}-${min}`]
			);
		}
	}

	async function recorded(from: IntegrationFixture = fx): Promise<string[]> {
		const r = await from.db.query<{ s: string }>(
			`SELECT block_num || ':' || sender || '>' || recipient || ':' || amount_blurt AS s
			   FROM waiver_trade_transfers ORDER BY block_num, trx_in_block, op_in_trx`
		);
		return r.rows.map((x) => x.s);
	}

	async function bonusRows(): Promise<number> {
		const r = await fx.db.query(`SELECT 1 FROM relay_pending_transfers`);
		return r.rowCount ?? 0;
	}

	async function firstTrade(account: string): Promise<Date | null> {
		const r = await fx.db.query<{ t: Date | null }>(
			`SELECT first_trade_complete_at AS t FROM accounts WHERE name = $1`,
			[account]
		);
		return r.rows[0]?.t ?? null;
	}

	const status = async (
		reviewer: string,
		subject: string,
		now: Date = new Date()
	): Promise<unknown> => {
		const res = await feedbackStatusRoute(fx.db, () => now).request(
			`/status?reviewer=${reviewer}&subject=${subject}&order_permlink=${PERMLINK}`
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		return res.json();
	};

	/** The fast notification gate, as the head tailer runs it. */
	const fast = (reviewer: string, subject: string, time: Date): Promise<boolean> =>
		(
			new HeadTailer({} as never, fx.db, {} as never) as unknown as {
				fastFeedbackAllowed(
					fb: { reviewer: string; subject: string; rating: number; orderPermlink: string },
					createdAt: Date
				): Promise<boolean>;
			}
		).fastFeedbackAllowed({ reviewer, subject, rating: 5, orderPermlink: PERMLINK }, time);

	// The history, block by block, with the BLURT that reached erin
	// before (relay dust) and after (a gift from frank, then the trade) her
	// waiver order was posted — all before the activation time.
	async function liveHistory(cfg: Partial<Config> = {}): Promise<void> {
		await at(70000500, new Date('2026-10-12T09:21:30Z'), [
			[transfer('morphit-relay', 'erin', '2.000 BLURT', 'morphit:signup_dust')]
		]);
		await at(70000846, ORDER_TIME, [[order('erin')]], cfg);
		await at(70019950, new Date('2026-10-13T10:02:12Z'), [
			[transfer('frank', 'erin', '4.000 BLURT')]
		]);
		await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
		await at(70181390, new Date('2026-10-19T14:40:06Z'), [
			[transfer('dave', 'erin', '2750.125 BLURT')]
		]);
		await at(70181427, new Date('2026-10-19T14:41:57Z'), [[complete('erin', 'dave')]]);
	}
	const WAITING = { from: 'dave', to: 'erin' };

	it('the case: refused before the activation time and until dave sends BLURT again from then; then both reviews indexed, no welcome bonus', async () => {
		const cfg = { instanceOperatorTag: 'morphit-relay' };
		await liveHistory(cfg);
		expect(await verdicts(70000846)).toEqual(['morphit_order_v1:applied:']);
		expect(await verdicts(70181427)).toEqual(['morphit_order_complete_v1:applied:']);
		// Nothing before the activation time is evidence, so nothing is kept.
		expect(await recorded()).toEqual([]);

		// Before the activation time: refused, exactly as before this rule.
		await at(70181428, new Date('2026-10-19T14:42:00Z'), [[review('erin', 'dave')]], cfg);
		await at(70181474, new Date('2026-10-19T14:44:18Z'), [[review('dave', 'erin')]], cfg);
		for (const n of [70181428, 70181474]) {
			expect(await reviewVerdict(n)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
		}
		// What the reviewers are told: everything is in place but dave's
		// transfer from 1 November on.
		for (const [reviewer, subject] of [
			['dave', 'erin'],
			['erin', 'dave']
		]) {
			expect(await status(reviewer!, subject!)).toEqual({
				state: 'refused',
				reason: 'order_permlink_not_found_or_unverified',
				block_time: expect.any(String),
				trx_id: expect.any(String),
				waiting_for_transfer: WAITING,
				rating: 5,
				comment: null
			});
		}

		// From the activation time, without a new transfer: still refused.
		expect(await fast('dave', 'erin', after(0))).toBe(false);
		await at(67000000, after(0), [[review('dave', 'erin')]], cfg);
		expect(await reviewVerdict(67000000)).toBe(
			'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
		);

		// dave sends her 50 BLURT. Asked after that, the reviews refused
		// before the activation time can be sent again.
		await at(67000010, after(30), [[transfer('dave', 'erin', '50.000 BLURT')]], cfg);
		expect(await recorded()).toEqual(['67000010:dave>erin:50.000']);
		// (From the time of the answer: the activation time has passed.)
		expect(await status('erin', 'dave', after(60))).toMatchObject({
			state: 'refused',
			resend_from: after(60).toISOString()
		});
		expect(await status('erin', 'dave', after(60))).not.toHaveProperty('waiting_for_transfer');

		// The two re-send their reviews: both indexed.
		expect(await fast('dave', 'erin', after(33))).toBe(true);
		await at(67000011, after(33), [[review('dave', 'erin')]], cfg);
		await at(67000012, after(36), [[review('erin', 'dave')]], cfg);
		expect(await reviewVerdict(67000011)).toBe('morphit_feedback_v1:applied:');
		expect(await reviewVerdict(67000012)).toBe('morphit_feedback_v1:applied:');
		const fb = await fx.db.query<{ s: string }>(
			`SELECT reviewer || '>' || subject || ':' || order_permlink AS s FROM feedback ORDER BY reviewer`
		);
		expect(fb.rows.map((r) => r.s)).toEqual([`dave>erin:${PERMLINK}`, `erin>dave:${PERMLINK}`]);
		expect(await status('dave', 'erin')).toMatchObject({ state: 'indexed' });
		expect(await status('erin', 'dave')).toMatchObject({ state: 'indexed' });
		// A re-send now is a duplicate; indexed still wins.
		await at(67000013, after(39), [[review('dave', 'erin')]], cfg);
		expect(await reviewVerdict(67000013)).toBe('morphit_feedback_v1:rejected:duplicate_feedback');
		expect(await status('dave', 'erin')).toMatchObject({ state: 'indexed' });
		// The fast path does not notify a duplicate either.
		expect(await fast('dave', 'erin', after(39))).toBe(false);

		// The waiver order's operator tag is THIS instance's, and still nothing
		// is queued, and neither account's one-time flag is used.
		expect(await bonusRows()).toBe(0);
		expect(await firstTrade('erin')).toBeNull();
		expect(await firstTrade('dave')).toBeNull();
	});

	it('a genesis replay and a node that upgraded before the activation time hold the same evidence', async () => {
		// The same chain for both: qualifying transfers before the activation
		// time (which an older version never recorded, and this one does not
		// either) and after it.
		const chain: Array<[number, Date, ChainOp[][]]> = [
			[100, ORDER_TIME, [[order('erin')]]],
			[200, new Date('2026-10-19T14:40:06Z'), [[transfer('dave', 'erin', '2750.125 BLURT')]]],
			[210, new Date('2026-10-30T10:00:00Z'), [[transfer('frank', 'erin', '4.000 BLURT')]]],
			[300, after(0), [[transfer('dave', 'erin', '52.000 BLURT')]]],
			[310, after(9), [[transfer('frank', 'erin', '61.500 BLURT')]]],
			[320, after(12), [[transfer('dave', 'erin', '9.000 BLURT')]]]
		];
		const blocks = chain.map(([n, t, txs]) => [n, block(n, t, txs.map(trx))] as const);
		// Genesis replay: every block with this code.
		for (const [n, b] of blocks) await apply(n, b, {}, fx);
		// Upgraded before the activation time: the older blocks applied by a
		// version without this table (nothing recorded), the rest by this one.
		for (const [n, b] of blocks) {
			await apply(n, b, {}, other);
			if (n < 300) await other.db.query(`TRUNCATE waiver_trade_transfers`);
		}
		expect(await recorded(fx)).toEqual(['300:dave>erin:52.000', '310:frank>erin:61.500']);
		expect(await recorded(other)).toEqual(await recorded(fx));
		// The older blocks did hold BLURT transfers to her: they are not read.
		expect(blurtTransfersOfBlock(blocks[1]![1]).length).toBe(1);
	});

	describe('what does not prove the trade (reviews after the activation time)', () => {
		async function orderChatAndComplete(counterparty: string, completeAt: Date): Promise<void> {
			await at(100, ORDER_TIME, [[order('erin')]]);
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await chat('erin', 'carol', new Date('2026-10-19T14:02:00Z'));
			await at(300, completeAt, [[complete('erin', counterparty)]]);
		}
		const XFER = after(0);
		const DONE = new Date('2026-10-19T14:41:57Z');
		const REVIEW = after(3);

		it('no transfer at all', async () => {
			await orderChatAndComplete('dave', DONE);
			await at(400, REVIEW, [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
			expect(await fast('dave', 'erin', REVIEW)).toBe(false);
		});

		it('a transfer before the activation time (after the order) is neither recorded nor counted', async () => {
			await orderChatAndComplete('dave', DONE);
			await at(200, new Date(AT.getTime() - 3000), [[transfer('dave', 'erin', '2750.125 BLURT')]]);
			expect(await recorded()).toEqual([]);
			await at(400, REVIEW, [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
		});

		it('a row stamped before the activation time (as a snapshot could carry) is not counted', async () => {
			await orderChatAndComplete('dave', DONE);
			await fx.db.query(
				`INSERT INTO waiver_trade_transfers
				   (block_num, trx_in_block, op_in_trx, block_time, trx_id, sender, recipient, amount_blurt)
				 VALUES (200, 0, 0, $1, 'x', 'dave', 'erin', 2750.125)`,
				[new Date(AT.getTime() - 3000)]
			);
			await at(400, REVIEW, [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
			// …nor admits a review before the activation time.
			await at(401, new Date(AT.getTime() - 1000), [[review('erin', 'dave')]]);
			expect(await reviewVerdict(401)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
		});

		it('the order was completed naming someone else', async () => {
			await orderChatAndComplete('carol', DONE);
			// Both sent her BLURT; carol is the one she named.
			await at(200, XFER, [
				[transfer('dave', 'erin', '2750.125 BLURT')],
				[transfer('carol', 'erin', '10.000 BLURT')]
			]);
			await at(400, REVIEW, [[review('dave', 'erin')]]);
			await at(401, REVIEW, [[review('erin', 'dave')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
			expect(await reviewVerdict(401)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
			expect(await fast('dave', 'erin', REVIEW)).toBe(false);
		});

		it('a transfer from someone other than the named counterparty', async () => {
			await orderChatAndComplete('dave', DONE);
			await at(200, XFER, [[transfer('carol', 'erin', '2750.125 BLURT')]]);
			await at(400, REVIEW, [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
		});

		it('below the minimum (49.999 BLURT) does not count; 50.000 BLURT does', async () => {
			await orderChatAndComplete('dave', DONE);
			await at(200, XFER, [[transfer('dave', 'erin', '49.999 BLURT')]]);
			await at(400, REVIEW, [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
			await at(201, XFER, [[transfer('dave', 'erin', '50.000 BLURT')]]);
			await at(401, REVIEW, [[review('dave', 'erin')]]);
			expect(await reviewVerdict(401)).toBe('morphit_feedback_v1:applied:');
		});

		it('a transfer before the order was posted (both after the activation time) is neither recorded nor counted', async () => {
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await at(50, after(0), [[transfer('dave', 'erin', '2750.125 BLURT')]]);
			await at(100, after(60), [[order('erin')]]);
			await at(300, after(90), [[complete('erin', 'dave')]]);
			expect(await recorded()).toEqual([]);
			await at(400, after(120), [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
		});

		it('a row below the minimum (as a snapshot could carry) is not counted', async () => {
			await orderChatAndComplete('dave', DONE);
			await fx.db.query(
				`INSERT INTO waiver_trade_transfers
				   (block_num, trx_in_block, op_in_trx, block_time, trx_id, sender, recipient, amount_blurt)
				 VALUES (200, 0, 0, $1, 'x', 'dave', 'erin', 49.999)`,
				[XFER]
			);
			await at(400, REVIEW, [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
		});

		it('a row older than the order (as a snapshot could carry) is not counted', async () => {
			// An order posted after the activation time, and a row from between.
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await at(100, after(60), [[order('erin')]]);
			await at(300, after(90), [[complete('erin', 'dave')]]);
			await fx.db.query(
				`INSERT INTO waiver_trade_transfers
				   (block_num, trx_in_block, op_in_trx, block_time, trx_id, sender, recipient, amount_blurt)
				 VALUES (99, 0, 0, $1, 'x', 'dave', 'erin', 2750.125)`,
				[after(30)]
			);
			await at(400, after(120), [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
		});

		it('a transfer after the review does not prove it, even when already in the table', async () => {
			await orderChatAndComplete('dave', DONE);
			// A row from a block after the review's (as a snapshot could carry).
			await fx.db.query(
				`INSERT INTO waiver_trade_transfers
				   (block_num, trx_in_block, op_in_trx, block_time, trx_id, sender, recipient, amount_blurt)
				 VALUES (401, 0, 0, $1, 'x', 'dave', 'erin', 2750.125)`,
				[after(6)]
			);
			await at(400, REVIEW, [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
			expect(await fast('dave', 'erin', REVIEW)).toBe(false);
		});

		it('an order not completed but carrying a counterparty (a state no handler writes; a snapshot could) proves nothing', async () => {
			await orderChatAndComplete('dave', DONE);
			await at(200, XFER, [[transfer('dave', 'erin', '2750.125 BLURT')]]);
			await fx.db.query(`UPDATE orders SET status = 'live' WHERE account = 'erin'`);
			await at(400, REVIEW, [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
		});

		it('an order that was never completed', async () => {
			await at(100, ORDER_TIME, [[order('erin')]]);
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await at(200, XFER, [[transfer('dave', 'erin', '2750.125 BLURT')]]);
			await at(400, REVIEW, [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
		});
	});

	describe('what free BLURT cannot prove (the minimum is above it)', () => {
		it("the relay's signup dust and its top-ups, even all at once, never prove a trade", async () => {
			await at(100, ORDER_TIME, [[order('erin')]]);
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await at(300, new Date('2026-10-19T14:41:57Z'), [[complete('erin', 'dave')]]);
			// dave passes on what the relay gave him: 4 BLURT of signup dust plus
			// top-ups, in one transfer — still under the minimum.
			await at(400, after(0), [[transfer('dave', 'erin', '9.000 BLURT')]]);
			expect(await recorded()).toEqual([]);
			await at(401, after(3), [[review('dave', 'erin')]]);
			expect(await reviewVerdict(401)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
		});
	});

	describe('same-block evidence (the block walk records before and after the ops)', () => {
		it('a review in the very block that posted the waiver order is refused, whatever else that block holds', async () => {
			// The block's transfers are recorded only after its ops, so the
			// review (in the order's own block) cannot see them.
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await at(100, after(0), [
				[transfer('dave', 'erin', '2750.125 BLURT')],
				[order('erin')],
				[complete('erin', 'dave')],
				[review('dave', 'erin')]
			]);
			expect(await reviewVerdict(100)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
			// The transfer IS recorded, so the same review in a later block is admitted.
			expect(await recorded()).toEqual(['100:dave>erin:2750.125']);
			await at(101, after(3), [[review('dave', 'erin')]]);
			expect(await reviewVerdict(101)).toBe('morphit_feedback_v1:applied:');
		});

		it('a transfer LATER in the review’s own block proves it too', async () => {
			await at(100, ORDER_TIME, [[order('erin')]]);
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await at(300, new Date('2026-10-19T14:41:57Z'), [[complete('erin', 'dave')]]);
			await at(400, after(0), [
				[review('dave', 'erin')],
				[transfer('dave', 'erin', '2750.125 BLURT')]
			]);
			expect(await reviewVerdict(400)).toBe('morphit_feedback_v1:applied:');
		});

		it('a transfer earlier in the review’s own block proves it', async () => {
			await at(100, ORDER_TIME, [[order('erin')]]);
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await at(300, new Date('2026-10-19T14:41:57Z'), [[complete('erin', 'dave')]]);
			await at(400, after(0), [
				[transfer('dave', 'erin', '2750.125 BLURT')],
				[review('dave', 'erin')]
			]);
			expect(await reviewVerdict(400)).toBe('morphit_feedback_v1:applied:');
		});

		it('a transfer in the block that posts the waiver order is recorded', async () => {
			await at(100, after(0), [[transfer('dave', 'erin', '2750.125 BLURT')], [order('erin')]]);
			expect(await recorded()).toEqual(['100:dave>erin:2750.125']);
		});

		it('the owner’s BLURT to herself is never evidence (and never stops a block)', async () => {
			await at(100, ORDER_TIME, [[order('erin')]]);
			await at(200, after(0), [[transfer('erin', 'erin', '5.000 BLURT')]]);
			expect(await verdicts(200)).toEqual([]);
			expect(await recorded()).toEqual([]);
		});

		it('only the earliest transfer of a pair is kept; a later one changes nothing', async () => {
			await at(100, ORDER_TIME, [[order('erin')]]);
			await at(200, after(0), [
				[transfer('dave', 'erin', '49.999 BLURT')],
				[transfer('dave', 'erin', '52.000 BLURT')],
				[transfer('dave', 'erin', '53.000 BLURT')]
			]);
			await at(201, after(3), [[transfer('dave', 'erin', '2750.125 BLURT')]]);
			expect(await recorded()).toEqual(['200:dave>erin:52.000']);
		});

		it('re-applying a block records nothing twice', async () => {
			await at(100, ORDER_TIME, [[order('erin')]]);
			const b = block(200, after(0), [trx([transfer('dave', 'erin', '2750.125 BLURT')])]);
			await apply(200, b);
			await apply(200, b);
			expect(await recorded()).toEqual(['200:dave>erin:2750.125']);
		});
	});

	describe('the welcome bonus is never paid for a waiver citation', () => {
		/** dave also owns a PAID order under the same permlink, tagged with
		 *  this instance — the subject's own paid order, which is what the
		 *  bonus code looks for. */
		async function davePaidOrderSamePermlink(): Promise<void> {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model,
				                     payment_methods, status, created_at, updated_at,
				                     fee_status, fee_method, operator_tag)
				 VALUES ('dave', $1, 'sell', 'BLURT', 'USD', '{}'::jsonb, ARRAY['cash'],
				         'live', $2, $2, 'verified', 'blurt', 'morphit')`,
				[PERMLINK, ORDER_TIME]
			);
		}
		async function provenAfterActivation(): Promise<void> {
			await liveHistory();
			await at(67000010, after(0), [[transfer('dave', 'erin', '50.000 BLURT')]]);
		}

		it('admitted through her waiver order, a review of dave does not pay him', async () => {
			await provenAfterActivation();
			await davePaidOrderSamePermlink();
			// His paid order is not one the pair traded on (no chat names it,
			// not completed), so only the waiver order admits the review.
			expect(
				await reviewCitesFeePaidOrder(fx.db, {
					permlink: PERMLINK,
					subject: 'dave',
					reviewer: 'erin',
					pairBound: true,
					asOf: after(3)
				})
			).toBe('waived');
			await at(500, after(3), [[review('erin', 'dave')]], {
				instanceOperatorTag: 'morphit'
			});
			expect(await reviewVerdict(500)).toBe('morphit_feedback_v1:applied:');
			expect(await bonusRows()).toBe(0);
			expect(await firstTrade('dave')).toBeNull();
		});

		it('when his paid order IS one the pair traded on, the paid citation wins and pays as before', async () => {
			await provenAfterActivation();
			await davePaidOrderSamePermlink();
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
				 VALUES ('erin', 'dave', 'eA==', '{}'::jsonb, $1, 'tagged-chat', $2)`,
				[new Date('2026-10-26T18:00:00Z'), PERMLINK]
			);
			expect(
				await reviewCitesFeePaidOrder(fx.db, {
					permlink: PERMLINK,
					subject: 'dave',
					reviewer: 'erin',
					pairBound: true,
					asOf: after(3)
				})
			).toBe('paid');
			await at(500, after(3), [[review('erin', 'dave')]], {
				instanceOperatorTag: 'morphit'
			});
			expect(await reviewVerdict(500)).toBe('morphit_feedback_v1:applied:');
			expect(await bonusRows()).toBe(2);
		});
	});

	describe('GET /v1/feedback/status: resend_from, waiting_for_transfer and the written review', () => {
		const EARLY = new Date('2026-10-19T14:44:18Z');
		const reviewWith = (extra: Record<string, unknown>): ChainOp =>
			customJson('dave', 'morphit_feedback_v1', {
				subject: 'erin',
				rating: 5,
				order_permlink: PERMLINK,
				...extra
			});
		/** Her waiver order, a conversation, completed naming dave — and,
		 *  unless `withTransfer` is false, his transfer at the activation time. */
		async function proven(withTransfer = true): Promise<void> {
			await at(100, ORDER_TIME, [[order('erin')]]);
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await at(300, new Date('2026-10-19T14:41:57Z'), [[complete('erin', 'dave')]]);
			if (withTransfer) {
				await at(500, after(0), [[transfer('dave', 'erin', '2750.125 BLURT')]]);
			}
		}
		/** Asked at a fixed moment before the activation time unless told
		 *  otherwise (the answer depends on when it is asked). */
		const BEFORE = new Date('2026-10-31T12:00:00Z');
		const body = async (now: Date = BEFORE): Promise<Record<string, unknown>> =>
			(await status('dave', 'erin', now)) as Record<string, unknown>;

		it('carries the rating and comment as written', async () => {
			await proven();
			await at(400, EARLY, [[reviewWith({ rating: 4, comment: 'Fast and friendly' })]]);
			expect(await body()).toMatchObject({
				state: 'refused',
				resend_from: '2026-11-01T00:00:00.000Z',
				rating: 4,
				comment: 'Fast and friendly'
			});
		});

		it('waiting_for_transfer until the partner sends at least 50 BLURT from the activation time; then resend_from', async () => {
			await proven(false);
			await at(400, EARLY, [[review('dave', 'erin')]]);
			let b = await body();
			expect(b).toMatchObject({ state: 'refused', waiting_for_transfer: WAITING });
			expect(b).not.toHaveProperty('resend_from');
			// Dust does not end the wait.
			await at(500, after(0), [[transfer('dave', 'erin', '49.999 BLURT')]]);
			expect(await body()).toMatchObject({ waiting_for_transfer: WAITING });
			await at(501, after(3), [[transfer('dave', 'erin', '50.000 BLURT')]]);
			b = await body(after(60));
			expect(b).toMatchObject({ state: 'refused', resend_from: after(60).toISOString() });
			expect(b).not.toHaveProperty('waiting_for_transfer');
		});

		it('a refusal after the activation time, once the transfer arrives: resend_from now', async () => {
			// The partner reviewed before sending the BLURT (or before the owner
			// completed the order): a resend now would be accepted, so the
			// reviewer is asked again — never left with "not counted" for good.
			await proven(false);
			await at(400, after(0), [[review('dave', 'erin')]]);
			expect(await body(after(1))).toMatchObject({ waiting_for_transfer: WAITING });
			await at(401, after(3), [[transfer('dave', 'erin', '2750.125 BLURT')]]);
			const b = await body(after(60));
			expect(b).toMatchObject({
				state: 'refused',
				rating: 5,
				comment: null,
				resend_from: after(60).toISOString()
			});
			expect(b).not.toHaveProperty('waiting_for_transfer');
		});

		it('neither, when the pair no longer clears the conversation gate (reciprocity since)', async () => {
			for (const withTransfer of [true, false]) {
				await truncateAll(fx);
				await proven(withTransfer);
				await at(400, EARLY, [[review('dave', 'erin')]]);
				// Since then: three 5★ reviews each way between just the two of
				// them within a week — the reciprocity pattern, which the
				// handler's conversation gate refuses from then on.
				for (let i = 0; i < 3; i++) {
					for (const [r, sub] of [
						['dave', 'erin'],
						['erin', 'dave']
					]) {
						await fx.db.query(
							`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
							 VALUES ($1, $2, 5, $3, $4, $5)`,
							[
								r,
								sub,
								`other-${i}`,
								new Date(EARLY.getTime() + (i + 1) * 60_000),
								`recip-${r}-${i}`
							]
						);
					}
				}
				const b = await body();
				expect(b).toMatchObject({ state: 'refused', rating: 5 });
				expect(b).not.toHaveProperty('resend_from');
				expect(b).not.toHaveProperty('waiting_for_transfer');
			}
		});

		it('neither, when the order is completed naming someone else', async () => {
			await at(100, ORDER_TIME, [[order('erin')]]);
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await chat('erin', 'carol', new Date('2026-10-19T14:02:00Z'));
			await at(300, new Date('2026-10-19T14:41:57Z'), [[complete('erin', 'carol')]]);
			await at(400, EARLY, [[review('dave', 'erin')]]);
			const b = await body();
			expect(b).not.toHaveProperty('resend_from');
			expect(b).not.toHaveProperty('waiting_for_transfer');
		});

		it('neither, when the order is not completed', async () => {
			await at(100, ORDER_TIME, [[order('erin')]]);
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await at(400, EARLY, [[review('dave', 'erin')]]);
			expect(await body()).not.toHaveProperty('waiting_for_transfer');
		});

		it('neither, when the waiver order cited is a third party’s', async () => {
			// carol's waiver order under the same permlink, completed naming
			// erin: not an order of this pair.
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await chat('carol', 'erin', new Date('2026-10-19T14:02:00Z'));
			await at(100, ORDER_TIME, [[order('carol')]]);
			await at(300, new Date('2026-10-19T14:41:57Z'), [[complete('carol', 'erin')]]);
			await at(400, EARLY, [[review('dave', 'erin')]]);
			const b = await body();
			expect(b).toMatchObject({ state: 'refused' });
			expect(b).not.toHaveProperty('waiting_for_transfer');
		});

		it('neither, when the cited waiver order does not hold a verified fee (a state no handler writes)', async () => {
			await proven(false);
			await at(400, EARLY, [[review('dave', 'erin')]]);
			await fx.db.query(`UPDATE orders SET fee_status = 'missing' WHERE account = 'erin'`);
			expect(await body()).not.toHaveProperty('waiting_for_transfer');
		});

		it('a paid order verified since: no waiting, and the review may be sent again', async () => {
			// dave's own order, completed naming erin and paid — but
			// unverified when the review came, so it was refused then.
			await chat('erin', 'dave', new Date('2026-10-19T14:02:00Z'));
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model,
				                     payment_methods, status, created_at, updated_at,
				                     fee_status, fee_method, completed_counterparty)
				 VALUES ('dave', $1, 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'],
				         'completed', $2, $2, 'pending_external', 'btc', 'erin')`,
				[PERMLINK, ORDER_TIME]
			);
			await at(400, EARLY, [[review('dave', 'erin')]]);
			expect(await reviewVerdict(400)).toBe(
				'morphit_feedback_v1:rejected:order_permlink_not_found_or_unverified'
			);
			let b = await body();
			expect(b).not.toHaveProperty('waiting_for_transfer');
			await fx.db.query(`UPDATE orders SET fee_status = 'verified' WHERE account = 'dave'`);
			b = await body();
			// A resend would now be accepted (the paid order admits it): now.
			expect(b).toMatchObject({ state: 'refused', resend_from: BEFORE.toISOString() });
			expect(b).not.toHaveProperty('waiting_for_transfer');
		});

		it('the trade waited on is a waiver order: a paid one completed naming the pair is not', async () => {
			// Through the route a paid order completed naming the pair always
			// admits the review first, so ask the lookup itself.
			const pair = { permlink: PERMLINK, subject: 'erin', reviewer: 'dave' };
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model,
				                     payment_methods, status, created_at, updated_at,
				                     fee_status, fee_method, completed_counterparty)
				 VALUES ('dave', $1, 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'],
				         'completed', $2, $2, 'verified', 'btc', 'erin')`,
				[PERMLINK, ORDER_TIME]
			);
			expect(await waiverTradeOfThePair(fx.db, pair)).toBeNull();
			await proven(false);
			expect(await waiverTradeOfThePair(fx.db, pair)).toEqual({
				owner: 'erin',
				partner: 'dave'
			});
		});

		it('not waiting but resendable, when a paid order of the pair now admits it (its fee verified since)', async () => {
			// Her waiver order completed naming dave, no transfer — and his
			// paid order under the same permlink, completed naming her, its fee
			// still unverified when the review came.
			await proven(false);
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model,
				                     payment_methods, status, created_at, updated_at,
				                     fee_status, fee_method, completed_counterparty)
				 VALUES ('dave', $1, 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'],
				         'completed', $2, $2, 'pending_external', 'btc', 'erin')`,
				[PERMLINK, ORDER_TIME]
			);
			await at(400, EARLY, [[review('dave', 'erin')]]);
			expect(await body()).toMatchObject({ waiting_for_transfer: WAITING });
			await fx.db.query(`UPDATE orders SET fee_status = 'verified' WHERE account = 'dave'`);
			const b = await body();
			expect(b).toMatchObject({ state: 'refused', resend_from: BEFORE.toISOString() });
			expect(b).not.toHaveProperty('waiting_for_transfer');
		});

		it('neither, when it was refused for something a resend would repeat; malformed values are left out', async () => {
			await proven();
			// The citation is good; the rating is not.
			await at(400, EARLY, [[reviewWith({ rating: 9, comment: 'ok' })]]);
			let b = await body();
			expect(b).toMatchObject({
				state: 'refused',
				reason: 'rating_out_of_range',
				comment: 'ok'
			});
			expect(b).not.toHaveProperty('resend_from');
			expect(b).not.toHaveProperty('rating');
			// With no transfer either: not waiting, it would be refused again.
			await truncateAll(fx);
			await proven(false);
			await at(400, EARLY, [[reviewWith({ rating: 9 })]]);
			expect(await body()).not.toHaveProperty('waiting_for_transfer');
			await truncateAll(fx);
			await proven();
			// A comment the handler refuses (a bidi override), and one too long.
			await at(401, EARLY, [[reviewWith({ comment: 'evil‮text' })]]);
			b = await body();
			expect(b).toMatchObject({ reason: 'comment_forbidden_char', rating: 5 });
			expect(b).not.toHaveProperty('comment');
			await at(402, EARLY, [[reviewWith({ rating: 3, comment: 'x'.repeat(257) })]]);
			b = await body();
			expect(b).toMatchObject({ reason: 'comment_too_long', rating: 3 });
			expect(b).not.toHaveProperty('comment');
			// A rating that is not a whole number.
			await at(403, EARLY, [[reviewWith({ rating: 4.5 })]]);
			b = await body();
			expect(b).toMatchObject({ reason: 'rating_out_of_range', comment: null });
			expect(b).not.toHaveProperty('rating');
		});
	});

	describe('GET /v1/feedback/status', () => {
		it('is one probe of ops_feedback_status_idx, not a scan of the signer’s ops', async () => {
			// A busy signer: thousands of chat ops, a few reviews.
			await fx.db.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
				 SELECT g, 0, 0, NOW(), 'c' || g, CASE WHEN g % 10 = 0 THEN 'other' || (g % 97) ELSE 'dave' END,
				        'morphit_chat_v1', '{}'::jsonb, 'applied'
				   FROM generate_series(1, 20000) g`
			);
			await fx.db.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
				 SELECT 30000 + g, 0, 0, NOW(), 'f' || g, 'dave', 'morphit_feedback_v1',
				        jsonb_build_object('subject', 'user' || g, 'rating', 5, 'order_permlink', 'p' || g), 'applied'
				   FROM generate_series(1, 50) g`
			);
			await fx.db.query('ANALYZE ops');
			const c = await fx.pool.connect();
			try {
				await c.query(`SET search_path TO "${fx.schema}"`);
				await c.query(`PREPARE status_q(text, text, text) AS ${FEEDBACK_STATUS_SQL}`);
				const plan = await c.query(`EXPLAIN (FORMAT JSON) EXECUTE status_q('dave', 'user7', 'p7')`);
				const text = JSON.stringify(plan.rows[0]);
				expect(text).toContain('ops_feedback_status_idx');
				expect(text).not.toContain('"Seq Scan"');
				await c.query('DEALLOCATE status_q');
			} finally {
				c.release();
			}
			await fx.db.query(`DELETE FROM ops`);
		});

		it('unknown when this indexer never saw such a review', async () => {
			expect(await status('dave', 'erin')).toEqual({ state: 'unknown' });
		});

		it('a review with no order is looked up without order_permlink', async () => {
			await chat('alice', 'bob', new Date('2026-10-19T14:02:00Z'));
			await at(700, AT, [
				[customJson('alice', 'morphit_feedback_v1', { subject: 'bob', rating: 4 })]
			]);
			const res = await feedbackStatusRoute(fx.db).request('/status?reviewer=alice&subject=bob');
			expect(await res.json()).toMatchObject({ state: 'indexed' });
			const other = await feedbackStatusRoute(fx.db).request(
				`/status?reviewer=alice&subject=bob&order_permlink=${PERMLINK}`
			);
			expect(await other.json()).toEqual({ state: 'unknown' });
		});

		it('rejects malformed input', async () => {
			const app = feedbackStatusRoute(fx.db);
			for (const q of [
				'reviewer=Alice&subject=bob',
				'reviewer=alice',
				'subject=bob',
				'reviewer=alice&subject=bob&order_permlink=',
				'reviewer=alice&subject=bob&order_permlink=Bad_Permlink',
				`reviewer=alice&subject=bob&order_permlink=${'a'.repeat(33)}`
			]) {
				const res = await app.request(`/status?${q}`);
				expect(res.status, q).toBe(400);
			}
		});

		it('serves only the slug of an internal error', () => {
			expect(publicReason('handler_threw:connection reset by peer')).toBe('handler_threw');
			expect(publicReason('no_verified_counterparty')).toBe('no_verified_counterparty');
			expect(publicReason(null)).toBe('unknown');
		});
	});
});
