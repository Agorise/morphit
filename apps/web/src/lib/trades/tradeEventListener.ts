/**
 * tradeEventListener — the global listener that powers cross-page
 * trade-status updates, toasts, and (opt-in) browser notifications.
 *
 * Phase F.5.  Incoming structured payloads (morphit_addr,
 * morphit_funds_sent) update the tradeStatus store.  Relevant
 * events also fire UI affordances:
 *
 *   - In-app toast: always (subject to visibility gate — we
 *     don't double-toast if the user is on the chat page where
 *     the same event renders a pill).
 *   - Browser notification: if the user opted in via Settings
 *     and the document is hidden.
 *
 * ─── What it listens to (v1.21.14 full chat audit, W-H2) ──────────
 *
 * It used to hold one chat stream OPEN per recent peer (up to five), next
 * to the account-wide activity stream and the open conversation's own: seven
 * long-lived connections to one site. A Tor or I2P instance is plain
 * http:// (no HTTP/2), and a browser allows six HTTP/1.1 connections per
 * site, so sends, history reads and the backup poll queued behind streams.
 *
 * Now it holds NONE of its own. The account-wide activity stream
 * (globalChatActivityStream) already names the peer of every new message;
 * on a ping the listener reads that peer's conversation once — a chat
 * stream opened only for its first answer (the snapshot, which carries the
 * newest durable rows AND the fast copies not yet durable) and closed at
 * once — one peer at a time. At most MAX_LISTENER_STREAMS such read is open
 * at any moment, so the app holds at most three long-lived connections to
 * its site: the activity stream, the open conversation, and this read.
 *
 * ─── Which messages count ─────────────────────────────────────────
 *
 * A message is known by its SENDER AND ENCRYPTED BYTES (as chatService's
 * wireOf), never by id: every fast copy carries id 0, so keying by id
 * dropped every fast copy after the first and processed each durable copy a
 * second time, putting a verified payment back to "pending" (W-M4). The
 * first read of a peer takes what is already durable as history (not
 * news, like the old per-peer snapshot); fast copies in it are news.
 *
 * A payload moves a trade only for the order of the thread it arrived in,
 * when that order belongs to its sender or to us (W-H1; see
 * applyRecord), under that owner (C-L3).
 *
 * ─── Lifecycle ────────────────────────────────────────────────
 *
 * +layout.svelte starts it once the user is unlocked
 * (startTradeEventListener) and stops it on lock / logout
 * (stopTradeEventListener).
 */

import { browser } from '$app/environment';
import { createChatStream, type ChatStreamHandle } from '$lib/chat/stream';
import { decodePayload, isValidBlurtAccount } from '$lib/chat/payload';
// chat/crypto (which pulls libsodium ~1 MB) is imported DYNAMICALLY
// inside tryDecrypt below — byte budget. A static import here
// would drag libsodium into the shared [lang] layout closure (this
// listener is started from +layout), i.e. onto EVERY page's first load.
import { subscribeChatActivityPings } from '$lib/chat/globalChatActivityStream';
import { recordAddressShared, recordFundsSent } from '$lib/trades/tradeStatus';
import { triggerBlurtVerification } from '$lib/trades/tradeVerify';
import { planListenerDispatch } from '$lib/trades/listenerDispatch';
import { orderOwnerOf } from '$lib/trades/orderParties';
import { showToast } from '$lib/stores/toast';
import { get } from 'svelte/store';
import { _, locale } from 'svelte-i18n';
import { liveIdentity } from '$stores/identity';
import { notify } from '$lib/notifications';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import type { LiveIdentity } from '$crypto/keygen';

/** At most this many conversation reads (each a chat stream open until its
 *  snapshot) at once — W-H2. One: they run one after the other. */
const MAX_LISTENER_STREAMS = 1;
/** A read with no snapshot by then is given up (and tried again later). */
export const LISTENER_READ_TIMEOUT_MS = 30_000;
/** A failed read is tried again after this, doubling, at most this often. */
const READ_RETRY_MIN_MS = 2_000;
const READ_RETRY_MAX_MS = 60_000;
const READ_RETRY_MAX_TRIES = 5;
/** Messages remembered per peer, and peers remembered. */
const MAX_SEEN_PER_PEER = 200;
const MAX_PEERS_SEEN = 50;

let me: string | null = null;
let unsubscribePings: (() => void) | null = null;
/** Bumped by every start/stop: work begun under an older one stops. */
let generation = 0;
/** Peers waiting for a read, in order; and those being read now. */
const queue: string[] = [];
const reading = new Map<string, ChatStreamHandle>();
/** peer → the messages (sender + bytes) already looked at. */
const seen = new Map<string, Set<string>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryTries = new Map<string, number>();

