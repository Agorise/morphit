/**
 * Morphit — chat conversation controller.
 *
 * Sits between the ConversationView Svelte component and the lower
 * layers (chat/crypto.ts, indexer client, broadcast). Owns the
 * state machine for a single conversation while the user has it
 * open.
 *
 * ─── The state machine for a LocalMessage ────────────────────────
 *
 * When the user types a message and hits send:
 *
 *   pending  — added to the local list instantly; broadcast is
 *              in flight. The UI shows the text at full opacity
 *              but WITHOUT a timestamp or delivery checkmark.
 *              User can see what they typed and know it hasn't
 *              confirmed yet.
 *
 *   broadcast — broadcast returned a trx_id; we're waiting for
 *              the indexer to pick it up and echo it back via
 *              poll. Visually identical to pending. The split
 *              exists only so we can distinguish "failed to
 *              broadcast" from "broadcast succeeded but indexer
 *              lags" when the message sticks too long.
 *
 *   confirmed — indexer poll returned this message (matched by
 *              client_tag). Timestamp appears; any pending/broadcast
 *              visual disappears. The record now has a real id
 *              and created_at.
 *
 *   failed   — broadcast threw. UI shows the message in red with
 *              "Tap to retry." Retrying transitions back to pending.
 *
 * Incoming messages from the peer go straight into the
 * `confirmed` bucket — they already have ids and created_at.
 *
 * ─── client_tag reconciliation ───────────────────────────────────
 *
 * Outgoing flow:
 *   1. User presses Enter → generate a random 16-byte client_tag
 *      (hex-encoded, 32 chars).
 *   2. Push {state: 'pending', text, client_tag, ...} to the local
 *      message list.
 *   3. Encrypt via crypto.ts's `encryptToRecipient` (X25519 ECDH
 *      + ChaCha20-Poly1305-IETF AEAD per ADR-0015), set
 *      header.client_tag to our generated value.
 *   4. Broadcast via broadcastCustomJson with OP_IDS.chatMessage.
 *   5. On success: flip state to 'broadcast'.
 *   6. On error: flip state to 'failed' + store the error message.
 *
 * Inbound flow (on each poll):
 *   1. Fetch /v1/chat/:me/:peer since last cursor.
 *   2. For each ChatMessageRecord:
 *        a. Extract header.client_tag if present.
 *        b. If it matches a pending/broadcast local message:
 *           merge — set state='confirmed', copy id + created_at.
 *        c. Else: it's an incoming message from the peer OR a
 *           confirmed own message from a different client — just
 *           add to the list as 'confirmed'.
 *   3. Decrypt each confirmed message's ciphertext via
 *      crypto.ts's `decryptFromSender`. On any decrypt error
 *      (malformed ciphertext, wrong recipient, AAD mismatch from
 *      tampering, etc.) the placeholder text "(encrypted)" is
 *      shown and `decryptFailed` is set on the LocalMessage.
 *
 * ─── Polling cadence ─────────────────────────────────────────────
 *
 * Phase E.5 ships SSE-primary delivery. The controller subscribes
 * to /v1/chat/:me/:peer/stream and receives:
 *   - one `snapshot` event on connect (and on each reconnect),
 *     equivalent to the initial getChatHistory call
 *   - one `message_appended` event per new message confirmed
 *     on-chain, typically <5s after broadcast
 *
 * Polling stays as defense-in-depth at 60s cadence. A missed
 * SSE emit (future code path that mutates chat without
 * recordChatChange, server crash mid-emit, etc.) is caught
 * by the next fallback poll. The visibility-aware throttling
 * is gone — SSE connections idle cheaply when no messages
 * arrive, so there's no need to slow down on hidden tabs.
 */

import { getChatHistory, getChatIdentity } from '$lib/indexer/client';
import { broadcastCustomJson } from '$blurt/sign';
import { OP_IDS } from '$net/config';
import { createChatStream } from '$lib/chat/stream';
import type { LiveIdentity } from '$crypto/keygen';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import { decodePayload } from '$lib/chat/payload';
import { recordAddressShared, recordFundsSent } from '$lib/trades/tradeStatus';
import { triggerBlurtVerification } from '$lib/trades/tradeVerify';
import { resolveChatPubFromIndexer, PubPinError, type ChatPubPin } from '$lib/chat/pubPin';
import { fetchLatestChatIdentityFromChainQuorum } from '$lib/chat/chainVerify';
import { readChatSecurityMode, shouldAttachSelfCopy, type ChatSecurityMode } from '$stores/chatSecurity';
import {
	deriveChatIdentity,
	encryptToRecipient,
	decryptFromSender,
	decryptSelfCopy,
	decodeChatPub,
	DecryptError
} from '$lib/chat/crypto';

/** A message as the UI sees it. Synthesis of local optimistic
 *  state + (potentially) a confirmed server record. */
export interface LocalMessage {
	/** Server id. Null while the message is pending / broadcast /
	 *  failed; populated when the indexer echoes it back. */
	id: number | null;
	/** The client-generated tag, present on every outgoing message
	 *  the CURRENT session sent. Used for reconciliation. Incoming
	 *  messages from the peer don't have one (from this client's
	 *  perspective — the peer's client tagged its own sends with
	 *  its own tag). */
	clientTag: string | null;
	/** Full text of the message as this client understands it.
	 *  For outgoing: the plaintext the user typed (pre-encryption).
	 *  For incoming: the decrypted plaintext, or the
	 *  "(encrypted)" placeholder if decryption failed (malformed
	 *  ciphertext, wrong recipient, etc.). `decryptFailed` tells
	 *  the two cases apart. */
	text: string;
	/** 'me' or the peer's account. */
	sender: string;
	/** Current lifecycle state — see module doc for meanings. */
	state: 'pending' | 'broadcast' | 'confirmed' | 'failed';
	/** Server-assigned timestamp once confirmed. Null while
	 *  pending/broadcast/failed. Rendering uses it to decide
	 *  whether to show the time line. */
	createdAt: Date | null;
	/** cp404 — Blurt transaction id anchoring this message on-chain,
	 *  once known. Null while pending/broadcast/failed, and for
	 *  not-yet-irreversible provisional copies. Populated on durable
	 *  confirmation (own messages) or straight from the record
	 *  (incoming). The chat PDF export cites this so each line is
	 *  independently verifiable on any Blurt block explorer. */
	trxId: string | null;
	/** Non-null only in the 'failed' state. Populated by the
	 *  broadcast catch block. Used by the "Tap to retry" UI. */
	error: string | null;
	/** True if the confirmed message was received but we couldn't
	 *  decrypt it (not our key, malformed ciphertext, etc.). The
	 *  UI renders with muted styling and an explanatory tooltip
	 *  rather than silently showing the raw ciphertext. */
	decryptFailed: boolean;
	/** Monotonically-increasing local sequence number used for
	 *  stable `{#each}` keying in the template. Always unique
	 *  within a controller's lifetime. Does NOT correspond to
	 *  the server id. */
	localSeq: number;
}

/** Dependencies the controller takes. Exposed as an interface
 *  for testability — the test harness substitutes mocks. */
