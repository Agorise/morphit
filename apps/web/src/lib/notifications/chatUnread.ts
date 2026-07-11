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

import { get } from 'svelte/store';
import { getConversations, getChatReadState } from '$lib/indexer/client';
import { getUserBlurtAccount } from '$blurt/ops/profile';
import {
	readState,
	isUnread,
	mergeRemoteReadState,
	markConversationRead
} from '$lib/chat/readState';
import { chatFolders, isArchived } from '$lib/chat/chatFolders';
import { hiddenAccounts } from '$lib/utils/hiddenAccounts';
import { blockedAccounts, loadBlocks } from '$lib/chat/blocks';
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
let convos: ReadonlyArray<{
	peer: string;
	last_message_at: string;
	/** cp446 — the discussion this row is about; null when it cites no order. */
	order: { permlink: string } | null;
}> = [];

/** A conversation feeds the chat badge iff it is not with yourself, not
 *  archived, and its peer is neither hidden (orderbook "hide") nor blocked —
 *  exactly the set the inbox renders (chat/+page.svelte filters hidden +
 *  blocked, then drops archived from the nag total). Before cp452 the badge
 *  skipped only self + archived, so an unread thread with a hidden or blocked
 *  peer inflated the avatar/favicon badge above the visible unread cards
 *  (t.txt item 1 — badge said 2 while no card was lit). Keeping this predicate
 *  identical to the inbox keeps the count and the cards in lockstep. */
function badgeEligible(
	c: { peer: string; order: { permlink: string } | null },
	meLc: string,
	hidden: ReadonlySet<string>,
	blocked: ReadonlySet<string>
): boolean {
	const peerLc = c.peer.toLowerCase();
	if (peerLc === meLc) return false;
	if (hidden.has(peerLc) || blocked.has(peerLc)) return false;
	return !isArchived(c.peer, c.order?.permlink ?? '');
}

/** Recompute the chat badge from the cached conversations + current
 *  read-state. Cheap; safe to call on every read-state / folder change. */
function recount(): void {
	const me = getUserBlurtAccount();
	if (!me) {
		setCategoryCount('chat', 0);
		return;
	}
	const meLc = me.toLowerCase();
	const hidden = get(hiddenAccounts);
	const blocked = get(blockedAccounts);
	let n = 0;
	for (const c of convos) {
		if (!badgeEligible(c, meLc, hidden, blocked)) continue;
		// cp446 — one count per DISCUSSION: three unread threads with the same
		// person are three unread conversations, exactly as in an email inbox.
		if (isUnread(c.peer, c.order?.permlink ?? '', c.last_message_at)) n++;
	}
	setCategoryCount('chat', n);
}

/** Acknowledge EVERY badge-eligible unread discussion as read, so the
 *  avatar-menu / favicon chat badge drops to zero the same way the inbox's own
 *  "Mark all read" does. cp452 (t.txt item I): the avatar-menu "Mark all read"
 *  called notifications.markRead(), which deliberately skips the state-based
 *  chat count — so it could never clear a chat badge. This gives it a real way
 *  to acknowledge chat, over the SAME (peer, order) read-state the inbox uses.
 *
 *  Clock-safe ack: markConversationRead is latest-call-wins (stores the ack
 *  verbatim), and isUnread compares against the chain's last_message_at — so a
 *  browser clock running behind chain would leave the thread lit if we acked
 *  with a bare now(). Ack no earlier than the newest message we can see. */
export function markAllChatRead(): void {
	const me = getUserBlurtAccount();
	if (!me) return;
	const meLc = me.toLowerCase();
	const hidden = get(hiddenAccounts);
	const blocked = get(blockedAccounts);
	const now = new Date();
	for (const c of convos) {
		if (!badgeEligible(c, meLc, hidden, blocked)) continue;
		const order = c.order?.permlink ?? '';
		if (!isUnread(c.peer, order, c.last_message_at)) continue;
		const lastAt = new Date(c.last_message_at);
		const ack =
			Number.isFinite(lastAt.getTime()) && lastAt.getTime() > now.getTime() ? lastAt : now;
		markConversationRead(c.peer, order, ack);
	}
	recount();
}

/** The account we've kicked a blocked-set load for. loadBlocks fetches from
 *  the indexer; we only need it once per signed-in account (later Block/Unblock
 *  mutations update the store directly and trigger a recount via subscription).
 *  Without this, the badge would over-count blocked-peer threads until the user
 *  happened to open the inbox (which is what loads blocks). */
let blocksLoadedFor: string | null = null;

/** Fetch conversations + read-state, then recount. Best-effort: a
 *  transient failure keeps the last known count. */
async function poll(): Promise<void> {
	const me = getUserBlurtAccount();
	if (!me) {
		convos = [];
		blocksLoadedFor = null;
		setCategoryCount('chat', 0);
		return;
	}
	if (blocksLoadedFor !== me) {
		blocksLoadedFor = me;
		// Populate the blocked set so the badge filter matches the inbox even
		// for a user who never opens the inbox. Best-effort; a failure just
		// leaves the set empty (badge falls back to the pre-cp452 behaviour).
		void loadBlocks(me);
	}
	try {
		const [cR, rR] = await Promise.all([getConversations(me), getChatReadState(me)]);
		if (rR.ok) mergeRemoteReadState(rR.data.items);
		if (cR.ok) {
			convos = cR.data.items.map((c) => ({
				order: c.order ? { permlink: c.order.permlink } : null,
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

	// Archiving / restoring a discussion changes what counts toward the badge
	// (archived is excluded), so recompute when the folder store changes too.
	// (Also fires once on subscribe.)
	const unsubFolders = chatFolders.subscribe(() => recount());

	// Hiding (orderbook "hide") or blocking a peer removes their threads from
	// the inbox — the badge must drop in lockstep or it nags about hidden
	// conversations (cp452, t.txt item 1). Recount when either set changes.
	// (Both also fire once on subscribe.)
	const unsubHidden = hiddenAccounts.subscribe(() => recount());
	const unsubBlocked = blockedAccounts.subscribe(() => recount());

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
		unsubFolders();
		unsubHidden();
		unsubBlocked();
		document.removeEventListener('visibilitychange', onVisible);
		unsubActivity();
		stopActivityStream();
	};
}