/** A message's identity: its sender and encrypted bytes — the fast copy and
 *  the durable one are the same message (chatService wireOf). */
function copyKey(rec: ChatMessageRecord): string {
	const h = (rec.header ?? {}) as { ephemeral_pub?: unknown; nonce?: unknown };
	const part = (v: unknown): string => (typeof v === 'string' ? v : '');
	return `${rec.sender}|${rec.ciphertext}|${part(h.ephemeral_pub)}|${part(h.nonce)}`;
}

function seenFor(peer: string): Set<string> | undefined {
	return seen.get(peer);
}

function markSeen(peer: string, key: string): void {
	let set = seen.get(peer);
	if (set === undefined) {
		set = new Set();
		seen.set(peer, set);
		while (seen.size > MAX_PEERS_SEEN) {
			const oldest = seen.keys().next().value;
			if (oldest === undefined) break;
			seen.delete(oldest);
		}
	}
	set.add(key);
	while (set.size > MAX_SEEN_PER_PEER) {
		const oldest = set.values().next().value;
		if (oldest === undefined) break;
		set.delete(oldest);
	}
}

/** Decrypt a record using the locally-cached identity if
 *  available.  Returns the plaintext on success or null on any
 *  failure (decryption errors, missing identity, malformed
 *  envelope, or a message whose sender is not PROVED — the older
 *  v1 envelope, which anyone who knows our public chat key could
 *  have written: it must never drive a trade).  This is a defensive
 *  read — we surface nothing to the UI if we can't decrypt; the user
 *  will see the message normally when they open the chat. */
async function tryDecrypt(rec: ChatMessageRecord): Promise<string | null> {
	if (me === null) return null;
	if (rec.sender === me) return null; // we don't toast our own outgoing
	const live = get(liveIdentity);
	if (!live) return null;
	return openTradeMessage(rec, me, live);
}

/**
 * Open a message TO `me` for the trade listener: the plaintext only when its
 * sender is PROVED by the key pinned for them (v2: chat key; v3: posting key,
 * v1.21.13), else null — an unproved message must never move a trade.
 * Exported for tests.
 */