export interface ChatControllerDeps {
	readonly me: string;
	readonly peer: string;
	/** Optional order permlink the user is chatting about.  When
	 *  present, every outgoing message includes this value as a
	 *  plaintext `order_permlink` field in the morphit_chat_v1
	 *  payload, which causes the indexer to bypass the stranger-
	 *  fee gate (see Q11 in apps/indexer/src/indexer/handlers/
	 *  chat.ts).  The bypass requires that the named order is
	 *  owned by `peer` (the recipient) — when the user is the
	 *  recipient of an order they posted, sending FROM that
	 *  conversation hits the `peer` direction; outbound from the
	 *  poster's side has no use for the field (their chat is
	 *  initiating, not responding).  Set to null when the user
	 *  reached the chat without an order context (direct DM,
	 *  inbox tap), in which case the field is omitted from the
	 *  payload and the gate behaves as before. */
	readonly orderPermlink: string | null;
	/** Returns the current LiveIdentity, or null if the session
	 *  is locked. Re-read on every send so a user who unlocks
	 *  mid-conversation can send without re-opening the view. */
	getLiveIdentity(): LiveIdentity | null;
	/** Returns the current time. Injected for tests. */
	now(): Date;
	/** Returns the current document.visibilityState, or 'visible'
	 *  if unavailable (SSR / test). Injected for testability. */
	visibilityState(): 'visible' | 'hidden';
	/** Register a listener for visibility changes. Returns a
	 *  cleanup function. In tests, a no-op. */
	onVisibilityChange(cb: () => void): () => void;
	/** Generate a 32-character hex client_tag. Injected so tests
	 *  can seed deterministic values. */
	generateClientTag(): string;
	/** The indexer history fetcher. Defaults to the real client
	 *  at runtime; tests inject a mock. */
	fetchHistory(
		a: string,
		b: string,
		opts: { cursor?: string; limit?: number; signal?: AbortSignal }
	): Promise<
		| { ok: true; items: readonly ChatMessageRecord[]; nextCursor: string | null }
		| { ok: false; message: string }
	>;
	/** Broadcast an op. Defaults to broadcastCustomJson at runtime;
	 *  tests inject a mock. */
	broadcast(
		live: LiveIdentity,
		payload: Record<string, unknown>,
		blurtAccount: string
	): Promise<{ block_num: number; trx_id: string }>;
	/** Fetch the peer's published X25519 chat pubkey (ADR-0015).
	 *  Returns null if the peer has never published — in that case
	 *  the sender can't encrypt and sendMessage surfaces a
	 *  `peer_not_ready` error. Injected for testability. */
	fetchPeerChatPub(peer: string): Promise<Uint8Array | null>;
	/** Derive the current user's chat identity from their
	 *  posting private key. Returns a Uint8Array priv + pub.
	 *  The returned priv is live key material — the controller
	 *  uses it, then forgets it (no persistent storage). */
	deriveMyChatIdentity(
		live: LiveIdentity,
		account: string
	): Promise<{ priv: Uint8Array; pub: Uint8Array }>;
	/** Encrypt plaintext to a recipient. Injected (rather than
	 *  called from crypto.ts directly) so tests can assert
	 *  "encrypt was called with these args" without exercising
	 *  libsodium. */
	encrypt(
		plaintext: string,
		recipientPub: Uint8Array,
		senderAccount: string,
		recipientAccount: string,
		senderChatPub: Uint8Array,
		includeSelfCopy: boolean
	): Promise<{
		ciphertext: string;
		ephemeralPub: string;
		nonce: string;
		selfCiphertext?: string;
		selfNonce?: string;
	}>;
	/** Decrypt an envelope. Returns the plaintext, or null if
	 *  decryption fails (the UI shows the placeholder in that
	 *  case rather than crashing the conversation). */
	decrypt(
		envelope: { ciphertext: string; ephemeralPub: string; nonce: string },
		myPriv: Uint8Array,
		myPub: Uint8Array,
		senderAccount: string,
		recipientAccount: string
	): Promise<string | null>;
	/** cp406 — decrypt the SENDER's own self-copy of a message they sent
	 *  (keep-history mode). Returns the plaintext, or null if there's no
	 *  self-copy present or it fails. Optional so existing test fakes without
	 *  it still type-check; the own-sent render path falls back to the
	 *  in-memory cache / placeholder when it's absent. */
	decryptSelfCopy?(
		envelope: {
			ciphertext: string;
			ephemeralPub: string;
			nonce: string;
			selfCiphertext?: string;
			selfNonce?: string;
		},
		myPriv: Uint8Array,
		myPub: Uint8Array,
		senderAccount: string,
		recipientAccount: string
	): Promise<string | null>;
	/** cp406 — the account's chat-security mode ('keep' | 'destroy'), read
	 *  fresh at send time. Optional: absent → treated as 'keep' (the default,
	 *  self-copy on), so existing tests keep their prior behavior. */
	chatSecurityMode?(): ChatSecurityMode;
	/** Called on EVERY state change. The component subscribes via
	 *  its own $effect so Svelte re-renders automatically. */
	onChange(messages: readonly LocalMessage[]): void;
	/** Called when the SSE stream's connected/disconnected state
	 *  flips.  Used to render a "Live" pip in the conversation
	 *  header.  No-op default — runtime callers wire this up if
	 *  they want to surface the connection state. */
	onStreamingChange?(streaming: boolean): void;
	/** Phase E.5 — subscribe to the live SSE stream for this
	 *  conversation pair.  Optional: if absent (legacy tests),
	 *  the controller runs in poll-only mode at the fallback
	 *  cadence.  In production, always set; the runtime adapter
	 *  wraps `createChatStream`.
	 *
	 *  The subscription receives snapshot + message_appended
	 *  events.  The controller routes both through its existing
	 *  merge logic (mergePollResponse) — semantically a snapshot
	 *  is "a list of items" and an append is "a list with one
	 *  item," so the same code path serves both.  Returns an
	 *  unsubscribe function called on destroy. */
	subscribeStream?: (handlers: {
		onSnapshot: (items: readonly ChatMessageRecord[]) => void;
		onAppend: (rec: ChatMessageRecord) => void;
		onStreamingChange: (streaming: boolean) => void;
	}) => () => void;
}

/** One active conversation's state + methods. */
export interface ChatController {
	/** Initial load + start the polling loop. Safe to call
	 *  multiple times; second+ calls are no-ops. */
	start(): void;
	/** Stop the polling loop, abort in-flight requests, drop
	 *  event listeners. Idempotent. */
	destroy(): void;
	/** Compose + broadcast a new outgoing message. Returns once
	 *  the op was signed + sent (not when it's confirmed). */
	sendMessage(text: string): Promise<void>;
	/** Retry a message that's in the `failed` state. The localSeq
	 *  is the key to identify which one. */
	retryMessage(localSeq: number): Promise<void>;
	/** Debug / test hook — read current messages without mutating. */
	snapshot(): readonly LocalMessage[];
}

/** Defense-in-depth fallback poll cadence. SSE is the primary
 *  delivery path; this catches messages that may have been
 *  missed due to a bus emit drop, network glitch during SSE
 *  re-connect, or future code path that mutates chat state
 *  without going through recordChatChange. 60s mirrors the
 *  orderbook-stream fallback poll. */
