/**
 * Morphit chat — chain-anchored pub-key pinning (Option 5).
 *
 * This module persists a pinned association
 *
 *     peer-account → { block_num, trx_id, chat_pub }
 *
 * for every peer the local user has fetched a chat identity for.
 * The `chat_pub` is the pub bytes from the chat_identities table;
 * `(block_num, trx_id)` is the reference to the on-chain
 * `morphit_chat_identity_v1` op that established this pub.
 *
 * Why pin?  See ADR-0015 §S2 / chat security audit S2.  The
 * indexer is currently the only source the frontend trusts for
 * peer chat_pubs.  A compromised indexer could substitute a pub
 * the operator controls and read every message we send to that
 * peer.  Pinning to the chain reference defends:
 *
 *   - On first contact:   pin (TOFU).
 *   - Same ref on later
 *     fetches:            trust the pinned pub.
 *   - Newer ref:          the peer republished their chat
 *                         identity.  The op is checked (see
 *                         chainVerify.ts) — but that check reads
 *                         the chain THROUGH the operator's own
 *                         indexer, which could forge both the
 *                         transaction and the authority it is
 *                         checked against.  So a newer ref that
 *                         carries the SAME key moves the pin, and
 *                         one that carries a DIFFERENT key is held
 *                         back as a pending "safety number
 *                         changed" until the user confirms it
 *                         (acceptKeyChange) — never silently.
 *   - Older ref:          impossible without rollback;
 *                         rollbacks of the chat-identity table
 *                         shouldn't happen on a forward-only
 *                         chain.  Treat as compromise.
 *   - Same ref, different
 *     pub bytes:          indexer mutated stored data behind the
 *                         on-chain reference.  Treat as
 *                         compromise.
 *
 * Storage: single localStorage key 'morphit.chat.pub_pins'
 * holding a JSON object.  Per-peer keys would have been cleaner
 * for clearing per peer, but bulk-clear (on explicit lock) is
 * the more common operation and the single-key shape makes that
 * one safeLocal.remove() call.  Each pin is ~100 chars; even a
 * pathological 5MB localStorage budget allows ~50000 peers.
 *
 * Privacy: the pin set IS sensitive ("which peers have I ever
 * chatted with?"). An explicit Lock therefore does not leave it readable:
 * sealPinsForLock() encrypts the pins (and pending key changes, under
 * 'morphit.chat.pub_pin_pending') with a key derived from the posting key
 * and removes the readable copies; the next unlock of the same account
 * restores them (unsealPins). Wiping them instead would let a hostile
 * operator substitute a key after any lock with no "safety number changed"
 * step. Each account seals into its own slot (an id derived one-way from its
 * posting key), so a second account on the same browser — its Lock or its
 * Sign Out — never replaces or removes the first one's seal. Sign Out
 * (another person may sign in next) clears the readable pins (clearAllPins);
 * a seal names nobody and only its own account's key opens it, so it stays.
 */

import { safeLocal } from '$utils/safeStorage';
import { sodium, ensureSodium } from '$crypto/sodium';
import { unsealSettled } from './unsealGate';

const KEY = 'morphit.chat.pub_pins';
const PENDING_KEY = 'morphit.chat.pub_pin_pending';
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
const TRX_ID_RE = /^[a-f0-9]{40}$/;

/** A pinned chat-pub reference.  All three fields together
 *  identify a unique on-chain op + the pub it carried.  Storing
 *  the pub bytes alongside the reference saves a redundant
 *  indexer fetch on every send (the pinned pub IS the trusted
 *  pub for the (block_num, trx_id) ref). */
export interface ChatPubPin {
	readonly blockNum: number;
	readonly trxId: string;
	/** Base64-encoded 32-byte X25519 pub.  Same encoding the
	 *  indexer returns. */
	readonly pubB64: string;
	/** Keys pinned for this peer BEFORE an accepted key change, newest first
	 *  (at most MAX_PAST_PUBS). They only DECRYPT history the peer sent under
	 *  an older key; a message they open is never authenticated (a key is
	 *  usually replaced because it leaked, so whoever holds it could write
	 *  "from" the peer today). */
	readonly pastPubsB64?: readonly string[];
}

const MAX_PAST_PUBS = 4;

