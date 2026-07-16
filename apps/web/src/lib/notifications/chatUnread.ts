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
import { chatFolders, isArchived, resurrectArchivedOnNewActivity } from '$lib/chat/chatFolders';
import { hiddenAccounts } from '$lib/utils/hiddenAccounts';
import { blockedAccounts, loadBlocks } from '$lib/chat/blocks';
import { setCategoryCount } from './index';
import {
	startGlobalChatActivity,
	subscribeChatActivity,
	subscribeFastPush
} from '$lib/chat/globalChatActivityStream';

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

/** v1.5.5 — OPTIMISTIC fast-chat overlay: threads a Web Push has told us about
 *  but the indexer hasn't published yet. Keyed `peer\u0000order`, value = when the
 *  push arrived.
 *
 *  WHY. `convos` is DB-derived, and the FAST path is deliberately ephemeral: the
 *  head-block tailer emits to SSE and enqueues the push, but it does NOT write
 *  chat_messages — only the durable handler does, ~60s later. So a push could
 *  land in ~5s while `last_message_at` sat unchanged and the badge stayed dark
 *  for the best part of a minute. Ken, on kentest3 sitting on another tab:
 *  "he should have received a fastnotif (not just the fast system notif)".
 *
 *  This is NOT a second source of truth. It only ever ADDS a thread to the
 *  count, it holds no message content, and the next poll (≤5s) supersedes it
 *  with the real row the moment the indexer catches up.
 *
 *  SPAM-SAFE BY CONSTRUCTION, without duplicating the anti-spam gates: the only
 *  thing that can put an entry here is a delivered Web Push, and the fast-notify
 *  gate already refuses to push for anyone but an established counterparty. No
 *  push, no bump. Ken: "unless it's a spammer, fastnotifs please." */
const fastPending = new Map<string, number>();

/** Discard an optimistic entry once the real conversation catches up or it goes
 *  stale. Generous vs the ~60s durable lag, since the cost of holding one is a
 *  single lit thread and the cost of dropping it early is the dark badge we're
 *  fixing. */
const FAST_PENDING_TTL_MS = 10 * 60 * 1000;

function fastKey(peer: string, order: string): string {
	return `${peer.toLowerCase()}\u0000${order}`;
}

/**
 * v1.5.5 — record that a Web Push announced a message on (peer, order), and
 * light the badge NOW rather than waiting for the indexer.
 *
 * Called from the CHAT_PUSH service-worker handler. Idempotent; the newest
 * timestamp wins.
 */