export async function openTradeMessage(
	rec: ChatMessageRecord,
	me: string,
	live: LiveIdentity
): Promise<string | null> {
	// byte budget: load chat message-crypto lazily so libsodium
	// (~1 MB) never sits in the every-page layout closure — it loads
	// only when a chat-bearing trade event actually arrives. Best-effort:
	// a failed chunk load just means no toast preview.
	const chatCrypto = await import('$lib/chat/crypto').catch(() => null);
	if (!chatCrypto) return null;

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
		if (header.v === 3 || header.v === 4) {
			// The posting-key envelope (v1.21.13): opened with our posting key; it
			// moves a trade only when made with the sender's PINNED posting key
			// (as a v2 message needs the pinned chat key). Not pinned yet → nothing
			// is proved here; the chat view pins on first contact. v4 (C-M2)
			// opens only under the order of the record it came in, the owner
			// and the time it was sealed with.
			const rk = header.rk;
			const wk = header.wk;
			const v4 = header.v === 4;
			if (
				(v4 && (!chatCrypto.validEnvelopeTime(header.t) || typeof header.o !== 'string')) ||
				typeof header.sk !== 'string' ||
				!Array.isArray(rk) ||
				!rk.every((k) => typeof k === 'string') ||
				!Array.isArray(wk) ||
				!wk.every((w) => typeof w === 'string')
			) {
				return null;
			}
			const { pinnedPostingFor } = await import('$lib/chat/pubPin');
			const senderPosting: Uint8Array[] = [];
			for (const b64 of pinnedPostingFor(rec.sender)) {
				try {
					senderPosting.push(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
				} catch {
					/* a malformed stored key proves nothing */
				}
			}
			// Nothing pinned: nothing can be proved, so nothing is opened.
			if (senderPosting.length === 0) return null;
			const reader = chatCrypto.postingReader(live.posting.privateKey);
			try {
				const opened = await chatCrypto.decryptPostingEnvelope(
					{
						...(v4
							? { v: 4 as const, t: header.t as number, o: header.o as string }
							: { v: 3 as const }),
						ephemeralPub: header.ephemeral_pub,
						nonce: header.nonce,
						ciphertext: rec.ciphertext,
						senderKey: header.sk,
						recipientKeys: rk as string[],
						wraps: wk as string[]
					},
					reader,
					rec.sender,
					rec.recipient,
					senderPosting,
					rec.order_permlink ?? null
				);
				return opened.authenticated ? opened.text : null;
			} finally {
				chatCrypto.wipePostingReader(reader);
			}
		}
		const envelope = {
			...(header.v === 2 ? { v: 2 as const } : {}),
			ephemeralPub: header.ephemeral_pub,
			nonce: header.nonce,
			ciphertext: rec.ciphertext
		};
		// The sender's CURRENT pinned chat key: a v2 message is proved only by
		// it (a key the sender replaced reads history, never proves a sender). Not pinned yet → nothing is proved here; the chat
		// view pins on first contact.
		const { pinnedPubsFor } = await import('$lib/chat/pubPin');
		const senderPubs: Uint8Array[] = [];
		for (const b64 of pinnedPubsFor(rec.sender)) {
			try {
				senderPubs.push(chatCrypto.decodeChatPub(b64));
			} catch {
				/* a malformed stored key opens nothing */
			}
		}
		// LiveIdentity carries posting + memo keys; chat keys are
		// derived deterministically from the posting private key
		// per ADR-0014.  Re-deriving on each decrypt is cheap
		// (BLAKE2b once) and keeps chat keys out of session memory.
		const chatKeys = await chatCrypto.deriveChatIdentity(live.posting.privateKey, me);
		const opened = await chatCrypto.decryptFromSender(
			envelope,
			chatKeys,
			rec.sender,
			rec.recipient,
			senderPubs
		);
		return opened.authenticated ? opened.text : null;
	} catch (err) {
		if (err instanceof chatCrypto.DecryptError) return null;
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

/**
 * One new message of the peer's: decrypt it (proved senders only), and apply
 * its trade payload, if any. 'retry' when whose order it names could not be
 * told now — it is looked at again on the next read.
 */
async function applyRecord(rec: ChatMessageRecord, gen: number): Promise<'done' | 'retry'> {
	// Phase F.5 audit fix (F-26) — defense-in-depth account name
	// validation.  The indexer already validates sender names but
	// a malformed value slipping through would corrupt store keys
	// and deep-links.  Cheap to re-check.
	if (!isValidBlurtAccount(rec.sender)) return 'done';

	const plaintext = await tryDecrypt(rec);
	if (plaintext === null || gen !== generation || me === null) return 'done';

	const decoded = decodePayload(plaintext);
	if (decoded.kind !== 'address' && decoded.kind !== 'funds_sent') return 'done';
	const order = decoded.payload.orderPermlink;
	// v1.21.14 full chat audit, W-H1: only the order of the thread the message
	// arrived in (its order_permlink) …
	if (!order || order !== (rec.order_permlink ?? null)) return 'done';
	// … and only an order of the sender's or ours, recorded under its owner.
	const owner = await orderOwnerOf(order, rec.sender, me).catch(() => null);
	// Phase F.5 audit fix (F-30) — the listener stopped (lock, logout) while
	// that was asked: no store write after the explicit-lock wipe.
	if (gen !== generation || me === null) return 'done';
	if (owner === null) return 'retry';
	if (owner === false) return 'done';
	// v4: sealed about ANOTHER owner's order by the same permlink (the
	// message opened, so its header owner is the sender's own words; C-M2).
	const h = rec.header as Record<string, unknown> | null;
	if (h !== null && typeof h === 'object' && h.v === 4 && h.o !== owner) return 'done';

	// Phase F.5 audit fix (F-32) — pure dispatch.  All routing
	// decisions live in listenerDispatch.ts; this function applies
	// the resulting plan via real I/O.
	const plan = planListenerDispatch(decoded, {
		sender: rec.sender,
		me,
		orderOwner: owner,
		currentPathname: typeof window !== 'undefined' ? window.location.pathname : '',
		lang: get(locale) ?? 'en'
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
		// One place for BOTH the ambient count AND the native alert. notify()
		// always ticks the badge (peripheral, opt-in-independent) and fires the
		// native only when the user has opted into order alerts + granted
		// permission — replacing the dead legacy trade-notifications gate (no UI
		// ever set it) under which order native alerts never fired.
		notify({
			category: 'order',
			title,
			body,
			href: plan.notify.href,
			id: plan.notify.notificationTag
		});
	}
	return 'done';
}

/**
 * What one read of `peer`'s conversation brought (its snapshot, newest
 * first): look at each message not looked at before, oldest first. On the
 * FIRST read of a peer, its durable messages are history — what was already
 * there when the listener started — and only fast copies (not yet durable,
 * so under a minute old) are news.
 */
async function processSnapshot(
	peer: string,
	items: readonly ChatMessageRecord[],
	gen: number
): Promise<void> {
	const firstRead = seenFor(peer) === undefined;
	if (firstRead) {
		// Mark the peer as read once even when nothing in it is news.
		seen.set(peer, new Set());
	}
	for (const rec of [...items].reverse()) {
		if (gen !== generation || me === null) return;
		if (rec.sender === me) continue; // we don't toast our own outgoing
		const key = copyKey(rec);
		if (seenFor(peer)?.has(key) === true) continue;
		markSeen(peer, key);
		if (firstRead && rec.id !== 0) continue;
		if ((await applyRecord(rec, gen)) === 'retry') seenFor(peer)?.delete(key);
	}
}

/** Read `peer`'s conversation once: a chat stream kept open only until its
 *  snapshot (or an error, or LISTENER_READ_TIMEOUT_MS). true when it came. */
function readOnce(peer: string, gen: number): Promise<boolean> {
	return new Promise((resolve) => {
		if (me === null) {
			resolve(false);
			return;
		}
		let finished = false;
		let snapshot: readonly ChatMessageRecord[] | null = null;
		const finish = (): void => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			handle.stop();
			reading.delete(peer);
			if (snapshot === null) {
				resolve(false);
				return;
			}
			void processSnapshot(peer, snapshot, gen).then(
				() => resolve(true),
				() => resolve(true)
			);
		};
		const handle = createChatStream({
			me,
			peer,
			handlers: {
				onSnapshot: (snap) => {
					snapshot = snap.items;
					finish();
				},
				// Closed right after its snapshot: appends are the next read's.
				applyAppend: () => undefined,
				// An error before the snapshot: this read failed (tried again).
				onStreamingChange: (s) => {
					if (!s) finish();
				}
			}
		});
		reading.set(peer, handle);
		const timer = setTimeout(finish, LISTENER_READ_TIMEOUT_MS);
		handle.start();
	});
}

/** Start the next queued read, if there is room. */
function pump(): void {
	while (me !== null && reading.size < MAX_LISTENER_STREAMS && queue.length > 0) {
		const peer = queue.shift()!;
		const gen = generation;
		void readOnce(peer, gen).then((ok) => {
			if (gen !== generation) return;
			if (ok) retryTries.delete(peer);
			else scheduleRetry(peer);
			pump();
		});
	}
}

/** A read that failed: queue it again after a pause that grows. */
function scheduleRetry(peer: string): void {
	const tries = (retryTries.get(peer) ?? 0) + 1;
	if (tries > READ_RETRY_MAX_TRIES) {
		// The next activity ping for this peer starts over.
		retryTries.delete(peer);
		return;
	}
	retryTries.set(peer, tries);
	if (retryTimers.has(peer)) return;
	const wait = Math.min(READ_RETRY_MIN_MS * 2 ** (tries - 1), READ_RETRY_MAX_MS);
	retryTimers.set(
		peer,
		setTimeout(() => {
			retryTimers.delete(peer);
			enqueue(peer);
		}, wait)
	);
}

/** Read `peer`'s conversation soon (once, however many pings ask). */
function enqueue(peer: string): void {
	if (me === null || peer === me || !isValidBlurtAccount(peer)) return;
	if (queue.includes(peer)) return;
	queue.push(peer);
	pump();
}

/** Start the listener for a logged-in user.  Idempotent — calling
 *  multiple times for the same `account` is a no-op. */
export function startTradeEventListener(account: string): void {
	if (!browser) return;
	if (me === account) return;
	if (me !== null) stopTradeEventListener();
	me = account;
	generation++;
	unsubscribePings = subscribeChatActivityPings((ping) => {
		// A message WE wrote (named by the fast path): nothing to look at.
		// `order: null` is the durable path's "something was stored" —
		// whichever way it went — so the peer's conversation is read
		// (reconcile), never taken as a thread named ''.
		if (ping.inbound === false && ping.order !== null) return;
		enqueue(ping.peer);
	});
}

/** Stop everything.  Called on lock / logout. */
export function stopTradeEventListener(): void {
	generation++;
	if (unsubscribePings !== null) {
		unsubscribePings();
		unsubscribePings = null;
	}
	for (const handle of reading.values()) handle.stop();
	reading.clear();
	queue.length = 0;
	for (const t of retryTimers.values()) clearTimeout(t);
	retryTimers.clear();
	retryTries.clear();
	seen.clear();
	me = null;
}