/** Outcome of comparing what the indexer just returned to what
 *  we have pinned.  Drives the caller's response: trust, verify,
 *  or reject. */
export type PinComparison =
	| { kind: 'no_pin' }
	| { kind: 'match' }
	| { kind: 'newer_ref'; oldPin: ChatPubPin; newRef: ChatPubPin }
	| { kind: 'older_ref'; oldPin: ChatPubPin; newRef: ChatPubPin }
	| { kind: 'same_ref_different_pub'; oldPin: ChatPubPin; newRef: ChatPubPin };

type PinMap = Record<string, ChatPubPin>;

function readRaw(key: string = KEY): PinMap {
	return parsePinMap(safeLocal.get(key));
}

/** A stored pin map, validated entry by entry (anything malformed is dropped). */
function parsePinMap(raw: string | null): PinMap {
	if (raw === null) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return {};
		}
		const out: PinMap = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (!ACCOUNT_NAME_RE.test(k)) continue;
			if (typeof v !== 'object' || v === null) continue;
			const r = v as Record<string, unknown>;
			if (typeof r.blockNum !== 'number') continue;
			if (!Number.isFinite(r.blockNum) || r.blockNum < 0) continue;
			if (typeof r.trxId !== 'string' || !TRX_ID_RE.test(r.trxId)) continue;
			if (typeof r.pubB64 !== 'string' || r.pubB64.length === 0) continue;
			const past = Array.isArray(r.pastPubsB64)
				? (r.pastPubsB64 as unknown[])
						.filter((x): x is string => typeof x === 'string' && x.length > 0)
						.slice(0, MAX_PAST_PUBS)
				: [];
			out[k] = {
				blockNum: r.blockNum,
				trxId: r.trxId,
				pubB64: r.pubB64,
				...(past.length > 0 ? { pastPubsB64: past } : {})
			};
		}
		return out;
	} catch {
		return {};
	}
}

function writeRaw(map: PinMap, key: string = KEY): void {
	try {
		safeLocal.set(key, JSON.stringify(map));
	} catch {
		// Quota / private-mode write failures are best-effort.
		// On failure, the next session sees no pins for these
		// peers — same effect as a fresh device.  The user is
		// "downgraded" to TOFU-on-next-fetch, no worse than a
		// session before pinning shipped.
	}
}

/** Read the pin for `peer`, or null if not pinned. */
export function getPin(peer: string): ChatPubPin | null {
	if (!ACCOUNT_NAME_RE.test(peer)) return null;
	return readRaw()[peer] ?? null;
}

/** Write (or overwrite) the pin for `peer`.  Use only after the
 *  caller has either:
 *    - established the pin for the first time (TOFU on first
 *      contact), OR
 *    - seen a newer op for the SAME key, OR
 *    - the user explicitly accepted a changed key
 *      (acceptKeyChange).
 *
 *  Direct callers outside chatService should not exist.  The
 *  pin contract is "what the local user trusts for this peer."
 *  All writes flow through chatService's fetchPeerChatPub dep. */
export function setPin(peer: string, pin: ChatPubPin): void {
	if (!ACCOUNT_NAME_RE.test(peer)) return;
	if (!TRX_ID_RE.test(pin.trxId)) return;
	if (!Number.isFinite(pin.blockNum) || pin.blockNum < 0) return;
	const current = readRaw();
	current[peer] = pin;
	writeRaw(current);
}

/** Compare an incoming reference against the local pin (if any).
 *  Pure: does not mutate storage.  The caller decides what to
 *  do based on the kind:
 *    - 'no_pin'                  → first contact; pin it.
 *    - 'match'                   → trust the pinned pub.
 *    - 'newer_ref'               → verify against chain, then
 *                                  update pin if valid.
 *    - 'older_ref'               → reject; suspicious.
 *    - 'same_ref_different_pub'  → reject; corruption / tamper. */
