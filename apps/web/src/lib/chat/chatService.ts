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
 *   3. Encrypt via crypto.ts's `encryptToPostingKey` (the posting-key
 *      envelope, v3 — the only one sent since v1.21.14; see seal), set
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
 *      crypto.ts's `decryptPostingEnvelope` (v3), or `decryptFromSender`
 *      for the older formats (v2, v1). On any decrypt error
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
import { decodePayload, MAX_CHAT_CIPHERTEXT_CHARS } from '$lib/chat/payload';
import { recordAddressShared, recordFundsSent } from '$lib/trades/tradeStatus';
import { triggerBlurtVerification } from '$lib/trades/tradeVerify';
import { orderOwnerOf } from '$lib/trades/orderParties';
import {
	PubPinError,
	pinnedPubsFor,
	replacedPubsFor,
	replacedPostingFor,
	pendingKeyChange,
	resolvePostingKeyPin,
	pinnedPostingFor,
	PUB_PIN_ERROR
} from '$lib/chat/pubPin';
import { ChainRelayError } from '$net/chainRelay';
import { unsealSettled } from '$lib/chat/unsealGate';

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
	decryptFromSender,
	decryptSelfCopy,
	decodeChatPub,
	DecryptError,
	encryptToPostingKey,
	decryptPostingEnvelope,
	decryptPostingSelfCopy,
	decodePostingPubBLT,
	postingReader,
	wipePostingReader,
	NotForThisKeyError,
	MAX_RECIPIENT_KEYS,
	WRITE_ENVELOPE_V4,
	validEnvelopeTime,
	type ChatEnvelopeWire,
	type EnvelopeBinding,
	type PostingEnvelopeWire,
	type PostingReader
} from '$lib/chat/crypto';
import { fetchDynamicGlobalProperties } from '$blurt/broadcastTransport';
import { sendBinding } from '$lib/chat/envelopeBinding';
import { classifyBroadcastError } from '$blurt/broadcastErrorClass';
import { fetchAccountKeys } from '$blurt/accountKeys';

/** A long history is opened a few messages at a time, letting the page paint
 *  and take input between batches: opening a posting-key message is ~3–6 ms
 *  of crypto on a server CPU and several times that on a phone. */
export const DECRYPT_YIELD_EVERY = 8;
/** Give the main thread a turn: a macrotask through MessageChannel (not a
 *  timer, so it is not clamped or throttled). The runtime's
 *  ChatControllerDeps.yieldToMain. */
export function yieldToMainThread(): Promise<void> {
	if (typeof MessageChannel === 'undefined') return Promise.resolve();
	return new Promise((resolve) => {
		const ch = new MessageChannel();
		ch.port1.onmessage = () => {
			ch.port1.close();
			resolve();
		};
		ch.port2.postMessage(0);
	});
}

const isStringArray = (x: unknown): x is string[] =>
	Array.isArray(x) && x.every((e) => typeof e === 'string');

/** LocalMessage.error for a recipient account the chain does not have (a
 *  mistyped direct message). Mapped by ChatMessage.svelte. */
export const PEER_NOT_FOUND_SENTINEL = 'peer_not_found';
/** LocalMessage.error for an account with no posting key that can sign on
 *  its own (its posting authority is other accounts, or a multi-signature
 *  set): nothing can be encrypted to it, and no Morphit session can hold it. */
export const PEER_NO_POSTING_KEY_SENTINEL = 'peer_no_posting_key';
/** A failed lookup of a key (ours or the peer's) is asked again only after
 *  this long, so a history full of messages costs one lookup, not one each.
 *  Retry asks at once. */
export const KEY_LOOKUP_RETRY_MS = 30_000;
/** LocalMessage.error prefix for a broadcast the network or the instance
 *  refused: the rest is a `common.broadcast_err.*` key (the wording every
 *  chain-write screen uses — "Broadcast rejected due to insufficient
 *  funds…"), its values in LocalMessage.errorValues. */
export const BROADCAST_ERR_PREFIX = 'broadcast_err:';
/** LocalMessage.error for a message whose encrypted form is longer than the
 *  indexer accepts (MAX_CHAT_CIPHERTEXT_CHARS): it is NOT broadcast (v1.21.14
 *  full chat audit, W-M5 — it used to be, the fee was charged, and the indexer
 *  then refused it: "on chain, not accepted"). Mapped by ChatMessage.svelte. */
export const MESSAGE_TOO_LONG_SENTINEL = 'message_too_long';

/** A v4 message's chain time may be this much later than its bound send
 *  time — the head read, signing (a transaction expires 60 s after the head
 *  it was made at), a block — and the indexer's created_at is shown … */
export const ENVELOPE_TIME_LATE_S = 300;
/** … or this much earlier (the head read and the block's clock). */
export const ENVELOPE_TIME_EARLY_S = 120;

/** The send time a v4 header carries, or undefined. AUTHENTICATED only once
 *  the message has opened (the time is part of what it was sealed with). */
export function boundTimeOf(header: unknown): number | undefined {
	if (header === null || typeof header !== 'object') return undefined;
	const h = header as Record<string, unknown>;
	return h.v === 4 && validEnvelopeTime(h.t) ? h.t : undefined;
}

/** The order owner a v4 header carries ('' for none), or undefined.
 *  AUTHENTICATED only once the message has opened. */
export function boundOwnerOf(header: unknown): string | undefined {
	if (header === null || typeof header !== 'object') return undefined;
	const h = header as Record<string, unknown>;
	return h.v === 4 && typeof h.o === 'string' ? h.o : undefined;
}

/**
 * The time a message is shown at. The indexer's `created_at` (the chain's
 * block time) while it agrees with the authenticated send time `boundT`;
 * `boundT` itself when it does not — an indexer can say when a message was
 * recorded, not move a v4 message to another time. Without `boundT` (v3 and
 * older, or unopened): `created_at` as before.
 */
export function shownTime(createdAt: string | Date, boundT: number | undefined): Date {
	const at = createdAt instanceof Date ? createdAt : new Date(createdAt);
	if (boundT === undefined) return at;
	const s = at.getTime() / 1000;
	if (
		Number.isFinite(s) &&
		s >= boundT - ENVELOPE_TIME_EARLY_S &&
		s <= boundT + ENVELOPE_TIME_LATE_S
	)
		return at;
	return new Date(boundT * 1000);
}

/** What one send attempt is encrypted into: v2 (both chat keys published),
 *  v3 (the posting-key envelope, crypto.ts) or v4 (v3 bound to its order and
 *  send time `t`). */
export interface SealedEnvelope {
	v?: 2 | 3 | 4;
	/** v4: the bound send time (crypto.ts EnvelopeBinding.t). */
	t?: number;
	/** v4: the bound order owner ('' for none). */
	o?: string;
	ciphertext: string;
	ephemeralPub: string;
	nonce: string;
	selfCiphertext?: string;
	selfNonce?: string;
	/** v3: the sender's posting key, the recipient's posting keys and the
	 *  content key wrapped for each of them (crypto.ts PostingEnvelopeWire). */
	senderKey?: string;
	recipientKeys?: readonly string[];
	wraps?: readonly string[];
}

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
	/** Values for a `broadcast_err:` error's message (its `{reason}`, …). */
	errorValues?: Record<string, string>;
	/** Set while this own message failed before reaching the network: its key
	 *  in the kept-past-this-view list of unsent messages (v1.21.13). */
	unsentId?: string;
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
	/** v1.21.13: why it failed, when that is worth telling — 'other_key': a
	 *  posting-key message made for ANOTHER posting key of this account (one
	 *  this session does not hold; an account can list several). */
	decryptFailedReason?: 'other_key';
	/** True for a message from the PEER whose sender is not proved: it
	 *  decrypted, but it cannot be shown that this person wrote it. The UI says
	 *  so, a payment request in it is shown as unverified, and it moves no
	 *  trade. */
	senderUnverified?: boolean;
	/** Set with senderUnverified when the message came in an OLDER format (v1,
	 *  or v2 — chat keys) whose sender key is not one pinned here. Chat relies
	 *  on the posting key only (v1.21.14): an older Morphit, including one on
	 *  another instance, may still write v2 for a while. Ordinary, so the UI
	 *  says it calmly; absent, the unproved message is one in the posting-key
	 *  format made with a key that is not the peer's pinned set (their keys
	 *  changed and the new safety number is not accepted yet). */
	olderFormat?: true;
	/** v4 (review C-M2): the send time the message was sealed with —
	 *  authenticated, since it opened under it (or we sealed it). Bounds the
	 *  time shown (shownTime). */
	boundT?: number;
	/** v4: the order owner it was sealed with ('' for none), authenticated
	 *  like boundT. A trade effect runs only when the order's owner as looked
	 *  up is this one. */
	boundOwner?: string;
	/** Monotonically-increasing local sequence number used for
	 *  stable `{#each}` keying in the template. Always unique
	 *  within a controller's lifetime. Does NOT correspond to
	 *  the server id. */
	localSeq: number;
	/** For messages from the PEER: the encrypted bytes this message was
	 *  decrypted from (ciphertext, ephemeral key, nonce). Two copies are the
	 *  same message only if these match — see `wireOf`. */
	wire?: string;
	/** v1.21.6 — loaded by scrolling back (`loadOlder`), older than what was
	 *  already shown. Not news: the view does not count it as a new message. */
	backfilled?: true;
	/** v1.21.6 — added by a history page with its trade side effects not run
	 *  yet; they run if the live path delivers it (see mergeNow). */
	effectsDue?: true;
	/** v1.21.14 full chat audit, W-M8 / W-L1 — shown as a placeholder (or as
	 *  "sender not verified") for a reason that passes: the session was locked
	 *  when it arrived, or the sender's key could not be looked up (a slow
	 *  Tor/I2P circuit). Opened again the next time any copy of it arrives
	 *  (the stream, the fallback poll), instead of staying unreadable — or
	 *  marked as a decryption FAILURE — for as long as the view is open. */
	reopen?: true;
}

/** What one send came to (`sendMessage`): the node took it, or it failed
 *  before or at the node (its bubble then says why, with Retry). v1.21.14 full
 *  chat audit, W-L5: callers that close a form on success — the address,
 *  payment, mailing and shipment modals, the Pay-now receipt — need to know. */
export type SendOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Where scrolling back through a thread stands (`loadOlder`). */
export interface HistoryState {
	/** The first live answer (stream snapshot or poll) has been merged, so the
	 *  view knows what the newest messages are. */
	ready: boolean;
	/** An older page is being read. */
	loading: boolean;
	/** The thread's first message is loaded: there is nothing older. */
	complete: boolean;
	/** The last attempt to read an older page failed (after retries). */
	failed: boolean;
}

/** One message of a whole-conversation read (`loadWholeConversation`). */
export type ConversationRecordMessage = Pick<
	LocalMessage,
	| 'sender'
	| 'text'
	| 'createdAt'
	| 'orderPermlink'
	| 'trxId'
	| 'decryptFailed'
	| 'unrecorded'
	| 'state'
>;

/** The whole conversation could not be read (a page failed after retries, the
 *  session locked, or the view closed). Nothing partial is returned. */
