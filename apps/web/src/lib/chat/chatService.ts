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
 *   failed   — broadcast threw, OR the send never became durable
 *              within NEVER_RECORDED_AFTER_MS (an asynchronously-
 *              broadcast message can be accepted by a node and still
 *              never reach a block). That applies to a message a fast
 *              provisional copy has ALREADY shown as confirmed, too:
 *              a provisional copy proves the node took it, not that the
 *              chain kept it. UI shows the message in red with "Tap to
 *              retry." Retrying transitions back to pending.
 *
 *              NOT TERMINAL. A real copy arriving late clears the
 *              failure — arriving is the proof it did not fail — and
 *              a retry keeps the original's client_tag in
 *              `priorTags` so that late copy still reconciles
 *              instead of appearing twice.
 *
 * Incoming messages from the peer go straight into the
 * `confirmed` bucket — they already have ids and created_at.
 *
 * ─── A copy the chain never records ──────────────────────────────
 *
 * The federation fast path hands a message to the recipient's instance
 * BEFORE the sender's broadcast (ADR-0052), so a recipient can hold a
 * provisional copy of a message the chain then refuses or drops. Such a
 * copy is never deleted — the recipient has read it — but once it has
 * gone NEVER_RECORDED_AFTER_MS without a durable twin it is marked
 * `unrecorded`, and the UI says so. A durable twin arriving later clears
 * the mark: arriving is the proof.
 *
 * When the sender retries, the retry carries the tags it replaces in
 * `header.prior_tags`, and a copy linked to an existing message by tag
 * AND identical plaintext is absorbed into it instead of appearing as a
 * second message. Both conditions, never one: the tag link alone would
 * let a sender hide a different message behind an old one.
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
import { broadcastChatMessage } from '$blurt/sign';
import { OP_IDS, resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
import { fetchChainTx } from '$blurt/chainExplorer';
import { createChatStream } from '$lib/chat/stream';
import type { LiveIdentity } from '$crypto/keygen';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import { decodePayload } from '$lib/chat/payload';
import { recordAddressShared, recordFundsSent } from '$lib/trades/tradeStatus';
import { triggerBlurtVerification } from '$lib/trades/tradeVerify';
import {
	resolveChatPubFromIndexer,
	PubPinError,
	pinnedPubsFor,
	replacedPubsFor,
	pendingKeyChange,
	type ChatPubPin
} from '$lib/chat/pubPin';
import { ChainRelayError } from '$net/chainRelay';

/** LocalMessage.error sentinel for "the chain relay could not be reached".
 *  Mapped to `chat.security.chain_unreachable` by ChatMessage.svelte, exactly
 *  as the PubPinError codes are. */
export const CHAIN_UNREACHABLE_SENTINEL = 'chain_unreachable';
import { verifyPeerChatIdentityOnChain } from '$lib/chat/chainVerify';
import {
	readChatSecurityMode,
	shouldAttachSelfCopy,
	type ChatSecurityMode
} from '$stores/chatSecurity';
import {
	deriveChatIdentity,
	encryptToRecipient,
	decryptFromSender,
	decryptSelfCopy,
	decodeChatPub,
	DecryptError,
	type ChatEnvelopeWire
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
	/** the order this message is about, or null. The inbox threads by it
	 *  (one card per peer+order) and this view is scoped to one thread, so a
	 *  message about another order must not appear here. */
	orderPermlink: string | null;
	/** Blurt transaction id anchoring this message on-chain,
	 *  once known. Null while pending/broadcast/failed, and for
	 *  not-yet-irreversible provisional copies. Populated on durable
	 *  confirmation (own messages) or straight from the record
	 *  (incoming). The chat PDF export cites this so each line is
	 *  independently verifiable on any Blurt block explorer. */
	trxId: string | null;
	/** Non-null only in the 'failed' state. Populated by the
	 *  broadcast catch block. Used by the "Tap to retry" UI. */
	error: string | null;
	/** Tags this message has previously been sent under, oldest first — a retry
	 *  mints a new one, and the copy sent under an older one can still arrive.
	 *  Kept so that late original reconciles instead of appearing twice. */
	priorTags?: string[];
	/** When this client handed the message to the indexer, for OUR OWN sends
	 *  only. Present so a message that was accepted by a node but never made it
	 *  into a block can be noticed and reported rather than sitting in the
	 *  transcript looking delivered — see NEVER_RECORDED_AFTER_MS. Set whether or
	 *  not a provisional copy has already shown the message as confirmed.
	 *  Undefined for incoming messages and for anything loaded from history. */
	sentAtMs?: number;
	/** The transaction id the node accepted this send under, for OUR OWN
	 *  sends. Lets the sweep ask the chain whether a send it is about to call
	 *  failed has in fact landed (v1.18.0 review, W3). */
	sentTrxId?: string;
	/** When the chain first said this send IS on it while our indexer still had
	 *  no durable copy. The sweep re-arms the window
	 *  once; a second "on chain, still not recorded" is final. */
	onChainAtMs?: number;
	/** When a PROVISIONAL copy (id 0 on the wire) of this message first reached
	 *  this client, for messages this client did not send itself — the peer's,
	 *  or our own from another session. Local clock, never the record's
	 *  `created_at`: a skewed clock must not mark every message unrecorded.
	 *  Cleared when the durable copy lands. */
	provisionalSinceMs?: number;
	/** True once a provisional copy has gone NEVER_RECORDED_AFTER_MS without a
	 *  durable twin: the chain has no record of this message. Never set on a
	 *  durable message; cleared if the durable copy turns up late. */
	unrecorded?: boolean;
	/** True if the confirmed message was received but we couldn't
	 *  decrypt it (not our key, malformed ciphertext, etc.). The
	 *  UI renders with muted styling and an explanatory tooltip
	 *  rather than silently showing the raw ciphertext. */
	decryptFailed: boolean;
	/** True for a message from the PEER that arrived in the older v1 envelope:
	 *  it decrypted, but anyone who knows our public chat key could have
	 *  written it, so its sender is not proved. The UI says so, and a payment
	 *  request in it is shown as unverified. */
	senderUnverified?: boolean;
	/** Monotonically-increasing local sequence number used for
	 *  stable `{#each}` keying in the template. Always unique
	 *  within a controller's lifetime. Does NOT correspond to
	 *  the server id. */
	localSeq: number;
	/** For messages from the PEER: the encrypted bytes this message was
	 *  decrypted from (ciphertext, ephemeral key, nonce). Two copies are the
	 *  same message only if these match — see `wireOf`. */
	wire?: string;
}

/**
 * The encrypted bytes a record decrypts from: ciphertext, ephemeral key and
 * nonce. Two records with the same client tag are TWINS — the fast copy and the
 * chain's copy of one message — only if these are identical too.
 *
 * WHY THE TAG ALONE IS NOT ENOUGH (v1.18.0 review, W1). The tag is chosen by
 * the SENDER, and nothing anywhere makes it unique per message. A sender who
 * reused one could make the recipient's view merge two different messages: the
 * words of a message the chain REFUSED (pushed to the federation first, which is
 * how fast delivery works) adopting the id and on-chain proof of a different
 * message that landed — so the transcript and the PDF export would show
 * "Blockchain proof: <tx>" beside words that transaction never carried. Or a
 * second on-chain message would be silently folded into the first and never
 * shown. The bytes are what the proof covers, so the bytes decide.
 */
export function wireOf(rec: { ciphertext: string; header: unknown }): string {
	const h = (rec.header ?? {}) as { ephemeral_pub?: unknown; nonce?: unknown };
	const part = (v: unknown): string => (typeof v === 'string' ? v : '');
	return `${rec.ciphertext}|${part(h.ephemeral_pub)}|${part(h.nonce)}`;
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
	/** Broadcast a chat message. Defaults to broadcastChatMessage at runtime;
	 *  tests inject a mock.
	 *
	 *  `block_num` is null: a chat message does not wait for a block (see
	 *  broadcastChatMessage). Nothing here reads it — both send paths discard
	 *  this result entirely and await it only so a rejection can mark the
	 *  message failed — but the type says so rather than implying a block
	 *  number that was never fetched. */
	broadcast(
		live: LiveIdentity,
		payload: Record<string, unknown>,
		blurtAccount: string
	): Promise<{ block_num: number | null; trx_id: string }>;
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
	/** Encrypt plaintext to a recipient in the v2 (sender-authenticated)
	 *  envelope; `sender` is our own chat identity. Injected (rather than
	 *  called from crypto.ts directly) so tests can assert "encrypt was
	 *  called with these args" without exercising libsodium. */
	encrypt(
		plaintext: string,
		recipientPub: Uint8Array,
		senderAccount: string,
		recipientAccount: string,
		sender: { priv: Uint8Array; pub: Uint8Array },
		includeSelfCopy: boolean
	): Promise<{
		v?: 2;
		ciphertext: string;
		ephemeralPub: string;
		nonce: string;
		selfCiphertext?: string;
		selfNonce?: string;
	}>;
	/** Decrypt an envelope. `senderPubs` are the sender's pinned chat keys
	 *  (current first), which a v2 envelope must open with. Returns the
	 *  plaintext and whether the sender is proved (a bare string counts as
	 *  NOT proved), or null if decryption fails (the UI shows the placeholder
	 *  in that case rather than crashing the conversation). */
	decrypt(
		envelope: { v?: number; ciphertext: string; ephemeralPub: string; nonce: string },
		myPriv: Uint8Array,
		myPub: Uint8Array,
		senderAccount: string,
		recipientAccount: string,
		senderPubs?: readonly Uint8Array[]
	): Promise<string | { text: string; authenticated: boolean } | null>;
	/** decrypt the SENDER's own self-copy of a message they sent
	 *  (keep-history mode). Returns the plaintext, or null if there's no
	 *  self-copy present or it fails. Optional so existing test fakes without
	 *  it still type-check; the own-sent render path falls back to the
	 *  in-memory cache / placeholder when it's absent. */
	decryptSelfCopy?(
		envelope: {
			v?: number;
			ciphertext: string;
			ephemeralPub: string;
			nonce: string;
			selfCiphertext?: string;
			selfNonce?: string;
		},
		myPriv: Uint8Array,
		myPub: Uint8Array,
		senderAccount: string,
		recipientAccount: string,
		recipientPubs?: readonly Uint8Array[]
	): Promise<string | null>;
	/** The chat key pinned for `peer` now (pubPin.pinnedPubsFor): the only
	 *  key a v2 message from the peer is authenticated with. Optional: absent →
	 *  the conversation's fetched key is used (tests). */
	pinnedPeerPubs?(peer: string): readonly Uint8Array[];
	/** Keys an accepted key change replaced (pubPin.replacedPubsFor): they
	 *  open older messages for reading only — such a message is shown as
	 *  "sender not verified" and never moves a trade. */
	replacedPeerPubs?(peer: string): readonly Uint8Array[];
	/** A changed key for `peer` the user has not accepted yet, if any. */
	pendingPeerPub?(peer: string): Uint8Array | null;
	/** the account's chat-security mode ('keep' | 'destroy'), read
	 *  fresh at send time. Optional: absent → treated as 'keep' (the default,
	 *  self-copy on), so existing tests keep their prior behavior. */
	chatSecurityMode?(): ChatSecurityMode;
	/**
	 * Is this transaction on the chain? Asked by the sweep before it calls one
	 * of our sends failed (v1.18.0 review, W3). 'unknown' when the question
	 * could not be answered — the sweep then does what it always did. Optional:
	 * absent, the sweep does not ask (tests that predate it).
	 */
	transactionOnChain?(trxId: string): Promise<'found' | 'not_found' | 'unknown'>;
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

/** Fallback poll cadence. SSE is the primary delivery path (appends
 *  typically arrive <5s after broadcast); this poll runs ALONGSIDE it as
 *  a safety net for messages missed on a bus-emit drop, a network glitch
 *  during SSE re-connect, or when EventSource is unavailable/blocked
 *  entirely. Was 60s — far too slow when the SSE is flaky (the felt
 *  "chat is way too slow"). Now ~4-6s (base + jitter) so the WORST-CASE
 *  latency, even with SSE fully down, stays inside the ≤6s fastchat
 *  target instead of a full minute. */
const FALLBACK_POLL_INTERVAL_MS = 4_000;

/** Initial history page size — the newest 50 messages on first
 *  load. Matches the design-doc recommendation. */
const HISTORY_PAGE_SIZE = 50;
/** Random jitter added to the fallback poll so clients don't all ping on
 *  the same block boundary. Kept small (≤2s) so base + jitter stays within
 *  the ≤6s fastchat target. */
const POLL_JITTER_MS = 2_000;
/**
 * How long a message may go without a durable copy before it is treated as one
 * the chain will never record.
 *
 * Built from the worst legitimate case, not a feeling. A Blurt transaction is
 * signed to expire sixty seconds after the head block it references, and a node
 * may include it any time before then; the durable row it reconciles with is
 * written only once its block is irreversible, 45-63 seconds after inclusion.
 * 60 + 63 = 123 seconds before anything can be called late — which the previous
 * two-minute figure did not cover. The rest is margin for the fallback poll and
 * a slow hidden-network round trip.
 *
 * Being early here is not harmless in either direction. On the sender's side it
 * prompts a resend of a message that is still on its way; on the recipient's it
 * tells them the chain has no record of something it is about to record.
 */
export const NEVER_RECORDED_AFTER_MS = 150_000;

/** LocalMessage.error sentinel: our own send was accepted but never became
 *  durable. Localized by ChatMessage.svelte as `chat.message.not_confirmed_on_chain`. */
export const NOT_CONFIRMED_SENTINEL = 'not_confirmed_on_chain';

/** LocalMessage.error sentinel: the session was locked when the send was
 *  attempted. Localized as `chat.message.session_locked`. */
export const SESSION_LOCKED_SENTINEL = 'session_locked';

/**
 * LocalMessage.error sentinel: the transaction IS on the chain, but no durable
 * copy ever arrived — the indexers refused it (the recipient blocks us, the
 * stranger fee applies after all, the order it answered is gone). FINAL: no
 * Retry, because resending would be refused the same way. Localized as
 * `chat.message.on_chain_not_accepted`. (W3 used to
 * treat "on chain" as "will be recorded" and re-armed forever, so such a
 * message said "confirmed" for good while the recipient never got it.)
 */
export const ON_CHAIN_NOT_ACCEPTED_SENTINEL = 'on_chain_not_accepted';

/**
 * Only unconfirmed own sends younger than this are put back when a thread is
 * reopened. Past it the sweep would already have
 * decided, and the durable copy may simply have landed while no view was open
 * — beyond the newest page of history, where the merge cannot see it. Putting
 * such a message back ended in a ghost "failed" bubble and, on Retry, a second
 * copy on chain. The window plus a minute for the poll and the chain check.
 */
export const RESTORE_UNCONFIRMED_MAX_AGE_MS = NEVER_RECORDED_AFTER_MS + 60_000;

/** At most this many earlier tags travel with a retry, and at most this many
 *  are accepted from one. Matches the bound on `priorTags` itself. */
export const MAX_PRIOR_TAGS = 8;

/** The shape `generateClientTag` produces: 16 random bytes as hex. */
const CLIENT_TAG_RE = /^[0-9a-f]{32}$/;

/**
 * The tags a copy declares it replaces (`header.prior_tags`), validated.
 *
 * Anything malformed yields none rather than some: the field is written by the
 * sender, and a partially-honoured list is harder to reason about than an
 * ignored one. Never includes the copy's own tag.
 */
export function priorTagsFromHeader(header: unknown, ownTag: string | null): string[] {
	if (typeof header !== 'object' || header === null) return [];
	const v = (header as Record<string, unknown>).prior_tags;
	if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PRIOR_TAGS) return [];
	if (!v.every((t) => typeof t === 'string' && CLIENT_TAG_RE.test(t))) return [];
	return [...new Set(v as string[])].filter((t) => t !== ownTag);
}

/** Placeholder text for messages we can't decrypt — shown when
 *  the AEAD verification fails (malformed ciphertext, recipient
 *  not us, key rotation since the message was sent, AAD tamper
 *  detection, etc.). The decrypt path catches any DecryptError
 *  from `crypto.ts`'s `decryptFromSender` and surfaces this
 *  text plus a `decryptFailed` flag on the LocalMessage so the
 *  UI can render appropriately. */
const ENCRYPTED_PLACEHOLDER = '(encrypted)';

// ─── own-sent plaintext cache (in-memory only) ─────────
//
// The sender generates a fresh ephemeral X25519 keypair per message and
// WIPES the ephemeral private key immediately after encrypting, so the
// sender cannot re-derive the recipient copy of its OWN sent messages from
// chain history (only the recipient's key opens it; the self-copy exists for
// this, and is absent in 'destroy' mode). During a live session that's invisible: the
// composer keeps the plaintext we typed as a local optimistic echo. But
// when the user navigates away and back, the controller is destroyed and
// that echo is gone; a fresh controller reloading history sees our own
// sent messages as ciphertext it cannot decrypt and renders "(encrypted)".
//
// This cache closes that gap by remembering the plaintext of OUR sent
// messages, keyed by account + client_tag, so a fresh controller can
// restore them. Crucially it lives ONLY in memory — nothing is written
// to disk — so it adds nothing to what disk or chain reveal (the plaintext
// is already resident in memory while the conversation is open; this merely
// lets it survive in-app navigation within the same tab session). It is:
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
	unconfirmedOwnSends.clear();
	// This is the lock hook — identity.ts calls it from
	// lockSession() and reset(). Clearing the maps was not enough: a controller
	// still mounted kept the decrypted transcript on screen and its derived chat
	// key, and its sweep or an in-flight send wrote plaintext straight back.
	for (const onLock of Array.from(controllerLockHooks)) {
		try {
			onLock();
		} catch {
			// One controller's trouble must not stop the others from locking.
		}
	}
}