export function comparePin(peer: string, incoming: ChatPubPin): PinComparison {
	const oldPin = getPin(peer);
	if (oldPin === null) return { kind: 'no_pin' };
	if (oldPin.blockNum === incoming.blockNum && oldPin.trxId === incoming.trxId) {
		if (oldPin.pubB64 !== incoming.pubB64) {
			return { kind: 'same_ref_different_pub', oldPin, newRef: incoming };
		}
		return { kind: 'match' };
	}
	if (incoming.blockNum > oldPin.blockNum) {
		return { kind: 'newer_ref', oldPin, newRef: incoming };
	}
	// incoming.blockNum < oldPin.blockNum, OR equal but different
	// trxId (which means a different op in the same block — highly
	// unusual; treat as suspicious).
	return { kind: 'older_ref', oldPin, newRef: incoming };
}

/** A changed key for `peer` that waits for the user's confirmation, or
 *  null. The Verify-peer panel shows the safety number computed with it, so
 *  the user can compare BEFORE accepting. */
export function pendingKeyChange(peer: string): ChatPubPin | null {
	if (!ACCOUNT_NAME_RE.test(peer)) return null;
	return readRaw(PENDING_KEY)[peer] ?? null;
}

function setPending(peer: string, next: ChatPubPin): void {
	const current = readRaw(PENDING_KEY);
	current[peer] = next;
	writeRaw(current, PENDING_KEY);
}

function clearPending(peer: string): void {
	const current = readRaw(PENDING_KEY);
	if (peer in current) {
		delete current[peer];
		writeRaw(current, PENDING_KEY);
	}
}

/** The user confirmed "safety number changed" for `peer`: the pending key
 *  becomes the pin. Returns false when nothing was pending. */
export function acceptKeyChange(peer: string): boolean {
	const next = pendingKeyChange(peer);
	if (next === null) return false;
	const old = getPin(peer);
	const past =
		old === null
			? []
			: [old.pubB64, ...(old.pastPubsB64 ?? [])]
					.filter((p) => p !== next.pubB64)
					.slice(0, MAX_PAST_PUBS);
	setPin(peer, {
		blockNum: next.blockNum,
		trxId: next.trxId,
		pubB64: next.pubB64,
		...(past.length > 0 ? { pastPubsB64: past } : {})
	});
	clearPending(peer);
	return true;
}

/** The key pinned for `peer` now — the only one a v2 message from this peer
 *  is AUTHENTICATED with. Empty when the peer is not pinned. */
export function pinnedPubsFor(peer: string): string[] {
	const p = getPin(peer);
	return p === null ? [] : [p.pubB64];
}

/** The keys an accepted key change replaced, newest first: they open older
 *  messages (and our self-copies to the peer) for reading only, never as
 *  proof of who sent them. */
export function replacedPubsFor(peer: string): string[] {
	const p = getPin(peer);
	return p === null ? [] : [...(p.pastPubsB64 ?? [])];
}

/** Remove the pin for a single peer.  Used by recovery flows
 *  (e.g. user explicitly accepts a 'older_ref' / 'tampered'
 *  state and wants to re-TOFU).  Not exposed in normal UX. */
export function clearPin(peer: string): void {
	if (!ACCOUNT_NAME_RE.test(peer)) return;
	const current = readRaw();
	if (peer in current) {
		delete current[peer];
		writeRaw(current);
	}
}

/** Wipe every readable pin. Called on Sign Out: the next person on this
 *  browser must not inherit (or read) who this one talked to. Sealed copies
 *  stay: each names nobody, opens only with its own account's posting key, and
 *  is that account's protection against a substituted key — another account
 *  signing out on the same browser must not strip it. */
export function clearAllPins(): void {
	safeLocal.remove(KEY);
	safeLocal.remove(PENDING_KEY);
}

/** Remove the readable pins and pending changes (a sealed copy stays). */
export function dropReadablePins(): void {
	safeLocal.remove(KEY);
	safeLocal.remove(PENDING_KEY);
}

/** The pins of a locked session, encrypted (see the file header): one slot
 *  per account, `<SEALED_PREFIX>.<slot id>`, so one account's Lock never
 *  replaces another's seal. */
export const SEALED_PREFIX = 'morphit.chat.pub_pin_sealed';
const SEAL_INFO = 'morphit-chat-pins-v1/seal';
const SLOT_INFO = 'morphit-chat-pins-v1/slot';
const SEAL_AAD = 'morphit-chat-pins-v1';
const SEAL_NONCE_BYTES = 12;

function sealKey(postingPriv: Uint8Array): Uint8Array {
	return sodium.crypto_generichash(32, new TextEncoder().encode(SEAL_INFO), postingPriv);
}

