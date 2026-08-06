/**
 * Morphit — pending-feedback-reminder helper (Item 3).
 *
 * Pure: takes the user's incoming feedback (reviews left ABOUT them
 * by counterparties) and outgoing feedback (reviews this user has
 * GIVEN), plus a "now" timestamp, and returns the list of orders
 * where the counterparty has reviewed but the user has not
 * reciprocated AND it has been longer than the threshold.
 *
 * Anchor choice: the trigger is "your counterparty reviewed you N
 * hours ago, you haven't reciprocated yet."  This is the cleanest
 * deterministic on-chain anchor for a "trade-completed-but-feedback-
 * pending" signal — there's no separate trade-complete event in
 * Morphit because feedback IS the trade-complete signal (per
 * ADR-0011 §8).  The first feedback in a (reviewer, subject) pair
 * citing an order is the trade-complete moment from the chain's
 * perspective.
 *
 * Why not "48h after the order's verified fee"?  Because trades can
 * legitimately take days to settle (slow bank transfers, weekends,
 * holidays).  Bombarding users with reminders on every order they
 * posted but haven't yet reciprocated for would be noise — most are
 * still mid-trade or the counterparty also hasn't left feedback.
 * The "your counterparty already reviewed you" anchor only fires
 * when we KNOW the trade settled to the counterparty's
 * satisfaction.
 *
 * Threshold default: 48 hours per Item 3 spec.
 *
 * Privacy posture: this is a CLIENT-SIDE computation.  No server
 * tracks "did this user remember to reciprocate"; it's purely the
 * user's own data, scanned in their own browser.  The result drives
 * an in-app banner always (it's the user's own data) and an OS-
 * level notification ONLY when the user has opted in via
 * notificationPrefs.feedback.
 */

import type { FeedbackRecord } from '@morphit/indexer-client';

/** Threshold in milliseconds — 48 hours per spec. */
export const PENDING_FEEDBACK_REMINDER_MS = 48 * 60 * 60 * 1000;

export interface PendingFeedbackReminder {
	/** The order this trade is anchored to.  Used to deep-link
	 *  back to /my/orders + auto-expand the LeaveFeedbackForm. */
	readonly orderPermlink: string;
	/** The counterparty's Blurt account name — they're who left
	 *  the review citing your order, and who you'd be reviewing
	 *  back. */
	readonly counterpartyAccount: string;
	/** The trx_id of the counterparty's feedback op.  Used as a
	 *  stable de-dup key for the localStorage "already reminded"
	 *  set. */
	readonly counterpartyFeedbackTrxId: string;
	/** When the counterparty's feedback landed on chain.  Used
	 *  for "X hours ago" display in the reminder banner. */
	readonly counterpartyFeedbackAt: string;
	/** Convenience: ms since counterpartyFeedbackAt at compute
	 *  time.  Matches `now - counterpartyFeedbackAt`. */
	readonly elapsedMs: number;
}

export interface ComputeRemindersInput {
	/** The user's own Blurt account name.  Used to filter
	 *  feedback-received to where the subject is them. */
	readonly myAccount: string;
	/** Feedback events ABOUT the user — reviews their
	 *  counterparties have left them.  From
	 *  GET /v1/accounts/:me/feedback. */
	readonly feedbackReceived: readonly FeedbackRecord[];
	/** Feedback the user has LEFT for others.  From
	 *  GET /v1/accounts/:me/feedback-given.  Used to detect
	 *  which order_permlinks the user has already reciprocated
	 *  for. */
	readonly feedbackGiven: readonly FeedbackRecord[];
	/** Reference timestamp.  Defaults to Date.now() — the
	 *  parameter is here for testability. */
	readonly nowMs?: number;
	/** Threshold override (ms).  Defaults to 48h per spec. */
	readonly thresholdMs?: number;
}

/** Pure computation: returns orders where the counterparty
 *  reviewed the user > thresholdMs ago AND the user has not
 *  yet reviewed back.  Returned newest-first to match the
 *  expected display order in the reminder banner. */
export function computePendingFeedbackReminders(
	input: ComputeRemindersInput
): readonly PendingFeedbackReminder[] {
	const now = input.nowMs ?? Date.now();
	const threshold = input.thresholdMs ?? PENDING_FEEDBACK_REMINDER_MS;

	// Build the set of order_permlinks the user has already
	// reciprocated on.  Use a Set for O(1) lookup in the loop.
	const reciprocated = new Set<string>();
	for (const given of input.feedbackGiven) {
		// Defensive: feedback-given is filtered server-side to
		// reviewer = myAccount, but check anyway for type-safety.
		if (given.reviewer !== input.myAccount) continue;
		if (given.order_permlink !== null && given.order_permlink !== undefined) {
			reciprocated.add(given.order_permlink);
		}
	}

	const reminders: PendingFeedbackReminder[] = [];
	for (const received of input.feedbackReceived) {
		// Defensive: subject must be the user.
		if (received.subject !== input.myAccount) continue;
		// Skip feedback that doesn't cite an order — those are
		// general-context feedback, not trade-completion signals.
		if (received.order_permlink === null || received.order_permlink === undefined) {
			continue;
		}
		// Skip if user already reciprocated.
		if (reciprocated.has(received.order_permlink)) continue;
		// Skip suppressed feedback (sock-puppet flagged).  We
		// don't want to pester users to "reciprocate" reviews
		// from sock-puppets we already excluded.
		if (received.suppressed === true) continue;

		// Compute elapsed.
		const at = Date.parse(received.created_at);
		if (Number.isNaN(at)) continue;
		const elapsed = now - at;
		if (elapsed < threshold) continue;

		reminders.push({
			orderPermlink: received.order_permlink,
			counterpartyAccount: received.reviewer,
			counterpartyFeedbackTrxId: received.source_trx_id,
			counterpartyFeedbackAt: received.created_at,
			elapsedMs: elapsed
		});
	}

	// Sort newest-first by counterparty feedback timestamp so
	// the reminder banner shows the most recent at the top.
	// (Older reminders pile up below — and the user can clear
	// them by reciprocating, which removes them from the list
	// next cycle.)
	reminders.sort((a, b) => {
		const aMs = Date.parse(a.counterpartyFeedbackAt);
		const bMs = Date.parse(b.counterpartyFeedbackAt);
		return bMs - aMs;
	});

	return reminders;
}

/** Format the elapsed time as a localizable hint string —
 *  "2 days ago", "3 hours over the 48h mark", etc.  Returns
 *  the human-friendly delta in HOURS, rounded.  Callers
 *  should combine with i18n for the actual string. */
export function elapsedHours(reminder: PendingFeedbackReminder): number {
	return Math.round(reminder.elapsedMs / (60 * 60 * 1000));
}