const FALLBACK_POLL_INTERVAL_MS = 60_000;

// [morphit-diag cp440] TEMP — standard base64 (padding stripped) so a logged
// public chat key is directly comparable to the on-chain morphit_chat_identity_v1
// chat_pub shown on the block explorer. Public keys only; nothing secret.
function __diagB64(u8: Uint8Array): string {
	let bin = '';
	for (const b of u8) bin += String.fromCharCode(b);
	try {
		return btoa(bin).replace(/=+$/, '');
	} catch {
		return '(b64-failed)';
	}
}
/** Initial history page size — the newest 50 messages on first
 *  load. Matches the design-doc recommendation. */
const HISTORY_PAGE_SIZE = 50;
/** Maximum random jitter we add to the fallback poll, to spread
 *  client load across block boundaries instead of every tab
 *  pinging at the same millisecond. Higher than the old
 *  per-poll jitter because polls are now infrequent enough that
 *  alignment doesn't auto-spread. */
const POLL_JITTER_MS = 5_000;
/** Placeholder text for messages we can't decrypt — shown when
 *  the AEAD verification fails (malformed ciphertext, recipient
 *  not us, key rotation since the message was sent, AAD tamper
 *  detection, etc.). The decrypt path catches any DecryptError
 *  from `crypto.ts`'s `decryptFromSender` and surfaces this
 *  text plus a `decryptFailed` flag on the LocalMessage so the
 *  UI can render appropriately. */
const ENCRYPTED_PLACEHOLDER = '(encrypted)';

// ─── cp402 [3] — own-sent plaintext cache (in-memory only) ─────────
//
// The chat crypto (see crypto.ts) is ephemeral sender-PFS: the sender
// generates a fresh ephemeral X25519 keypair per message and WIPES the
// ephemeral private key immediately after encrypting. That is what gives
// us forward secrecy — a later key/disk/chain compromise cannot recover
// the plaintext of messages already sent. The unavoidable consequence is
// that WE can never re-derive the shared secret for our OWN sent messages
// from chain history either. During a live session that's invisible: the
// composer keeps the plaintext we typed as a local optimistic echo. But
// when the user navigates away and back, the controller is destroyed and
// that echo is gone; a fresh controller reloading history sees our own
// sent messages as ciphertext it cannot decrypt and renders "(encrypted)".
//
// This cache closes that gap by remembering the plaintext of OUR sent
// messages, keyed by account + client_tag, so a fresh controller can
// restore them. Crucially it lives ONLY in memory — nothing is written
// to disk — so the on-disk / on-chain forward-secrecy guarantee is
// unchanged (the plaintext is already resident in memory while the
// conversation is open; this merely lets it survive in-app navigation
// within the same tab session). It is:
//   • gated on read by getLiveIdentity() — a LOCKED session shows the
//     placeholder, consistent with incoming messages;
//   • cleared on lock AND sign-out (identity.ts reset()/lockSession())
//     so plaintext never lingers in memory past a lock, and one
//     account's messages never leak into another's session;
//   • bounded to OWN_SENT_CACHE_MAX entries (oldest evicted) so a very
//     long, reload-free session can't grow it without bound.
const OWN_SENT_CACHE_MAX = 1000;
const ownSentPlaintext = new Map<string, string>();

/** Key: account + client_tag. Client tags are 16 random bytes so they
 *  never collide across conversations; scoping by account too is
 *  defense-in-depth against the astronomically-unlikely collision and
 *  keeps entries unambiguously owned. */
function ownSentKey(me: string, clientTag: string): string {
	return `${me}\t${clientTag}`;
}

function rememberOwnSent(me: string, clientTag: string, plaintext: string): void {
	ownSentPlaintext.set(ownSentKey(me, clientTag), plaintext);
	// Evict oldest (Map preserves insertion order) if over the cap.
	if (ownSentPlaintext.size > OWN_SENT_CACHE_MAX) {
		const oldest = ownSentPlaintext.keys().next().value;
		if (oldest !== undefined) ownSentPlaintext.delete(oldest);
	}
}

/** Clear the own-sent plaintext cache. Called by identity.ts on lock and
 *  on explicit sign-out so plaintext never survives a locked/signed-out
 *  session in memory. Exported (not a controller method) because the
 *  cache is module-scoped and must be clearable without a live
 *  controller instance. */
export function clearOwnSentPlaintextCache(): void {
	ownSentPlaintext.clear();
}

/** Map an unknown caught error to a stable sentinel string for
 *  LocalMessage.error.  `PubPinError` carries a stable code that
 *  the UI maps to a localized copy via the chat.security.*
 *  i18n keys; other Errors fall through to their .message
 *  (preserving the existing technical-detail surface for non-
 *  localized failures); anything else gets String()-ified
 *  defensively. */