export class ConversationIncompleteError extends Error {
	constructor(reason: string) {
		super(`conversation history incomplete: ${reason}`);
		this.name = 'ConversationIncompleteError';
	}
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

/** A message's durable id, or null (sending, failed, provisional). */
function durableId(m: { id: number | null }): number | null {
	return m.id !== null && m.id !== 0 ? m.id : null;
}

/**
 * Transcript order: chain time; within one second, copies with no durable id
 * yet (in the order this client saw them) before durable ones, and durable
 * ones in the order the indexer recorded them (id). Messages with no chain
 * time yet go last. Every message has one key (time, group, id/localSeq), so
 * the order is total and every sort agrees.
 *
 * v1.21.6: the id step is new. A block's messages had been shown in the order
 * their copies happened to arrive — backwards, for a page (pages list a
 * block's rows in id order and are merged reversed), and in any order for
 * copies pushed by the federation.
 */
export function chronological(
	a: { createdAt: Date | null; id: number | null; localSeq: number },
	b: { createdAt: Date | null; id: number | null; localSeq: number }
): number {
	const aT = a.createdAt ? a.createdAt.getTime() : Number.POSITIVE_INFINITY;
	const bT = b.createdAt ? b.createdAt.getTime() : Number.POSITIVE_INFINITY;
	if (aT !== bT) return aT < bT ? -1 : 1;
	const aId = durableId(a);
	const bId = durableId(b);
	if ((aId === null) !== (bId === null)) return aId === null ? -1 : 1;
	if (aId !== null && bId !== null && aId !== bId) return aId - bId;
	return a.localSeq - b.localSeq;
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
		opts: {
			cursor?: string;
			limit?: number;
			signal?: AbortSignal;
			/** v1.21.6 — one thread only: an order permlink, or null for the
			 *  thread that cites no order. Absent: every thread of the pair. An
			 *  indexer that predates the filter ignores it; the thread filter in
			 *  mergePollResponse still applies. */
			order?: string | null;
		}
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
	/** The peer's published X25519 chat key (ADR-0015), as the chain confirms
	 *  it, or null when they never published one. ONLY to open their older
	 *  (v2) messages — nothing is sent to a chat key any more — and never
	 *  pinned: a message opened with it is shown as not proved (v1.21.14,
	 *  posting-key-only chat). Injected for testability. */
	fetchPeerChatPub(peer: string): Promise<Uint8Array | null>;
	/** Derive the current user's chat identity from their
	 *  posting private key. Returns a Uint8Array priv + pub.
	 *  The returned priv is live key material — the controller
	 *  uses it, then forgets it (no persistent storage). Only to READ older
	 *  (v2) messages, to us and our own. */
	deriveMyChatIdentity(
		live: LiveIdentity,
		account: string
	): Promise<{ priv: Uint8Array; pub: Uint8Array }>;
	/**
	 * The posting-key envelope (v3, crypto.ts) — since v1.21.14 the ONLY one a
	 * message is sent in (chat relies on the posting key only; the chat-key v2
	 * envelope is read, never written). It needs nothing from the recipient
	 * but their account, so a message to someone offline who never opened chat
	 * goes on chain and waits for them. Required: there is no other way to send.
	 *
	 * `fetchPostingPubs`: the account's posting keys that can sign on their
	 * own (at most MAX_RECIPIENT_KEYS), as the chain lists them; [] when it has
	 * none; null when the chain has no such account. Throws when the chain
	 * could not be asked.
	 */
	fetchPostingPubs(account: string): Promise<Uint8Array[] | null>;
	/** The posting keys of `peer` to encrypt to and to authenticate them with
	 *  (pubPin.resolvePostingKeyPin): the set first seen is pinned (trust on
	 *  first use, whatever chat key is pinned); an added key is refused
	 *  (PubPinError 'pub_pin_posting_key_changed') until the user accepts the
	 *  new safety number. Optional: absent, the chain's keys are used (tests). */
	pinPostingKey?(peer: string, chainKeys: readonly Uint8Array[]): Promise<Uint8Array[]>;
	/** The posting keys pinned for `peer`, without asking anyone: what a v3
	 *  message from them is authenticated by. */
	pinnedPostingKeys?(peer: string): readonly Uint8Array[];
	/** Let the page paint between batches of DECRYPT_YIELD_EVERY messages
	 *  while a history is opened. Absent: no pause (tests). */
	yieldToMain?(): Promise<void>;
	encryptPosting(
		plaintext: string,
		recipientPostingPubs: readonly Uint8Array[],
		live: LiveIdentity,
		senderAccount: string,
		recipientAccount: string,
		includeSelfCopy: boolean,
		/** v4: the order and send time to bind (review C-M2); absent: v3. */
		binding?: EnvelopeBinding
	): Promise<SealedEnvelope>;
	/** Write v4 (WRITE_ENVELOPE_V4 when absent; tests turn it on). */
	writeEnvelopeV4?: boolean;
	/** The chain's head time, whole seconds: a v4 message's bound send time.
	 *  Absent: this device's clock (tests). */
	chainNowSeconds?(): Promise<number>;
	/** Open a v3 or v4 message to us; `authenticated` when its sender key is
	 *  one of `senderPostingPubs` (their pinned keys). `order`: the order
	 *  permlink of the record it came in (a v4 message is bound to it). Null
	 *  when it does not open; 'other_key' when it was made for other posting
	 *  keys of our account. */
	decryptPosting?(
		envelope: SealedEnvelope,
		live: LiveIdentity,
		senderAccount: string,
		recipientAccount: string,
		senderPostingPubs: readonly Uint8Array[],
		order: string | null
	): Promise<{ text: string; authenticated: boolean } | null | 'other_key'>;
	/** Open our own self-copy of a v3 or v4 message we sent (`order` as for
	 *  decryptPosting). Null when it does not. */
	decryptPostingSelfCopy?(
		envelope: SealedEnvelope,
		live: LiveIdentity,
		senderAccount: string,
		recipientAccount: string,
		order: string | null
	): Promise<string | null>;
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
	/** Posting keys of `peer` an accepted change replaced
	 *  (pubPin.replacedPostingFor): a v3 message made with one is readable and
	 *  shown with the calm "older" note — never proof (review C, L4). */
	replacedPostingKeys?(peer: string): readonly Uint8Array[];
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
	/**
	 * v1.21.14 full chat audit, W-H1 — whose order `orderPermlink` is: `sender`'s
	 * or ours (orderParties.orderOwnerOf). A structured trade payload moves the
	 * trade store only when it is one of those, under that owner (C-L3). false:
	 * neither; null: could not be told now (the payload's effects wait for its
	 * next delivery). Optional: absent, every order is taken as the sender's
	 * (tests that predate it).
	 */
	orderOwnerOf?(orderPermlink: string, sender: string): Promise<string | false | null>;
	/** Called on EVERY state change. The component subscribes via
	 *  its own $effect so Svelte re-renders automatically. */
	onChange(messages: readonly LocalMessage[]): void;
	/** v1.21.6 — called when scrolling back changes state (see HistoryState).
	 *  Optional: absent, nobody is told. */
	onHistoryChange?(state: HistoryState): void;
	/** Wait before retrying a history page. Injected for tests; absent, a
	 *  real timer. */
	sleep?(ms: number): Promise<void>;
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
	 *  the op was signed + sent (not when it's confirmed): ok when the node
	 *  took it, else why not (the bubble says so too, with Retry). The bubble
	 *  is in the list before the first await, so a composer need not wait. */
	sendMessage(text: string): Promise<SendOutcome>;
	/** Retry a message that's in the `failed` state. The localSeq
	 *  is the key to identify which one. */
	retryMessage(localSeq: number): Promise<void>;
	/** Debug / test hook — read current messages without mutating. */
	snapshot(): readonly LocalMessage[];
	/** v1.21.6 — read this thread further back, page by page, until at least
	 *  one older message is added or its first message is reached. One read at
	 *  a time: a second call while one runs joins it. Progress is reported
	 *  through `onHistoryChange`. Never throws. */
	loadOlder(): Promise<void>;
	/** v1.21.6 — every message ever exchanged with the peer, in every thread,
	 *  oldest first, decrypted where this session can: for the PDF export.
	 *  Reads the indexer from the newest message to the first; the view's own
	 *  messages are not changed and no trade side effects run. Messages of
	 *  this thread that have no durable copy yet (sending, failed, or a copy
	 *  not yet irreversible) are included as the view shows them. Throws
	 *  ConversationIncompleteError rather than return part of it. */
	loadWholeConversation(): Promise<readonly ConversationRecordMessage[]>;
	/** Changes on every session lock. A caller holding plaintext it got from
	 *  this controller (the export) checks it is unchanged before using it. */
	lockGeneration(): number;
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
/** v1.21.6 — a page read when scrolling back or exporting: the indexer's
 *  maximum, so a long history takes as few round trips as it can. */
const OLDER_PAGE_SIZE = 100;
/** Waits before the second and third try of a page read by scrolling back. A
 *  page lost to a slow Tor/I2P circuit usually comes on the next try; after
 *  that the reader can try again. */
const HISTORY_RETRY_WAITS_MS = [2_000, 5_000] as const;
/** Waits between tries of a page of the export, which reads on from where it
 *  stopped. Long enough together (112 s) to outlast the indexer's one-minute
 *  rate-limit window, which a long conversation — or one a peer flooded —
 *  can use up on its own. */
const EXPORT_RETRY_WAITS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
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
/** Bumped by every lock and sign-out (clearOwnSentPlaintextCache, the lock
 *  hook): work started before one — an outgoing trade record waiting for its
 *  order's owner, in a view that may since have closed — records nothing
 *  after it. */
let sessionGeneration = 0;
/** An outgoing trade record whose order owner could not be told is asked
 *  again after these pauses (C-L3 review). */
export const OUTGOING_OWNER_RETRY_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000];
const ownSentPlaintext = new Map<string, string>();

/** Key: account, recipient, order thread and client_tag. Client tags are 16
 *  random bytes so they never collide; the thread is in the key so a record
 *  an indexer re-files under another order (or another conversation) is not
 *  shown from here as what we wrote in this one (v1.21.14 final review: the
 *  cache otherwise bypassed v4's order binding). */
function ownSentKey(me: string, peer: string, order: string | null, clientTag: string): string {
	return `${me}\t${peer}\t${order ?? ''}\t${clientTag}`;
}

/** The cached plaintext of OUR record `rec` — what we wrote in the thread
 *  the record is filed under — or undefined. */
function ownSentFor(me: string, rec: ChatMessageRecord, clientTag: string): string | undefined {
	return ownSentPlaintext.get(ownSentKey(me, rec.recipient, rec.order_permlink ?? null, clientTag));
}

function rememberOwnSent(
	me: string,
	peer: string,
	order: string | null,
	clientTag: string,
	plaintext: string
): void {
	ownSentPlaintext.set(ownSentKey(me, peer, order, clientTag), plaintext);
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
	sessionGeneration++;
	ownSentPlaintext.clear();
	unconfirmedOwnSends.clear();
	unsentOwnSends.clear();
	forgetPostingReader();
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

/**
 * Our own sends that FAILED before the network took them, kept past the view
 * that sent them (v1.21.13). A failed message lived only in its conversation
 * controller, so leaving the chat and coming back showed nothing where it had
 * been — the sender's words gone, and no Retry. Restored on return, failed,
 * with the reason and Retry. Same rules as the lists above: keep-history mode
 * only, in memory only, cleared on lock and sign-out, bounded.
 */
interface UnsentOwnSend {
	readonly text: string;
	readonly error: string | null;
	readonly errorValues: Record<string, string> | null;
	readonly priorTags: readonly string[];
	readonly atMs: number;
}
const UNSENT_OWN_MAX = 200;
let unsentSeq = 0;
const unsentOwnSends = new Map<string, UnsentOwnSend>();
function unsentKey(me: string, peer: string, order: string | null, id: string): string {
	return `${me}\t${peer}\t${order ?? ''}\t${id}`;
}
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

/** A sender's key could not be looked up (the chain or the indexer did not
 *  answer): a reason that passes, unlike a pin verdict. W-M8. */
class KeyLookupUnavailable extends Error {
	constructor() {
		super('key lookup unavailable');
		this.name = 'KeyLookupUnavailable';
	}
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
	/** v1.21.6 — scrolling back. `olderCursor`: undefined until the first older
	 *  page (that read starts at the thread's newest message); then the
	 *  indexer's next_cursor. */
	let olderCursor: string | undefined = undefined;
	let olderComplete = false;
	let olderFailed = false;
	let olderRun: Promise<void> | null = null;
	let liveReady = false;
	/** Aborts history reads (scrolling back, export) on destroy. */
	const historyAbort = new AbortController();
	/** Merges run one at a time: each reads the list, awaits decrypts, then
	 *  adds — two at once could each add the same record (a live append and a
	 *  history page overlap, and so do the stream snapshot and the poll). */
	let mergeChain: Promise<unknown> = Promise.resolve();
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

	/** Cached fetch of the peer's published chat pubkey, to open their older
	 *  (v2) messages that no pinned key opens. Null means "not yet looked up";
	 *  a fetched-and-absent peer is remembered via peerPubUnknown for the rest
	 *  of the conversation (Retry asks again), so a history costs one lookup. */
	let peerChatPub: Uint8Array | null = null;
	let peerPubUnknown = false;

	async function ensureMyChatIdentity(
		live: LiveIdentity
	): Promise<{ priv: Uint8Array; pub: Uint8Array }> {
		if (myChatIdentity) return myChatIdentity;
		myChatIdentity = await deps.deriveMyChatIdentity(live, deps.me);
		return myChatIdentity;
	}

	const nowMs = (): number => deps.now().getTime();

	/** One lookup at a time: the warm-up at start and a send that comes before
	 *  it finished share the same request. */
	let peerPubInFlight: Promise<Uint8Array | null> | null = null;
	/** A failed lookup, asked again only after KEY_LOOKUP_RETRY_MS (Retry: at
	 *  once), so each send does not wait out the timeout again. */
	let peerPubFailed: { at: number; err: unknown } | null = null;
	async function ensurePeerChatPub(): Promise<Uint8Array | null> {
		if (peerChatPub) {
			return peerChatPub;
		}
		if (peerPubUnknown) return null;
		if (peerPubInFlight !== null) return peerPubInFlight;
		if (peerPubFailed !== null && nowMs() - peerPubFailed.at < KEY_LOOKUP_RETRY_MS) {
			throw peerPubFailed.err;
		}
		peerPubInFlight = (async () => {
			const fetched = await deps.fetchPeerChatPub(deps.peer);
			if (fetched === null) {
				peerPubUnknown = true;
				return null;
			}
			peerChatPub = fetched;
			return fetched;
		})().then(
			(v) => {
				peerPubFailed = null;
				return v;
			},
			(err: unknown) => {
				peerPubFailed = { at: nowMs(), err };
				throw err;
			}
		);
		try {
			return await peerPubInFlight;
		} finally {
			peerPubInFlight = null;
		}
	}

	/** Posting keys per account (v3). Only an answer with keys is kept for the
	 *  conversation; "no such account" / "no usable key" is asked again on the
	 *  next send, and a failed read after KEY_LOOKUP_RETRY_MS (or on Retry). */
	const postingPubsCache = new Map<string, Uint8Array[]>();
	const postingPubsInFlight = new Map<string, Promise<Uint8Array[] | null>>();
	const postingPubsFailed = new Map<string, { at: number; err: unknown }>();
	async function postingPubsOf(account: string): Promise<Uint8Array[] | null> {
		const hit = postingPubsCache.get(account);
		if (hit !== undefined) return hit;
		if (deps.fetchPostingPubs === undefined) return null;
		const pending = postingPubsInFlight.get(account);
		if (pending !== undefined) return pending;
		const failed = postingPubsFailed.get(account);
		if (failed !== undefined && nowMs() - failed.at < KEY_LOOKUP_RETRY_MS) throw failed.err;
		const p = deps.fetchPostingPubs(account).then(
			(pubs) => {
				postingPubsFailed.delete(account);
				if (pubs !== null && pubs.length > 0) postingPubsCache.set(account, pubs);
				return pubs;
			},
			(err: unknown) => {
				postingPubsFailed.set(account, { at: nowMs(), err });
				throw err;
			}
		);
		postingPubsInFlight.set(account, p);
		try {
			return await p;
		} finally {
			postingPubsInFlight.delete(account);
		}
	}

	/** Retry: every negative or failed key answer is asked again, and the
	 *  peer's posting keys are read afresh. */
	function forgetKeyMisses(): void {
		peerPubUnknown = false;
		peerPubFailed = null;
		postingPubsFailed.clear();
		// The peer's posting keys are read again too: a send refused over them
		// (a changed set) is retried against what the chain says now — the keys
		// the user just compared in Verify peer, not the answer cached at open.
		postingPubsCache.delete(deps.peer);
	}

	/**
	 * Look up, as the conversation opens, what the first send needs: the
	 * peer's posting keys. On a Tor/I2P instance it is a hidden round trip of a
	 * second or more; done while the user types, the first message leaves as
	 * fast as any other (the 6-second delivery budget). Best-effort: a send
	 * asks again if this could not get it.
	 *
	 * (Until v1.21.14 this also read our own chat key's status and the peer's
	 * chat key — and the latter PINNED that chat key, which then held the
	 * peer's posting keys back as a "change" for Verify peer: on a first
	 * conversation with someone an older Morphit had published a chat key for,
	 * every message from them showed "Sender not verified" and every reply was
	 * refused. Nothing is sent to a chat key any more, so neither is asked.)
	 */
	function warmUpKeys(): void {
		void postingPubsOf(deps.peer).catch(() => undefined);
	}

	/** A key lookup that failed, as LocalMessage.error: a pin verdict keeps its
	 *  own code; anything else is the chain not answering (retry). */
	function lookupSentinel(err: unknown): string {
		return err instanceof PubPinError ? err.code : CHAIN_UNREACHABLE_SENTINEL;
	}

	/**
	 * Encrypt one send attempt. ONE place for the first send, every retry and
	 * nothing else, so the two can never pick differently.
	 *
	 * Always the posting-key envelope (v3, crypto.ts), to the peer's PINNED
	 * posting keys — chat relies on the posting key only (v1.21.14). It needs
	 * nothing from the recipient but their account, so a message to someone
	 * offline who never opened chat goes on chain and waits for them. Their
	 * posting keys are trusted on first use, whatever chat key of theirs is
	 * pinned here; a CHANGED set stops the send until the user compares the new
	 * safety number (pub_pin_posting_key_changed — never silently).
	 *
	 * (Until v1.21.14 it chose: the chat-key envelope (v2) when our published
	 * chat key was current and the peer had one, else v3. Two formats meant two
	 * sets of keys to pin per person, and a first set of posting keys was held
	 * back for a peer whose chat key was pinned — which a normal first
	 * conversation hit; see warmUpKeys.)
	 */
	async function seal(
		text: string,
		live: LiveIdentity,
		includeSelfCopy: boolean
	): Promise<{ ok: true; envelope: SealedEnvelope } | { ok: false; error: string }> {
		const sealed = await sealAnyFormat(text, live, includeSelfCopy);
		// v1.21.14 full chat audit, W-M5 — the last check before anything is
		// signed: the indexer refuses a ciphertext (or self-copy) longer than
		// MAX_CHAT_CIPHERTEXT_CHARS, AFTER the chain has taken the fee. Both
		// formats, every caller (composer, modals, retry). The modals check
		// the same budget before this, with a message about their own fields.
		if (
			sealed.ok &&
			(sealed.envelope.ciphertext.length > MAX_CHAT_CIPHERTEXT_CHARS ||
				(sealed.envelope.selfCiphertext?.length ?? 0) > MAX_CHAT_CIPHERTEXT_CHARS)
		) {
			return { ok: false, error: MESSAGE_TOO_LONG_SENTINEL };
		}
		return sealed;
	}

	async function sealAnyFormat(
		text: string,
		live: LiveIdentity,
		includeSelfCopy: boolean
	): Promise<{ ok: true; envelope: SealedEnvelope } | { ok: false; error: string }> {
		let pubs: Uint8Array[] | null;
		try {
			pubs = await postingPubsOf(deps.peer);
		} catch (err) {
			return { ok: false, error: lookupSentinel(err) };
		}
		if (pubs === null) return { ok: false, error: PEER_NOT_FOUND_SENTINEL };
		if (pubs.length === 0) return { ok: false, error: PEER_NO_POSTING_KEY_SENTINEL };
		// The pinned keys, never silently a changed set (see pinPostingKey).
		let targets: Uint8Array[];
		try {
			targets = deps.pinPostingKey !== undefined ? await deps.pinPostingKey(deps.peer, pubs) : pubs;
		} catch (err) {
			return { ok: false, error: lookupSentinel(err) };
		}
		try {
			// v4 (review C-M2): bound to this thread's order, its owner and the
			// chain's time — or v3 when any of them cannot be (sendBinding).
			const binding: EnvelopeBinding | undefined = await sendBinding({
				write: deps.writeEnvelopeV4 ?? WRITE_ENVELOPE_V4,
				order: deps.orderPermlink,
				ownerOf: (order) =>
					deps.orderOwnerOf !== undefined
						? deps.orderOwnerOf(order, deps.peer)
						: Promise.resolve(deps.peer),
				chainNowSeconds:
					deps.chainNowSeconds ?? (() => Promise.resolve(Math.floor(Date.now() / 1000)))
			});
			return {
				ok: true,
				envelope: await deps.encryptPosting(
					text,
					targets,
					live,
					deps.me,
					deps.peer,
					includeSelfCopy,
					...(binding !== undefined ? [binding] : [])
				)
			};
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** The posting keys a v3 message from `sender` is authenticated by: the
	 *  pinned set, without a lookup. Only when none is pinned, and only for the
	 *  peer, is the chain asked and its answer pinned (trust on first use),
	 *  whatever chat key of theirs is pinned here (v1.21.14: that used to hold
	 *  the keys back, and a first conversation showed every message from the
	 *  peer as "Sender not verified"). */
	async function senderPostingCandidates(sender: string): Promise<readonly Uint8Array[]> {
		await unsealSettled();
		if (deps.pinnedPostingKeys !== undefined) {
			const pinned = deps.pinnedPostingKeys(sender);
			if (pinned.length > 0) return pinned;
		}
		if (sender !== deps.peer) return [];
		let chainKeys: Uint8Array[] | null;
		try {
			chainKeys = await postingPubsOf(sender);
		} catch {
			// The chain could not be asked: a reason that passes (W-M8).
			throw new KeyLookupUnavailable();
		}
		if (chainKeys === null || chainKeys.length === 0) return [];
		if (deps.pinPostingKey === undefined) return chainKeys;
		// A CHANGED set is held for Verify peer (pinPostingKey throws): the
		// message stays unproved until the user accepts the new safety number.
		return deps.pinPostingKey(sender, chainKeys).catch(() => []);
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
	 * return 'changed' (something the view shows changed) or 'same' (a copy
	 * already reconciled: nothing to redraw). On miss, 'no' — the caller
	 * appends a new confirmed entry.
	 *
	 * v1.21.14 full chat audit, W-L3: this used to answer a bare "matched",
	 * which the merge counted as a change, so every fallback poll (4–6 s)
	 * re-rendered the whole view and wrote a read-ack to storage although
	 * nothing had changed.
	 */
	function reconcileByClientTag(rec: ChatMessageRecord): 'no' | 'same' | 'changed' {
		const tag = clientTagFromHeader(rec.header);
		if (tag === null) return 'no';
		// id 0 marks a PROVISIONAL head-block (fast-path)
		// copy that isn't irreversible yet (ADR-0048). It must never
		// overwrite a real, durable id.
		const isDurable = rec.id !== 0;
		let changed = false;
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
				delete m.errorValues;
				// It reached the network after all: nothing left to restore.
				forgetUnsent(m);
				m.createdAt = shownTime(rec.created_at, m.boundT);
				changed = true;
			}
			// The encrypted bytes this message went out as: a copy of them
			// re-served under ANOTHER tag is this message, not a new one (W-H3).
			m.wire ??= wireOf(rec);
			// Adopt the durable id the first time it lands; a provisional
			// (id 0) never overwrites a real id we already hold.
			if (isDurable && (m.id === null || m.id === 0)) {
				adoptDurable(m, rec);
				changed = true;
			}
			return changed ? 'changed' : 'same';
		}
		return 'no';
	}

	/** A durable copy has landed for `m`: take its id, time and on-chain anchor,
	 *  and drop every "still waiting for the chain" marker — arriving is the
	 *  proof. */
	/** `boundT`: the authenticated bound time of `rec` itself — the same as
	 *  m's for a copy of the same attempt (the default), its own for another
	 *  attempt folded in (absorbRetryCopy). */
	function adoptDurable(
		m: LocalMessage,
		rec: ChatMessageRecord,
		boundT: number | undefined = m.boundT
	): void {
		// Our own send is on the chain for good: nothing left to remember (W2).
		if (m.sender === deps.me) {
			forgetUnconfirmed(m.clientTag);
			delete m.sentTrxId;
			delete m.onChainAtMs;
		}
		m.id = rec.id;
		if (boundT !== undefined) m.boundT = boundT;
		else delete m.boundT;
		m.createdAt = shownTime(rec.created_at, boundT);
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
	 * Returns whether anything the view shows changed (W-L3).
	 */
	function absorbRetryCopy(
		m: LocalMessage,
		rec: ChatMessageRecord,
		incomingTag: string,
		declared: readonly string[],
		/** The copy's own authenticated bound time (v4), if it has one. */
		copyBoundT: number | undefined
	): boolean {
		const tags = new Set([...(m.priorTags ?? []), incomingTag, ...declared]);
		if (m.clientTag !== null) tags.delete(m.clientTag);
		// Bounded like everything a peer can grow: one attempt's own declared
		// list plus the attempts folded in since, newest kept.
		m.priorTags = [...tags].slice(-MAX_PRIOR_TAGS * 2);
		// Its bytes are this message from now on: a later copy of them is a
		// twin, not a new record to open and fold again on every poll (W-L3).
		rememberWireAlias(rec, m);
		if (rec.id !== 0) {
			if (m.id === null || m.id === 0) {
				// The durable copy is THIS attempt: its own time (C-M2).
				adoptDurable(m, rec, copyBoundT);
				return true;
			}
		} else if (m.id === null) {
			// A fresh provisional attempt: it may yet land, so the verdict on the
			// old one no longer describes this message. Start its window again.
			m.provisionalSinceMs = Date.now();
			m.unrecorded = false;
			return true;
		}
		return false;
	}

	/** Encrypted bytes (sender + wireOf) that are a copy of a message already
	 *  here under other bytes: a retry folded into the attempt it resends. */
	let wireAliases = new Map<string, LocalMessage>();
	function rememberWireAlias(rec: ChatMessageRecord, m: LocalMessage): void {
		wireAliases.set(`${rec.sender}\u0000${wireOf(rec)}`, m);
		while (wireAliases.size > 500) {
			const oldest = wireAliases.keys().next().value;
			if (oldest === undefined) break;
			wireAliases.delete(oldest);
		}
	}

	/**
	 * The message `rec` is a copy of, by its encrypted bytes alone: the same
	 * sender and the same ciphertext, ephemeral key and nonce.
	 *
	 * v1.21.14 full chat audit, W-H3: a twin used to need the same client tag
	 * TOO, and the tag is the one part of a record the encryption does not
	 * cover. A hostile operator's stream could re-serve an old, genuine
	 * message under a fresh tag: it showed again as a new message from the
	 * real sender, and its trade effects ran again — an old payment address
	 * put back over a newer one. The bytes are what the sender wrote; the tag
	 * only says how the sender's own client reconciles its echo.
	 */
	function twinByWire(rec: ChatMessageRecord): LocalMessage | undefined {
		const wire = wireOf(rec);
		return (
			messages.find((m) => m.sender === rec.sender && m.wire === wire) ??
			// (A lock empties the list, and these with it: onSessionLocked.)
			wireAliases.get(`${rec.sender}\u0000${wire}`)
		);
	}

	/**
	 * Decrypt a ciphertext record to plaintext, or return the
	 * placeholder if any step fails. Failures here are common and
	 * expected in edge cases (old messages from before a key
	 * rotation, messages encrypted by a buggy client, tampering):
	 * we want the conversation to keep rendering, with the one
	 * bad message shown muted.
	 */
	async function decryptOrPlaceholder(rec: ChatMessageRecord): Promise<{
		text: string;
		decryptFailed: boolean;
		senderUnverified: boolean;
		otherKey?: true;
		/** The result may change on a later try (W-M8 / W-L1): see
		 *  LocalMessage.reopen. */
		transient?: true;
		/** See LocalMessage.olderFormat. */
		olderFormat?: true;
		/** See LocalMessage.boundT / boundOwner: set only when a v4 message
		 *  opened. */
		boundT?: number;
		boundOwner?: string;
	}> {
		// If the session is locked, we can't derive our chat
		// identity. Show placeholder, and open it again when a later copy
		// arrives after the unlock (v1.21.14 full chat audit, W-L1: an idle
		// auto-lock undone by another tab's session handoff left the view
		// mounted and these placeholders in it for good).
		const live = deps.getLiveIdentity();
		if (!live) {
			return {
				text: ENCRYPTED_PLACEHOLDER,
				decryptFailed: false,
				senderUnverified: false,
				transient: true
			};
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

		if (v === 3 || v === 4) {
			// The posting-key envelope (crypto.ts): opened with our posting key;
			// its sender is proved when the key it was made with is one of the
			// sender's posting keys on chain.
			const sk = h.sk;
			const rk = h.rk;
			const wk = h.wk;
			// v4: bound to its send time and its order's owner (in the header)
			// and to the order of the record it came in (review C-M2) — another
			// order, owner or time: no open.
			const boundT = v === 4 ? boundTimeOf(h) : undefined;
			const boundOwner = v === 4 ? boundOwnerOf(h) : undefined;
			if (
				deps.decryptPosting === undefined ||
				typeof sk !== 'string' ||
				!isStringArray(rk) ||
				!isStringArray(wk) ||
				(v === 4 && (boundT === undefined || boundOwner === undefined))
			) {
				return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: true, senderUnverified: false };
			}
			const sealedAs: SealedEnvelope = {
				v,
				...(boundT !== undefined ? { t: boundT, o: boundOwner } : {}),
				ciphertext: rec.ciphertext,
				ephemeralPub,
				nonce,
				senderKey: sk,
				recipientKeys: rk,
				wraps: wk
			};
			const order = rec.order_permlink ?? null;
			const bound = boundT !== undefined && boundOwner !== undefined ? { boundT, boundOwner } : {};
			try {
				// Proved only by a PINNED key (a changed set waits for the user,
				// as with chat keys): readable either way. A lookup that could not
				// be made leaves it unproved FOR NOW (W-M8): opened again later.
				let lookupFailed = false;
				const senderPubs = await senderPostingCandidates(rec.sender).catch((err: unknown) => {
					if (err instanceof KeyLookupUnavailable) lookupFailed = true;
					return [];
				});
				const opened = await deps.decryptPosting(
					sealedAs,
					live,
					rec.sender,
					rec.recipient,
					senderPubs,
					order
				);
				if (opened === null) {
					return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: true, senderUnverified: false };
				}
				if (opened === 'other_key') {
					return {
						text: ENCRYPTED_PLACEHOLDER,
						decryptFailed: true,
						senderUnverified: false,
						otherKey: true
					};
				}
				// Made with a posting key the user accepted a replacement for
				// (review C, L4): history, shown calmly, never proof.
				if (!opened.authenticated && !lookupFailed) {
					const past = deps.replacedPostingKeys?.(rec.sender) ?? [];
					if (past.length > 0) {
						const viaPast = await deps.decryptPosting(
							sealedAs,
							live,
							rec.sender,
							rec.recipient,
							past,
							order
						);
						if (viaPast !== null && viaPast !== 'other_key' && viaPast.authenticated)
							return {
								text: opened.text,
								decryptFailed: false,
								senderUnverified: true,
								olderFormat: true,
								...bound
							};
					}
				}
				return {
					text: opened.text,
					decryptFailed: false,
					senderUnverified: !opened.authenticated,
					...(lookupFailed && !opened.authenticated ? { transient: true as const } : {}),
					...bound
				};
			} catch {
				return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: true, senderUnverified: false };
			}
		}

		// An OLDER format: v2 (chat keys; still written by an older Morphit,
		// also on other instances, for a while) or v1. Read with the chat key we
		// derive from our posting key. Its sender is PROVED only by a chat key
		// pinned here — from a conversation before v1.21.14; none is pinned any
		// more. Opened with any other key, it is readable and shown with a calm
		// "older format" note (LocalMessage.olderFormat), and moves no trade.
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
			// v1.21.14 full chat audit, W-M8: a key lookup that could not be MADE
			// (a Tor timeout) is not a decryption failure. The message is shown as
			// not opened yet and opened again when it next arrives, instead of
			// "couldn't be decrypted" for good.
			let lookupFailed = false;
			const unanswered = (err: unknown): [] => {
				if (!(err instanceof KeyLookupUnavailable)) throw err;
				lookupFailed = true;
				return [];
			};
			let opened = await open(await provingChatKeys(rec.sender).catch(unanswered));
			// Readable, never proof of who sent it: a changed key the user never
			// accepted (they can no longer: the safety number is made from posting
			// keys only), a key the peer REPLACED (it may be in someone else's
			// hands now), or the chat key the chain says they publish now.
			let viaUnpinnedKey = false;
			if (opened === null && v === 2) {
				const pending = deps.pendingPeerPub?.(rec.sender) ?? null;
				if (pending !== null) {
					opened = await open([pending]);
					viaUnpinnedKey = opened !== null;
				}
			}
			if (opened === null && v === 2) {
				const replaced = deps.replacedPeerPubs?.(rec.sender) ?? [];
				if (replaced.length > 0) {
					opened = await open(replaced);
					viaUnpinnedKey = opened !== null;
				}
			}
			if (opened === null && v === 2 && rec.sender === deps.peer && deps.pinnedPeerPubs) {
				const current = await currentChatKeyOfPeer().catch(unanswered);
				if (current.length > 0) {
					opened = await open(current);
					viaUnpinnedKey = opened !== null;
				}
			}
			if (opened === null) {
				return lookupFailed
					? {
							text: ENCRYPTED_PLACEHOLDER,
							decryptFailed: false,
							senderUnverified: false,
							transient: true
						}
					: { text: ENCRYPTED_PLACEHOLDER, decryptFailed: true, senderUnverified: false };
			}
			const text = typeof opened === 'string' ? opened : opened.text;
			const authenticated = typeof opened === 'string' ? false : opened.authenticated;
			const unproved = !authenticated || viaUnpinnedKey;
			return {
				text,
				decryptFailed: false,
				senderUnverified: unproved,
				...(unproved ? { olderFormat: true as const } : {}),
				...(unproved && lookupFailed ? { transient: true as const } : {})
			};
		} catch {
			// Any unexpected error during decrypt (including
			// crypto init failures, libsodium issues, etc.) falls
			// back to placeholder. Conversation keeps rendering.
			return { text: ENCRYPTED_PLACEHOLDER, decryptFailed: true, senderUnverified: false };
		}
	}

	/** The chat keys that PROVE an older-format message from `sender`: those
	 *  pinned here (before v1.21.14; nothing pins a chat key any more). Tests
	 *  without a pin store (no `pinnedPeerPubs`): the conversation's fetched
	 *  key. Throws KeyLookupUnavailable when that lookup could not be made. */
	async function provingChatKeys(sender: string): Promise<Uint8Array[]> {
		await unsealSettled();
		if (deps.pinnedPeerPubs !== undefined) return [...deps.pinnedPeerPubs(sender)];
		return sender === deps.peer ? currentChatKeyOfPeer() : [];
	}

	/** The peer's chat key as the chain says they publish it now (never
	 *  pinned), or none. Throws KeyLookupUnavailable when it could not be
	 *  asked (W-M8); a verdict about the key (PubPinError) is an answer. */
	async function currentChatKeyOfPeer(): Promise<Uint8Array[]> {
		try {
			const k = await ensurePeerChatPub();
			return k !== null ? [k] : [];
		} catch (err) {
			if (err instanceof PubPinError) return [];
			throw new KeyLookupUnavailable();
		}
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
		if (!live) return null;
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
		if (v === 3 || v === 4) {
			const sk = h.sk;
			const rk = h.rk;
			const wk = h.wk;
			const boundT = v === 4 ? boundTimeOf(h) : undefined;
			const boundOwner = v === 4 ? boundOwnerOf(h) : undefined;
			if (
				deps.decryptPostingSelfCopy === undefined ||
				typeof sk !== 'string' ||
				!isStringArray(rk) ||
				!isStringArray(wk) ||
				(v === 4 && (boundT === undefined || boundOwner === undefined))
			) {
				return null;
			}
			try {
				return await deps.decryptPostingSelfCopy(
					{
						v,
						...(boundT !== undefined ? { t: boundT, o: boundOwner } : {}),
						ciphertext: rec.ciphertext,
						ephemeralPub,
						nonce,
						selfCiphertext,
						selfNonce,
						senderKey: sk,
						recipientKeys: rk,
						wraps: wk
					},
					live,
					rec.sender,
					rec.recipient,
					rec.order_permlink ?? null
				);
			} catch {
				return null;
			}
		}
		if (deps.decryptSelfCopy === undefined) return null;
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
				// Our self-copy was made with the key the peer had then: pinned,
				// replaced or the one on chain now (reading our own message
				// proves nothing).
				[
					...(await provingChatKeys(rec.recipient).catch(() => [])),
					...(deps.replacedPeerPubs?.(rec.recipient) ?? []),
					...(rec.recipient === deps.peer && deps.pinnedPeerPubs
						? await currentChatKeyOfPeer().catch(() => [])
						: [])
				]
			);
		} catch {
			return null;
		}
	}