/** This account's slot: a one-way id from its posting key (it says nothing
 *  about the account, and no other account's key reaches it). */
function sealSlot(postingPriv: Uint8Array): string {
	const id = sodium.crypto_generichash(16, new TextEncoder().encode(SLOT_INFO), postingPriv);
	return `${SEALED_PREFIX}.${sodium.to_hex(id)}`;
}

/**
 * Explicit Lock: take the readable pins off disk NOW (synchronously, so
 * nothing readable outlives the lock) and store them encrypted under a key
 * only the same account's posting key gives. `postingPriv` is copied; the
 * caller may wipe its own copy at once.
 */
export function sealPinsForLock(postingPriv: Uint8Array): Promise<void> {
	const pins = readRaw();
	const pending = readRaw(PENDING_KEY);
	safeLocal.remove(KEY);
	safeLocal.remove(PENDING_KEY);
	if (Object.keys(pins).length === 0 && Object.keys(pending).length === 0) {
		return Promise.resolve();
	}
	const priv = Uint8Array.from(postingPriv);
	const done = (async () => {
		await ensureSodium();
		const key = sealKey(priv);
		const slot = sealSlot(priv);
		try {
			// Keep anything an earlier lock of this account sealed.
			const prior = openSealed(slot, key);
			const nonce = sodium.randombytes_buf(SEAL_NONCE_BYTES);
			const plain = new TextEncoder().encode(
				JSON.stringify({
					pins: { ...(prior?.pins ?? {}), ...pins },
					pending: { ...(prior?.pending ?? {}), ...pending }
				})
			);
			const ct = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
				plain,
				new TextEncoder().encode(SEAL_AAD),
				null,
				nonce,
				key
			);
			const blob = new Uint8Array(nonce.length + ct.length);
			blob.set(nonce, 0);
			blob.set(ct, nonce.length);
			safeLocal.set(slot, sodium.to_base64(blob, sodium.base64_variants.ORIGINAL));
		} finally {
			sodium.memzero(key);
			sodium.memzero(priv);
		}
	})();
	// An unlock that comes before this write lands waits for it.
	sealing = done.catch(() => undefined);
	return done;
}

/** The seal being written, if any (see unsealPins). */
let sealing: Promise<void> = Promise.resolve();

function openSealed(slot: string, key: Uint8Array): { pins: PinMap; pending: PinMap } | null {
	const raw = safeLocal.get(slot);
	if (raw === null) return null;
	try {
		const blob = sodium.from_base64(raw, sodium.base64_variants.ORIGINAL);
		if (blob.length <= SEAL_NONCE_BYTES) return null;
		const plain = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
			null,
			blob.slice(SEAL_NONCE_BYTES),
			new TextEncoder().encode(SEAL_AAD),
			blob.slice(0, SEAL_NONCE_BYTES),
			key
		);
		const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
			pins?: unknown;
			pending?: unknown;
		};
		// Validated exactly like the readable copy.
		return {
			pins: parsePinMap(JSON.stringify(parsed.pins ?? {})),
			pending: parsePinMap(JSON.stringify(parsed.pending ?? {}))
		};
	} catch {
		return null; // damaged: nothing to restore
	}
}

/**
 * Unlock: restore the pins a Lock sealed, when they are this account's.
 * A sealed pin wins over a readable one for the same peer (it is the one
 * the user had before the lock; a different key met since then is then
 * compared against it again). Resolves true when pins were restored.
 * `stillUnlocked` is asked once the crypto is ready: when the session that
 * asked has been locked meanwhile, nothing is restored (the seal stays).
 */
export async function unsealPins(
	postingPriv: Uint8Array,
	stillUnlocked: () => boolean = () => true
): Promise<boolean> {
	await sealing;
	await ensureSodium();
	if (!stillUnlocked()) return false;
	const slot = sealSlot(postingPriv);
	if (safeLocal.get(slot) === null) return false;
	const key = sealKey(postingPriv);
	try {
		const sealed = openSealed(slot, key);
		if (sealed === null) return false;
		writeRaw({ ...readRaw(), ...sealed.pins });
		writeRaw({ ...sealed.pending, ...readRaw(PENDING_KEY) }, PENDING_KEY);
		safeLocal.remove(slot);
		return true;
	} finally {
		sodium.memzero(key);
	}
}

