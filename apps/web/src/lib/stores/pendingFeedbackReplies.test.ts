// @vitest-environment jsdom
/**
 * cp475 (v1.7.0, "fastrepliestofeedbacks", ADR-0051).
 *
 * THE BUG. `morphit_feedback_response_v1` lands on chain immediately, but the
 * indexer applies only irreversible blocks (ADR-0008), so the reply is invisible
 * to `/v1/feedback/:account` for ~45-63s. The page showed "Reply posted ✓" above
 * a visibly empty reply slot — the user's own words missing from their own
 * profile for a minute. Truthful, and still unsettling: the natural reading is
 * that it didn't work.
 *
 * THE LINE THIS STORE SITS ON. ADR-0051 keeps review SCORES and trade counts
 * durable-only, and a feedback reply brushes right against that. It's on the
 * display side, and that was VERIFIED rather than assumed: `feedback_responses`
 * is only ever SELECTed to attach display rows (apps/indexer/src/api/feedback.ts);
 * `weighted_rating` and `feedback_count` are computed from `feedback` rows and
 * never read responses. Nothing a reply says can move a number. If that ever
 * changes, this store must go — that's the test, not "is it feedback-shaped".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { FeedbackRecord } from '@morphit/indexer-client';
import {
	pendingFeedbackReplies,
	addPendingReply,
	clearPendingReplies,
	mergePendingReplies,
	pendingReplyKeys,
	PENDING_TTL_MS
} from './pendingFeedbackReplies';

function mkFeedback(
	trx: string,
	responses: { responder: string; comment: string }[] = []
): FeedbackRecord {
	return {
		id: 1,
		reviewer: 'kentest2',
		subject: 'kentest3',
		rating: 5,
		comment: 'great trade',
		source_trx_id: trx,
		responses: responses.map((r) => ({ ...r, created_at: '2026-01-01T00:00:00Z' }))
	} as unknown as FeedbackRecord;
}

const T0 = 1_700_000_000_000;

describe('pendingFeedbackReplies', () => {
	beforeEach(() => {
		clearPendingReplies();
	});

	it('shows a reply the indexer has never heard of (the bug)', () => {
		addPendingReply('trx-abc', 'kentest3', 'thanks for trading!', T0);

		const merged = mergePendingReplies([mkFeedback('trx-abc')], get(pendingFeedbackReplies), T0 + 1_000);

		expect(merged[0]?.responses).toHaveLength(1);
		expect(merged[0]?.responses[0]?.comment).toBe('thanks for trading!');
		expect(merged[0]?.responses[0]?.responder).toBe('kentest3');
	});

	it('never shows the reply twice once the indexer catches up', () => {
		// The subtle one. A staged reply is "confirmed" when the indexer shows ANY
		// response for that feedback — NOT when the feedback row merely exists. The
		// row always exists (it's the feedback we replied to), so keying on row
		// presence would drop the echo instantly and put the bug straight back.
		addPendingReply('trx-abc', 'kentest3', 'thanks!', T0);
		const confirmed = [mkFeedback('trx-abc', [{ responder: 'kentest3', comment: 'thanks!' }])];

		const merged = mergePendingReplies(confirmed, get(pendingFeedbackReplies), T0 + 60_000);

		expect(merged[0]?.responses).toHaveLength(1);
	});

	it('the durable copy wins at the handover', () => {
		// The indexer's row is authoritative — it carries the real created_at and
		// whatever normalisation the handler applied.
		addPendingReply('trx-abc', 'kentest3', 'staged text', T0);
		const confirmed = [mkFeedback('trx-abc', [{ responder: 'kentest3', comment: 'durable text' }])];

		const merged = mergePendingReplies(confirmed, get(pendingFeedbackReplies), T0 + 60_000);

		expect(merged[0]?.responses[0]?.comment).toBe('durable text');
	});

	it('ages out a reply that never confirms, rather than lying forever', () => {
		addPendingReply('trx-abc', 'kentest3', 'thanks!', T0);

		const still = mergePendingReplies([mkFeedback('trx-abc')], get(pendingFeedbackReplies), T0 + PENDING_TTL_MS - 1);
		expect(still[0]?.responses).toHaveLength(1);

		const gone = mergePendingReplies([mkFeedback('trx-abc')], get(pendingFeedbackReplies), T0 + PENDING_TTL_MS + 1);
		expect(gone[0]?.responses).toHaveLength(0);
	});

	it('outlasts the irreversibility lag it exists to bridge', () => {
		// The failure mode that produced every other timing bug in this batch: a
		// window calibrated against block time (~3s) instead of irreversibility
		// (45-63s), expiring before the indexer could possibly have the answer.
		addPendingReply('trx-abc', 'kentest3', 'thanks!', T0);

		const merged = mergePendingReplies([mkFeedback('trx-abc')], get(pendingFeedbackReplies), T0 + 63_000);

		expect(merged[0]?.responses).toHaveLength(1);
	});

	it('only touches the feedback it was replying to', () => {
		addPendingReply('trx-abc', 'kentest3', 'thanks!', T0);
		const rows = [mkFeedback('trx-abc'), mkFeedback('trx-other')];

		const merged = mergePendingReplies(rows, get(pendingFeedbackReplies), T0 + 1_000);

		expect(merged.find((f) => f.source_trx_id === 'trx-abc')?.responses).toHaveLength(1);
		expect(merged.find((f) => f.source_trx_id === 'trx-other')?.responses).toHaveLength(0);
	});

	it('replacing a reply keeps only the latest', () => {
		addPendingReply('trx-abc', 'kentest3', 'first', T0);
		addPendingReply('trx-abc', 'kentest3', 'second', T0 + 1_000);

		expect(get(pendingFeedbackReplies)).toHaveLength(1);
		const merged = mergePendingReplies([mkFeedback('trx-abc')], get(pendingFeedbackReplies), T0 + 2_000);
		expect(merged[0]?.responses[0]?.comment).toBe('second');
	});

	it('never mutates the indexer rows it was handed', () => {
		const rows = [mkFeedback('trx-abc')];
		addPendingReply('trx-abc', 'kentest3', 'thanks!', T0);

		mergePendingReplies(rows, get(pendingFeedbackReplies), T0 + 1_000);

		expect(rows[0]?.responses).toHaveLength(0);
	});

	it('reports which replies are still confirming', () => {
		addPendingReply('trx-abc', 'kentest3', 'thanks!', T0);
		const keys = pendingReplyKeys([mkFeedback('trx-abc')], get(pendingFeedbackReplies), T0 + 1_000);
		expect(keys.has('trx-abc')).toBe(true);
	});

	it("clears on sign-out — a session must not inherit another account's replies", () => {
		addPendingReply('trx-abc', 'kentest3', 'thanks!', T0);
		expect(get(pendingFeedbackReplies)).toHaveLength(1);
		clearPendingReplies();
		expect(get(pendingFeedbackReplies)).toHaveLength(0);
	});
});
