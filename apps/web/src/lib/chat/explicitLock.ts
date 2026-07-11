/**
 * Explicit-lock cleanup helpers.
 *
 * Per docs/CHAT-UI-DESIGN.md, a user-initiated Lock (Avatar menu →
 * Lock now) is a PRIVACY POSTURE action and should wipe more than
 * an auto-lock timer does. Specifically it wipes every category
 * of draft, plus the chat recent-peers list, so a subsequent
 * unlock starts clean.
 *
 * An auto-lock (idle timeout) preserves drafts because the user's
 * intent to send is still there; they walked away, they'll be
 * back.
 *
 * How to use: lock flows that are EXPLICITLY user-initiated call
 * `runExplicitLockExtras()` in addition to `lockSession()`. Auto-
 * lock flows call only `lockSession()`. The identity-store
 * lockSession itself is intentionally unaware of this distinction
 * — it keeps its minimal contract "wipe live keys, flip state."
 *
 * Scope: clears every draft in any category (chat, post-order,
 * feedback-leave, feedback-response) plus the recent-peers list.
 * Extension to future draft categories is one line per category
 * using `clearDraftsMatching`.
 */

import { clearDraft, clearDraftsMatching } from '$lib/drafts';
import { clearRecentPeers } from '$lib/chat/recentPeers';
import { clearReadState } from '$lib/chat/readState';
import { clearChatFolders } from '$lib/chat/chatFolders';
import { clearAllPins } from '$lib/chat/pubPin';
import { clearAllTradeStates } from '$lib/trades/tradeStatus';
import { _clearVerifyCache } from '$lib/chat/blurtVerify';

/**
 * Run the extra cleanup that happens on a user-initiated Lock,
 * beyond what `lockSession()` itself does. Safe to call when no
 * drafts exist (each clear is idempotent). Must be called BEFORE
 * or AFTER `lockSession()` — order doesn't matter because the
 * state being cleared lives in localStorage, not the identity
 * store.
 */
export function runExplicitLockExtras(): void {
	// Chat drafts. Use prefix-match clearing rather than iterating
	// the recent-peers list, because the recent-peers list is
	// capped at 20 entries — iterating it would leak drafts for
	// any peer the user once chatted with that has since fallen
	// off the list. The drafts module's prefix scan walks
	// localStorage directly and catches every `chat.<peer>` slot.
	clearDraftsMatching('chat');
	// Then wipe the peers list itself.
	clearRecentPeers();
	// And the per-peer read-state map (when did the user last
	// visit @alice's conversation, etc.). This is privacy-
	// sensitive metadata about who the user has been chatting
	// with — exactly the sort of state an explicit lock should
	// not leak.
	clearReadState();
	// And the per-discussion folder state (which threads the user starred or
	// archived). Same privacy class as read-state — it reveals which
	// discussions the user has been organising — so an explicit lock wipes it.
	clearChatFolders();
	// And the chain-anchored chat-pub pins (Option 5 / S2
	// mitigation).  The pin set reveals which peers the user has
	// chatted with, same privacy class as recentPeers and
	// readState.  Clearing on explicit lock means the next
	// session starts fresh and TOFUs all peers anew.
	clearAllPins();

	// Post-compose draft — single well-known key. Matches
	// DRAFT_KEY = 'post.compose' in routes/post/+page.svelte.
	clearDraft('post.compose');

	// Feedback-leave drafts — one per order-permlink. The caller
	// (LeaveFeedbackForm) uses `feedback.<orderPermlink>` keys, so
	// we clear everything under that namespace prefix.
	clearDraftsMatching('feedback');

	// Feedback-response drafts — one per feedback-trx-id. The
	// caller (RespondToFeedbackForm) uses
	// `feedback_response.<feedbackTrxId>` keys.
	clearDraftsMatching('feedback_response');

	// Phase F.5 — trade-status entries.  Reveals which peers the
	// user has been actively trading with + amounts + memos.
	// Same privacy class as recentPeers/readState/pubPins.
	clearAllTradeStates();

	// Phase F.5 audit fix (F-44) — verifier result cache.  Holds
	// (txid, recipient, sender, amount, memo) → verify-result
	// tuples for every BLURT verification done this session.
	// Reveals trade activity by inspection.  Same privacy class
	// as the trade-status clear above.
	_clearVerifyCache();
}