/** For tests / debugging only: list all currently-pinned peers. */
export function __listPinnedPeers(): readonly string[] {
	return Object.keys(readRaw()).sort();
}

// ─── Resolution state machine ────────────────────────────────────

/** Stable error codes thrown by resolveChatPubFromIndexer when
 *  pin/chain checks detect tampering or inconsistency.  Stable so
 *  the UI / FAQ can map each to a specific localized explanation
 *  rather than rendering a free-form English string. */
export const PUB_PIN_ERROR = {
	tampered_same_ref: 'pub_pin_tampered_same_ref',
	older_indexer_ref: 'pub_pin_older_indexer_ref',
	chain_reports_none: 'pub_pin_chain_reports_none',
	chain_older_than_pin: 'pub_pin_chain_older_than_pin',
	malformed_indexer_response: 'pub_pin_malformed_indexer_response',
	/** The peer's key changed. Not an error the user can do nothing about:
	 *  they compare the new safety number and accept it (acceptKeyChange). */
	key_changed: 'pub_pin_key_changed'
} as const;
export type PubPinErrorCode = (typeof PUB_PIN_ERROR)[keyof typeof PUB_PIN_ERROR];

/** Error thrown by resolveChatPubFromIndexer on tamper detection.
 *  `code` is a stable identifier (above); `peer` is the peer the
 *  failure relates to.  The message is best-effort English and
 *  not user-facing — UIs map `code` to localized copy. */
export class PubPinError extends Error {
	readonly code: PubPinErrorCode;
	readonly peer: string;
	constructor(code: PubPinErrorCode, peer: string, message: string) {
		super(message);
		this.code = code;
		this.peer = peer;
		this.name = 'PubPinError';
	}
}

/** Minimal shape of "what the chain says is the latest
 *  chat-identity for an account."  Mirrors ChainChatIdentity in
 *  chainVerify.ts but redeclared here to keep this module
 *  free of Blurt-RPC dependencies. */
export interface ChainPubResult {
	readonly chatPubB64: string;
	readonly blockNum: number;
	readonly trxId: string;
}

/**
 * Resolve a peer's chat_pub against the local pin and (if
 * needed) the chain.  Pure-ish: mutates pin storage on the
 * happy paths; throws PubPinError on detected tampering /
 * inconsistency.
 *
 * Inputs:
 *   - `peer`            : the peer account name.
 *   - `indexerPin`      : what the indexer just returned, packaged
 *                         as a ChatPubPin candidate.
 *   - `verifyOnChain`   : function returning the chain-authoritative
 *                         ChainPubResult (or null if the chain has
 *                         no record).  Receives the peer AND the
 *                         indexer's claimed reference so it can
 *                         chase that exact op (O(1)) rather than
 *                         re-deriving "the latest" from a bounded,
 *                         witness-defeating history window.  Called
 *                         on the 'no_pin' and 'newer_ref' branches.
 *
 * Returns: the base64-encoded pub the caller should encrypt to.
 * Throws: PubPinError on any tamper signal; the underlying
 * Error from verifyOnChain if that throws.
 */
