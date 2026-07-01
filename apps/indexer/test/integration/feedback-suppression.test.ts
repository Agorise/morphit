/**
 * Integration tests — /v1/accounts/:account/feedback +
 * /v1/accounts/:account/feedback-given suppression flag.
 *
 * Part 118 closure of the gap caught after Part 117 sealed:
 * the per-row `suppressed: boolean` flag on both endpoints
 * previously only checked Signal A (related_accounts) and
 * Signal B (suspicious_reciprocity).  The summary aggregate
 * at the top of the /feedback handler already correctly
 * excluded Signal C (one_way_pile_on.attacking_reviewers) per
 * Part 113's design — but the per-row flag did not, so a
 * Signal C-flagged reviewer's row appeared on the subject
 * profile WITHOUT the suppression chip while still being
 * excluded from the headline rating.  That's exactly the
 * displayed-list-vs-summary inconsistency Finding R15 was
 * meant to prevent for A+B.
 *
 * These tests exercise the full SQL pair-check across all
 * three signal types against real Postgres.  The unit-test
 * tier can't meaningfully cover this — the suppression
 * decision depends on jsonb_array_elements + jsonb operators
 * (Signal C), greatest/least pair normalization (A+B), and
 * the WHERE-EXISTS OR-chain in the same query.  Postgres is
 * the source of truth.
 *
 * Tests run only if TEST_DATABASE_URL is set; otherwise
 * `describe.skipIf` skips the suite cleanly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { feedbackByAccountRoute } from '../../src/api/feedback';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

interface FeedbackItem {
	id: number;
	reviewer: string;
	subject: string;
	rating: number;
	suppressed: boolean;
	has_verified_chat: boolean;
}

interface FeedbackResponse {
	summary: {
		count: number;
		weighted_rating: number;
		by_rating: Record<string, number>;
	};
	items: FeedbackItem[];
}

async function insertFeedback(
	fx: IntegrationFixture,
	reviewer: string,
	subject: string,
	rating: number,
	trxId: string
): Promise<void> {
	await fx.db.query(
		`INSERT INTO feedback (
			reviewer, subject, rating, order_permlink, created_at, source_trx_id
		) VALUES ($1, $2, $3, $4, NOW(), $5)`,
		[reviewer, subject, rating, `order-${trxId}`, trxId]
	);
}

/** Insert a (reviewer, subject) pair into related_accounts as a
 *  Signal A flag.  The detector uses LEAST/GREATEST normalization,
 *  so the schema requires account_a < account_b by name; we
 *  enforce that here. */
async function flagSignalA(
	fx: IntegrationFixture,
	account_a: string,
	account_b: string
): Promise<void> {
	const [lo, hi] = account_a < account_b ? [account_a, account_b] : [account_b, account_a];
	await fx.db.query(
		`INSERT INTO related_accounts (account_a, account_b, reason, detected_at)
		 VALUES ($1, $2, 'same_creator_close_first_activity', NOW())`,
		[lo, hi]
	);
}

/** Insert a (reviewer, subject) pair into suspicious_reciprocity
 *  as a Signal B flag. */
async function flagSignalB(
	fx: IntegrationFixture,
	account_a: string,
	account_b: string
): Promise<void> {
	const [lo, hi] = account_a < account_b ? [account_a, account_b] : [account_b, account_a];
	await fx.db.query(
		`INSERT INTO suspicious_reciprocity (
			account_a, account_b, mutual_review_count, avg_rating, detected_at
		) VALUES ($1, $2, 2, 5.00, NOW())`,
		[lo, hi]
	);
}

/** Insert a Signal C pile-on detection.  `subject` is the
 *  victim; `attackers` is the list of reviewers flagged for
 *  that subject.  Schema: `attacking_reviewers JSONB NOT NULL`
 *  with the canonical `{reviewer, rating_avg, count,
 *  first_activity_at}` shape emitted by the detector at
 *  signals.ts.  The lookup in feedback.ts only reads the
 *  `reviewer` field; the other fields are decoration matching
 *  the production shape for cleanliness. */
async function flagSignalC(
	fx: IntegrationFixture,
	subject: string,
	attackers: readonly string[]
): Promise<void> {
	const attackerObjects = attackers.map((r) => ({
		reviewer: r,
		rating_avg: 1.5,
		count: 1,
		first_activity_at: new Date().toISOString()
	}));
	await fx.db.query(
		`INSERT INTO one_way_pile_on (
			subject, attacking_reviewers, avg_rating, review_count,
			review_window_days, activity_cluster_days
		) VALUES ($1, $2::jsonb, 1.5, $3, 7, 14)`,
		[subject, JSON.stringify(attackerObjects), attackers.length]
	);
}

