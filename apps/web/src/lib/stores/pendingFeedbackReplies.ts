/**
 * pendingFeedbackReplies — optimistic, DISPLAY-ONLY echo of feedback replies the
 * CURRENT USER just posted (v1.7.0, "fastrepliestofeedbacks", ADR-0051).
 *
 * WHY. `morphit_feedback_response_v1` lands on chain immediately, but the
 * indexer applies only irreversible blocks (ADR-0008), so the reply is invisible
 * to `/v1/feedback/:account` for ~45-63s. The page said "Reply posted ✓" and
 * then showed no reply — the user's own words, missing from their own profile,
 * for a minute. Truthful, and still unsettling: the natural reading is that it
 * didn't work.
 *
 * WHY THIS IS DISPLAY, NOT REPUTATION. ADR-0051's matrix keeps review SCORES and
 * trade counts durable-only, and a feedback REPLY brushes right up against that
 * line — so it's worth being explicit about which side it's on. A reply is a
 * comment: it carries no rating, and the indexer's own reputation maths never
 * reads it (`weighted_rating` and `feedback_count` are computed from feedback
 * rows, not responses). Nothing a reply says can move a number. So it's display,
 * and provisional display is allowed. If a response ever DID feed scoring, this
 * store would have to go — that is the test, not "is it feedback-shaped".
 *
 * Keyed on `source_trx_id` — the feedback op's trx id — because that is what the
 * on-chain op references its parent by, and what `RespondToFeedbackForm` already
 * broadcasts. The indexer's numeric `id` is internal and would be a second
 * identity to keep in step.
 *
 * Inherits pendingEcho's invariants: display only, self-reconciling (vanishes
 * the moment the indexer's copy lands, ages out if it never does), local only.
 */

import { writable } from 'svelte/store';
import type { FeedbackRecord, FeedbackResponseRecord } from '@morphit/indexer-client';
import { PENDING_TTL_MS, liveEntries, upsertEntry } from './pendingEcho';

export { PENDING_TTL_MS };

export interface PendingFeedbackReply {
	/** The trx id of the feedback being replied to. */
	readonly sourceTrxId: string;
	readonly responder: string;
	readonly comment: string;
	readonly createdAt: string;
	readonly addedAt: number;
}

const store = writable<readonly PendingFeedbackReply[]>([]);

/** Read-only subscription for components (`$pendingFeedbackReplies`). */
export const pendingFeedbackReplies = { subscribe: store.subscribe };

const entryKey = (e: { sourceTrxId: string }): string => e.sourceTrxId;

/**
 * Stage a reply the user just successfully broadcast.
 *
 * Call ONLY after the broadcast resolves ok — staging on submit would show a
 * reply that may never exist, which is the one thing this store must never do.
 */
export function addPendingReply(
	sourceTrxId: string,
	responder: string,
	comment: string,
	nowMs: number = Date.now()
): void {
	store.update((list) =>
		upsertEntry(
			list,
			{
				sourceTrxId,
				responder,
				comment,
				createdAt: new Date(nowMs).toISOString(),
				addedAt: nowMs
			},
			entryKey
		)
	);
}

/** Drop everything. Called on sign-out — another account's session must never
 *  inherit this one's staged replies. */
export function clearPendingReplies(): void {
	store.set([]);
}

/**
 * Merge staged replies into the indexer's feedback rows.
 *
 * Rules:
 *   1. A feedback row the indexer already shows a response for is left ALONE.
 *      The durable copy wins — it's the same text, and re-adding ours would
 *      show the reply twice.
 *   2. Otherwise the staged reply is slotted in, so the user sees their own
 *      words in the place they'll permanently live.
 *
 * PURE. Never mutates its inputs.
 */
export function mergePendingReplies(
	feedback: readonly FeedbackRecord[],
	pending: readonly PendingFeedbackReply[],
	nowMs: number
): readonly FeedbackRecord[] {
	// A staged reply is "confirmed" once the indexer shows ANY response for that
	// feedback — not once the row merely exists (it always does; it's the feedback
	// we replied to). Getting that wrong would drop the echo instantly and put the
	// bug straight back.
	const confirmedKeys = new Set(
		feedback.filter((f) => f.responses.length > 0).map((f) => f.source_trx_id)
	);
	const live = liveEntries(pending, entryKey, confirmedKeys, nowMs);
	if (live.length === 0) return feedback;

	const byTrx = new Map(live.map((e) => [e.sourceTrxId, e]));
	return feedback.map((f) => {
		const staged = byTrx.get(f.source_trx_id);
		// No second `f.responses.length > 0` check here. `confirmedKeys` above
		// already excluded every row the indexer has a response for, so a duplicate
		// check would be unreachable — and an unreachable guard is worse than none:
		// it reads as load-bearing, no tamper test can prove it, and the next reader
		// trusts it. One gate, tamper-proven.
		if (!staged) return f;
		const response: FeedbackResponseRecord = {
			responder: staged.responder,
			comment: staged.comment,
			created_at: staged.createdAt
		};
		return { ...f, responses: [response] };
	});
}

/** Which feedback rows are showing a staged (not-yet-durable) reply, so the UI
 *  can mark them "confirming". PURE. */
export function pendingReplyKeys(
	feedback: readonly FeedbackRecord[],
	pending: readonly PendingFeedbackReply[],
	nowMs: number
): ReadonlySet<string> {
	const confirmedKeys = new Set(
		feedback.filter((f) => f.responses.length > 0).map((f) => f.source_trx_id)
	);
	return new Set(liveEntries(pending, entryKey, confirmedKeys, nowMs).map(entryKey));
}