function errorToSentinel(err: unknown): string {
	if (err instanceof PubPinError) return err.code;
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Build a chat conversation controller. Takes all its
 * dependencies as args to make the state machine unit-testable.
 *
 * Typical runtime invocation passes the real indexer client,
 * broadcastCustomJson, and document.visibilityState; tests
 * inject fake versions.
 */
export function createConversationController(deps: ChatControllerDeps): ChatController {
	let messages: LocalMessage[] = [];
	let localSeqCounter = 0;
	/** The latest `created_at` ISO string seen from the server.
	 *  Subsequent polls use this as a cursor so we only fetch
	 *  the delta. Starts null (no pages yet); the first fetch
	 *  pulls the full history page. */
	let latestSeenAt: string | null = null;
	let pollHandle: ReturnType<typeof setTimeout> | null = null;
	let currentAbort: AbortController | null = null;
	let visibilityCleanup: (() => void) | null = null;
	let streamUnsubscribe: (() => void) | null = null;
	let destroyed = false;
	let started = false;

	/** Cached derivation of the current user's chat identity. Null
	 *  until the first send/decrypt needs it. Keyed implicitly by
	 *  the (account, live-identity) pair — since the controller is
	 *  per-conversation and re-created when the user re-enters, a
	 *  re-unlock mid-session produces a fresh controller. */
	let myChatIdentity: { priv: Uint8Array; pub: Uint8Array } | null = null;

	/** Cached fetch of the peer's published chat pubkey. Null means
	 *  "not yet looked up"; a fetched-and-absent peer is cached as
	 *  `{ pub: null }` via the peerPubUnknown flag to avoid spam
	 *  polling their identity endpoint while they haven't set up
	 *  chat yet. */
	let peerChatPub: Uint8Array | null = null;
	let peerPubUnknown = false;

	async function ensureMyChatIdentity(
		live: LiveIdentity
	): Promise<{ priv: Uint8Array; pub: Uint8Array }> {
		if (myChatIdentity) return myChatIdentity;
		myChatIdentity = await deps.deriveMyChatIdentity(live, deps.me);
		// [morphit-diag cp440] TEMP — public chat key only, nothing secret.
		// eslint-disable-next-line no-console
		console.info('[morphit-diag] myChatIdentity derived', {
			me: deps.me,
			myChatPub: __diagB64(myChatIdentity.pub)
		});
		return myChatIdentity;
	}

	async function ensurePeerChatPub(): Promise<Uint8Array | null> {
		if (peerChatPub) {
			// [morphit-diag cp440] TEMP — log the cached peer key we'll encrypt to.
			// eslint-disable-next-line no-console
			console.info('[morphit-diag] ensurePeerChatPub → CACHE', {
				peer: deps.peer,
				peerChatPub: __diagB64(peerChatPub)
			});
			return peerChatPub;
		}
		if (peerPubUnknown) return null;
		const fetched = await deps.fetchPeerChatPub(deps.peer);
		if (fetched === null) {
			// [morphit-diag cp440] TEMP
			// eslint-disable-next-line no-console
			console.info('[morphit-diag] ensurePeerChatPub → NO published chat_pub', {
				peer: deps.peer
			});
			peerPubUnknown = true;
			return null;
		}
		peerChatPub = fetched;
		// [morphit-diag cp440] TEMP — compare this to the peer's on-chain
		// morphit_chat_identity_v1 chat_pub. A mismatch = we're encrypting to a
		// stale/wrong key, which is exactly why the recipient can't decrypt.
		// eslint-disable-next-line no-console
		console.info('[morphit-diag] ensurePeerChatPub → FETCHED', {
			peer: deps.peer,
			peerChatPub: __diagB64(fetched)
		});
		return fetched;
	}

	function emit(): void {
		// Emit a shallow copy so consumers can't mutate in-place.
		deps.onChange([...messages]);
	}

	/**
	 * Extract client_tag from a header object. The header is
	 * untyped (server stores JSONB verbatim), so we pick out the
	 * field defensively. Missing, wrong-type, or malformed tags
	 * return null.
	 */
	function clientTagFromHeader(header: unknown): string | null {
		if (typeof header !== 'object' || header === null) return null;
		const v = (header as Record<string, unknown>).client_tag;
		return typeof v === 'string' && v.length > 0 ? v : null;
	}

	/**
	 * Try to reconcile a server-returned message with a local
	 * pending/broadcast one by client_tag. On match, update the
	 * existing entry in-place (preserving local ordering) and
	 * return true. On miss, return false — the caller appends a
	 * new confirmed entry.
	 */
	function reconcileByClientTag(rec: ChatMessageRecord): boolean {
		const tag = clientTagFromHeader(rec.header);
		if (tag === null) return false;
		// cp403 [1] — id 0 marks a PROVISIONAL head-block (fast-path)
		// copy that isn't irreversible yet (ADR-0048). It must never
		// overwrite a real, durable id.
		const isDurable = rec.id !== 0;
		for (const m of messages) {
			if (m.clientTag !== tag) continue;
			// This is one of our own messages, matched by client_tag. It
			// could be the local optimistic echo (pending/broadcast), a
			// provisional fast-path copy already reconciled (confirmed,
			// id still null), or the durable copy (confirmed, real id).
			// Every case is a dedup hit — we return true so the caller
			// never appends a second entry.
			if (m.state === 'pending' || m.state === 'broadcast') {
				m.state = 'confirmed';
				m.createdAt = new Date(rec.created_at);
			}
			// Adopt the durable id the first time it lands; a provisional
			// (id 0) never overwrites a real id we already hold.
			if (isDurable && (m.id === null || m.id === 0)) {
				m.id = rec.id;
				m.createdAt = new Date(rec.created_at);
				m.trxId = rec.source_trx_id || null;
			}
			return true;
		}
		return false;
	}

	/**
	 * Decrypt a ciphertext record to plaintext, or return the
	 * placeholder if any step fails. Failures here are common and
	 * expected in edge cases (old messages from before a key
	 * rotation, messages encrypted by a buggy client, tampering):
	 * we want the conversation to keep rendering, with the one
	 * bad message shown muted.
	 */
	async function decryptOrPlaceholder(
		rec: ChatMessageRecord
	): Promise<{ text: string; decryptFailed: boolean }> {
		// If the session is locked, we can't derive our chat
		// identity. Show placeholder; once the user unlocks and
		// re-enters the conversation, a fresh controller will
		// decrypt the history.
		const live = deps.getLiveIdentity();
		if (!live) {
			return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: false };
		}

		// Extract envelope fields from the header. The on-chain
		// header is JSONB and arbitrarily-shaped; we narrow defensively.
		const header = rec.header;
		if (typeof header !== 'object' || header === null) {
			return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: true };
		}
		const h = header as Record<string, unknown>;
		const ephemeralPub = h.ephemeral_pub;
		const nonce = h.nonce;
		if (typeof ephemeralPub !== 'string' || typeof nonce !== 'string') {
			// Could be a legacy "stub" message from the pre-crypto
			// days — those have no ephemeral_pub or nonce, only a
			// client_tag. Render as placeholder without flagging as
			// a "real" failure (it's a known boundary case).
			return {
				text: ENCRYPTED_PLACEHOLDER,
				decryptFailed: false
			};
		}

		try {
			const id = await ensureMyChatIdentity(live);
			const plaintext = await deps.decrypt(
				{ ciphertext: rec.ciphertext, ephemeralPub, nonce },
				id.priv,
				id.pub,
				rec.sender,
				rec.recipient
			);
			if (plaintext === null) {
				return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: true };
			}
			return { text: plaintext, decryptFailed: false };
		} catch {
			// Any unexpected error during decrypt (including
			// crypto init failures, libsodium issues, etc.) falls
			// back to placeholder. Conversation keeps rendering.
			return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: true };
		}
	}

	/** cp406 — decrypt OUR OWN sent message from chain via its self-copy
	 *  (keep-history mode, the default). Returns the plaintext, or null when
	 *  there's no self-copy (PFS "destroy" mode / a pre-feature message), the
	 *  session is locked, deps.decryptSelfCopy isn't wired (older tests), or
	 *  decrypt fails. This is what lets own sent history survive a reload
	 *  without depending on the in-memory cache. Only called for records where
	 *  rec.sender === deps.me. */
	async function decryptOwnFromChain(rec: ChatMessageRecord): Promise<string | null> {
		const live = deps.getLiveIdentity();
		if (!live || deps.decryptSelfCopy === undefined) return null;
		const header = rec.header;
		if (typeof header !== 'object' || header === null) return null;
		const h = header as Record<string, unknown>;
		const ephemeralPub = h.ephemeral_pub;
		const nonce = h.nonce;
		const selfCiphertext = h.self_ciphertext;
		const selfNonce = h.self_nonce;
		if (
			typeof ephemeralPub !== 'string' ||
			typeof nonce !== 'string' ||
			typeof selfCiphertext !== 'string' ||
			typeof selfNonce !== 'string'
		) {
			return null;
		}
		try {
			const id = await ensureMyChatIdentity(live);
			return await deps.decryptSelfCopy(
				{ ciphertext: rec.ciphertext, ephemeralPub, nonce, selfCiphertext, selfNonce },
				id.priv,
				id.pub,
				rec.sender,
				rec.recipient
			);
		} catch {
			return null;
		}
	}

	/** Process one poll response: merge new messages into the
	 *  local list, advance the cursor. The template then renders
	 *  sorted oldest-first.
	 *
	 *  Dedup strategy: build a set of already-seen server ids and
	 *  skip records we've already confirmed. This is O(n+m) per
	 *  poll where n is local messages and m is returned records.
	 *  Acceptable for the 50-item polling page size.
	 *
	 *  Future: when/if the indexer grows a "since" cursor mode, we
	 *  can avoid re-fetching the whole window every 3s. For now
	 *  it's 50 records × small-payload every 3s — small enough
	 *  that the wasted bandwidth isn't worth a server change. */
	async function mergePollResponse(items: readonly ChatMessageRecord[]): Promise<void> {
		if (items.length === 0) return;

		// Build a set of ids already in local state as 'confirmed'.
		// Pending / broadcast / failed don't have ids yet, so they
		// aren't in this set (their reconciliation happens via
		// client_tag below).
		const seenIds = new Set<number>();
		for (const m of messages) {
			if (m.state === 'confirmed' && m.id !== null) {
				seenIds.add(m.id);
			}
		}

		// The endpoint returns newest-first; iterate reversed so
		// we add oldest-first to preserve chronological order.
		const oldestFirst = [...items].reverse();
		let added = false;

		for (const rec of oldestFirst) {
			// Is this a confirmation of a local outgoing message?
			if (rec.sender === deps.me) {
				if (reconcileByClientTag(rec)) {
					added = true;
					continue;
				}
				// No local tag matched AND we've seen this id before
				// (e.g. second poll after we already merged it once):
				// skip.
				if (seenIds.has(rec.id)) continue;
				// No local tag matched — a message we sent, but not from
				// this controller's live echo (we navigated away and back,
				// or it was sent from another client/session). cp406: in
				// keep-history mode we can now re-decrypt our own messages from
				// chain via their self-copy — so try that FIRST (survives a full
				// reload). Fall back to the in-memory own-sent cache (covers
				// PFS-mode messages we typed this session), then the placeholder.
				// Everything is gated on getLiveIdentity() so a LOCKED session
				// shows the placeholder, exactly like incoming messages.
				const ownTag = clientTagFromHeader(rec.header);
				const ownFromChain = await decryptOwnFromChain(rec);
				const ownCached =
					ownFromChain === null && deps.getLiveIdentity() !== null && ownTag !== null
						? ownSentPlaintext.get(ownSentKey(deps.me, ownTag))
						: undefined;
				messages.push({
					id: rec.id,
					clientTag: ownTag,
					text: ownFromChain ?? ownCached ?? ENCRYPTED_PLACEHOLDER,
					sender: rec.sender,
					state: 'confirmed',
					createdAt: new Date(rec.created_at),
					trxId: rec.source_trx_id || null,
					error: null,
					decryptFailed: false,
					localSeq: ++localSeqCounter
				});
				added = true;
			} else {
				// Incoming from the peer.
				// cp403 [1] — id 0 marks a PROVISIONAL head-block copy
				// (ADR-0048 fast path), not yet irreversible.
				const incomingTag = clientTagFromHeader(rec.header);
				const isDurable = rec.id !== 0;

				// Collapse a fast-path provisional against its durable
				// twin — either may arrive first, and both carry the same
				// on-chain client_tag. On a hit, adopt the durable id the
				// first time it lands, but NEVER re-decode or re-record:
				// the trade-status side effects below ran when the message
				// first arrived, and re-running them would double-record
				// an address/funds-sent payload.
				if (incomingTag !== null) {
					const twin = messages.find(
						(m) => m.sender === rec.sender && m.clientTag === incomingTag
					);
					if (twin) {
						if (isDurable && (twin.id === null || twin.id === 0)) {
							twin.id = rec.id;
							twin.createdAt = new Date(rec.created_at);
							twin.trxId = rec.source_trx_id || null;
						}
						added = true;
						continue;
					}
				}

				// No twin yet. Durable copies dedup by id; a provisional
				// (id 0) is stored with a null id and never enters seenIds.
				if (isDurable && seenIds.has(rec.id)) continue;
				const d = await decryptOrPlaceholder(rec);
				messages.push({
					id: isDurable ? rec.id : null,
					clientTag: incomingTag,
					text: d.text,
					sender: rec.sender,
					state: 'confirmed',
					createdAt: new Date(rec.created_at),
					trxId: isDurable ? rec.source_trx_id || null : null,
					error: null,
					decryptFailed: d.decryptFailed,
					localSeq: ++localSeqCounter
				});
				added = true;

				// Phase F.5 — populate the trade-status store from
				// incoming structured payloads.  If the decrypted
				// plaintext is a recognized address/funds-sent
				// payload with an orderPermlink, route it.  Plain
				// chat messages decode to 'plaintext' and are no-ops.
				if (!d.decryptFailed) {
					try {
						const decoded = decodePayload(d.text);
						if (decoded.kind === 'address' && decoded.payload.orderPermlink) {
							recordAddressShared({
								orderPermlink: decoded.payload.orderPermlink,
								peer: rec.sender,
								method: decoded.payload.method,
								address: decoded.payload.address,
								expectedAmount: decoded.payload.amount ? Number(decoded.payload.amount) : undefined,
								expectedMemo: decoded.payload.memo,
								direction: 'incoming'
							});
						} else if (decoded.kind === 'funds_sent' && decoded.payload.orderPermlink) {
							recordFundsSent({
								orderPermlink: decoded.payload.orderPermlink,
								peer: rec.sender,
								method: decoded.payload.method,
								txid: decoded.payload.txid,
								claimedMemo: decoded.payload.memo,
								amount: decoded.payload.amount ? Number(decoded.payload.amount) : undefined,
								direction: 'incoming'
							});

							// Phase F.5 audit fix (F-41) — trigger
							// chain verification immediately on
							// receipt.  Idempotent with the listener's
							// trigger (cache hit on duplicate).
							if (decoded.payload.method === 'blurt') {
								const amountStr = decoded.payload.amount;
								if (amountStr !== undefined) {
									const amountNum = Number(amountStr);
									if (Number.isFinite(amountNum) && amountNum > 0) {
										triggerBlurtVerification({
											recipient: deps.me,
											sender: rec.sender,
											amountBlurt: amountNum,
											echoedMemo: decoded.payload.memo ?? '',
											orderPermlink: decoded.payload.orderPermlink,
											txid: decoded.payload.txid
										});
									}
								}
							}
						}
					} catch {
						// decode never throws; defensive swallow.
					}
				}
			}
		}

		// Advance the watermark to the newest created_at we saw —
		// currently unused (we don't pass a cursor to the server),
		// but useful if a future "since" mode lands.
		const newest = items[0]; // server returns DESC so [0] is newest
		if (newest && (!latestSeenAt || newest.created_at > latestSeenAt)) {
			latestSeenAt = newest.created_at;
		}

		// Sort the local list by createdAt ASC, putting pending /
		// broadcast / failed messages (no createdAt) at the end.
		// Secondary sort by localSeq so ordering is stable within
		// a timestamp.
		messages.sort((a, b) => {
			const aT = a.createdAt ? a.createdAt.getTime() : Number.POSITIVE_INFINITY;
			const bT = b.createdAt ? b.createdAt.getTime() : Number.POSITIVE_INFINITY;
			if (aT !== bT) return aT - bT;
			return a.localSeq - b.localSeq;
		});

		if (added) emit();
	}

	/** Fetch the latest page and merge. Caller handles the poll
	 *  scheduling. */
	async function pollOnce(): Promise<void> {
		if (destroyed) return;
		if (currentAbort) currentAbort.abort();
		currentAbort = new AbortController();
		const signal = currentAbort.signal;

		const r = await deps.fetchHistory(deps.me, deps.peer, {
			signal,
			limit: HISTORY_PAGE_SIZE
		});
		if (signal.aborted || destroyed) return;
		// Defensive: a misbehaving fetcher (test mock without
		// mockResolvedValue, custom client returning undefined on
		// transport error) returns nothing.  Treat as transient
		// failure — same as r.ok===false.  The next poll will try
		// again.  Without this guard, pollOnce throws an unhandled
		// rejection that surfaces as a test-run warning AND could
		// in principle escape to the browser console in prod.
		if (r && r.ok) {
			await mergePollResponse(r.items);
		}
		// On error, silently skip — next poll will try again. The
		// user doesn't need to see every transient network error.
	}

	function schedulePoll(): void {
		if (destroyed) return;
		const jitter = Math.floor(Math.random() * POLL_JITTER_MS);
		pollHandle = setTimeout(async () => {
			await pollOnce();
			schedulePoll();
		}, FALLBACK_POLL_INTERVAL_MS + jitter);
	}

	async function sendMessage(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;

		// Phase F.5 — populate the trade-status store from outgoing
		// structured payloads.  Done before the broadcast attempt
		// so the /my/orders badge updates immediately even if the
		// network is slow.  If the broadcast eventually fails, the
		// trade entry still reflects the user's intent — they'll
		// see the failed message in their chat and can retry.
		try {
			const decoded = decodePayload(trimmed);
			if (decoded.kind === 'address' && decoded.payload.orderPermlink) {
				recordAddressShared({
					orderPermlink: decoded.payload.orderPermlink,
					peer: deps.peer,
					method: decoded.payload.method,
					address: decoded.payload.address,
					expectedAmount: decoded.payload.amount ? Number(decoded.payload.amount) : undefined,
					expectedMemo: decoded.payload.memo,
					direction: 'outgoing'
				});
			} else if (decoded.kind === 'funds_sent' && decoded.payload.orderPermlink) {
				recordFundsSent({
					orderPermlink: decoded.payload.orderPermlink,
					peer: deps.peer,
					method: decoded.payload.method,
					txid: decoded.payload.txid,
					claimedMemo: decoded.payload.memo,
					amount: decoded.payload.amount ? Number(decoded.payload.amount) : undefined,
					direction: 'outgoing'
				});
			}
		} catch {
			// Decoding never throws — but if it did, sending the
			// message is more important than the store update.
			// Swallow.
		}

		const live = deps.getLiveIdentity();
		if (!live) {
			// Caller UI should check isUnlocked before calling — but
			// defense in depth: if somehow we got here, record a
			// failed message rather than silently dropping.
			messages.push({
				id: null,
				clientTag: null,
				text: trimmed,
				sender: deps.me,
				state: 'failed',
				createdAt: null,
				trxId: null,
				error: 'Session is locked — unlock and try again.',
				decryptFailed: false,
				localSeq: ++localSeqCounter
			});
			emit();
			return;
		}

		const clientTag = deps.generateClientTag();
		// cp406 — keep-history mode (the DEFAULT) caches our own plaintext so it
		// survives navigating away and back, as a fast path (the durable source
		// is the on-chain self-copy attached below). In DESTROY mode we
		// deliberately do NOT cache: with no self-copy on chain and nothing left
		// in memory after we leave, own messages become unreadable once the
		// session ends — the "destroyed after you leave this chat" guarantee.
		// The cache is in-memory only and also cleared on lock/sign-out.
		const keepHistory = shouldAttachSelfCopy(deps.chatSecurityMode?.());
		if (keepHistory) {
			rememberOwnSent(deps.me, clientTag, trimmed);
		}
		const local: LocalMessage = {
			id: null,
			clientTag,
			text: trimmed,
			sender: deps.me,
			state: 'pending',
			createdAt: null,
			trxId: null,
			error: null,
			decryptFailed: false,
			localSeq: ++localSeqCounter
		};
		messages.push(local);
		emit();

		// Real crypto path (ADR-0015).
		// Step 1: fetch peer's chat pubkey (cached).
		let peerPub: Uint8Array | null;
		try {
			peerPub = await ensurePeerChatPub();
		} catch (err) {
			local.state = 'failed';
			local.error = errorToSentinel(err);
			emit();
			return;
		}
		if (peerPub === null) {
			// Peer hasn't published their chat identity yet. The UI
			// layer maps this exact error string to a localized
			// "peer not ready" message and suggests retrying after
			// the peer opens chat once.
			local.state = 'failed';
			local.error = 'peer_not_ready';
			// Reset peerPubUnknown so the next send retries — if the
			// peer publishes in the meantime, the retry will succeed.
			peerPubUnknown = false;
			emit();
			return;
		}

		// Step 2: derive my identity (cached). Used for the sender self-copy
		// (keep-history mode, below) and to keep receive-path decryption fast.
		let myId: { priv: Uint8Array; pub: Uint8Array };
		try {
			myId = await ensureMyChatIdentity(live);
		} catch (err) {
			local.state = 'failed';
			local.error = err instanceof Error ? err.message : String(err);
			emit();
			return;
		}

		// Step 3: encrypt. deps.encrypt wraps crypto.encryptToRecipient. In
		// keep-history mode (the default) we pass our own chat pubkey so the
		// envelope also carries a sender self-copy — a second ciphertext only WE
		// can open — letting us reread our own sent messages from chain. The
		// opt-in PFS "destroy on leave" mode (keepHistory === false) omits it.
		const includeSelfCopy = keepHistory;
		let envelope: {
			ciphertext: string;
			ephemeralPub: string;
			nonce: string;
			selfCiphertext?: string;
			selfNonce?: string;
		};
		try {
			envelope = await deps.encrypt(
				trimmed,
				peerPub,
				deps.me,
				deps.peer,
				myId.pub,
				includeSelfCopy
			);
		} catch (err) {
			local.state = 'failed';
			local.error = err instanceof Error ? err.message : String(err);
			emit();
			return;
		}

		// Step 4: build on-wire payload. Header carries the envelope's
		// public fields (ephemeral_pub + nonce) PLUS our client_tag
		// for optimistic reconciliation on the poll side.
		//
		// Q11: when the user is responding to a specific order
		// (deps.orderPermlink set, e.g. /chat/peer?order=...), we
		// include `order_permlink` as a plaintext field on the
		// payload.  The indexer uses this to bypass the
		// stranger-fee gate for that message.  The block list and
		// rate limits still apply regardless.  When orderPermlink
		// is null (direct DM, inbox follow-up, etc.), the field is
		// omitted entirely so the indexer's gate runs as before.
		const payload: Record<string, unknown> = {
			recipient: deps.peer,
			ciphertext: envelope.ciphertext,
			header: {
				client_tag: clientTag,
				ephemeral_pub: envelope.ephemeralPub,
				nonce: envelope.nonce,
				// cp406 — sender self-copy (keep-history mode). Bounded + validated
				// by the indexer exactly like the main ciphertext.
				...(envelope.selfCiphertext !== undefined && envelope.selfNonce !== undefined
					? { self_ciphertext: envelope.selfCiphertext, self_nonce: envelope.selfNonce }
					: {})
			}
		};
		if (deps.orderPermlink !== null) {
			payload.order_permlink = deps.orderPermlink;
		}

		try {
			await deps.broadcast(live, payload, deps.me);
			// Flip the local state to 'broadcast' only if the message
			// is still in 'pending' — a race with the poll loop
			// might have already upgraded it to 'confirmed' before
			// we got here. (Extremely unlikely in practice, but the
			// check is cheap.)
			if (local.state === 'pending') {
				local.state = 'broadcast';
				emit();
			}
		} catch (err) {
			local.state = 'failed';
			local.error = err instanceof Error ? err.message : String(err);
			emit();
		}
	}

	async function retryMessage(localSeq: number): Promise<void> {
		const target = messages.find((m) => m.localSeq === localSeq);
		if (!target || target.state !== 'failed') return;
		// Reset to pending and re-run the send path with the
		// existing text. We reuse the existing LocalMessage — don't
		// add a new one — so the UI doesn't duplicate. Generate a
		// new client_tag for the retry, since the previous tag's
		// broadcast may have actually landed on-chain (we just
		// never saw the confirmation). A new tag means the retry
		// is a distinct op.
		const text = target.text;
		const newTag = deps.generateClientTag();
		target.state = 'pending';
		target.clientTag = newTag;
		target.error = null;
		emit();

		const live = deps.getLiveIdentity();
		if (!live) {
			target.state = 'failed';
			target.error = 'Session is locked — unlock and try again.';
			emit();
			return;
		}

		// Re-run the full crypto path. We don't trust any cached
		// peerPub for a retry (the peer might have just published
		// between the failed send and the retry), so reset
		// peerPubUnknown if it was set.
		let peerPub: Uint8Array | null;
		try {
			peerPub = await ensurePeerChatPub();
		} catch (err) {
			target.state = 'failed';
			target.error = errorToSentinel(err);
			emit();
			return;
		}
		if (peerPub === null) {
			target.state = 'failed';
			target.error = 'peer_not_ready';
			peerPubUnknown = false; // allow next retry to refetch
			emit();
			return;
		}

		let myId: { priv: Uint8Array; pub: Uint8Array };
		try {
			myId = await ensureMyChatIdentity(live);
		} catch (err) {
			target.state = 'failed';
			target.error = err instanceof Error ? err.message : String(err);
			emit();
			return;
		}

		// cp406 — attach a sender self-copy in keep-history mode (the default),
		// so a retried message is also readable by us from chain; DESTROY mode
		// omits it, exactly like the send path (shared helper, no drift).
		const includeSelfCopy = shouldAttachSelfCopy(deps.chatSecurityMode?.());
		let envelope: {
			ciphertext: string;
			ephemeralPub: string;
			nonce: string;
			selfCiphertext?: string;
			selfNonce?: string;
		};
		try {
			envelope = await deps.encrypt(
				text,
				peerPub,
				deps.me,
				deps.peer,
				myId.pub,
				includeSelfCopy
			);
		} catch (err) {
			target.state = 'failed';
			target.error = err instanceof Error ? err.message : String(err);
			emit();
			return;
		}

		const payload: Record<string, unknown> = {
			recipient: deps.peer,
			ciphertext: envelope.ciphertext,
			header: {
				client_tag: newTag,
				ephemeral_pub: envelope.ephemeralPub,
				nonce: envelope.nonce,
				...(envelope.selfCiphertext !== undefined && envelope.selfNonce !== undefined
					? { self_ciphertext: envelope.selfCiphertext, self_nonce: envelope.selfNonce }
					: {})
			}
		};
		try {
			await deps.broadcast(live, payload, deps.me);
			if (target.state === 'pending') {
				target.state = 'broadcast';
				emit();
			}
		} catch (err) {
			target.state = 'failed';
			target.error = err instanceof Error ? err.message : String(err);
			emit();
		}
	}

	return {
		start() {
			if (started || destroyed) return;
			started = true;

			// Phase E.5 — wire up SSE if the dep is provided. The
			// stream delivers a snapshot followed by appended
			// messages.  Both flow through mergePollResponse, the
			// same code path the fallback poll uses, so the local
			// state machine sees a uniform "list of records to
			// merge" regardless of transport.
			if (deps.subscribeStream) {
				streamUnsubscribe = deps.subscribeStream({
					onSnapshot: (items) => {
						// SSE snapshot is authoritative — same as
						// the REST snapshot would be.  mergePollResponse
						// dedups by id, so passing the snapshot through
						// the merge path is idempotent vs already-loaded
						// state.  This matters on reconnect: the user
						// might have history loaded, the connection
						// drops + reconnects, and the new snapshot lands
						// on top of existing state without duplication.
						void mergePollResponse(items);
					},
					onAppend: (rec) => {
						void mergePollResponse([rec]);
					},
					onStreamingChange: (s) => {
						deps.onStreamingChange?.(s);
					}
				});
			}

			// Initial REST fetch — fires only when SSE is NOT wired
			// (legacy / test path).  When SSE is active the snapshot
			// event delivers the same data slightly faster, and we
			// avoid the redundant round-trip.  The fallback poll
			// below still runs in both cases as defense in depth.
			if (!deps.subscribeStream) {
				void pollOnce().then(() => schedulePoll());
			} else {
				// SSE path: schedule the fallback poll without an
				// initial poll.  The first SSE snapshot is the
				// authoritative initial state.
				schedulePoll();
			}

			// Re-poll on visibility-change is only useful when SSE
			// is absent; with SSE the connection stays open across
			// hidden/visible flips.  Keep the listener for the
			// no-SSE path.
			if (!deps.subscribeStream) {
				visibilityCleanup = deps.onVisibilityChange(() => {
					if (destroyed) return;
					if (deps.visibilityState() === 'visible') {
						if (pollHandle !== null) {
							clearTimeout(pollHandle);
							pollHandle = null;
						}
						void pollOnce().then(() => schedulePoll());
					}
				});
			}
		},

		destroy() {
			if (destroyed) return;
			destroyed = true;
			if (streamUnsubscribe !== null) {
				streamUnsubscribe();
				streamUnsubscribe = null;
			}
			if (pollHandle !== null) {
				clearTimeout(pollHandle);
				pollHandle = null;
			}
			if (currentAbort) {
				currentAbort.abort();
				currentAbort = null;
			}
			if (visibilityCleanup) {
				visibilityCleanup();
				visibilityCleanup = null;
			}
			// Wipe sensitive state on destroy. These references live
			// in this closure; once the controller itself is GC'd the
			// closure vanishes, but we don't wait — zero the bytes
			// now so private-key material and plaintext messages
			// don't linger in memory any longer than necessary. This
			// is best-effort (JS's memory model doesn't guarantee
			// zeros survive to the OS page); it's the same posture
			// $crypto/keygen.ts's wipeLiveIdentity uses.
			if (myChatIdentity) {
				try {
					// Dynamic import avoids pulling libsodium into any
					// place that transitively references destroy's
					// type — it's already loaded at this point (we're
					// in destroy, the conversation opened), so this
					// is essentially a free lookup.
					void import('libsodium-wrappers-sumo').then((mod) => {
						if (myChatIdentity) {
							mod.default.memzero(myChatIdentity.priv);
							myChatIdentity = null;
						}
					});
				} catch {
					// Fail silent — memzero is hygiene, not correctness.
					myChatIdentity = null;
				}
			}
			peerChatPub = null;
			// Drop the messages array so any decrypted plaintext
			// becomes GC-eligible immediately, without waiting for
			// the controller's closure to vanish.
			messages = [];
		},

		sendMessage,
		retryMessage,
		snapshot() {
			return [...messages];
		}
	};
}