export function noteFastChatPush(peer: string, orderPermlink: string): void {
	if (!peer) return;
	fastPending.set(fastKey(peer, orderPermlink), Date.now());
	recount();
}

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
	const order = c.order?.permlink ?? '';
	return !isArchived(c.peer, order);
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
	const counted = new Set<string>();
	for (const c of convos) {
		if (!badgeEligible(c, meLc, hidden, blocked)) continue;
		// cp446 — one count per DISCUSSION: three unread threads with the same
		// person are three unread conversations, exactly as in an email inbox.
		const order = c.order?.permlink ?? '';
		counted.add(fastKey(c.peer, order));
		if (isUnread(c.peer, order, c.last_message_at)) n++;
	}
	// v1.5.5 — add threads a push announced that the indexer hasn't published
	// yet, so the badge lights in ~5s instead of ~60s. Drop an entry as soon as
	// the real conversation carries the message (its last_message_at has caught
	// up past the push), or once it's simply stale.
	const now = Date.now();
	for (const [key, at] of fastPending) {
		if (now - at > FAST_PENDING_TTL_MS) {
			fastPending.delete(key);
			continue;
		}
		const sep = key.indexOf('\u0000');
		const peer = key.slice(0, sep);
		const order = key.slice(sep + 1);
		const real = convos.find(
			(c) => c.peer.toLowerCase() === peer && (c.order?.permlink ?? '') === order
		);
		if (real && new Date(real.last_message_at).getTime() >= at) {
			// The durable row landed — the loop above already judged it.
			fastPending.delete(key);
			continue;
		}
		if (counted.has(key)) continue; // already counted as unread above
		// SAME eligibility as every other counted thread — a push must never
		// light the badge for a self/hidden/blocked/archived thread the inbox
		// won't show, or the count outruns the visible cards (the cp452 bug).
		if (!badgeEligible({ peer, order: order ? { permlink: order } : null }, meLc, hidden, blocked)) {
			continue;
		}
		// Judge it by the SAME read-state rule as a real conversation, treating
		// the push's arrival as the message time. Without this the entry would
		// count unconditionally and OPENING the thread wouldn't clear the badge
		// — it would sit lit until the TTL expired.
		if (!isUnread(peer, order, new Date(at).toISOString())) {
			fastPending.delete(key);
			continue;
		}
		n++;
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
			// v1.4.10 — Gmail-style un-archive, GLOBALLY. This channel runs on
			// every page (and re-polls on the activity ping even while the tab is
			// hidden), so doing the resurrect here — not only on the inbox page —
			// is what guarantees a new message to an ARCHIVED thread surfaces + the
			// favicon/avatar badge (and sound) fire even when the user is on another
			// page or off in another browser tab. Un-archiving moves the thread into
			// the badge-eligible set; the folder-store change triggers recount via
			// the subscription below, and recount() runs anyway.
			resurrectArchivedOnNewActivity(
				convos.map((c) => ({
					peer: c.peer,
					orderPermlink: c.order?.permlink ?? '',
					lastMessageAt: c.last_message_at
				}))
			);
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
	//
	// v1.4.8 (t.txt #6) — do NOT gate this on `!document.hidden`. A background
	// notification is exactly the case where the tab IS hidden: the whole point
	// is that the favicon/title badge updates while the user is on another tab so
	// they see there's a new message when they glance back. The ping is
	// event-driven (fires only on a real new message for this account), so a poll
	// per ping is cheap even when hidden. The interval backstop above stays gated
	// to avoid idle polling; the event stream covers the hidden-tab case.
	const stopActivityStream = startGlobalChatActivity();
	const unsubActivity = subscribeChatActivity(() => {
		void poll();
	});
	// v1.5.5 — a Web Push names the thread it's about, so light that thread's
	// badge immediately instead of waiting for the indexer. The poll above is
	// the reconciler, not the trigger: the fast path never writes
	// chat_messages, so polling on a push just re-reads the same stale
	// last_message_at (the ~60s dark badge Ken reported on kentest3's other
	// tab).
	const unsubFastPush = subscribeFastPush((peer, order) => {
		// cp474 (t.txt #3 + #4) — a push for an ARCHIVED thread used to light
		// nothing for ~60s, and this is why.
		//
		// `noteFastChatPush` files the thread in `fastPending`, but `recount()`
		// then runs it through `badgeEligible`, which ends in `!isArchived(...)`
		// — so an archived thread's push was counted, judged, and dropped. The
		// badge could only light once the MAIN indexer wrote `chat_messages`
		// (~60s), `poll()` read a fresh `last_message_at`, and the resurrect below
		// finally un-archived the thread. That single dependency produced BOTH of
		// Ken's symptoms at once: the ~1-minute dark badge, and the new message
		// sitting in Archived instead of moving to the Inbox.
		//
		// The eligibility check itself is right and stays (cp452: a badge that
		// outruns the visible cards nags about threads the inbox won't show). The
		// error was treating "archived" as a reason to stay silent, when a message
		// arriving after you archived a thread is precisely the Gmail-style
		// new-activity signal that should un-archive it. The push IS that signal —
		// it fires only for a genuinely new message for this account — so resurrect
		// on the push rather than waiting for the indexer to publish the same fact
		// a minute later.
		//
		// Resurrect FIRST, then note: un-archiving sets the folder store, whose
		// existing subscription recounts, and `noteFastChatPush`'s own recount then
		// sees a thread that is both eligible and fast-pending. Both land inside the
		// push's own ~6s latency, and both happen wherever the user is standing —
		// this is an AMBIENT channel, not the chat page's.
		//
		// Wall-clock is the honest activity time here: the push carries no message
		// timestamp, and it means "a message just landed", so now ≈ message time to
		// within the push latency. `resurrectArchivedOnNewActivity` only acts when
		// the activity POSTDATES the archive, so a thread archived after its last
		// message still stays put — the property that keeps the Archived tab from
		// dumping itself into the Inbox.
		//
		// Starred threads are deliberately NOT touched: folders are exclusive, so
		// moving one to the Inbox would silently destroy the star the user chose.
		// They already badge correctly — `badgeEligible` excludes only archived.
		resurrectArchivedOnNewActivity([
			{ peer, orderPermlink: order, lastMessageAt: new Date().toISOString() }
		]);
		noteFastChatPush(peer, order);
	});

	return () => {
		window.clearInterval(timer);
		unsub();
		unsubFolders();
		unsubHidden();
		unsubBlocked();
		unsubFastPush();
		document.removeEventListener('visibilitychange', onVisible);
		unsubActivity();
		stopActivityStream();
	};
}
