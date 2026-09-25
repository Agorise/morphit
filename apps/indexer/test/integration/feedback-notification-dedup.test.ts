/**
 * The FEEDBACK notification path — chat's twin, and until now untested.
 *
 * WHY THIS FILE EXISTS. `feedbackPushEnqueue` is called from exactly two
 * places, which is the same shape as the chat bug the maintainer hit:
 *
 *   • `handlers/feedback.ts`  — the durable path, ~60 s behind
 *   • `headTailer.ts`         — the fast head-block path, ~5 s
 *
 * Both pass the on-chain trx id, and the partial unique index on
 * `(account, source_trx_id)` is what collapses them into one notification.
 * Identical mechanism to chat, identical dependency on an index that F16
 * showed can go missing in silence — and it had no runtime test of any kind.
 * The only thing standing behind it was `web-push-wiring-smoke`, which grepped
 * `feedbackPushEnqueue.ts` for the string `INSERT INTO push_pending` and would
 * have passed with the `ON CONFLICT` clause deleted.
 *
 * WHICH GUARD CATCHES WHAT, because the two are not interchangeable and the
 * mutation trials made the division sharp:
 *
 *   • Delete the dedup KEY (pass NULL for `source_trx_id`) and three cases in
 *     THIS file fail. Nothing text-based would notice, because the SQL still
 *     reads correctly — the column is simply never populated.
 *   • Delete the `ON CONFLICT` CLAUSE and this file stays GREEN, all six. The
 *     index still rejects the duplicate, `enqueueFeedbackPush` catches its own
 *     errors, and the subject still gets exactly one notification. Only the
 *     smoke catches that one.
 *
 * The second is the more interesting half: it means the clause is not what
 * enforces the dedup. The INDEX is. The clause keeps an ordinary event from
 * becoming a caught exception and a `push_enqueue_failed` log line on every
 * second delivery — worth keeping, and worth knowing is not the safety
 * mechanism it looks like. This is the same shape that led to F16: a mutation
 * that survives a runtime test is telling you where the enforcement actually
 * lives.
 *
 * WHY THE GAP SURVIVED ROUND TEN, which was looking straight at it: the chat
 * dedup suite written that round carries a comment asserting that "`featureBid`
 * and `feedback` pushes are single-path and leave `source_trx_id` NULL". Half
 * of that is true — `featureBid` really is single-path with a NULL key — and
 * half of it was never checked. Feedback is two-path and keyed. A false
 * sentence in a passing test is worse than no test, because it answers the
 * question for the next reader and stops them looking.
 *
 * Skips without TEST_DATABASE_URL, like every other integration suite here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { enqueueFeedbackPush, feedbackDedupKey } from '../../src/indexer/feedbackPushEnqueue';
import { enqueueChatPush } from '../../src/indexer/chatPushEnqueue';

/** The person being reviewed — the one whose phone buzzes. */
const SUBJECT = 'bob';
const REVIEWER = 'alice';
const TRX = 'fbfbfbfb00112233445566778899aabbccddeeff';

