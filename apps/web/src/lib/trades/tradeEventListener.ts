/**
 * tradeEventListener — global chat SSE subscriber that powers
 * cross-page trade-status updates, toasts, and (opt-in)
 * browser notifications.
 *
 * Phase F.5.  When the user is logged in, this module opens
 * one chat SSE stream per peer in their recent-peers list.
 * Incoming structured payloads (morphit_addr,
 * morphit_funds_sent) update the tradeStatus store.  Relevant
 * events also fire UI affordances:
 *
 *   - In-app toast: always (subject to visibility gate — we
 *     don't double-toast if the user is on the chat page where
 *     the same event renders a pill).
 *   - Browser notification: if the user opted in via Settings
 *     and the document is hidden.
 *
 * ─── Why one stream per peer (not a single global stream) ─────
 *
 * The indexer's chat SSE endpoint takes (me, peer).  A single
 * "subscribe to all chat events involving me" endpoint would be
 * cleaner but would require new indexer surface area.  Keeping
 * the streams per-peer respects the existing protocol; the
 * connection cost is bounded by recent-peers size (~10 max).
 *
 * Trade-off: the user's ConversationView ALSO opens a stream
 * for the active conversation.  Both this listener and the
 * conversation view receive the same events.  The store
 * mutators are idempotent (monotonic phase advancement) so
 * duplicate calls are safe; toast firing is gated to avoid
 * double-toasting.
 *
 * ─── Lifecycle ────────────────────────────────────────────────
 *
 * +layout.svelte mounts a single instance via startTradeEventListener
 * once the user is logged in.  refreshTradeEventListener is
 * called whenever the recent-peers list changes.  Lock /
 * logout calls stopTradeEventListener.
 */

import { browser } from '$app/environment';
import { createChatStream, type ChatStreamHandle } from '$lib/chat/stream';
import { decodePayload, isValidBlurtAccount } from '$lib/chat/payload';
import { decryptFromSender, DecryptError, deriveChatIdentity } from '$lib/chat/crypto';
import { loadRecentPeers } from '$lib/chat/recentPeers';
import { recordAddressShared, recordFundsSent } from '$lib/trades/tradeStatus';
import { triggerBlurtVerification } from '$lib/trades/tradeVerify';
import { planListenerDispatch } from '$lib/trades/listenerDispatch';
import { showToast } from '$lib/stores/toast';
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { liveIdentity } from '$stores/identity';
import { tradeNotificationsEnabled } from '$lib/notifications/tradeNotifications';
import type { ChatMessageRecord } from '@morphit/indexer-client';

interface PerPeerStream {
	readonly peer: string;
	readonly handle: ChatStreamHandle;
	/** Set of message ids we've already routed.  The SSE snapshot
	 *  on connect / reconnect can replay messages we've already
	 *  seen; dedup prevents toasting the same arrival twice. */
	readonly seenIds: Set<number>;
}

/** Phase F.5 audit fix (F-21) — cap concurrent listener streams.
 *
 *  Browsers limit 6 concurrent connections per origin on
 *  HTTP/1.1.  Each listener stream uses one of those slots for
 *  its lifetime (SSE long-poll).  If we open one stream per peer
 *  in the full recent-peers list (up to 20), we'd exhaust the
 *  HTTP/1.1 budget — most streams would queue indefinitely and
 *  the cross-page trade-status feature would silently fail.
 *
 *  HTTP/2 doesn't have this problem (limit is in the hundreds),
 *  but Morphit operators control the deployment and may run
 *  HTTP/1.1.  Capping at 5 leaves at least one connection slot
 *  free for ad-hoc requests (profile fetches, stream-reconnect
 *  retries) under HTTP/1.1.
 *
 *  Recent-peers list is sorted most-recent-first by
 *  recordRecentPeer; we slice the prefix so the user's most
 *  active conversations get cross-page coverage.  Older recent
 *  peers fall back to the in-page chatService when the user
 *  opens that specific conversation.
 *
 *  Document HTTP/2 as deployment requirement in OPERATIONS.md. */
const MAX_LISTENER_STREAMS = 5;

let me: string | null = null;
const streams = new Map<string, PerPeerStream>();