	/**
	 * Phase F.5 — populate the trade-status store from an incoming structured
	 * payload. If the decrypted plaintext is a recognized address/funds-sent
	 * payload with an orderPermlink, route it. Plain chat messages decode to
	 * 'plaintext' and are no-ops. The caller checks that the sender is proved.
	 *
	 * v1.21.14 full chat audit, W-H1 — and only for the order of the thread the
	 * message arrived in (`threadOrder`, the record's order_permlink, which the
	 * merge has already matched to this view's thread), when that order belongs
	 * to the sender or to us. Before, the order NAMED INSIDE the message was
	 * taken at its word: a peer in an unrelated direct message could mark our
	 * trade with someone else as paid, or replace the amount and memo it asked.
	 *
	 * 'retry': whose order it is could not be told now; the caller marks the
	 * message `effectsDue` and they run when it is next delivered.
	 */
	async function applyIncomingTradePayload(
		text: string,
		sender: string,
		threadOrder: string | null,
		epoch: number,
		/** v4: the order owner the sender sealed it with (C-M2). */
		boundOwner?: string
	): Promise<'done' | 'retry'> {
		const decoded = decodePayload(text);
		if (decoded.kind !== 'address' && decoded.kind !== 'funds_sent') return 'done';
		const order = decoded.payload.orderPermlink;
		if (!order || order !== threadOrder) return 'done';
		const owner =
			deps.orderOwnerOf === undefined
				? sender
				: await deps.orderOwnerOf(order, sender).catch(() => null);
		// A lock (or the view closing) while that was asked: record nothing.
		if (destroyed || epoch !== lockEpoch) return 'done';
		if (owner === null) return 'retry';
		if (owner === false) return 'done';
		// v4: sealed about ANOTHER owner's order by the same permlink — not
		// this one's trade (C-M2).
		if (boundOwner !== undefined && boundOwner !== owner) return 'done';
		recordIncomingTradePayload(decoded, sender, owner);
		return 'done';
	}

