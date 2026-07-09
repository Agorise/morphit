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
	es.addEventListener('chat_activity', fire);
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

	return () => {
		window.clearInterval(watch);
		if (fireTimer !== null) {
			clearTimeout(fireTimer);
			fireTimer = null;
		}
		closeStream();
	};
}