/** Decrypt a record using the locally-cached identity if
 *  available.  Returns the plaintext on success or null on any
 *  failure (decryption errors, missing identity, malformed
 *  envelope).  This is a defensive read — we surface nothing
 *  to the UI if we can't decrypt; the user will see the
 *  message normally when they open the chat. */
async function tryDecrypt(rec: ChatMessageRecord): Promise<string | null> {
	if (me === null) return null;
	if (rec.sender === me) return null; // we don't toast our own outgoing
	const live = get(liveIdentity);
	if (!live) return null;

	try {
		const header = rec.header as Record<string, unknown> | null;
		if (
			header === null ||
			typeof header !== 'object' ||
			typeof header.ephemeral_pub !== 'string' ||
			typeof header.nonce !== 'string'
		) {
			return null;
		}
		const envelope = {
			ephemeralPub: header.ephemeral_pub,
			nonce: header.nonce,
			ciphertext: rec.ciphertext
		};
		// LiveIdentity carries posting + memo keys; chat keys are
		// derived deterministically from the posting private key
		// per ADR-0014.  Re-deriving on each decrypt is cheap
		// (BLAKE2b once) and keeps chat keys out of session memory.
		const chatKeys = await deriveChatIdentity(live.posting.privateKey, me);
		const plaintext = await decryptFromSender(envelope, chatKeys, rec.sender, rec.recipient);
		return plaintext;
	} catch (err) {
		if (err instanceof DecryptError) return null;
		// Phase F.5 audit fix (F-25) — surface unexpected errors
		// via console.warn so developers notice listener bugs
		// instead of silent inaction.  PII-safe: log the error
		// class only, not the rec contents (ciphertext, header).
		// Listener stays best-effort regardless — return null so
		// the caller continues normally.
		if (typeof console !== 'undefined') {
			const errName = err instanceof Error ? err.constructor.name : 'unknown';
			console.warn('[tradeEventListener] tryDecrypt unexpected error:', errName);
		}
		return null;
	}
}

/** Try the browser Notification API.  Silent no-op on permission
 *  denial or missing API.
 *
 *  Phase F.5 audit fix (F-31) — tag includes the order permlink
 *  so different trades produce SEPARATE notifications.  Updates
 *  to the SAME trade (e.g. address-shared → funds-sent) still
 *  coalesce, which is desirable. */
function maybeBrowserNotify(title: string, body: string, tag: string): void {
	if (!browser) return;
	if (typeof Notification === 'undefined') return;
	if (Notification.permission !== 'granted') return;
	if (!get(tradeNotificationsEnabled)) return;
	// Only surface when the document is hidden — visible pages
	// show toast instead.
	if (typeof document !== 'undefined' && !document.hidden) return;
	try {
		new Notification(title, { body, tag });
	} catch {
		// Silent.  Quotas / focus rules vary per browser.
	}
}

async function handleAppend(peer: string, rec: ChatMessageRecord): Promise<void> {
	const stream = streams.get(peer);
	if (stream === undefined) return;
	if (stream.seenIds.has(rec.id)) return;
	addSeenId(stream.seenIds, rec.id);

	// Phase F.5 audit fix (F-26) — defense-in-depth account name
	// validation.  The indexer already validates sender names but
	// a malformed value slipping through would corrupt store keys
	// and deep-links.  Cheap to re-check.
	if (!isValidBlurtAccount(rec.sender)) return;

	const plaintext = await tryDecrypt(rec);
	if (plaintext === null) return;

	// Phase F.5 audit fix (F-30) — re-check listener state after
	// the async decrypt window.  If the stream was closed (peer
	// rotated out, listener stopped) OR the user explicit-locked
	// (clears `me` and `clearAllTradeStates`) during decryption,
	// abort before any store write.  Without this guard, a
	// post-lock store write could leak a trade-status entry that
	// the explicit-lock contract promised to wipe.
	if (me === null) return;
	if (!streams.has(peer)) return;

	const decoded = decodePayload(plaintext);

	// Phase F.5 audit fix (F-32) — pure dispatch.  All routing
	// decisions live in listenerDispatch.ts; this function applies
	// the resulting plan via real I/O.
	const plan = planListenerDispatch(decoded, {
		sender: rec.sender,
		me,
		currentPathname: typeof window !== 'undefined' ? window.location.pathname : ''
	});

	if (plan.store !== null) {
		if (plan.store.kind === 'recordAddressShared') {
			recordAddressShared(plan.store.args);
		} else {
			recordFundsSent(plan.store.args);
		}
	}

	if (plan.verify !== null) {
		// Phase F.5 audit fix (F-41) — trigger on-chain verification
		// from the listener so the badge updates regardless of
		// which page the user is on.
		triggerBlurtVerification(plan.verify);
	}

	if (plan.notify !== null) {
		const t = get(_);
		const title = t(plan.notify.i18n.titleKey, {
			values: plan.notify.i18n.values
		}) as string;
		const body = t(plan.notify.i18n.bodyKey, {
			values: plan.notify.i18n.values
		}) as string;
		showToast(body, plan.notify.toastKind, { href: plan.notify.href });
		maybeBrowserNotify(title, body, plan.notify.notificationTag);
	}
}

