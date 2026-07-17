/**
 * Morphit frontend — global chat-activity SSE subscription.
 *
 * A SINGLE EventSource to the operator's own indexer at
 * /v1/chat-activity/:me/stream. It fires a debounced callback whenever the
 * signed-in account is a participant in ANY new chat message, so the inbox
 * list and the notification badges update SUB-SECOND instead of waiting for
 * the ≤6s poll. The polls stay as the backstop if the stream is unavailable.
 *
 * PRIVACY: same-origin only (never a third party). The server pushes just a
 * peer-account ping (on-chain-public metadata) — no ciphertext, no content.
 * On a ping we re-fetch the conversation summary via the existing same-origin
 * getConversations; content stays end-to-end encrypted. See the indexer's
 * chatActivityStream.ts header for the full rationale.
 *
 * Lifecycle: `startGlobalChatActivity()` runs once (ambient, from
 * startAmbientChannels). It (re)connects when the signed-in account changes
 * and closes when logged out. EventSource auto-reconnects on transient
 * network errors. Consumers register via `subscribeChatActivity`.
 */

import { getUserBlurtAccount } from '$blurt/ops/profile';

import { folderOf, restoreThread } from '$lib/chat/chatFolders';

type Listener = () => void;

const listeners = new Set<Listener>();

/** Register a callback fired (debounced) on each chat-activity ping.
 *  Returns an unsubscribe function. */