// ─── Runtime-deps adapter ──────────────────────────────────────────

/** Default deps that use the real indexer client + browser APIs.
 *  The controller factory takes deps explicitly for testability;
 *  runtime callers use this helper to fill in the common set.
 *
 *  `orderPermlink` is optional and threads through to outgoing
 *  payloads (Q11) — pass the order context from ConversationView's
 *  `orderPermlink` prop, or null when no order context exists.
 */
export function runtimeDeps(
	me: string,
	peer: string,
	getLiveIdentity: () => LiveIdentity | null,
	orderPermlink: string | null = null
): ChatControllerDeps {
	return {
		me,
		peer,
		orderPermlink,
		getLiveIdentity,
		now: () => new Date(),
		visibilityState: () =>
			typeof document !== 'undefined' && document.visibilityState === 'hidden'
				? 'hidden'
				: 'visible',
		onVisibilityChange: (cb: () => void) => {
			if (typeof document === 'undefined') return () => undefined;
			document.addEventListener('visibilitychange', cb);
			return () => document.removeEventListener('visibilitychange', cb);
		},
		generateClientTag: () => {
			// 16 random bytes → 32 hex chars. crypto.getRandomValues is
			// available in both browser and Node (webcrypto shim).
			const buf = new Uint8Array(16);
			crypto.getRandomValues(buf);
			let hex = '';
			for (const b of buf) hex += b.toString(16).padStart(2, '0');
			return hex;
		},
		fetchHistory: async (a: string, b: string, opts) => {
			const r = await getChatHistory(a, b, {
				limit: opts.limit,
				cursor: opts.cursor,
				signal: opts.signal
			});
			if (r.ok) {
				return {
					ok: true,
					items: r.data.items,
					nextCursor: r.data.next_cursor
				};
			}
			return { ok: false, message: r.message };
		},
		broadcast: (live, payload, blurtAccount) =>
			broadcastCustomJson(live, OP_IDS.chatMessage, payload, blurtAccount),
		fetchPeerChatPub: async (peerAccount: string) => {
			const r = await getChatIdentity(peerAccount);
			if (!r.ok) {
				// 'not_found' is the expected "peer hasn't published
				// yet" case — surface as null, not an error.  Any
				// other code (network, server error) bubbles up so
				// the caller shows the underlying reason.
				if (r.code === 'not_found') return null;
				throw new Error(r.message);
			}

			// Option-5 chain-anchored TOFU pin (security S2).
			// resolveChatPubFromIndexer is the state machine; we
			// just adapt the indexer response and inject the chain
			// verifier.  On any tamper detection it throws a
			// PubPinError with a stable code; the caller surfaces
			// to the user via the standard "failed message" UX.
			const indexerPin: ChatPubPin = {
				blockNum: r.data.source_block_num,
				trxId: r.data.source_trx_id,
				pubB64: r.data.chat_pub
			};
			const trustedPubB64 = await resolveChatPubFromIndexer(
				peerAccount,
				indexerPin,
				// S14: opt in to local secp256k1 signature verify on
				// the pin-mismatch hot path.  This adds two RPC
				// roundtrips, but only fires when the indexer-reported
				// pub doesn't match the locally pinned one — a rare
				// path that already costs RPC for chain consultation.
				(peer) => fetchLatestChatIdentityFromChainQuorum(peer, 3, 2, true)
			);
			return decodeChatPub(trustedPubB64);
		},
		deriveMyChatIdentity: async (live: LiveIdentity, account: string) => {
			const id = await deriveChatIdentity(live.posting.privateKey, account);
			return { priv: id.priv, pub: id.pub };
		},
		encrypt: async (
			plaintext: string,
			recipientPub: Uint8Array,
			senderAccount: string,
			recipientAccount: string,
			senderChatPub: Uint8Array,
			includeSelfCopy: boolean
		) => {
			const env = await encryptToRecipient(
				plaintext,
				recipientPub,
				senderAccount,
				recipientAccount,
				senderChatPub,
				includeSelfCopy
			);
			return {
				ciphertext: env.ciphertext,
				ephemeralPub: env.ephemeralPub,
				nonce: env.nonce,
				...(env.selfCiphertext !== undefined && env.selfNonce !== undefined
					? { selfCiphertext: env.selfCiphertext, selfNonce: env.selfNonce }
					: {})
			};
		},
		decrypt: async (
			envelope: { ciphertext: string; ephemeralPub: string; nonce: string },
			myPriv: Uint8Array,
			myPub: Uint8Array,
			senderAccount: string,
			recipientAccount: string
		) => {
			try {
				return await decryptFromSender(
					envelope,
					{ priv: myPriv, pub: myPub },
					senderAccount,
					recipientAccount
				);
			} catch (err) {
				if (err instanceof DecryptError) return null;
				// Other errors (missing sodium, etc.) propagate.
				throw err;
			}
		},
		decryptSelfCopy: async (
			envelope: {
				ciphertext: string;
				ephemeralPub: string;
				nonce: string;
				selfCiphertext?: string;
				selfNonce?: string;
			},
			myPriv: Uint8Array,
			myPub: Uint8Array,
			senderAccount: string,
			recipientAccount: string
		) => {
			try {
				return await decryptSelfCopy(
					envelope,
					{ priv: myPriv, pub: myPub },
					senderAccount,
					recipientAccount
				);
			} catch (err) {
				if (err instanceof DecryptError) return null;
				throw err;
			}
		},
		chatSecurityMode: () => readChatSecurityMode(me),
		onChange: () => {
			// Runtime caller replaces this with their Svelte-reactive
			// state-setter. This default is a no-op so a controller
			// created without an onChange doesn't crash.
		},
		subscribeStream: (handlers) => {
			const stream = createChatStream({
				me,
				peer,
				handlers: {
					onSnapshot: (snap) => handlers.onSnapshot(snap.items),
					applyAppend: (rec) => handlers.onAppend(rec),
					onStreamingChange: (s) => handlers.onStreamingChange(s)
				}
			});
			stream.start();
			return () => stream.stop();
		}
	};
}

/** Exported constants — test / UI consumers occasionally need them. */
export const CHAT_CONSTANTS = {
	FALLBACK_POLL_INTERVAL_MS,
	HISTORY_PAGE_SIZE,
	ENCRYPTED_PLACEHOLDER
} as const;