/** Phase F.5 audit fix (F-22) — cap on seenIds Set per stream.
 *  Snapshot is 50 IDs; live arrivals append.  100 gives 2× the
 *  snapshot's worth of headroom so reconnect-replay doesn't
 *  collide with the cap.  At 8 bytes per number ID × 5 streams ×
 *  100 ids = ~4KB total.  Without the cap, a long-lived
 *  listener accumulates one ID per chat message ever seen on
 *  any monitored peer → unbounded growth. */
const MAX_SEEN_IDS = 100;

function openStream(peer: string): void {
	if (me === null) return;
	if (streams.has(peer)) return;

	const seenIds = new Set<number>();
	const handle = createChatStream({
		me,
		peer,
		handlers: {
			onSnapshot: (snap) => {
				// Snapshot on initial connect: pre-populate seenIds
				// from history so we don't toast for messages that
				// landed BEFORE this listener attached.  The toast
				// is for live arrivals only.
				for (const item of snap.items) {
					addSeenId(seenIds, item.id);
				}
			},
			applyAppend: (rec) => {
				void handleAppend(peer, rec);
			}
		}
	});
	handle.start();
	streams.set(peer, { peer, handle, seenIds });
}

/** Add an ID to the seen-set, evicting the oldest entry when
 *  over cap.  Sets preserve insertion order in JS, so iterating
 *  yields oldest-first. */
function addSeenId(set: Set<number>, id: number): void {
	if (set.has(id)) return;
	set.add(id);
	while (set.size > MAX_SEEN_IDS) {
		// Iterator's first value is the oldest insertion.
		const oldest = set.values().next().value;
		if (oldest === undefined) break;
		set.delete(oldest);
	}
}

function closeStream(peer: string): void {
	const stream = streams.get(peer);
	if (stream === undefined) return;
	stream.handle.stop();
	streams.delete(peer);
}

/** Start the listener for a logged-in user.  Opens streams for
 *  every peer currently in the recent-peers list.  Idempotent —
 *  calling multiple times for the same `account` is a no-op. */
export function startTradeEventListener(account: string): void {
	if (!browser) return;
	if (me === account) return;
	if (me !== null) stopTradeEventListener();
	me = account;
	// F-21: cap stream count to MAX_LISTENER_STREAMS, picking the
	// most-recent peers (recent-peers list is sorted newest-first).
	const peers = loadRecentPeers().slice(0, MAX_LISTENER_STREAMS);
	for (const peer of peers) {
		if (peer === account) continue; // self-chat not a thing
		openStream(peer);
	}
}

/** Refresh the active set against the current recent-peers list.
 *  Open streams for new peers, close streams for peers no longer
 *  in the list.  Called when recordRecentPeer fires. */
export function refreshTradeEventListener(): void {
	if (me === null) return;
	// F-21: same cap as startup.  As conversations rotate (new
	// peer appears at the top), older peers drop out of the
	// listener even if still in the recent-peers list.
	const peers: Set<string> = new Set(loadRecentPeers().slice(0, MAX_LISTENER_STREAMS));
	for (const existing of streams.keys()) {
		if (!peers.has(existing)) closeStream(existing);
	}
	for (const peer of peers) {
		if (peer === me) continue;
		if (!streams.has(peer)) openStream(peer);
	}
}

/** Stop all streams.  Called on lock / logout. */
export function stopTradeEventListener(): void {
	for (const peer of [...streams.keys()]) {
		closeStream(peer);
	}
	me = null;
}
