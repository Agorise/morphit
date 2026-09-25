/**
 * The fast/durable notification dedup, at RUNTIME — the bug the maintainer actually hit.
 *
 * WHAT THIS IS ABOUT. A chat message is notified twice by design: the head
 * tailer enqueues a push ~5 s after send, and the durable handler enqueues the
 * SAME push when the message goes irreversible ~60 s later. Exactly one of them
 * must reach the recipient's phone. The mechanism is a partial UNIQUE index on
 * `(account, source_trx_id) WHERE source_trx_id IS NOT NULL` plus a matching
 * `ON CONFLICT ... DO NOTHING`, so whichever path inserts first wins and the
 * other is a no-op.
 *
 * WHY IT IS WORTH A LIVE DATABASE. This has been broken in production before,
 * and the migration note for v1.5.5 says so in as many words: the relay used to
 * DELETE a row once it had been delivered (~5 s), so when the durable handler
 * enqueued the same trx ~60 s later there was nothing left to conflict with and
 * it inserted a SECOND push — "the duplicate notification the maintainer hit". The fix was
 * not to the predicate but to the LIFETIME: the sender now stamps `sent_at` and
 * a pruner reclaims the row much later, so the dedup key survives delivery.
 *
 * That failure is invisible to every check short of a database. The SQL is
 * correct in isolation and stays correct; what broke was how long the row lived
 * relative to when the second insert arrived. `REVISIT-LIST` has carried it as
 * "needs a live Postgres — confirm on the VPS" since cp471, and an audit pass
 * marked the predicate "verified clean" by READING it, which is exactly the
 * distinction this file exists to close: the predicate was never the part that
 * failed.
 *
 * Skips without TEST_DATABASE_URL, like every other integration suite here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { enqueueChatPush } from '../../src/indexer/chatPushEnqueue';

const RECIPIENT = 'bob';
const SENDER = 'alice';
const TRX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';

describe.skipIf(!INTEGRATION_ENABLED)('one message, one notification', () => {
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
		// Without a subscription the enqueue returns early, and every assertion
		// below would pass against a path that never ran.
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode, locale)
			   VALUES ($1, 'https://example.invalid/ep', 'p', 'a', 'standard', 'en')`,
			[RECIPIENT]
		);
	});

	const push = (): Promise<void> =>
		enqueueChatPush(fx.db, {
			recipient: RECIPIENT,
			sender: SENDER,
			orderPermlink: null,
			sourceTrxId: TRX,
			eventAt: new Date()
		});

	const rows = async (): Promise<number> => {
		const r = await fx.db.query<{ n: string }>('SELECT count(*) AS n FROM push_pending');
		return Number(r.rows[0]?.n ?? 0);
	};

	it('the fast enqueue alone produces one push — the baseline the rest rests on', async () => {
		await push();
		expect(await rows(), 'if this is 0 the dedup assertions below prove nothing').toBe(1);
	});

	it('the durable enqueue of the SAME message adds nothing', async () => {
		await push(); // head tailer, ~5s
		await push(); // durable handler, ~60s
		expect(await rows(), 'the recipient must be notified once, not twice').toBe(1);
	});

	/**
	 * THE ONE THAT ACTUALLY BROKE. Delivery happens BETWEEN the two enqueues —
	 * the relay sends the fast push at ~5 s and marks it sent, and the durable
	 * enqueue arrives at ~60 s. If a delivered row stops existing, the dedup key
	 * goes with it and the second insert is no longer a no-op.
	 *
	 * The SQL cannot express this; only the interleaving can.
	 */
	it('a push already DELIVERED still absorbs the durable enqueue', async () => {
		await push();
		// Exactly what apps/relay/src/policy/pushSender.ts does on success.
		await fx.db.query('UPDATE push_pending SET sent_at = NOW()');

		await push(); // the durable handler, arriving after delivery

		// COUNTING ROWS IS NOT THE TEST, and getting that wrong is how this file
		// first passed against the very bug it exists for. Under the v1.5.5
		// behaviour — delete the row on send — the durable enqueue inserts a
		// fresh row and the total is ONE either way: one surviving row in the
		// correct case, one newly-created row in the broken one. The number is
		// identical and the user experience is opposite.
		//
		// What distinguishes them is what is still WAITING to be delivered. The
		// recipient's phone buzzes once per unsent row, so that is the question
		// worth asking, and it is the user-visible property rather than a proxy.
		const r = await fx.db.query<{ n: string }>(
			'SELECT count(*) AS n FROM push_pending WHERE sent_at IS NULL'
		);
		expect(
			Number(r.rows[0]?.n ?? 0),
			'nothing may be left to deliver — a delivered row must OUTLIVE delivery, ' +
				'because deleting it on send is exactly how the duplicate notification ' +
				'happened in v1.5.5'
		).toBe(0);
	});

	/**
	 * And the counterweight, because a dedup that is too eager is its own bug.
	 * The outbid notification in `handlers/featureBid.ts` is single-path and
	 * inserts with no `source_trx_id` at all; the partial index ignores NULLs
	 * precisely so two unrelated notifications to the same account do not
	 * collapse into one.
	 *
	 * AN EARLIER VERSION OF THIS COMMENT SAID "`featureBid` and `feedback`
	 * pushes are single-path and leave `source_trx_id` NULL". The featureBid
	 * half is true; the feedback half was never checked and is false. Feedback
	 * is enqueued from BOTH `handlers/feedback.ts` and `headTailer.ts`, keyed on
	 * the trx id (namespaced `feedback:<trx id>` since F17b, so a review and a
	 * chat message in one transaction do not collide), with exactly the
	 * two-path dedup this file is about — so it
	 * needed its own runtime coverage as much as chat did, and the sentence
	 * above is what stopped it getting any for a round. It has it now, in
	 * `feedback-notification-dedup.test.ts`. A false sentence in a passing test
	 * is worse than no test: it answers the question for the next reader.
	 */
	it('pushes with no dedup key do NOT collapse into each other', async () => {
		await fx.db.query(
			`INSERT INTO push_pending (account, category, title, body, click_path, event_at)
			   VALUES ($1, 'feedback', 't1', 'b1', '/a', NOW()),
			          ($1, 'feedback', 't2', 'b2', '/b', NOW())`,
			[RECIPIENT]
		);
		expect(
			await rows(),
			'the partial index ignores NULLs, so single-path pushes stay independent'
		).toBe(2);
	});

	/** Two DIFFERENT messages to the same person are two notifications. A dedup
	 *  keyed on the account alone would silence the second one. */
	it('two different messages notify twice', async () => {
		await push();
		await enqueueChatPush(fx.db, {
			recipient: RECIPIENT,
			sender: SENDER,
			orderPermlink: null,
			sourceTrxId: 'ffffffffffffffffffffffffffffffffffffffff',
			eventAt: new Date()
		});
		expect(await rows()).toBe(2);
	});

	/** The same message to two different people is two notifications — the key
	 *  is the PAIR, and dropping the account from it would silence one of them. */
	it('the same message to two recipients notifies both', async () => {
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode, locale)
			   VALUES ('carol', 'https://example.invalid/ep2', 'p', 'a', 'standard', 'en')`
		);
		await push();
		await enqueueChatPush(fx.db, {
			recipient: 'carol',
			sender: SENDER,
			orderPermlink: null,
			sourceTrxId: TRX,
			eventAt: new Date()
		});
		expect(await rows(), 'same trx, different recipients — both must be told').toBe(2);
	});
});