	function recordIncomingTradePayload(
		decoded: ReturnType<typeof decodePayload>,
		sender: string,
		orderOwner: string
	): void {
		try {
			if (decoded.kind === 'address' && decoded.payload.orderPermlink) {
				recordAddressShared({
					orderOwner,
					orderPermlink: decoded.payload.orderPermlink,
					peer: sender,
					method: decoded.payload.method,
					address: decoded.payload.address,
					expectedAmount: decoded.payload.amount ? Number(decoded.payload.amount) : undefined,
					expectedMemo: decoded.payload.memo,
					direction: 'incoming'
				});
			} else if (decoded.kind === 'funds_sent' && decoded.payload.orderPermlink) {
				recordFundsSent({
					orderOwner,
					orderPermlink: decoded.payload.orderPermlink,
					peer: sender,
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
								sender,
								amountBlurt: amountNum,
								echoedMemo: decoded.payload.memo ?? '',
								orderOwner,
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

	/**
	 * Trade side effects run here, one at a time and in the order the messages
	 * were merged, but OUTSIDE the merge: the order-owner lookup they may wait
	 * for (W-H1, a hidden-network round trip the first time) must not hold back
	 * the messages after it from appearing.
	 */
	let effectsChain: Promise<unknown> = Promise.resolve();
	function queueTradeEffects(m: LocalMessage): void {
		const epoch = lockEpoch;
		const text = m.text;
		effectsChain = effectsChain
			.then(async () => {
				const r = await applyIncomingTradePayload(
					text,
					m.sender,
					deps.orderPermlink ?? null,
					epoch,
					m.boundOwner
				);
				// Not decided now: run them when the message is next delivered.
				if (r === 'retry') m.effectsDue = true;
			})
			.catch(() => undefined);
	}

	/** A message whose trade side effects have not run yet (a history page
	 *  added it, or whose order could not be checked): the live path has now
	 *  delivered it, so they run (once). */
	function runDueEffects(m: LocalMessage | undefined): void {
		if (m?.effectsDue !== true) return;
		delete m.effectsDue;
		queueTradeEffects(m);
	}

	/**
	 * A message of the peer's shown unopened or unproved for a reason that
	 * passes (LocalMessage.reopen), opened again: take what this try says.
	 * Its trade side effects become due when its sender is now proved (they
	 * never ran: an unopened or unproved message moves no trade). Returns
	 * whether anything the view shows changed.
	 */
	function applyReopened(
		m: LocalMessage,
		d: Awaited<ReturnType<typeof decryptOrPlaceholder>>
	): boolean {
		const before = `${m.text}\u0000${m.decryptFailed}\u0000${m.senderUnverified === true}`;
		m.text = d.text;
		m.decryptFailed = d.decryptFailed;
		if (d.otherKey === true) m.decryptFailedReason = 'other_key';
		else delete m.decryptFailedReason;
		if (d.senderUnverified) m.senderUnverified = true;
		else delete m.senderUnverified;
		if (d.olderFormat === true) m.olderFormat = true;
		else delete m.olderFormat;
		// Opened now: its bound send time bounds the time shown (C-M2).
		if (d.boundT !== undefined && m.boundT === undefined) {
			m.boundT = d.boundT;
			if (m.createdAt !== null) m.createdAt = shownTime(m.createdAt, d.boundT);
		}
		if (d.boundOwner !== undefined) m.boundOwner = d.boundOwner;
		if (d.transient !== true) {
			delete m.reopen;
			if (!d.decryptFailed && !d.senderUnverified) m.effectsDue = true;
		}
		return before !== `${m.text}\u0000${m.decryptFailed}\u0000${m.senderUnverified === true}`;
	}

	/**
	 * One of OUR messages shown as the placeholder because the session was
	 * locked when it arrived (W-L1): `rec` is a copy of it arriving while
	 * unlocked — open it from its self-copy (or this session's own-sent cache).
	 * Returns whether its text changed.
	 */
	async function reopenOwn(rec: ChatMessageRecord): Promise<boolean> {
		if (deps.getLiveIdentity() === null) return false;
		const wire = wireOf(rec);
		const m = messages.find((x) => x.sender === deps.me && x.reopen === true && x.wire === wire);
		if (m === undefined) return false;
		const tag = clientTagFromHeader(rec.header);
		const fromChain = await decryptOwnFromChain(rec);
		if (deps.getLiveIdentity() === null) return false;
		const text = fromChain ?? (tag !== null ? ownSentFor(deps.me, rec, tag) : undefined);
		// Unlocked and still nothing to open it with (no self-copy: "destroy"
		// mode, or a message from before self-copies): final.
		delete m.reopen;
		if (text === undefined) return false;
		m.text = text;
		// Opened from its self-copy: the bound send time is authenticated (C-M2).
		const boundT = fromChain !== null ? boundTimeOf(rec.header) : undefined;
		if (boundT !== undefined && m.boundT === undefined) {
			m.boundT = boundT;
			if (m.createdAt !== null) m.createdAt = shownTime(m.createdAt, boundT);
		}
		return true;
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
	function mergePollResponse(
		items: readonly ChatMessageRecord[],
		mode: 'live' | 'history' = 'live'
	): Promise<number> {
		const run = mergeChain.then(() => mergeNow(items, mode));
		mergeChain = run.catch(() => undefined);
		return run;
	}

	/** One merge (see mergePollResponse, which runs them one at a time).
	 *  Resolves to how many messages it added to the list (a copy folded into
	 *  one already there changes the list but adds none).
	 *
	 *  `mode` 'history' is a page read by scrolling back. Two differences:
	 *
	 *  - The trade side effects (applyIncomingTradePayload) do not run for what
	 *    it adds. They record the latest address and payment claim of an order;
	 *    run for an old message after a newer one, they would put the old
	 *    address or transaction back. The message is marked `effectsDue`
	 *    instead, and they run when — if — the live path (stream, poll) delivers
	 *    it too: exactly the messages they ran for before v1.21.6, including a
	 *    genuinely new one a history page happened to read first.
	 *  - A record older than the newest message already shown is marked
	 *    `backfilled`, so the view does not count it as a new message. */
	async function mergeNow(
		items: readonly ChatMessageRecord[],
		mode: 'live' | 'history'
	): Promise<number> {
		if (items.length === 0) return 0;
		const epoch = lockEpoch;
		/** A lock landed while this merge was awaiting a decrypt: stop here. */
		const lockedSince = (): boolean => epoch !== lockEpoch || destroyed;
		let newestBefore: number | null = null;
		if (mode === 'history') {
			for (const m of messages) {
				const at = m.createdAt?.getTime();
				if (at !== undefined && (newestBefore === null || at > newestBefore)) newestBefore = at;
			}
		}
		const isBackfill = (rec: ChatMessageRecord): boolean =>
			newestBefore !== null && new Date(rec.created_at).getTime() < newestBefore;

		// Build a set of ids already in local state as 'confirmed'.
		// Pending / broadcast / failed don't have ids yet, so they
		// aren't in this set (their reconciliation happens via
		// client_tag below).
		const seenIds = new Set<number>();
		const byId = new Map<number, LocalMessage>();
		for (const m of messages) {
			if (m.state === 'confirmed' && m.id !== null) {
				seenIds.add(m.id);
				byId.set(m.id, m);
			}
		}

		// The endpoint returns newest-first; iterate reversed so
		// we add oldest-first to preserve chronological order.
		const oldestFirst = [...items].reverse();
		let added = false;
		const before = messages.length;
		let opened = 0;

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
				// W-L1: one of ours shown as a placeholder while the session was
				// locked — this copy arrives after the unlock: open it now.
				if (await reopenOwn(rec)) added = true;
				if (lockedSince()) return 0;
				const reconciled = reconcileByClientTag(rec);
				if (reconciled !== 'no') {
					if (reconciled === 'changed') added = true;
					continue;
				}
				// W-H3: the same bytes under another tag (or none) are a copy of
				// a message already here, never a second one.
				const ownTwin = twinByWire(rec);
				if (ownTwin) {
					if (isDurable && (ownTwin.id === null || ownTwin.id === 0)) {
						adoptDurable(ownTwin, rec);
						added = true;
					}
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
				if (++opened % DECRYPT_YIELD_EVERY === 0 && deps.yieldToMain !== undefined) {
					await deps.yieldToMain();
				}
				// Locked: shown as the placeholder now, opened after the unlock.
				const lockedNow = deps.getLiveIdentity() === null;
				const ownFromChain = await decryptOwnFromChain(rec);
				if (lockedSince()) return 0;
				const ownCached =
					ownFromChain === null && deps.getLiveIdentity() !== null && ownTag !== null
						? ownSentFor(deps.me, rec, ownTag)
						: undefined;
				const ownText = ownFromChain ?? ownCached ?? ENCRYPTED_PLACEHOLDER;
				// Opened from its self-copy: its bound send time is authenticated.
				const ownBoundT = ownFromChain !== null ? boundTimeOf(rec.header) : undefined;
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
						if (absorbRetryCopy(linked, rec, ownTag, ownDeclared, ownBoundT)) added = true;
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
					createdAt: shownTime(rec.created_at, ownBoundT),
					...(ownBoundT !== undefined ? { boundT: ownBoundT } : {}),
					trxId: isDurable ? rec.source_trx_id || null : null,
					error: null,
					decryptFailed: false,
					localSeq: ++localSeqCounter,
					wire: wireOf(rec),
					...(lockedNow && ownText === ENCRYPTED_PLACEHOLDER ? { reopen: true as const } : {}),
					...(ownDeclared.length > 0 ? { priorTags: ownDeclared } : {}),
					...(isDurable ? {} : { provisionalSinceMs: Date.now() }),
					...(isBackfill(rec) ? { backfilled: true as const } : {})
				});
				added = true;
			} else {
				// Incoming from the peer.
				// id 0 marks a PROVISIONAL head-block copy
				// (ADR-0048 fast path), not yet irreversible.
				const incomingTag = clientTagFromHeader(rec.header);

				// Collapse a fast-path provisional against its durable
				// twin — either may arrive first. On a hit, adopt the durable id
				// the first time it lands, but NEVER re-decode or re-record:
				// the trade-status side effects below ran when the message
				// first arrived, and re-running them would double-record
				// an address/funds-sent payload.
				//
				// A twin is the same sender and the same encrypted bytes, WHATEVER
				// its tag (v1.21.14 full chat audit, W-H3; see twinByWire).
				const twin = twinByWire(rec);
				if (twin) {
					let changed = false;
					if (isDurable && (twin.id === null || twin.id === 0)) {
						adoptDurable(twin, rec);
						changed = true;
					}
					// W-M8 / W-L1: shown unopened (or unproved) for a reason that
					// passes — try again now.
					if (twin.reopen === true && deps.getLiveIdentity() !== null) {
						const d = await decryptOrPlaceholder(rec);
						if (lockedSince()) return 0;
						if (applyReopened(twin, d)) changed = true;
					}
					if (mode === 'live') runDueEffects(twin);
					if (changed) added = true;
					continue;
				}

				// No twin yet. Durable copies dedup by id; a provisional
				// (id 0) is stored with a null id and never enters seenIds.
				if (isDurable && seenIds.has(rec.id)) {
					if (mode === 'live') runDueEffects(byId.get(rec.id));
					continue;
				}
				if (++opened % DECRYPT_YIELD_EVERY === 0 && deps.yieldToMain !== undefined) {
					await deps.yieldToMain();
					if (lockedSince()) return 0;
				}
				const d = await decryptOrPlaceholder(rec);
				if (lockedSince()) return 0;
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
						if (absorbRetryCopy(linked, rec, incomingTag, declared, d.boundT)) added = true;
						continue;
					}
				}

				const entry: LocalMessage = {
					id: isDurable ? rec.id : null,
					orderPermlink: rec.order_permlink ?? null,
					clientTag: incomingTag,
					text: d.text,
					sender: rec.sender,
					state: 'confirmed',
					createdAt: shownTime(rec.created_at, d.boundT),
					...(d.boundT !== undefined ? { boundT: d.boundT } : {}),
					...(d.boundOwner !== undefined ? { boundOwner: d.boundOwner } : {}),
					trxId: isDurable ? rec.source_trx_id || null : null,
					error: null,
					decryptFailed: d.decryptFailed,
					...(d.otherKey === true ? { decryptFailedReason: 'other_key' as const } : {}),
					...(d.senderUnverified ? { senderUnverified: true } : {}),
					...(d.olderFormat === true ? { olderFormat: true as const } : {}),
					localSeq: ++localSeqCounter,
					wire: wireOf(rec),
					...(d.transient === true ? { reopen: true as const } : {}),
					// Kept so a copy of the attempt this one replaces, arriving
					// AFTER it, is recognised too. Unverified until then: the
					// link still has to pass the identical-text test.
					...(declared.length > 0 ? { priorTags: declared } : {}),
					...(isDurable ? {} : { provisionalSinceMs: Date.now() }),
					...(isBackfill(rec) ? { backfilled: true as const } : {})
				};
				messages.push(entry);
				added = true;

				// Trade side effects (see applyIncomingTradePayload). Only for a
				// message whose sender is PROVED (v2): a v1 message could have been
				// written by anyone who knows our public chat key, so it never moves
				// a trade forward. A page read by scrolling back defers them to the
				// live path (see mergeNow).
				if (!d.decryptFailed && !d.senderUnverified) {
					if (mode === 'history') entry.effectsDue = true;
					else queueTradeEffects(entry);
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
		messages.sort(chronological);

		if (added) emit();
		return messages.length - before;
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
			markLiveReady();
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

	async function sendMessage(text: string): Promise<SendOutcome> {
		const trimmed = text.trim();
		if (trimmed.length === 0) return { ok: false, error: 'empty' };

		// Phase F.5 — populate the trade-status store from outgoing
		// structured payloads.  Started before the broadcast attempt
		// so the /my/orders badge updates even if the network is
		// slow.  If the broadcast eventually fails, the trade entry
		// still reflects the user's intent — they'll see the failed
		// message in their chat and can retry.
		// C-L3: under the order's owner (the peer's or ours), once known —
		// asked again while it cannot be told (OUTGOING_OWNER_RETRY_MS); neither
		// party's order, or a lock or sign-out meanwhile (even after this view
		// closed): nothing is recorded.
		try {
			const decoded = decodePayload(trimmed);
			const order =
				decoded.kind === 'address' || decoded.kind === 'funds_sent'
					? decoded.payload.orderPermlink
					: undefined;
			const generation = sessionGeneration;
			const ownerOf = (o: string): Promise<string | false | null> =>
				deps.orderOwnerOf === undefined
					? Promise.resolve(deps.peer)
					: deps.orderOwnerOf(o, deps.peer).catch(() => null);
			const record = (orderOwner: string): void => {
				if (decoded.kind === 'address' && decoded.payload.orderPermlink) {
					recordAddressShared({
						orderOwner,
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
						orderOwner,
						orderPermlink: decoded.payload.orderPermlink,
						peer: deps.peer,
						method: decoded.payload.method,
						txid: decoded.payload.txid,
						claimedMemo: decoded.payload.memo,
						amount: decoded.payload.amount ? Number(decoded.payload.amount) : undefined,
						direction: 'outgoing'
					});
				}
			};
			const attempt = (n: number): void => {
				if (!order) return;
				void ownerOf(order).then((orderOwner) => {
					if (generation !== sessionGeneration) return;
					if (typeof orderOwner === 'string') record(orderOwner);
					else if (orderOwner === null && n < OUTGOING_OWNER_RETRY_MS.length)
						setTimeout(() => attempt(n + 1), OUTGOING_OWNER_RETRY_MS[n]);
				});
			};
			attempt(0);
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
			return { ok: false, error: SESSION_LOCKED_SENTINEL };
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
			rememberOwnSent(deps.me, deps.peer, deps.orderPermlink, clientTag, trimmed);
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

		// Real crypto path (ADR-0015): v2 to the peer's chat key, or v3 to their
		// posting key when either side has no chat key (seal). keep-history mode
		// (the default) adds a self-copy so we can reread our own message from
		// chain; the opt-in "destroy on leave" mode omits it.
		const includeSelfCopy = keepHistory;
		const sealed = await seal(trimmed, live, includeSelfCopy);
		if (!sealed.ok) {
			local.state = 'failed';
			local.error = sealed.error;
			rememberUnsent(local);
			emit();
			return { ok: false, error: sealed.error };
		}
		const envelope = sealed.envelope;
		// v4: the send time we bound it to (C-M2) bounds the time it shows.
		if (envelope.v === 4 && envelope.t !== undefined) local.boundT = envelope.t;

		// Step 4: build the on-wire payload and hand it to the node.
		const payload = wirePayload(clientTag, envelope, []);
		try {
			const res = await deps.broadcast(live, payload, deps.me);
			markAccepted(local, res?.trx_id);
			return { ok: true };
		} catch (err) {
			markSendFailed(local, err);
			// Our own copy may already have come back and confirmed it (see
			// markSendFailed): then it was delivered, whatever the reply said.
			return local.state === 'failed'
				? { ok: false, error: local.error ?? 'failed' }
				: { ok: true };
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
		envelope: SealedEnvelope,
		priorTags: readonly string[]
	): Record<string, unknown> {
		const payload: Record<string, unknown> = {
			recipient: deps.peer,
			ciphertext: envelope.ciphertext,
			header: {
				// The envelope version: 2 = sender-authenticated (chat keys),
				// 3 = posting keys (crypto.ts), 4 = posting keys bound to the
				// order and the send time `t` (review C-M2).
				...(envelope.v === 2 || envelope.v === 3 ? { v: envelope.v } : {}),
				...(envelope.v === 4 ? { v: 4, t: envelope.t, o: envelope.o } : {}),
				client_tag: clientTag,
				ephemeral_pub: envelope.ephemeralPub,
				nonce: envelope.nonce,
				// v3: the posting keys it was made with (public keys) and the
				// content key wrapped for each recipient key.
				...(envelope.senderKey !== undefined &&
				envelope.recipientKeys !== undefined &&
				envelope.wraps !== undefined
					? { sk: envelope.senderKey, rk: [...envelope.recipientKeys], wk: [...envelope.wraps] }
					: {}),
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
		forgetUnsent(m);
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

	/** A send that never reached the network, kept past this view (v1.21.13):
	 *  coming back to the chat showed nothing where the failed message had
	 *  been. Keyed by the message's own sequence in this thread. */
	function rememberUnsent(m: LocalMessage): void {
		if (deps.getLiveIdentity() === null) return;
		if (!shouldAttachSelfCopy(deps.chatSecurityMode?.())) return;
		if (m.id !== null || m.state !== 'failed') return;
		const key = unsentKey(
			deps.me,
			deps.peer,
			deps.orderPermlink ?? null,
			m.unsentId ?? newUnsentId(m)
		);
		unsentOwnSends.set(key, {
			text: m.text,
			error: m.error,
			errorValues: m.errorValues ? { ...m.errorValues } : null,
			// The tags it was sent under, so a copy that reached the network after
			// all still reconciles into it instead of beside it.
			priorTags: [
				...new Set([...(m.priorTags ?? []), ...(m.clientTag !== null ? [m.clientTag] : [])])
			].slice(-MAX_PRIOR_TAGS),
			atMs: Date.now()
		});
		while (unsentOwnSends.size > UNSENT_OWN_MAX) {
			const oldest = unsentOwnSends.keys().next().value;
			if (oldest === undefined) break;
			unsentOwnSends.delete(oldest);
		}
	}
	function newUnsentId(m: LocalMessage): string {
		// Its own counter, never a client tag: tags are what goes on chain.
		m.unsentId = `u${++unsentSeq}`;
		return m.unsentId;
	}
	function forgetUnsent(m: LocalMessage): void {
		if (m.unsentId === undefined) return;
		unsentOwnSends.delete(unsentKey(deps.me, deps.peer, deps.orderPermlink ?? null, m.unsentId));
		delete m.unsentId;
	}
	/** Put this thread's never-sent messages back, failed, with Retry. */
	function restoreUnsent(): void {
		if (deps.getLiveIdentity() === null) return;
		const prefix = unconfirmedThreadPrefix(deps.me, deps.peer, deps.orderPermlink ?? null);
		// "Destroy after you leave this chat" chosen since the send failed: the
		// words are not shown again, and not kept.
		const keep = shouldAttachSelfCopy(deps.chatSecurityMode?.());
		let restored = false;
		for (const [key, u] of Array.from(unsentOwnSends)) {
			if (!key.startsWith(prefix)) continue;
			if (!keep) {
				unsentOwnSends.delete(key);
				continue;
			}
			const id = key.slice(prefix.length);
			if (messages.some((m) => m.unsentId === id)) continue;
			messages.push({
				id: null,
				orderPermlink: deps.orderPermlink ?? null,
				clientTag: null,
				text: u.text,
				sender: deps.me,
				state: 'failed',
				createdAt: null,
				trxId: null,
				error: u.error,
				...(u.errorValues !== null ? { errorValues: { ...u.errorValues } } : {}),
				decryptFailed: false,
				localSeq: ++localSeqCounter,
				unsentId: id,
				...(u.priorTags.length > 0 ? { priorTags: [...u.priorTags] } : {})
			});
			restored = true;
		}
		if (restored) emit();
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
			// In the words every chain-write screen uses (out of BLURT: "Broadcast
			// rejected due to insufficient funds…"), not the chain's raw
			// assertion text, which the bubble used to show verbatim.
			const copy = classifyBroadcastError(err, deps.me);
			m.error = `${BROADCAST_ERR_PREFIX}${copy.key}`;
			if (copy.values !== undefined) m.errorValues = { ...copy.values };
			else delete m.errorValues;
			rememberUnsent(m);
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
			rememberOwnSent(deps.me, deps.peer, deps.orderPermlink, newTag, text);
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

		// Re-run the full crypto path (the same choice of envelope as a first
		// send). A peer that was not found or had no chat key is asked again:
		// they may have published one since.
		const includeSelfCopy = shouldAttachSelfCopy(deps.chatSecurityMode?.());
		forgetKeyMisses();
		const sealed = await seal(text, live, includeSelfCopy);
		if (!sealed.ok) {
			target.state = 'failed';
			target.error = sealed.error;
			delete target.errorValues;
			rememberUnsent(target);
			emit();
			return;
		}
		const envelope = sealed.envelope;
		// A retry is sealed afresh: its own bound send time (C-M2).
		if (envelope.v === 4 && envelope.t !== undefined) target.boundT = envelope.t;
		else delete target.boundT;

		const payload = wirePayload(newTag, envelope, target.priorTags ?? []);
		try {
			const res = await deps.broadcast(live, payload, deps.me);
			markAccepted(target, res?.trx_id);
		} catch (err) {
			markSendFailed(target, err);
		}
	}

	// ─── Scrolling back, and the whole conversation (v1.21.6) ─────────
	//
	// The live paths (stream snapshot, fallback poll) only ever read the pair's
	// newest 50 messages. A thread's older messages — or all of a thread whose
	// messages are older than the newest 50 of the pair — were never loaded, so
	// they could not be reread or exported. These read the rest, page by page.

	function historyState(loading: boolean): HistoryState {
		return { ready: liveReady, loading, complete: olderComplete, failed: olderFailed };
	}

	function emitHistory(): void {
		if (destroyed) return;
		deps.onHistoryChange?.(historyState(olderRun !== null));
	}

	/** The first live answer is in (even one with nothing for this thread). */
	function markLiveReady(): void {
		if (liveReady || destroyed) return;
		liveReady = true;
		emitHistory();
	}

	/** One history page, tried up to three times. Null when every try failed
	 *  or the view closed. */
	async function fetchHistoryPage(opts: {
		cursor: string | undefined;
		order?: string | null;
		waits: readonly number[];
	}): Promise<{ items: readonly ChatMessageRecord[]; nextCursor: string | null } | null> {
		const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
		for (let attempt = 0; ; attempt++) {
			if (destroyed) return null;
			let r: Awaited<ReturnType<ChatControllerDeps['fetchHistory']>> | undefined;
			try {
				r = await deps.fetchHistory(deps.me, deps.peer, {
					limit: OLDER_PAGE_SIZE,
					signal: historyAbort.signal,
					...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
					...(opts.order !== undefined ? { order: opts.order } : {})
				});
			} catch {
				r = undefined;
			}
			if (destroyed) return null;
			if (r && r.ok) return { items: r.items, nextCursor: r.nextCursor };
			const wait = opts.waits[attempt];
			if (wait === undefined) return null;
			await sleep(wait);
		}
	}

	/**
	 * Does this page take the read further back? An indexer answers each page
	 * with rows it has not given before in this read, and a cursor it has not
	 * given before, and never an empty page that says there is more. Anything
	 * else — a buggy or hostile one — would keep the read asking forever.
	 * Records the page's cursor and ids in `followed` / `ids`.
	 */
	function progresses(
		page: { items: readonly ChatMessageRecord[]; nextCursor: string | null },
		followed: Set<string>,
		ids: Set<number>
	): boolean {
		if (page.nextCursor !== null) {
			// `every` of an empty page is true: an empty page that says there
			// is more fails too.
			if (followed.has(page.nextCursor) || page.items.every((r) => ids.has(r.id))) return false;
			followed.add(page.nextCursor);
		}
		for (const r of page.items) ids.add(r.id);
		return true;
	}

	function loadOlder(): Promise<void> {
		if (destroyed || olderComplete) return Promise.resolve();
		if (olderRun !== null) return olderRun;
		const epoch = lockEpoch;
		const stale = (): boolean => destroyed || epoch !== lockEpoch;
		olderFailed = false;
		olderRun = (async () => {
			/** Cursors this read has followed: one coming back means the
			 *  indexer is going round in circles, not further back. */
			const followed = new Set<string>();
			const runIds = new Set<number>();
			try {
				for (;;) {
					const page = await fetchHistoryPage({
						cursor: olderCursor,
						order: deps.orderPermlink ?? null,
						waits: HISTORY_RETRY_WAITS_MS
					});
					if (stale()) return;
					if (page === null || !progresses(page, followed, runIds)) {
						olderFailed = true;
						return;
					}
					const added = (await mergePollResponse(page.items, 'history')) > 0;
					if (stale()) return;
					if (page.nextCursor === null) {
						olderComplete = true;
						return;
					}
					olderCursor = page.nextCursor;
					// Something older is on screen: stop until the reader asks
					// again. Otherwise (a page of other threads, from an indexer
					// that ignores the thread filter, or one we already had) read on.
					if (added) return;
				}
			} catch {
				// A merge that threw: say so, never reject (the view awaits this).
				if (!stale()) olderFailed = true;
			} finally {
				olderRun = null;
				emitHistory();
			}
		})();
		emitHistory();
		return olderRun;
	}

	async function loadWholeConversation(): Promise<readonly ConversationRecordMessage[]> {
		if (destroyed) throw new ConversationIncompleteError('closed');
		const epoch = lockEpoch;
		const stale = (): boolean => destroyed || epoch !== lockEpoch;
		const records: ChatMessageRecord[] = [];
		const seen = new Set<number>();
		let cursor: string | undefined = undefined;
		const followed = new Set<string>();
		const pageIds = new Set<number>();
		for (;;) {
			const page = await fetchHistoryPage({ cursor, waits: EXPORT_RETRY_WAITS_MS });
			if (stale()) throw new ConversationIncompleteError('locked or closed');
			if (page === null) throw new ConversationIncompleteError('a page could not be read');
			if (!progresses(page, followed, pageIds)) {
				throw new ConversationIncompleteError('the indexer went round in circles');
			}
			for (const rec of page.items) {
				if (seen.has(rec.id)) continue;
				seen.add(rec.id);
				records.push(rec);
			}
			if (page.nextCursor === null) break;
			cursor = page.nextCursor;
		}

		// What this view already decrypted is reused: the same words it shows.
		const shown = new Map<number, LocalMessage>();
		for (const m of messages) if (m.id !== null && m.id !== 0) shown.set(m.id, m);

		const out: (ConversationRecordMessage & { id: number | null; localSeq: number })[] = [];
		for (const rec of records) {
			const orderPermlink = rec.order_permlink ?? null;
			const base = {
				id: rec.id,
				localSeq: 0,
				sender: rec.sender,
				createdAt: new Date(rec.created_at),
				orderPermlink,
				trxId: rec.source_trx_id || null,
				state: 'confirmed' as const
			};
			const known = shown.get(rec.id);
			if (known) {
				out.push({
					...base,
					createdAt: shownTime(rec.created_at, known.boundT),
					text: known.text,
					decryptFailed: known.decryptFailed
				});
				continue;
			}
			if (rec.sender === deps.me) {
				const tag = clientTagFromHeader(rec.header);
				const fromChain = await decryptOwnFromChain(rec);
				if (stale()) throw new ConversationIncompleteError('locked or closed');
				const cached =
					fromChain === null && deps.getLiveIdentity() !== null && tag !== null
						? ownSentFor(deps.me, rec, tag)
						: undefined;
				out.push({
					...base,
					// Opened from its self-copy: its bound send time is authenticated.
					createdAt: shownTime(
						rec.created_at,
						fromChain !== null ? boundTimeOf(rec.header) : undefined
					),
					text: fromChain ?? cached ?? ENCRYPTED_PLACEHOLDER,
					decryptFailed: false
				});
			} else {
				const d = await decryptOrPlaceholder(rec);
				if (stale()) throw new ConversationIncompleteError('locked or closed');
				out.push({
					...base,
					createdAt: shownTime(rec.created_at, d.boundT),
					text: d.text,
					decryptFailed: d.decryptFailed
				});
			}
		}
		// What this view shows that the pages did not hold: messages with no
		// durable copy yet (sending, failed, or a copy the chain has not made
		// irreversible), and any whose durable copy landed while the pages were
		// being read. A message whose durable copy IS among the records is
		// listed once, as that record: matched by id, or by sender and tag (for
		// the peer's, the same encrypted bytes too).
		const durable = new Set<string>();
		for (const rec of records) {
			const tag = clientTagFromHeader(rec.header);
			if (tag === null) continue;
			durable.add(rec.sender === deps.me ? `me\u0000${tag}` : `${tag}\u0000${wireOf(rec)}`);
		}
		for (const m of messages) {
			const id = durableId(m);
			const listed =
				id !== null
					? seen.has(id)
					: m.sender === deps.me
						? [m.clientTag, ...(m.priorTags ?? [])].some(
								(t) => t !== null && durable.has(`me\u0000${t}`)
							)
						: m.clientTag !== null && durable.has(`${m.clientTag}\u0000${m.wire ?? ''}`);
			if (listed) continue;
			out.push({
				id,
				localSeq: m.localSeq,
				sender: m.sender,
				text: m.text,
				createdAt: m.createdAt,
				orderPermlink: m.orderPermlink,
				trxId: m.trxId,
				decryptFailed: m.decryptFailed,
				state: m.state,
				...(m.unrecorded === true ? { unrecorded: true } : {})
			});
		}
		// Oldest first; anything without a chain time last, in the view's order.
		return out.sort(chronological).map(({ id: _id, localSeq: _seq, ...m }) => m);
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
		wireAliases = new Map();
		// Scrolling back starts again from the newest message: what it had
		// loaded was just dropped.
		olderCursor = undefined;
		olderComplete = false;
		olderFailed = false;
		emit();
		emitHistory();
	}

	return {
		start() {
			if (started || destroyed) return;
			started = true;
			controllerLockHooks.add(onSessionLocked);
			restoreUnconfirmed();
			restoreUnsent();
			warmUpKeys();

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
						void mergePollResponse(items).then(markLiveReady, () => undefined);
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
			historyAbort.abort();
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
		},
		loadOlder,
		loadWholeConversation,
		lockGeneration: () => lockEpoch
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
const bytesToB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const b64ToBytes = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The runtime's posting-key pin (ChatControllerDeps.pinPostingKey), over the
 *  pin store in pubPin.ts. */
export async function pinPostingKeyInStore(
	peerAccount: string,
	chainKeys: readonly Uint8Array[]
): Promise<Uint8Array[]> {
	return (await resolvePostingKeyPin(peerAccount, chainKeys.map(bytesToB64))).map(b64ToBytes);
}

/** The posting keys pinned for `peer` (ChatControllerDeps.pinnedPostingKeys). */
export function pinnedPostingKeysInStore(peer: string): Uint8Array[] {
	const out: Uint8Array[] = [];
	for (const b64 of pinnedPostingFor(peer)) {
		try {
			out.push(b64ToBytes(b64));
		} catch {
			/* a malformed stored key proves nothing */
		}
	}
	return out;
}

/**
 * An account's posting keys as the posting-key envelope wants them: the keys
 * that can sign on their own (weight at least the threshold) — a Morphit
 * session holds one of them — at most MAX_RECIPIENT_KEYS, unreadable entries
 * dropped. [] when there is none (the authority is other accounts, or only a
 * multi-signature set); null when the chain has no such account. PURE.
 */
export function orderPostingPubs(
	keys: { posting?: { weight_threshold?: number; key_auths?: Array<[string, number]> } } | null
): Uint8Array[] | null {
	if (keys === null) return null;
	const auths = keys.posting?.key_auths ?? [];
	const threshold = keys.posting?.weight_threshold ?? 1;
	const out: Uint8Array[] = [];
	for (const [blt, w] of auths) {
		if (!(w >= threshold)) continue;
		const k = decodePostingPubBLT(blt);
		if (k === null || out.some((o) => bytesToB64(o) === bytesToB64(k))) continue;
		out.push(k);
		if (out.length === MAX_RECIPIENT_KEYS) break;
	}
	return out;
}

/** Our posting key's reader (its public half, and the per-sender secrets a
 *  history reuses — crypto.ts PostingReader), for the session's key. Wiped on
 *  lock and sign-out (clearOwnSentPlaintextCache) and when the key changes. */
let cachedReader: PostingReader | null = null;
function readerFor(postingPriv: Uint8Array): PostingReader {
	if (
		cachedReader !== null &&
		cachedReader.priv === postingPriv &&
		postingPriv.some((b) => b !== 0)
	) {
		return cachedReader;
	}
	forgetPostingReader();
	cachedReader = postingReader(postingPriv);
	return cachedReader;
}
/** For tests: the cached reader, or null. */
export function __cachedPostingReader(): PostingReader | null {
	return cachedReader;
}
function forgetPostingReader(): void {
	if (cachedReader !== null) wipePostingReader(cachedReader);
	cachedReader = null;
}

/** A v3 SealedEnvelope as crypto.ts takes it, or null when a field is missing. */
function postingWire(envelope: SealedEnvelope): PostingEnvelopeWire | null {
	if (
		envelope.senderKey === undefined ||
		envelope.recipientKeys === undefined ||
		envelope.wraps === undefined
	) {
		return null;
	}
	if (envelope.v === 4 && (envelope.t === undefined || envelope.o === undefined)) return null;
	return {
		...(envelope.v === 4 ? { v: 4 as const, t: envelope.t, o: envelope.o } : { v: 3 as const }),
		ciphertext: envelope.ciphertext,
		ephemeralPub: envelope.ephemeralPub,
		nonce: envelope.nonce,
		senderKey: envelope.senderKey,
		recipientKeys: envelope.recipientKeys,
		wraps: envelope.wraps,
		...(envelope.selfCiphertext !== undefined && envelope.selfNonce !== undefined
			? { selfCiphertext: envelope.selfCiphertext, selfNonce: envelope.selfNonce }
			: {})
	};
}

/** The posting-key envelope's three operations, as the controller takes them
 *  (pure crypto, no network): used by runtimeDeps and by the tests that run
 *  two real parties against each other. */
export const postingEnvelopeCrypto: Pick<
	Required<ChatControllerDeps>,
	'encryptPosting' | 'decryptPosting' | 'decryptPostingSelfCopy'
> = {
	encryptPosting: async (
		plaintext,
		recipientPostingPubs,
		live,
		senderAccount,
		recipientAccount,
		includeSelfCopy,
		binding
	) => {
		const env = await encryptToPostingKey(
			plaintext,
			recipientPostingPubs,
			live.posting.privateKey,
			senderAccount,
			recipientAccount,
			includeSelfCopy,
			binding
		);
		return {
			...(env.v === 4 ? { v: 4 as const, t: env.t, o: env.o } : { v: 3 as const }),
			ciphertext: env.ciphertext,
			ephemeralPub: env.ephemeralPub,
			nonce: env.nonce,
			senderKey: env.senderKey,
			recipientKeys: [...env.recipientKeys],
			wraps: [...env.wraps],
			...(env.selfCiphertext !== undefined && env.selfNonce !== undefined
				? { selfCiphertext: env.selfCiphertext, selfNonce: env.selfNonce }
				: {})
		};
	},
	decryptPosting: async (
		envelope,
		live,
		senderAccount,
		recipientAccount,
		senderPostingPubs,
		order
	) => {
		const wire = postingWire(envelope);
		if (wire === null) return null;
		try {
			return await decryptPostingEnvelope(
				wire,
				readerFor(live.posting.privateKey),
				senderAccount,
				recipientAccount,
				senderPostingPubs,
				order
			);
		} catch (err) {
			if (err instanceof NotForThisKeyError) return 'other_key';
			if (err instanceof DecryptError) return null;
			throw err;
		}
	},
	decryptPostingSelfCopy: async (envelope, live, senderAccount, recipientAccount, order) => {
		const wire = postingWire(envelope);
		if (wire === null) return null;
		try {
			return await decryptPostingSelfCopy(
				wire,
				readerFor(live.posting.privateKey),
				senderAccount,
				recipientAccount,
				order
			);
		} catch (err) {
			if (err instanceof DecryptError) return null;
			throw err;
		}
	}
};

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
				signal: opts.signal,
				...(opts.order !== undefined ? { order: opts.order } : {})
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
		// W-H1: a structured payload moves a trade only for an order of the
		// sender's or ours, under its owner (C-L3).
		orderOwnerOf: (orderPermlink: string, sender: string) =>
			orderOwnerOf(orderPermlink, sender, me),
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

			// Only to READ the peer's older (v2) messages, and NEVER pinned
			// (v1.21.14, posting-key-only chat: pinning it here, as the conversation
			// opened, is what held a first conversation's posting keys back). The
			// chain must confirm the op the indexer names — the same check as
			// before (chainVerify, with the S14 signature check) — or the key is
			// not used at all. A message it opens is shown as not proved anyway.
			const onChain = await verifyPeerChatIdentityOnChain(peerAccount, {
				blockNum: r.data.source_block_num,
				trxId: r.data.source_trx_id
			});
			if (onChain === null || onChain.chatPubB64 !== r.data.chat_pub) return null;
			return decodeChatPub(onChain.chatPubB64);
		},
		deriveMyChatIdentity: async (live: LiveIdentity, account: string) => {
			const id = await deriveChatIdentity(live.posting.privateKey, account);
			return { priv: id.priv, pub: id.pub };
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
		fetchPostingPubs: async (account: string) =>
			// The account's posting authority, read through this instance's
			// indexer (the same chain read every other key check here uses).
			orderPostingPubs(await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), account)),
		pinPostingKey: pinPostingKeyInStore,
		pinnedPostingKeys: pinnedPostingKeysInStore,
		yieldToMain: yieldToMainThread,
		...postingEnvelopeCrypto,
		// v4's bound send time: the chain's head time, read through this
		// instance (used only once WRITE_ENVELOPE_V4 is on).
		chainNowSeconds: async () =>
			Math.floor(new Date((await fetchDynamicGlobalProperties()).time + 'Z').getTime() / 1000),
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
		replacedPostingKeys: (p: string) => {
			const out: Uint8Array[] = [];
			for (const b64 of replacedPostingFor(p)) {
				try {
					out.push(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
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