/** One entry per live conversation controller: what it does on a lock. */
const controllerLockHooks = new Set<() => void>();

/**
 * Our own sends the node ACCEPTED and the chain has not yet confirmed, kept
 * past the conversation view that sent them (v1.18.0 review, W2).
 *
 * "Not confirmed on chain — tap to send again" (F29) lived only inside one
 * conversation controller. Sending and then leaving the chat is the ordinary
 * pattern, and the next controller rebuilt the message from whatever the
 * indexer still had: within five minutes a provisional copy with a fresh clock
 * (and no Retry), after that nothing at all. So a send the chain dropped
 * vanished from the sender's view, silently, exactly when they were not
 * looking — the case F29 exists for. Restored here on return, with the
 * ORIGINAL clock, so the sweep can still say so and offer Retry.
 *
 * Holds plaintext, so it follows the own-sent cache's rules: keep-history mode
 * only (destroy mode promises nothing survives leaving the chat), in memory
 * only, cleared on lock and sign-out, bounded.
 */
interface UnconfirmedOwnSend {
	readonly clientTag: string;
	readonly text: string;
	readonly sentAtMs: number;
	readonly trxId: string | null;
	readonly priorTags: readonly string[];
	readonly onChainAtMs: number | null;
}
const UNCONFIRMED_OWN_MAX = 200;
const unconfirmedOwnSends = new Map<string, UnconfirmedOwnSend>();
function unconfirmedKey(me: string, peer: string, order: string | null, tag: string): string {
	return `${me}\t${peer}\t${order ?? ''}\t${tag}`;
}
function unconfirmedThreadPrefix(me: string, peer: string, order: string | null): string {
	return `${me}\t${peer}\t${order ?? ''}\t`;
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
	// A chain read that could not be MADE is not a verification result, and must
	// not fall through to a raw technical message on a send failure. It gets its
	// own localized sentinel so the user is told the ordinary truth — the
	// blockchain was briefly unreachable, common on Tor/I2P, try again — rather
	// than an AbortError, or worse, a tamper warning.
	if (err instanceof ChainRelayError) return CHAIN_UNREACHABLE_SENTINEL;
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
	/** Bumped on every session lock. An async merge that started before the lock
	 *  must not add what it decrypted after it. */
	let lockEpoch = 0;

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
		return myChatIdentity;
	}

	async function ensurePeerChatPub(): Promise<Uint8Array | null> {
		if (peerChatPub) {
			return peerChatPub;
		}
		if (peerPubUnknown) return null;
		const fetched = await deps.fetchPeerChatPub(deps.peer);
		if (fetched === null) {
			peerPubUnknown = true;
			return null;
		}
		peerChatPub = fetched;
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
		// id 0 marks a PROVISIONAL head-block (fast-path)
		// copy that isn't irreversible yet (ADR-0048). It must never
		// overwrite a real, durable id.
		const isDurable = rec.id !== 0;
		for (const m of messages) {
			// Our own messages only. A tag is chosen by whoever signs the message,
			// and the PEER's messages carry tags too — including, since retries
			// declare the tags they replace, tags the peer merely NAMED. Without
			// this a peer could list one of our tags and have our own message
			// reconcile into theirs and vanish from our transcript.
			if (m.sender !== deps.me) continue;
			// A tag this message is CURRENTLY using, or one it used before a retry.
			// See `priorTags`: without the second clause a late original arrives
			// matching nothing and is appended as a duplicate.
			if (m.clientTag !== tag && m.priorTags?.includes(tag) !== true) continue;
			// This is one of our own messages, matched by client_tag. It
			// could be the local optimistic echo (pending/broadcast), a
			// provisional fast-path copy already reconciled (confirmed,
			// id still null), or the durable copy (confirmed, real id).
			// Every case is a dedup hit — we return true so the caller
			// never appends a second entry.
			// 'failed' is included deliberately. A message can be marked failed
			// while it is in fact on its way — the node accepted it and the
			// response was lost, or an older bundle rejected a reply shape it did
			// not recognise. If the real copy then arrives, the transcript should
			// say what happened rather than keep a red bubble beside the message
			// it is complaining about. Arriving IS the proof it did not fail.
			if (m.state === 'pending' || m.state === 'broadcast' || m.state === 'failed') {
				// A PROVISIONAL copy clearing a failure proves the node took the
				// message, not that the chain kept it — so it earns a fresh window,
				// not a permanent pass. Without this the next sweep would fail it
				// again at once, and without the window at all it would sit
				// confirmed forever if it then never landed.
				if (m.state === 'failed' && !isDurable) m.sentAtMs = Date.now();
				m.state = 'confirmed';
				m.error = null;
				m.createdAt = new Date(rec.created_at);
			}
			// Adopt the durable id the first time it lands; a provisional
			// (id 0) never overwrites a real id we already hold.
			if (isDurable && (m.id === null || m.id === 0)) adoptDurable(m, rec);
			return true;
		}
		return false;
	}

	/** A durable copy has landed for `m`: take its id, time and on-chain anchor,
	 *  and drop every "still waiting for the chain" marker — arriving is the
	 *  proof. */
	function adoptDurable(m: LocalMessage, rec: ChatMessageRecord): void {
		// Our own send is on the chain for good: nothing left to remember (W2).
		if (m.sender === deps.me) {
			forgetUnconfirmed(m.clientTag);
			delete m.sentTrxId;
			delete m.onChainAtMs;
		}
		m.id = rec.id;
		m.createdAt = new Date(rec.created_at);
		m.trxId = rec.source_trx_id || null;
		delete m.provisionalSinceMs;
		delete m.sentAtMs;
		m.unrecorded = false;
	}

	/**
	 * An existing message that `rec` is a retry of, or that is a retry of `rec`.
	 *
	 * Linked by TAG — the new copy names the message's tag in its prior_tags, or
	 * the message already carries the copy's tag among its own — AND by identical
	 * readable plaintext from the same sender in the same thread. The tag says the
	 * sender means it as a resend; the text says it IS one. A tag link alone would
	 * let a sender quietly hide a different message behind an older one, in the
	 * live view only, which is worse than a duplicate.
	 */
	function findRetryLink(
		sender: string,
		orderPermlink: string | null,
		text: string,
		incomingTag: string,
		declared: readonly string[]
	): LocalMessage | undefined {
		// A placeholder is not content: two unreadable messages are not the same
		// message. (A locked session yields the placeholder with decryptFailed
		// false, so the flag alone does not cover it.)
		if (text === ENCRYPTED_PLACEHOLDER) return undefined;
		return messages.find(
			(m) =>
				m.sender === sender &&
				m.orderPermlink === orderPermlink &&
				!m.decryptFailed &&
				m.text === text &&
				((m.clientTag !== null && declared.includes(m.clientTag)) ||
					m.priorTags?.includes(incomingTag) === true)
		);
	}

	/**
	 * Fold a retry copy into the message it resends. The message keeps its place
	 * in the transcript and its tag; the copy's tag and whatever it declared join
	 * `priorTags`, so every later copy of either attempt lands here too.
	 */
	function absorbRetryCopy(
		m: LocalMessage,
		rec: ChatMessageRecord,
		incomingTag: string,
		declared: readonly string[]
	): void {
		const tags = new Set([...(m.priorTags ?? []), incomingTag, ...declared]);
		if (m.clientTag !== null) tags.delete(m.clientTag);
		// Bounded like everything a peer can grow: one attempt's own declared
		// list plus the attempts folded in since, newest kept.
		m.priorTags = [...tags].slice(-MAX_PRIOR_TAGS * 2);
		if (rec.id !== 0) {
			if (m.id === null || m.id === 0) adoptDurable(m, rec);
		} else if (m.id === null) {
			// A fresh provisional attempt: it may yet land, so the verdict on the
			// old one no longer describes this message. Start its window again.
			m.provisionalSinceMs = Date.now();
			m.unrecorded = false;
		}
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
	): Promise<{ text: string; decryptFailed: boolean; senderUnverified: boolean }> {
		// If the session is locked, we can't derive our chat
		// identity. Show placeholder; once the user unlocks and
		// re-enters the conversation, a fresh controller will
		// decrypt the history.
		const live = deps.getLiveIdentity();
		if (!live) {
			return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: false, senderUnverified: false };
		}

		// Extract envelope fields from the header. The on-chain
		// header is JSONB and arbitrarily-shaped; we narrow defensively.
		const header = rec.header;
		if (typeof header !== 'object' || header === null) {
			return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: true, senderUnverified: false };
		}
		const h = header as Record<string, unknown>;
		const ephemeralPub = h.ephemeral_pub;
		const nonce = h.nonce;
		if (typeof ephemeralPub !== 'string' || typeof nonce !== 'string') {
			// Could be a legacy "stub" message from the pre-crypto
			// days — those have no ephemeral_pub or nonce, only a
			// client_tag. Render as placeholder without flagging as
			// a "real" failure (it's a known boundary case).
			return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: false, senderUnverified: false };
		}
		const v = typeof h.v === 'number' ? h.v : undefined;

		try {
			const id = await ensureMyChatIdentity(live);
			const open = (pubs: readonly Uint8Array[]) =>
				deps.decrypt(
					{ ...(v !== undefined ? { v } : {}), ciphertext: rec.ciphertext, ephemeralPub, nonce },
					id.priv,
					id.pub,
					rec.sender,
					rec.recipient,
					pubs
				);
			let opened = await open(await senderPubCandidates(rec.sender));
			let viaPendingKey = false;
			if (opened === null && v === 2) {
				// The peer may have changed keys and the user has not accepted
				// the new one yet: the message can be read, but its sender is
				// not proved until they do.
				const pending = deps.pendingPeerPub?.(rec.sender) ?? null;
				if (pending !== null) {
					opened = await open([pending]);
					viaPendingKey = opened !== null;
				}
			}
			if (opened === null && v === 2) {
				// A key the peer REPLACED: readable history, never proof of who
				// sent it (the old key may be in someone else's hands now).
				const replaced = deps.replacedPeerPubs?.(rec.sender) ?? [];
				if (replaced.length > 0) {
					opened = await open(replaced);
					viaPendingKey = opened !== null;
				}
			}
			if (opened === null) {
				return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: true, senderUnverified: false };
			}
			const text = typeof opened === 'string' ? opened : opened.text;
			const authenticated = typeof opened === 'string' ? false : opened.authenticated;
			return { text, decryptFailed: false, senderUnverified: !authenticated || viaPendingKey };
		} catch {
			// Any unexpected error during decrypt (including
			// crypto init failures, libsodium issues, etc.) falls
			// back to placeholder. Conversation keeps rendering.
			return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: true, senderUnverified: false };
		}
	}

	/** The chat keys a message from `sender` (always the peer here) may be
	 *  opened with: the pinned key, then keys it replaced. When the peer is not
	 *  pinned yet, their key is fetched and pinned once (trust on first use). */
	async function senderPubCandidates(sender: string): Promise<Uint8Array[]> {
		const pinned = deps.pinnedPeerPubs?.(sender) ?? [];
		if (pinned.length > 0) return [...pinned];
		if (sender !== deps.peer) return [];
		const fetched = await ensurePeerChatPub().catch(() => null);
		return fetched !== null ? [fetched] : [];
	}

	/** decrypt OUR OWN sent message from chain via its self-copy
	 *  (keep-history mode, the default). Returns the plaintext, or null when
	 *  there's no self-copy ("destroy" mode / a pre-feature message), the
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
		const v = typeof h.v === 'number' ? h.v : undefined;
		try {
			const id = await ensureMyChatIdentity(live);
			return await deps.decryptSelfCopy(
				{
					...(v !== undefined ? { v } : {}),
					ciphertext: rec.ciphertext,
					ephemeralPub,
					nonce,
					selfCiphertext,
					selfNonce
				},
				id.priv,
				id.pub,
				rec.sender,
				rec.recipient,
				// Our self-copy was made with the key the peer had then: the
				// replaced ones too (reading our own message proves nothing).
				[
					...(await senderPubCandidates(rec.recipient)),
					...(deps.replacedPeerPubs?.(rec.recipient) ?? [])
				]
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
		const epoch = lockEpoch;
		/** A lock landed while this merge was awaiting a decrypt: stop here. */
		const lockedSince = (): boolean => epoch !== lockEpoch || destroyed;

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
			// A durable copy of our own send, in ANY thread
			// with this peer (history spans them all): that send is recorded, so it
			// must never be put back as "unconfirmed" — even if this view never
			// shows the record. Checked before the thread filter for that reason.
			if (rec.sender === deps.me && rec.id !== 0) {
				const durableTag = clientTagFromHeader(rec.header);
				if (durableTag !== null) {
					unconfirmedOwnSends.delete(
						unconfirmedKey(deps.me, deps.peer, rec.order_permlink ?? null, durableTag)
					);
				}
			}
			// ONE THREAD PER (peer, order). Every record enters here: the
			// initial page, "load older" pages, and live SSE appends. Filtering at
			// this single seam is what keeps a reply about order A out of the
			// discussion about order B, no matter which path delivered it.
			//
			// `?? null` on both sides: an older instance omits the field entirely,
			// and an order-less thread is a real thread whose key is null.
			if ((rec.order_permlink ?? null) !== (deps.orderPermlink ?? null)) {
				continue;
			}
			// id 0 marks a PROVISIONAL copy (ADR-0048/0052): not yet on the
			// chain's irreversible record, and possibly never.
			const isDurable = rec.id !== 0;
			// Is this a confirmation of a local outgoing message?
			if (rec.sender === deps.me) {
				if (reconcileByClientTag(rec)) {
					added = true;
					continue;
				}
				// No local tag matched AND we've seen this id before
				// (e.g. second poll after we already merged it once):
				// skip. Durable ids only: every provisional carries id 0, so
				// testing it would drop each provisional after the first.
				if (isDurable && seenIds.has(rec.id)) continue;
				// No local tag matched — a message we sent, but not from
				// this controller's live echo (we navigated away and back,
				// or it was sent from another client/session). in
				// keep-history mode we can now re-decrypt our own messages from
				// chain via their self-copy — so try that FIRST (survives a full
				// reload). Fall back to the in-memory own-sent cache (covers
				// destroy-mode messages we typed this session), then the placeholder.
				// Everything is gated on getLiveIdentity() so a LOCKED session
				// shows the placeholder, exactly like incoming messages.
				const ownTag = clientTagFromHeader(rec.header);
				const ownFromChain = await decryptOwnFromChain(rec);
				if (lockedSince()) return;
				const ownCached =
					ownFromChain === null && deps.getLiveIdentity() !== null && ownTag !== null
						? ownSentPlaintext.get(ownSentKey(deps.me, ownTag))
						: undefined;
				const ownText = ownFromChain ?? ownCached ?? ENCRYPTED_PLACEHOLDER;
				const ownDeclared = priorTagsFromHeader(rec.header, ownTag);
				// A retry made from our OTHER session: fold it into the attempt it
				// resends, exactly as the recipient does (see the incoming branch).
				if (ownTag !== null) {
					const linked = findRetryLink(
						rec.sender,
						rec.order_permlink ?? null,
						ownText,
						ownTag,
						ownDeclared
					);
					if (linked) {
						absorbRetryCopy(linked, rec, ownTag, ownDeclared);
						added = true;
						continue;
					}
				}
				messages.push({
					// Provisional copies get NO id. They all carry 0, and a 0 here
					// entered seenIds above and silenced every later provisional
					// from our other session until its durable copy arrived.
					id: isDurable ? rec.id : null,
					orderPermlink: rec.order_permlink ?? null,
					clientTag: ownTag,
					text: ownText,
					sender: rec.sender,
					state: 'confirmed',
					createdAt: new Date(rec.created_at),
					trxId: isDurable ? rec.source_trx_id || null : null,
					error: null,
					decryptFailed: false,
					localSeq: ++localSeqCounter,
					...(ownDeclared.length > 0 ? { priorTags: ownDeclared } : {}),
					...(isDurable ? {} : { provisionalSinceMs: Date.now() })
				});
				added = true;
			} else {
				// Incoming from the peer.
				// id 0 marks a PROVISIONAL head-block copy
				// (ADR-0048 fast path), not yet irreversible.
				const incomingTag = clientTagFromHeader(rec.header);

				// Collapse a fast-path provisional against its durable
				// twin — either may arrive first, and both carry the same
				// on-chain client_tag. On a hit, adopt the durable id the
				// first time it lands, but NEVER re-decode or re-record:
				// the trade-status side effects below ran when the message
				// first arrived, and re-running them would double-record
				// an address/funds-sent payload.
				if (incomingTag !== null) {
					// Same sender, same tag AND the same encrypted bytes — the tag
					// alone is the sender's to choose. See wireOf.
					const wire = wireOf(rec);
					const twin = messages.find(
						(m) => m.sender === rec.sender && m.clientTag === incomingTag && m.wire === wire
					);
					if (twin) {
						if (isDurable && (twin.id === null || twin.id === 0)) {
							adoptDurable(twin, rec);
						}
						added = true;
						continue;
					}
				}

				// No twin yet. Durable copies dedup by id; a provisional
				// (id 0) is stored with a null id and never enters seenIds.
				if (isDurable && seenIds.has(rec.id)) {
					continue;
				}
				const d = await decryptOrPlaceholder(rec);
				if (lockedSince()) return;
				const declared = priorTagsFromHeader(rec.header, incomingTag);

				// A RETRY of a message already here — typically one whose first
				// attempt reached us from a peer and was then refused by the chain.
				// Fold it in rather than show the same words twice, and DO NOT run
				// the side effects below again: they ran for the first copy, and a
				// second run would record the same payment claim twice.
				if (incomingTag !== null && !d.decryptFailed) {
					const linked = findRetryLink(
						rec.sender,
						rec.order_permlink ?? null,
						d.text,
						incomingTag,
						declared
					);
					if (linked) {
						absorbRetryCopy(linked, rec, incomingTag, declared);
						added = true;
						continue;
					}
				}

				messages.push({
					id: isDurable ? rec.id : null,
					orderPermlink: rec.order_permlink ?? null,
					clientTag: incomingTag,
					text: d.text,
					sender: rec.sender,
					state: 'confirmed',
					createdAt: new Date(rec.created_at),
					trxId: isDurable ? rec.source_trx_id || null : null,
					error: null,
					decryptFailed: d.decryptFailed,
					...(d.senderUnverified ? { senderUnverified: true } : {}),
					localSeq: ++localSeqCounter,
					wire: wireOf(rec),
					// Kept so a copy of the attempt this one replaces, arriving
					// AFTER it, is recognised too. Unverified until then: the
					// link still has to pass the identical-text test.
					...(declared.length > 0 ? { priorTags: declared } : {}),
					...(isDurable ? {} : { provisionalSinceMs: Date.now() })
				});
				added = true;

				// Phase F.5 — populate the trade-status store from
				// incoming structured payloads.  If the decrypted
				// plaintext is a recognized address/funds-sent
				// payload with an orderPermlink, route it.  Plain
				// chat messages decode to 'plaintext' and are no-ops.
				// Only for a message whose sender is PROVED (v2): a v1 message
				// could have been written by anyone who knows our public chat
				// key, so it never moves a trade forward.
				if (!d.decryptFailed && !d.senderUnverified) {
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
											txid: decoded.payload.txid,
											direction: 'incoming'
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

	/**
	 * Say so when a message has gone NEVER_RECORDED_AFTER_MS without a durable
	 * copy — on both sides of the conversation.
	 *
	 * OUR OWN SENDS. A chat message is answered when the NODE accepts it, not when
	 * a witness seals it into a block — which is what removes three seconds from
	 * every send. Acceptance is not inclusion: a transaction can be accepted and
	 * then expire, be dropped, or lose a fork. Such a send becomes 'failed', with
	 * Retry. That includes one a provisional copy has already shown as
	 * 'confirmed' — and in practice that is nearly all of them, because this
	 * instance delivers every accepted chat message to its own listeners, the
	 * sender's included. A sweep that looked only at 'broadcast' therefore almost
	 * never fired: the one case it was written for sat confirmed forever.
	 *
	 * EVERYONE ELSE'S. A provisional copy from the peer (or from our own other
	 * session) with no durable twin is marked `unrecorded` — never removed, since
	 * the recipient has read it, and not failed, since there is nothing here to
	 * retry.
	 *
	 * Safe to be wrong in the late-arriving case either way: a durable copy
	 * clears both the failure and the mark.
	 */
	function sweepUnconfirmed(): void {
		const cutoff = Date.now() - NEVER_RECORDED_AFTER_MS;
		let changed = false;
		for (const m of messages) {
			if (m.id !== null && m.id !== 0) continue; // durable: nothing to wait for
			if (
				m.sentAtMs !== undefined &&
				m.sentAtMs <= cutoff &&
				(m.state === 'broadcast' || m.state === 'confirmed')
			) {
				// ASK THE CHAIN FIRST, when we can (v1.18.0 review, W3). The
				// window assumes our indexer keeps up; one that is catching up
				// — hidden-only RPC, a restart — has not yet recorded a message
				// that DID land, and calling it failed invites a Retry that puts
				// a second copy on chain. The answer arrives asynchronously and
				// decides then; see askChainBeforeFailing.
				if (m.sentTrxId !== undefined && deps.transactionOnChain !== undefined) {
					askChainBeforeFailing(m);
					continue;
				}
				m.state = 'failed';
				m.error = NOT_CONFIRMED_SENTINEL;
				changed = true;
			} else if (
				m.provisionalSinceMs !== undefined &&
				m.provisionalSinceMs <= cutoff &&
				m.unrecorded !== true
			) {
				m.unrecorded = true;
				changed = true;
			}
		}
		if (changed) emit();
	}

	/** Messages whose chain check is in flight, so a sweep does not ask twice. */
	const chainChecks = new WeakSet<LocalMessage>();

	/**
	 * One of our sends has waited out the window: is it on the chain after all?
	 *
	 *   found     → our indexer is behind, not the send: ONE fresh window for the
	 *               durable copy, and no Retry to put a second one on chain. Found
	 *               again after that window → final: on chain but not accepted
	 *               (L1 — the indexers refused it; a resend would be refused too);
	 *   not_found → it never landed: failed, with Retry, exactly as before;
	 *   unknown   → the question could not be answered: as before, failed.
	 *
	 * Decided only if the message is still the same attempt, still waiting.
	 */
	function askChainBeforeFailing(m: LocalMessage): void {
		const trxId = m.sentTrxId;
		const ask = deps.transactionOnChain;
		if (trxId === undefined || ask === undefined || chainChecks.has(m)) return;
		chainChecks.add(m);
		void ask(trxId)
			.catch(() => 'unknown' as const)
			.then((verdict) => {
				chainChecks.delete(m);
				if (destroyed) return;
				if (m.sentTrxId !== trxId || (m.id !== null && m.id !== 0)) return;
				if (m.state !== 'broadcast' && m.state !== 'confirmed') return;
				if (verdict === 'found') {
					if (m.onChainAtMs === undefined) {
						m.onChainAtMs = Date.now();
						m.sentAtMs = Date.now();
						rememberUnconfirmed(m);
						return;
					}
					// A whole further window on the chain and
					// still no durable copy: the indexers will not record it. Say so,
					// finally, with no Retry — not "confirmed" forever.
					forgetUnconfirmed(m.clientTag);
					m.state = 'failed';
					m.error = ON_CHAIN_NOT_ACCEPTED_SENTINEL;
					emit();
					return;
				}
				m.state = 'failed';
				m.error = NOT_CONFIRMED_SENTINEL;
				emit();
			});
	}

	function schedulePoll(): void {
		if (destroyed) return;
		const jitter = Math.floor(Math.random() * POLL_JITTER_MS);
		pollHandle = setTimeout(async () => {
			await pollOnce();
			sweepUnconfirmed();
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
				orderPermlink: deps.orderPermlink ?? null,
				clientTag: null,
				text: trimmed,
				sender: deps.me,
				state: 'failed',
				createdAt: null,
				trxId: null,
				error: SESSION_LOCKED_SENTINEL,
				decryptFailed: false,
				localSeq: ++localSeqCounter
			});
			emit();
			return;
		}

		const clientTag = deps.generateClientTag();
		// keep-history mode (the DEFAULT) caches our own plaintext so it
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
			orderPermlink: deps.orderPermlink ?? null,
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

		// Step 3: encrypt. deps.encrypt wraps crypto.encryptToRecipient (the v2,
		// sender-authenticated envelope: our own chat identity takes part in
		// the key). In keep-history mode (the default) the envelope also carries
		// a sender self-copy — a second ciphertext only the two of us can have
		// written, which we can reopen — letting us reread our own sent messages
		// from chain. The opt-in "destroy on leave" mode omits it.
		const includeSelfCopy = keepHistory;
		let envelope: {
			v?: 2;
			ciphertext: string;
			ephemeralPub: string;
			nonce: string;
			selfCiphertext?: string;
			selfNonce?: string;
		};
		try {
			envelope = await deps.encrypt(trimmed, peerPub, deps.me, deps.peer, myId, includeSelfCopy);
		} catch (err) {
			local.state = 'failed';
			local.error = err instanceof Error ? err.message : String(err);
			emit();
			return;
		}

		// Step 4: build the on-wire payload and hand it to the node.
		const payload = wirePayload(clientTag, envelope, []);
		try {
			const res = await deps.broadcast(live, payload, deps.me);
			markAccepted(local, res?.trx_id);
		} catch (err) {
			markSendFailed(local, err);
		}
	}

	/**
	 * The morphit_chat_v1 payload for one send attempt.
	 *
	 * ONE builder for the first send and every retry. They used to be two
	 * literals, and the retry's had quietly lost `order_permlink`: a retried
	 * message in an order discussion went out as a DIRECT message — threaded
	 * into the wrong conversation on both sides, charged the stranger fee the
	 * order context waives, and never reconciled with the bubble it was sent
	 * from, which the sweep then failed again. Retrying could not succeed.
	 *
	 * Header: the envelope version (`v: 2`), its public fields (ephemeral_pub +
	 * nonce), our client_tag for reconciliation, the keep-history self-copy when there is
	 * one, and on a retry the tags it replaces (`prior_tags`), so the recipient
	 * can fold it into a first attempt the chain never recorded rather than show
	 * both. All opaque to the indexer, which bounds the header's size and stores
	 * it.
	 *
	 * Q11: `order_permlink`, when this conversation is about an order, lets the
	 * indexer bypass the stranger-fee gate for it (the block list and rate
	 * limits still apply) and is what threads the message by order. Omitted for
	 * a direct message, so the gate runs as before.
	 */
	function wirePayload(
		clientTag: string,
		envelope: {
			v?: 2;
			ciphertext: string;
			ephemeralPub: string;
			nonce: string;
			selfCiphertext?: string;
			selfNonce?: string;
		},
		priorTags: readonly string[]
	): Record<string, unknown> {
		const payload: Record<string, unknown> = {
			recipient: deps.peer,
			ciphertext: envelope.ciphertext,
			header: {
				// The envelope version: 2 = sender-authenticated (crypto.ts).
				...(envelope.v === 2 ? { v: 2 } : {}),
				client_tag: clientTag,
				ephemeral_pub: envelope.ephemeralPub,
				nonce: envelope.nonce,
				// sender self-copy (keep-history mode). Bounded + validated
				// by the indexer exactly like the main ciphertext.
				...(envelope.selfCiphertext !== undefined && envelope.selfNonce !== undefined
					? { self_ciphertext: envelope.selfCiphertext, self_nonce: envelope.selfNonce }
					: {}),
				...(priorTags.length > 0 ? { prior_tags: priorTags.slice(-MAX_PRIOR_TAGS) } : {})
			}
		};
		if (deps.orderPermlink !== null) {
			payload.order_permlink = deps.orderPermlink;
		}
		return payload;
	}

	/**
	 * The node took the message. Start its durable clock — whether or not a
	 * provisional copy has ALREADY shown it as confirmed, which on this
	 * instance is the usual order of events: it delivers an accepted chat
	 * message to its own listeners before it answers the request.
	 */
	function markAccepted(m: LocalMessage, trxId?: string): void {
		if (m.state === 'pending') m.state = 'broadcast';
		if (m.id === null) {
			m.sentAtMs = Date.now();
			if (typeof trxId === 'string' && trxId.length > 0 && !trxId.startsWith('tag:')) {
				m.sentTrxId = trxId;
			}
			rememberUnconfirmed(m);
		}
		emit();
	}

	/** Keep an accepted, unconfirmed own send past this view (W2). */
	function rememberUnconfirmed(m: LocalMessage): void {
		// Plaintext is kept only for a live session: after
		// a lock, a send completing in flight or a sweep's "found" must not put
		// the words back into memory for a locked view to show.
		if (deps.getLiveIdentity() === null) return;
		if (m.clientTag === null || m.sentAtMs === undefined) return;
		if (!shouldAttachSelfCopy(deps.chatSecurityMode?.())) return;
		unconfirmedOwnSends.set(
			unconfirmedKey(deps.me, deps.peer, deps.orderPermlink ?? null, m.clientTag),
			{
				clientTag: m.clientTag,
				text: m.text,
				sentAtMs: m.sentAtMs,
				trxId: m.sentTrxId ?? null,
				priorTags: m.priorTags ?? [],
				onChainAtMs: m.onChainAtMs ?? null
			}
		);
		while (unconfirmedOwnSends.size > UNCONFIRMED_OWN_MAX) {
			const oldest = unconfirmedOwnSends.keys().next().value;
			if (oldest === undefined) break;
			unconfirmedOwnSends.delete(oldest);
		}
	}

	function forgetUnconfirmed(tag: string | null): void {
		if (tag === null) return;
		unconfirmedOwnSends.delete(unconfirmedKey(deps.me, deps.peer, deps.orderPermlink ?? null, tag));
	}

	/** Put this thread's unconfirmed own sends back, with their original clocks.
	 *  Run at start, BEFORE any record merges, so a copy the indexer still has
	 *  reconciles against the restored message by tag instead of beside it. */
	function restoreUnconfirmed(): void {
		// A locked or read-only view shows no plaintext —
		// the same rule as the own-sent cache and incoming messages.
		if (deps.getLiveIdentity() === null) return;
		const prefix = unconfirmedThreadPrefix(deps.me, deps.peer, deps.orderPermlink ?? null);
		const oldestRestorable = Date.now() - RESTORE_UNCONFIRMED_MAX_AGE_MS;
		let restored = false;
		for (const [key, u] of Array.from(unconfirmedOwnSends)) {
			if (!key.startsWith(prefix)) continue;
			// (L2) Too old to still be waiting: the sweep has long had its say,
			// and its durable copy may have landed out of sight. Forget it.
			if (u.sentAtMs < oldestRestorable) {
				unconfirmedOwnSends.delete(key);
				continue;
			}
			if (messages.some((m) => m.clientTag === u.clientTag)) continue;
			messages.push({
				id: null,
				orderPermlink: deps.orderPermlink ?? null,
				clientTag: u.clientTag,
				text: u.text,
				sender: deps.me,
				state: 'broadcast',
				createdAt: null,
				trxId: null,
				error: null,
				decryptFailed: false,
				localSeq: ++localSeqCounter,
				sentAtMs: u.sentAtMs,
				...(u.trxId !== null ? { sentTrxId: u.trxId } : {}),
				...(u.onChainAtMs !== null ? { onChainAtMs: u.onChainAtMs } : {}),
				...(u.priorTags.length > 0 ? { priorTags: [...u.priorTags] } : {})
			});
			restored = true;
		}
		if (restored) emit();
	}

	/**
	 * The send request failed. Guarded, because our own provisional copy can come
	 * back on the stream and reconcile the message to 'confirmed' while the
	 * request is still in flight; if the response then dies on the wire — a
	 * dropped Tor circuit, a proxy timeout, a 502 — stamping 'failed' over it
	 * would put a Retry button beside a message the sender can SEE delivered, and
	 * the retry would post it to the recipient a second time.
	 *
	 * But a provisional copy proves only that the node took it. Such a message
	 * still gets a durable clock, so if the chain then drops it the sweep says so.
	 */
	function markSendFailed(m: LocalMessage, err: unknown): void {
		if (m.state === 'pending') {
			m.state = 'failed';
			m.error = err instanceof Error ? err.message : String(err);
		} else if (m.id === null && m.sentAtMs === undefined) {
			m.sentAtMs = Date.now();
		}
		emit();
	}

	async function retryMessage(localSeq: number): Promise<void> {
		const target = messages.find((m) => m.localSeq === localSeq);
		if (!target || target.state !== 'failed') return;
		// (L1) Final: the chain has it and the indexers refused it. A resend
		// would be refused the same way — and would put a second copy on chain.
		if (target.error === ON_CHAIN_NOT_ACCEPTED_SENTINEL) return;
		// Reset to pending and re-run the send path with the
		// existing text. We reuse the existing LocalMessage — don't
		// add a new one — so the UI doesn't duplicate. Generate a
		// new client_tag for the retry, since the previous tag's
		// broadcast may have actually landed on-chain (we just
		// never saw the confirmation). A new tag means the retry
		// is a distinct op.
		const text = target.text;
		const newTag = deps.generateClientTag();
		// KEEP THE OLD TAG REACHABLE. A retry deliberately gets a fresh tag,
		// because the previous broadcast may have landed and a repeated tag would
		// collide. But the old one is how the ORIGINAL copy identifies itself, and
		// the original really can still be in flight — the unconfirmed sweeper
		// exists precisely to prompt a retry for a send that is late rather than
		// lost. Forget the old tag and that original arrives matching nothing, so
		// it is appended as a second message and both people see it twice.
		// This attempt is abandoned: it is not "unconfirmed" any more, it is
		// being replaced. The new one is remembered once the node accepts it.
		forgetUnconfirmed(target.clientTag);
		delete target.sentTrxId;
		delete target.onChainAtMs;
		if (target.clientTag !== null) {
			target.priorTags = [...(target.priorTags ?? []), target.clientTag];
			// Bounded: someone leaning on Retry must not grow this without limit.
			// The same bound the recipient accepts from `prior_tags`.
			while (target.priorTags.length > MAX_PRIOR_TAGS) target.priorTags.shift();
		}
		// Same own-sent cache the first send fills, under the tag this attempt
		// will come back with — otherwise a retried message reads as the
		// placeholder after navigating away and back in keep-history mode.
		// Only for a live session: a locked one fails just below, and must not
		// leave the words in memory.
		if (deps.getLiveIdentity() !== null && shouldAttachSelfCopy(deps.chatSecurityMode?.())) {
			rememberOwnSent(deps.me, newTag, text);
		}
		target.state = 'pending';
		target.clientTag = newTag;
		target.error = null;
		// The previous attempt's clock says nothing about this one.
		delete target.sentAtMs;
		emit();

		const live = deps.getLiveIdentity();
		if (!live) {
			target.state = 'failed';
			target.error = SESSION_LOCKED_SENTINEL;
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

		// attach a sender self-copy in keep-history mode (the default),
		// so a retried message is also readable by us from chain; DESTROY mode
		// omits it, exactly like the send path (shared helper, no drift).
		const includeSelfCopy = shouldAttachSelfCopy(deps.chatSecurityMode?.());
		let envelope: {
			v?: 2;
			ciphertext: string;
			ephemeralPub: string;
			nonce: string;
			selfCiphertext?: string;
			selfNonce?: string;
		};
		try {
			envelope = await deps.encrypt(text, peerPub, deps.me, deps.peer, myId, includeSelfCopy);
		} catch (err) {
			target.state = 'failed';
			target.error = err instanceof Error ? err.message : String(err);
			emit();
			return;
		}

		const payload = wirePayload(newTag, envelope, target.priorTags ?? []);
		try {
			const res = await deps.broadcast(live, payload, deps.me);
			markAccepted(target, res?.trx_id);
		} catch (err) {
			markSendFailed(target, err);
		}
	}

	/**
	 * The session was locked (idle auto-lock, Lock, sign-out) while this view is
	 * open. Before, the view kept the whole decrypted
	 * transcript on screen and this controller kept the chat key derived from the
	 * posting key the lock had just wiped. Now: drop every message (the next poll
	 * brings the records back, shown the way a locked view shows them), wipe the
	 * derived key, and make any merge still decrypting stop.
	 */
	function onSessionLocked(): void {
		if (destroyed) return;
		lockEpoch++;
		const id = myChatIdentity;
		myChatIdentity = null;
		if (id) id.priv.fill(0);
		messages = [];
		emit();
	}

	return {
		start() {
			if (started || destroyed) return;
			started = true;
			controllerLockHooks.add(onSessionLocked);
			restoreUnconfirmed();

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
			controllerLockHooks.delete(onSessionLocked);
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
		broadcast: (live, payload, blurtAccount) => broadcastChatMessage(live, payload, blurtAccount),
		transactionOnChain: async (trxId: string) => {
			const r = await fetchChainTx(resolveOrigin(MORPHIT_INDEXER_ORIGIN), trxId);
			return r.kind === 'ok' ? 'found' : r.kind === 'not_found' ? 'not_found' : 'unknown';
		},
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
				// Verify the indexer's CLAIMED op directly (O(1)
				// get_transaction) so witnesses / other high-activity
				// accounts don't false-trip `chain_reports_none` when
				// their identity op is buried beyond the history window;
				// falls back to the history walk otherwise.  Includes
				// the S14 local secp256k1 signature verify.  Only fires
				// on the pin-mismatch / first-contact path.
				(peer, claimed) => verifyPeerChatIdentityOnChain(peer, claimed)
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
			sender: { priv: Uint8Array; pub: Uint8Array },
			includeSelfCopy: boolean
		) => {
			const env = await encryptToRecipient(
				plaintext,
				recipientPub,
				sender,
				senderAccount,
				recipientAccount,
				includeSelfCopy
			);
			return {
				...(env.v === 2 ? { v: 2 as const } : {}),
				ciphertext: env.ciphertext,
				ephemeralPub: env.ephemeralPub,
				nonce: env.nonce,
				...(env.selfCiphertext !== undefined && env.selfNonce !== undefined
					? { selfCiphertext: env.selfCiphertext, selfNonce: env.selfNonce }
					: {})
			};
		},
		decrypt: async (
			envelope: { v?: number; ciphertext: string; ephemeralPub: string; nonce: string },
			myPriv: Uint8Array,
			myPub: Uint8Array,
			senderAccount: string,
			recipientAccount: string,
			senderPubs?: readonly Uint8Array[]
		) => {
			try {
				return await decryptFromSender(
					envelope as ChatEnvelopeWire,
					{ priv: myPriv, pub: myPub },
					senderAccount,
					recipientAccount,
					senderPubs ?? []
				);
			} catch (err) {
				if (err instanceof DecryptError) return null;
				// Other errors (missing sodium, etc.) propagate.
				throw err;
			}
		},
		decryptSelfCopy: async (
			envelope: {
				v?: number;
				ciphertext: string;
				ephemeralPub: string;
				nonce: string;
				selfCiphertext?: string;
				selfNonce?: string;
			},
			myPriv: Uint8Array,
			myPub: Uint8Array,
			senderAccount: string,
			recipientAccount: string,
			recipientPubs?: readonly Uint8Array[]
		) => {
			try {
				return await decryptSelfCopy(
					envelope as ChatEnvelopeWire,
					{ priv: myPriv, pub: myPub },
					senderAccount,
					recipientAccount,
					recipientPubs ?? []
				);
			} catch (err) {
				if (err instanceof DecryptError) return null;
				throw err;
			}
		},
		pinnedPeerPubs: (p: string) => {
			const out: Uint8Array[] = [];
			for (const b64 of pinnedPubsFor(p)) {
				try {
					out.push(decodeChatPub(b64));
				} catch {
					/* a malformed stored key opens nothing */
				}
			}
			return out;
		},
		replacedPeerPubs: (p: string) => {
			const out: Uint8Array[] = [];
			for (const b64 of replacedPubsFor(p)) {
				try {
					out.push(decodeChatPub(b64));
				} catch {
					/* a malformed stored key opens nothing */
				}
			}
			return out;
		},
		pendingPeerPub: (p: string) => {
			const pending = pendingKeyChange(p);
			if (pending === null) return null;
			try {
				return decodeChatPub(pending.pubB64);
			} catch {
				return null;
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
