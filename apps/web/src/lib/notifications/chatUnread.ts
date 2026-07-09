/**
 * Global chat-unread channel.
 *
 * THE BUG THIS FIXES. The chat page tracked unread per-conversation, but
 * that count never reached the GLOBAL notification store — so the avatar-menu
 * badge and the Notifications menu's "Chat" row never ticked up for waiting
 * messages, on the chat page OR anywhere else. Only `feedback` was ever wired
 * to the counts; `chat` (and `order`) were dead.
 *
 * This channel polls the indexer for the signed-in account's conversations,
 * computes the unread total from read-state (`isUnread`), and pushes it into
 * the chat count. It is STATE-based (setCategoryCount, not notify): the count
 * is "how many conversations have unread messages", recomputed — not a stream
 * of discrete events. It clears naturally when the user reads a conversation
 * (markConversationRead → read-state store → recount, no network round-trip).
 *
 * Runs from startAmbientChannels() alongside the title/favicon/badge channels.
 * Logged-out → count 0, no polling. Poll cadence is gentle (60 s) and pauses
 * while the tab is hidden; a focus/visibility change forces an immediate poll
 * so a returning user sees a fresh count.
 */

import { getConversations, getChatReadState } from '$lib/indexer/client';
import { getUserBlurtAccount } from '$blurt/ops/profile';
import { readState, isUnread, mergeRemoteReadState } from '$lib/chat/readState';
import { setCategoryCount } from './index';
import { startGlobalChatActivity, subscribeChatActivity } from '$lib/chat/globalChatActivityStream';

/** How often to re-poll the conversation list while the tab is visible.
 *  Fastchat target: a peer's ping / new message must surface (inbox green
 *  dot + avatar-menu dot + tab badge) within ~6 s, so poll at 5 s to stay
 *  comfortably under that after request latency. Paused while hidden, so
 *  only foreground tabs poll this often. (A push/SSE feed would make this
 *  sub-second — future optimization; 5 s meets the "6 s max" requirement.) */
const POLL_MS = 5_000;

/** Last-fetched conversation list (peer + last_message_at only). Recount
 *  runs against this cache when read-state changes, avoiding a refetch. */
let convos: ReadonlyArray<{ peer: string; last_message_at: string }> = [];

/** Recompute the chat count from the cached conversations + current
 *  read-state. Cheap; safe to call on every read-state change. */
function recount(): void {
	const me = getUserBlurtAccount();
	if (!me) {
		setCategoryCount('chat', 0);
		return;
	}
	const meLc = me.toLowerCase();
	let n = 0;
	for (const c of convos) {
		if (c.peer.toLowerCase() === meLc) continue;
		if (isUnread(c.peer, c.last_message_at)) n++;
	}
	setCategoryCount('chat', n);
}

/** Fetch conversations + read-state, then recount. Best-effort: a
 *  transient failure keeps the last known count. */
async function poll(): Promise<void> {
	const me = getUserBlurtAccount();
	if (!me) {
		convos = [];
		setCategoryCount('chat', 0);
		return;
	}
	try {
		const [cR, rR] = await Promise.all([getConversations(me), getChatReadState(me)]);
		if (rR.ok) mergeRemoteReadState(rR.data.items);
		if (cR.ok) {
			convos = cR.data.items.map((c) => ({
				peer: c.peer,
				last_message_at: c.last_message_at
			}));
			recount();
		}
	} catch {
		// keep the last known count on a transient network/indexer failure
	}
}

/**
 * Start the global chat-unread channel. Returns a stop function that
 * clears the timer, unsubscribes from read-state, and drops the
 * visibility listener.
 */
export function startChatUnreadChannel(): () => void {
	if (typeof window === 'undefined') return () => {};

	void poll();

	const timer = window.setInterval(() => {
		if (!document.hidden) void poll();
	}, POLL_MS);

	// Reading a conversation (markConversationRead) writes read-state, which
	// should decrement the badge instantly — recount against the cached list
	// rather than waiting for the next poll. (Also fires once on subscribe.)
	const unsub = readState.subscribe(() => recount());

	const onVisible = (): void => {
		if (!document.hidden) void poll();
	};
	document.addEventListener('visibilitychange', onVisible);

	// SUB-SECOND path: the global chat-activity SSE pings the moment a new
	// message lands for this account; re-poll immediately so the badge/tab
	// update in real time instead of on the ≤5s backstop. Same-origin,
	// content-free ping — see globalChatActivityStream.ts.
	const stopActivityStream = startGlobalChatActivity();
	const unsubActivity = subscribeChatActivity(() => {
		if (!document.hidden) void poll();
	});

	return () => {
		window.clearInterval(timer);
		unsub();
		document.removeEventListener('visibilitychange', onVisible);
		unsubActivity();
		stopActivityStream();
	};
}