describe.skipIf(!INTEGRATION_ENABLED)('one review, one notification', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	beforeEach(async () => {
		await fx.db.query('DELETE FROM push_pending');
		await fx.db.query('DELETE FROM push_subscriptions');
		// Without a subscription the enqueue returns early and every assertion
		// below would pass against a path that never ran.
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode, locale)
			   VALUES ($1, 'https://example.invalid/ep', 'p', 'a', 'standard', 'en')`,
			[SUBJECT]
		);
	});

	const review = (trx = TRX): Promise<void> =>
		enqueueFeedbackPush(fx.db, {
			subject: SUBJECT,
			reviewer: REVIEWER,
			rating: 5,
			sourceTrxId: trx,
			eventAt: new Date()
		});

	const rows = async (): Promise<number> => {
		const r = await fx.db.query<{ n: string }>('SELECT count(*) AS n FROM push_pending');
		return Number(r.rows[0]?.n ?? 0);
	};

	const unsent = async (): Promise<number> => {
		const r = await fx.db.query<{ n: string }>(
			'SELECT count(*) AS n FROM push_pending WHERE sent_at IS NULL'
		);
		return Number(r.rows[0]?.n ?? 0);
	};

	it('the fast enqueue alone produces one push — the baseline the rest rests on', async () => {
		await review();
		expect(await rows(), 'if this is 0 the dedup assertions below prove nothing').toBe(1);
	});

	it('the durable enqueue of the SAME review adds nothing', async () => {
		await review(); // head tailer, ~5s
		await review(); // durable handler, ~60s
		expect(await rows(), 'the subject must be notified once, not twice').toBe(1);
	});

	/**
	 * THE ONE THAT BROKE ON CHAT, asked of feedback for the first time.
	 * Delivery happens BETWEEN the two enqueues. If a delivered row stops
	 * existing, the dedup key goes with it and the durable enqueue is no longer
	 * a no-op. Counting rows cannot see this — the total is 1 either way — so
	 * this counts what is still WAITING to be delivered, which is what the
	 * subject's phone reacts to.
	 */
	it('a review push already DELIVERED still absorbs the durable enqueue', async () => {
		await review();
		await fx.db.query('UPDATE push_pending SET sent_at = NOW()'); // pushSender on success
		await review();
		expect(
			await unsent(),
			'nothing may be left to deliver — a delivered row must OUTLIVE delivery'
		).toBe(0);
	});

	/** Two different reviews of the same person are two notifications. A dedup
	 *  keyed on the account alone would silence the second. */
	it('two different reviews notify twice', async () => {
		await review();
		await review('ffffffffffffffffffffffffffffffffffffffff');
		expect(await rows()).toBe(2);
	});
});

/**
 * THE CROSS-CATEGORY COLLISION (F17b) — and its fix.
 *
 * `(account, source_trx_id)` is the dedup key for BOTH the chat enqueue and the
 * feedback enqueue. A Blurt transaction carries a LIST of operations, and
 * `headTailer.scanBlock` walks every op in it against `block.transaction_ids[ti]`
 * — the same trx id for all of them. A transaction holding both a feedback op and
 * a chat custom_json, where the reviewed account is also the chat recipient,
 * therefore used to enqueue twice under one identical key, and the partial index
 * dropped the second in silence: one row, `category = 'chat'`, the review
 * notification gone, no error anywhere. These cases pinned that until it was
 * fixed, precisely so the fix would have to come through here.
 *
 * The fix namespaces the REVIEW key (`feedback:<trx id>`, see `feedbackDedupKey`)
 * and leaves chat's key byte-for-byte alone. Not a category column in the index:
 * one chat message displays as either `chat` or `order`, and a key built on how a
 * notification is displayed could split the fast and durable enqueues of one
 * message and bring back the v1.5.5 duplicate.
 *
 * What must hold after the fix, and is asserted below:
 *   • a chat message and a review in ONE transaction → two notifications;
 *   • the review's own fast/durable pair still collapses to one (the first
 *     describe block in this file, unchanged, is that guarantee);
 *   • either order of arrival — the tailer walks ops in transaction order, and
 *     nothing fixes which comes first;
 *   • the chat key is still the bare trx id, because the chat fast/durable dedup
 *     (fast-notification-dedup.test.ts) depends on both chat paths agreeing on it.
 */
describe.skipIf(!INTEGRATION_ENABLED)('chat and feedback in one transaction', () => {
	let fx: IntegrationFixture;
	const TRX2 = 'c0ffee00112233445566778899aabbccddeeff01';

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	beforeEach(async () => {
		await fx.db.query('DELETE FROM push_pending');
		await fx.db.query('DELETE FROM push_subscriptions');
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode, locale)
			   VALUES ($1, 'https://example.invalid/ep', 'p', 'a', 'standard', 'en')`,
			[SUBJECT]
		);
	});

	const chat = (recipient = SUBJECT): Promise<void> =>
		enqueueChatPush(fx.db, {
			recipient,
			sender: REVIEWER,
			orderPermlink: null,
			sourceTrxId: TRX2,
			eventAt: new Date()
		});

	const feedback = (): Promise<void> =>
		enqueueFeedbackPush(fx.db, {
			subject: SUBJECT,
			reviewer: REVIEWER,
			rating: 5,
			sourceTrxId: TRX2,
			eventAt: new Date()
		});

	const categories = async (): Promise<string[]> => {
		const r = await fx.db.query<{ category: string }>(
			'SELECT category FROM push_pending ORDER BY category'
		);
		return r.rows.map((x) => x.category);
	};

	it('a chat message and a review in ONE transaction notify the account twice', async () => {
		await chat();
		await feedback();
		expect(
			await categories(),
			'the review notification was swallowed by the chat one — the two share ' +
				'(account, source_trx_id) and the second op of the transaction is dropped silently (F17b)'
		).toEqual(['chat', 'feedback']);
	});

	it('…in either order of arrival', async () => {
		await feedback();
		await chat();
		expect(
			await categories(),
			'the chat notification was swallowed by the review one (F17b, reversed op order)'
		).toEqual(['chat', 'feedback']);
	});

	/** The whole transaction seen twice — fast tailer, then durable handler —
	 *  is still two notifications, not four. The fix must separate the two
	 *  OPERATIONS without separating the two PATHS of either one. */
	it('fast and durable enqueues of that transaction still collapse: two, not four', async () => {
		await chat(); // head tailer, chat op
		await feedback(); // head tailer, feedback op
		await feedback(); // durable feedback handler
		await chat(); // durable chat handler
		expect(await categories(), 'each operation notifies exactly once').toEqual([
			'chat',
			'feedback'
		]);
	});

	/** Chat's key is untouched. The chat fast/durable pair agrees only because
	 *  both chat paths write the bare trx id; namespacing it on one path and not
	 *  the other is the v1.5.5 duplicate again. Asserted on the stored value
	 *  because a behavioural test of chat alone cannot see a change applied to
	 *  both chat paths at once — and the review key is asserted alongside it so
	 *  the two cannot drift into the same namespace. */
	it('the chat key is the bare trx id and the review key is namespaced', async () => {
		await chat();
		await feedback();
		const r = await fx.db.query<{ category: string; source_trx_id: string }>(
			'SELECT category, source_trx_id FROM push_pending ORDER BY category'
		);
		expect(r.rows).toEqual([
			{ category: 'chat', source_trx_id: TRX2 },
			{ category: 'feedback', source_trx_id: feedbackDedupKey(TRX2) }
		]);
		expect(feedbackDedupKey(TRX2), 'the review key must differ from the chat key').not.toBe(TRX2);
	});

	/** Two different accounts in one transaction were never affected — different
	 *  accounts, different keys — and must stay that way. */
	it('two different accounts in one transaction both get notified', async () => {
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode, locale)
			   VALUES ('carol', 'https://example.invalid/ep2', 'p', 'a', 'standard', 'en')`
		);
		await chat('carol');
		await feedback();
		const r = await fx.db.query<{ n: string }>('SELECT count(*) AS n FROM push_pending');
		expect(Number(r.rows[0]?.n ?? 0), 'different accounts, different keys').toBe(2);
	});
});