/** Mount the feedback route on a fresh Hono app and dispatch
 *  a GET against it; return the parsed body. */
async function fetchFeedback(
	fx: IntegrationFixture,
	account: string
): Promise<FeedbackResponse> {
	const app = new Hono();
	app.route('/v1/accounts', feedbackByAccountRoute(fx.db));
	const res = await app.request(`/v1/accounts/${account}/feedback`);
	expect(res.status).toBe(200);
	return (await res.json()) as FeedbackResponse;
}

async function fetchFeedbackGiven(
	fx: IntegrationFixture,
	account: string
): Promise<FeedbackResponse> {
	const app = new Hono();
	app.route('/v1/accounts', feedbackByAccountRoute(fx.db));
	const res = await app.request(`/v1/accounts/${account}/feedback-given`);
	expect(res.status).toBe(200);
	return (await res.json()) as FeedbackResponse;
}

describe.skipIf(!INTEGRATION_ENABLED)('feedback API — suppression flag covers Signals A+B+C', () => {
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

	describe('/feedback (received) — per-row suppressed flag', () => {
		it('clean review is NOT suppressed and DOES count in summary', async () => {
			await insertFeedback(fx, 'alice', 'bob', 5, 'trx-clean');
			const body = await fetchFeedback(fx, 'bob');
			expect(body.items.length).toBe(1);
			expect(body.items[0]!.suppressed).toBe(false);
			expect(body.summary.count).toBe(1);
			expect(body.summary.weighted_rating).toBe(5);
		});

		it('Signal A (related_accounts) flagged → suppressed=true, summary excludes', async () => {
			await insertFeedback(fx, 'alice', 'bob', 5, 'trx-a');
			await flagSignalA(fx, 'alice', 'bob');
			const body = await fetchFeedback(fx, 'bob');
			expect(body.items.length).toBe(1);
			expect(body.items[0]!.suppressed).toBe(true);
			expect(body.summary.count).toBe(0);
		});

		it('Signal B (suspicious_reciprocity) flagged → suppressed=true, summary excludes', async () => {
			await insertFeedback(fx, 'alice', 'bob', 5, 'trx-b');
			await flagSignalB(fx, 'alice', 'bob');
			const body = await fetchFeedback(fx, 'bob');
			expect(body.items.length).toBe(1);
			expect(body.items[0]!.suppressed).toBe(true);
			expect(body.summary.count).toBe(0);
		});

		it('Signal C (one_way_pile_on) flagged → suppressed=true, summary excludes (Part 118 fix)', async () => {
			// This is the regression case.  Pre-Part-118 the row
			// appeared with suppressed=false WHILE summary count
			// was 0 — list/summary visibly disagreed.
			await insertFeedback(fx, 'alice', 'bob', 1, 'trx-c');
			await flagSignalC(fx, 'bob', ['alice']);
			const body = await fetchFeedback(fx, 'bob');
			expect(body.items.length).toBe(1);
			expect(body.items[0]!.suppressed).toBe(true);
			expect(body.summary.count).toBe(0);
		});

		it('Signal C flags only the specific (subject, reviewer) — other reviewers stay clean', async () => {
			await insertFeedback(fx, 'alice', 'bob', 1, 'trx-c-alice');
			await insertFeedback(fx, 'charlie', 'bob', 5, 'trx-clean-charlie');
			// Only alice is in the attackers list.
			await flagSignalC(fx, 'bob', ['alice']);
			const body = await fetchFeedback(fx, 'bob');
			expect(body.items.length).toBe(2);
			const byReviewer = new Map(body.items.map((i) => [i.reviewer, i]));
			expect(byReviewer.get('alice')!.suppressed).toBe(true);
			expect(byReviewer.get('charlie')!.suppressed).toBe(false);
			expect(body.summary.count).toBe(1);
			expect(body.summary.weighted_rating).toBe(5);
		});

		it('Signal C multi-attacker — every named reviewer in the JSONB array is suppressed', async () => {
			await insertFeedback(fx, 'alice', 'bob', 1, 'trx-multi-a');
			await insertFeedback(fx, 'charlie', 'bob', 2, 'trx-multi-c');
			await insertFeedback(fx, 'dan', 'bob', 5, 'trx-multi-d');
			await flagSignalC(fx, 'bob', ['alice', 'charlie']);
			const body = await fetchFeedback(fx, 'bob');
			const byReviewer = new Map(body.items.map((i) => [i.reviewer, i]));
			expect(byReviewer.get('alice')!.suppressed).toBe(true);
			expect(byReviewer.get('charlie')!.suppressed).toBe(true);
			expect(byReviewer.get('dan')!.suppressed).toBe(false);
			expect(body.summary.count).toBe(1);
		});

		it('overlapping signals — A AND C on same pair still produces single suppressed=true', async () => {
			// Both signals flag the same (reviewer, subject) pair.
			// The OR-chain in the per-row query means either is
			// sufficient; the row should be suppressed once.
			await insertFeedback(fx, 'alice', 'bob', 1, 'trx-overlap');
			await flagSignalA(fx, 'alice', 'bob');
			await flagSignalC(fx, 'bob', ['alice']);
			const body = await fetchFeedback(fx, 'bob');
			expect(body.items.length).toBe(1);
			expect(body.items[0]!.suppressed).toBe(true);
			expect(body.summary.count).toBe(0);
		});

		it('Signal C on a DIFFERENT subject does not suppress unrelated rows', async () => {
			// owpo flags charlie as attacker against eve.  alice's
			// review of bob is unrelated and must stay clean.
			await insertFeedback(fx, 'alice', 'bob', 5, 'trx-unrelated');
			await flagSignalC(fx, 'eve', ['charlie']);
			const body = await fetchFeedback(fx, 'bob');
			expect(body.items.length).toBe(1);
			expect(body.items[0]!.suppressed).toBe(false);
			expect(body.summary.count).toBe(1);
		});
	});

	describe('/feedback-given (given) — per-row suppressed flag', () => {
		it('clean review is NOT suppressed', async () => {
			await insertFeedback(fx, 'alice', 'bob', 5, 'trx-given-clean');
			const body = await fetchFeedbackGiven(fx, 'alice');
			expect(body.items.length).toBe(1);
			expect(body.items[0]!.suppressed).toBe(false);
		});

		it('Signal A flag on (alice, bob) shows suppressed=true in alice\'s given list', async () => {
			await insertFeedback(fx, 'alice', 'bob', 5, 'trx-given-a');
			await flagSignalA(fx, 'alice', 'bob');
			const body = await fetchFeedbackGiven(fx, 'alice');
			expect(body.items.length).toBe(1);
			expect(body.items[0]!.suppressed).toBe(true);
		});

		it('Signal B flag on (alice, bob) shows suppressed=true in alice\'s given list', async () => {
			await insertFeedback(fx, 'alice', 'bob', 5, 'trx-given-b');
			await flagSignalB(fx, 'alice', 'bob');
			const body = await fetchFeedbackGiven(fx, 'alice');
			expect(body.items.length).toBe(1);
			expect(body.items[0]!.suppressed).toBe(true);
		});

		it('Signal C — alice in attackers list against bob → suppressed=true on alice\'s row (Part 118 fix)', async () => {
			// Reviewer alice is the fixed account on /feedback-given;
			// subject bob varies.  The per-row check looks up
			// (subject=row.subject, reviewer=$1) in
			// owpo.attacking_reviewers.
			await insertFeedback(fx, 'alice', 'bob', 1, 'trx-given-c');
			await flagSignalC(fx, 'bob', ['alice']);
			const body = await fetchFeedbackGiven(fx, 'alice');
			expect(body.items.length).toBe(1);
			expect(body.items[0]!.suppressed).toBe(true);
		});

		it('Signal C — alice NOT in attackers list → her row stays unsuppressed even if subject has a pile-on', async () => {
			// bob got piled on by charlie + dan, but NOT alice.
			// alice's review of bob is unrelated to the pile-on.
			await insertFeedback(fx, 'alice', 'bob', 4, 'trx-given-c-unrelated');
			await flagSignalC(fx, 'bob', ['charlie', 'dan']);
			const body = await fetchFeedbackGiven(fx, 'alice');
			expect(body.items.length).toBe(1);
			expect(body.items[0]!.suppressed).toBe(false);
		});

		it('Signal C — alice in attackers across MULTIPLE subjects → both rows suppressed', async () => {
			// Alice is a serial Signal C attacker: flagged against
			// bob AND against charlie.  Her own /feedback-given
			// view should show BOTH rows as suppressed.
			await insertFeedback(fx, 'alice', 'bob', 1, 'trx-multi-b');
			await insertFeedback(fx, 'alice', 'charlie', 2, 'trx-multi-c');
			await flagSignalC(fx, 'bob', ['alice', 'dan']);
			await flagSignalC(fx, 'charlie', ['alice', 'eve']);
			const body = await fetchFeedbackGiven(fx, 'alice');
			expect(body.items.length).toBe(2);
			expect(body.items.every((i) => i.suppressed === true)).toBe(true);
		});
	});
});