export async function resolveChatPubFromIndexer(
	peer: string,
	indexerPin: ChatPubPin,
	verifyOnChain: (peer: string, claimedRef: ChatPubPin) => Promise<ChainPubResult | null>
): Promise<string> {
	// Validate the incoming pin shape before letting it flow into
	// the state machine.  The TS types claim these fields are
	// well-formed, but a misbehaving / older server could still
	// return junk at runtime — defending here is cheap insurance
	// against an undefined comparison anomaly downstream.
	if (
		!ACCOUNT_NAME_RE.test(peer) ||
		typeof indexerPin.trxId !== 'string' ||
		!TRX_ID_RE.test(indexerPin.trxId) ||
		typeof indexerPin.blockNum !== 'number' ||
		!Number.isFinite(indexerPin.blockNum) ||
		indexerPin.blockNum < 0 ||
		typeof indexerPin.pubB64 !== 'string' ||
		indexerPin.pubB64.length === 0
	) {
		throw new PubPinError(
			PUB_PIN_ERROR.malformed_indexer_response,
			peer,
			`indexer returned a malformed chat-identity row for @${peer}`
		);
	}

	// The pins a Lock sealed are compared against too: wait for this unlock's
	// unseal before deciding anything is a first contact.
	await unsealSettled();
	const cmp = comparePin(peer, indexerPin);

	switch (cmp.kind) {
		case 'no_pin': {
			// Audit 2026-05 finding 2-9: TOFU previously trusted the
			// indexer outright on first contact.  A hostile indexer
			// could substitute the pub on first fetch and win
			// permanently (subsequent fetches match the now-pinned
			// hostile pub).  Now: verify with the chain quorum
			// before pinning.
			const chain = await verifyOnChain(peer, indexerPin);
			if (chain === null) {
				throw new PubPinError(
					PUB_PIN_ERROR.chain_reports_none,
					peer,
					`indexer claims a chat-identity for @${peer} but the chain reports none`
				);
			}
			// Compare the indexer's claim to the chain's view; if
			// they differ, the indexer is lying.  Chain wins either
			// way; pin the chain's triple.
			const chainPin: ChatPubPin = {
				blockNum: chain.blockNum,
				trxId: chain.trxId,
				pubB64: chain.chatPubB64
			};
			setPin(peer, chainPin);
			return chainPin.pubB64;
		}
		case 'match': {
			// Indexer agrees with what we have pinned.  Trust the
			// pinned pub — the indexer didn't tell us anything new.
			return indexerPin.pubB64;
		}
		case 'same_ref_different_pub': {
			// Indexer claims the same on-chain op that established
			// the pinned pub, but the pub bytes are different.
			// This can only happen if the indexer mutated stored
			// data behind the reference — i.e. tampering.  Reject
			// hard.
			throw new PubPinError(
				PUB_PIN_ERROR.tampered_same_ref,
				peer,
				`indexer returned tampered chat-identity row for @${peer}; ` +
					'pinned ref matches but pub bytes differ'
			);
		}
		case 'older_ref': {
			// Indexer reports an op earlier than the one we pinned.
			// Forward-only chain shouldn't roll back; treat as
			// suspicious.
			throw new PubPinError(
				PUB_PIN_ERROR.older_indexer_ref,
				peer,
				`indexer returned an older chat-identity reference than the pinned one for @${peer}: ` +
					`pinned ${cmp.oldPin.blockNum}/${cmp.oldPin.trxId.slice(0, 8)}, ` +
					`indexer ${cmp.newRef.blockNum}/${cmp.newRef.trxId.slice(0, 8)}`
			);
		}
		case 'newer_ref': {
			// Indexer reports a NEWER op than the one we pinned.  Check
			// the op (through the relay — see the file header for why
			// that check alone may not move a changed key).
			const chain = await verifyOnChain(peer, indexerPin);
			if (chain === null) {
				throw new PubPinError(
					PUB_PIN_ERROR.chain_reports_none,
					peer,
					`indexer claims a chat-identity for @${peer} but the chain reports none`
				);
			}
			if (chain.blockNum < cmp.oldPin.blockNum) {
				throw new PubPinError(
					PUB_PIN_ERROR.chain_older_than_pin,
					peer,
					`chain reports an older chat-identity than the pinned one for @${peer}`
				);
			}
			const verifiedPin: ChatPubPin = {
				blockNum: chain.blockNum,
				trxId: chain.trxId,
				pubB64: chain.chatPubB64
			};
			// Same key, newer op (the identity was republished): nothing the
			// user would see changes, so the pin follows.
			if (verifiedPin.pubB64 === cmp.oldPin.pubB64) {
				setPin(peer, {
					...verifiedPin,
					...(cmp.oldPin.pastPubsB64 ? { pastPubsB64: cmp.oldPin.pastPubsB64 } : {})
				});
				clearPending(peer);
				return verifiedPin.pubB64;
			}
			// A DIFFERENT key. Hold it until the user confirms; until then
			// nothing is encrypted to it.
			setPending(peer, verifiedPin);
			throw new PubPinError(
				PUB_PIN_ERROR.key_changed,
				peer,
				`@${peer}'s chat key changed; waiting for the user to confirm the new safety number`
			);
		}
	}
}
