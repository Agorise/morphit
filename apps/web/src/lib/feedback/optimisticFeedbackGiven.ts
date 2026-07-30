/**
 * Morphit — optimistic "feedback given" store (cp514 / t.txt D, v1.8.7).
 *
 * THE PROBLEM. After leaving feedback for a peer in the chatroom, returning to
 * the chat inbox still showed the settled-trade card's 3rd line as the green
 * "Leave feedback" prompt — the truth (★★★★★ stars) only appeared once the
 * durable /feedback-given fetch caught up (a poll later). Ken (t.txt D): the
 * line "needs to be accurate and fast, dynamic too so that a page refresh is
 * not needed … show the truth immediately."
 *
 * THE FIX. The chatroom's LeaveFeedbackForm records the just-broadcast feedback
 * here the instant the op lands on-chain; the inbox consults this store — keyed
 * exactly like its durable feedbackGivenMap, `${subject}\u0000${order_permlink}`
 * — so the card flips to the stars immediately, with no refresh. The durable
 * fetch takes precedence once it arrives (it carries the full, indexer-verified
 * record incl. reputation), so this is a transient stand-in, never
 * authoritative. In-memory only; a reload clears it and the durable fetch (by
 * then caught up) is the source of truth.
 */

import { writable } from 'svelte/store';
import type { FeedbackRecord } from '@morphit/indexer-client';

const given = new Map<string, FeedbackRecord>();

/** Bumped on every write so `$optimisticFeedbackTick` re-runs inbox deriveds
 *  the moment a feedback is recorded. */
export const optimisticFeedbackTick = writable(0);

/** Same key shape as the inbox's durable feedbackGivenMap so a lookup by
 *  (peer, order) hits whichever source has the record first. Blurt account
 *  names are already lower-case, matching the inbox's `convo.peer`. */
function key(subject: string, orderPermlink: string): string {
	return `${subject}\u0000${orderPermlink}`;
}

/** Record a feedback the current user just left, so surfaces reflect it before
 *  the durable indexer fetch catches up. No-op without a subject + order. */
export function noteFeedbackGiven(record: FeedbackRecord): void {
	if (!record.subject || !record.order_permlink) return;
	given.set(key(record.subject, record.order_permlink), record);
	optimisticFeedbackTick.update((n) => n + 1);
}

/** The optimistic record for (subject, order), or null when none recorded. */
export function getOptimisticFeedbackGiven(
	subject: string,
	orderPermlink: string
): FeedbackRecord | null {
	return given.get(key(subject, orderPermlink)) ?? null;
}