export function subscribeChatActivity(fn: Listener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** v1.5.5 — fast-push observers, told WHICH thread a Web Push announced.
 *
 *  Separate from the plain activity ping above, which is content-free and only
 *  says "something happened, go refetch". A refetch is exactly what does NOT
 *  help here: the FAST path never writes chat_messages (it emits to SSE and
 *  enqueues the push, nothing more), so refetching at ~5s returns the same
 *  stale conversation list and the badge stays dark until the durable handler
 *  lands ~60s later. Subscribers get (peer, order) so they can act on the push
 *  itself.
 *
 *  Deliberately a subscription rather than importing chatUnread here:
 *  chatUnread already imports THIS module, so calling into it directly would
 *  close an import cycle. The dependency arrow stays one-way. */
/** v1.7.5 — `atMs` is the message's REAL time, present only on REPLAYED events
 *  (a browser that was closed when the message landed; see the indexer's
 *  chatActivityStream replay). Live pushes omit it and mean "now", which is true
 *  to within the push latency. Honouring it is what stops a replayed old message
 *  from being dated to this instant and lighting a badge already cleared. */
type FastPushListener = (peer: string, orderPermlink: string, atMs?: number) => void;
const fastPushListeners = new Set<FastPushListener>();

/** Register a callback fired for each Web Push naming a thread.
 *  Returns an unsubscribe function. */
export function subscribeFastPush(fn: FastPushListener): () => void {
	fastPushListeners.add(fn);
	return () => {
		fastPushListeners.delete(fn);
	};
}

function emitFastPush(peer: string, orderPermlink: string, atMs?: number): void {
	for (const fn of fastPushListeners) {
		try {
			fn(peer, orderPermlink, atMs);
		} catch {
			// A badge observer must never break push handling.
		}
	}
}

/** Coalesce bursts (e.g. a spammer sending rapidly, or a snapshot of several
 *  messages) into a single fire so subscribers don't refresh in a storm. */
const FIRE_DEBOUNCE_MS = 300;
let fireTimer: ReturnType<typeof setTimeout> | null = null;
function fire(): void {
	if (fireTimer !== null) return;
	fireTimer = setTimeout(() => {
		fireTimer = null;
		for (const l of listeners) {
			try {
				l();
			} catch {
				/* a listener throwing must not kill the stream */
			}
		}
	}, FIRE_DEBOUNCE_MS);
}

let es: EventSource | null = null;
let connectedMe: string | null = null;

function closeStream(): void {
	if (es !== null) {
		try {
			es.close();
		} catch {
			/* ignore */
		}
		es = null;
	}
	connectedMe = null;
}

function connectFor(me: string): void {
	closeStream();
	connectedMe = me;
	try {
		es = new EventSource(`/v1/chat-activity/${encodeURIComponent(me)}/stream`);
	} catch {
		es = null;
		connectedMe = null;
		return;
	}
	// v1.7.5 (t.txt #1) — the ping now NAMES the thread, so act on it rather than
	// only re-polling.
	//
	// This is what makes the badge fast for a user who never granted push
	// permission. Before, this listener was just `fire` — a re-poll of
	// `getConversations`, which reads the durable table the fast path
	// deliberately never writes (ADR-0051 invariant #1). So the poll re-read the
	// same stale `last_message_at` and the badge sat dark for ~45-63s. The Web
	// Push carried the thread; this ping didn't. The badge was therefore only ever
	// as fast as the user's notification permission — and silently slow for
	// everyone else.
	//
	// Same handling as CHAT_PUSH, deliberately: resurrect an archived thread, then
	// light it. Two paths, one rule.
	es.addEventListener('chat_activity', (ev) => {
		try {
			const d = JSON.parse((ev as MessageEvent).data as string) as {
				peer?: unknown;
				order?: unknown;
				inbound?: unknown;
				at?: unknown;
			};
			// `inbound !== true` covers BOTH the durable path (which sends
			// inbound:false because its event carries no direction) and a message
			// this account SENT. Badging on either would nag the sender about their
			// own words on their other devices — t.txt #2. Falling through to
			// `fire()` still reconciles, which is all the durable path needs.
			if (d.inbound === true && typeof d.peer === 'string' && d.peer && typeof d.order === 'string') {
				if (folderOf(d.peer, d.order) === 'archived') restoreThread(d.peer, d.order);
				// `at` is present on REPLAYED events (a browser that was closed when the
				// message landed) and carries the message's real block time. Passing it
				// through is what stops a replayed old message from being dated to now
				// and lighting a badge the user already cleared.
				emitFastPush(d.peer, d.order, typeof d.at === 'number' ? d.at : undefined);
			}
		} catch {
			// A malformed ping must never break the backstop poll below.
		}
		fire();
	});
	es.addEventListener('ready', fire);
	// No error handler needed to reconnect — EventSource does that itself.
}

/**
 * Start the ambient global chat-activity stream. Reconnects when the
 * signed-in account changes; closes when logged out. Returns a stop
 * function (clears the account-watch timer and closes the stream).
 */
export function startGlobalChatActivity(): () => void {
	if (typeof EventSource === 'undefined') return () => {};

	const sync = (): void => {
		const me = getUserBlurtAccount();
		if (!me) {
			closeStream();
			return;
		}
		if (me !== connectedMe) connectFor(me);
	};

	sync();
	// Re-check the signed-in account so login/logout (re)connects promptly.
	const watch = window.setInterval(sync, 5_000);

	// cp471 — the service worker receives Web Pushes even for a backgrounded
	// tab (it is not throttled) and postMessages every tab `{ type: 'CHAT_PUSH' }`.
	// Treat that exactly like an EventSource ping: refresh the conversation
	// summary so the unread badges (favicon + avatar dots) and the OS app-badge
	// update promptly even when this tab is inactive and its own stream/poll is
	// throttled. This is what lets an untouched tab badge like Element does.
	const onSwMessage = (ev: MessageEvent): void => {
		const data = ev.data as { type?: unknown; peer?: unknown; order?: unknown } | null;
		if (data && data.type === 'CHAT_PUSH') {
			// v1.5.0 fast archived-restore — if the push names an ARCHIVED thread,
			// pull it back into the Inbox immediately (Gmail-style) rather than
			// waiting ~irreversibility for getConversations to surface the message.
			if (typeof data.peer === 'string' && data.peer) {
				const order = typeof data.order === 'string' ? data.order : '';
				if (folderOf(data.peer, order) === 'archived') restoreThread(data.peer, order);
				// v1.5.5 — light the badge NOW, straight off the push, instead of
				// waiting for the indexer. `fire()` below only triggers a refetch,
				// and the FAST path never writes chat_messages (it emits to SSE +
				// enqueues the push and nothing else) — so the refetch at ~5s
				// returns the same stale last_message_at and the badge stayed dark
				// for ~60s. That's Ken's kentest3, sitting on another tab with the
				// system notification already delivered.
				//
				// No spam risk and no gate duplicated here: the fast-notify gate
				// upstream refuses to push for anyone but an established
				// counterparty, so no push means no bump.
				emitFastPush(data.peer, order);
			}
			fire();
		}
	};
	const swContainer =
		typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
	swContainer?.addEventListener('message', onSwMessage);

	return () => {
		window.clearInterval(watch);
		swContainer?.removeEventListener('message', onSwMessage);
		if (fireTimer !== null) {
			clearTimeout(fireTimer);
			fireTimer = null;
		}
		closeStream();
	};
}
