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
 *   - Newer ref:          legitimate-looking key rotation.  The
 *                         caller must verify the new op against a
 *                         Blurt RPC (see chainVerify.ts) before
 *                         updating the pin.
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
 * chatted with?").  runExplicitLockExtras() must wipe this key.
 * That wiring lives in explicitLock.ts; see clearAllPins() below.
 */

import { safeLocal } from '$utils/safeStorage';

const KEY = 'morphit.chat.pub_pins';
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;
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
}

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

function readRaw(): PinMap {
	const raw = safeLocal.get(KEY);
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
			out[k] = {
				blockNum: r.blockNum,
				trxId: r.trxId,
				pubB64: r.pubB64
			};
		}
		return out;
	} catch {
		return {};
	}
}

function writeRaw(map: PinMap): void {
	try {
		safeLocal.set(KEY, JSON.stringify(map));
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
 *    - successfully verified the new op against a Blurt RPC
 *      and the user has implicitly accepted the rotation.
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

/** Wipe every pin.  Called by runExplicitLockExtras() — the
 *  pinned-peers set is privacy-sensitive metadata about who the
 *  user has been talking to. */
export function clearAllPins(): void {
	safeLocal.remove(KEY);
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
	malformed_indexer_response: 'pub_pin_malformed_indexer_response'
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
 *                         no record).  Called only on the
 *                         'newer_ref' branch — i.e. when the
 *                         indexer indicates a key rotation.
 *
 * Returns: the base64-encoded pub the caller should encrypt to.
 * Throws: PubPinError on any tamper signal; the underlying
 * Error from verifyOnChain if that throws.
 */
export async function resolveChatPubFromIndexer(
	peer: string,
	indexerPin: ChatPubPin,
	verifyOnChain: (peer: string) => Promise<ChainPubResult | null>
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

	const cmp = comparePin(peer, indexerPin);

	switch (cmp.kind) {
		case 'no_pin': {
			// Audit 2026-05 finding 2-9: TOFU previously trusted the
			// indexer outright on first contact.  A hostile indexer
			// could substitute the pub on first fetch and win
			// permanently (subsequent fetches match the now-pinned
			// hostile pub).  Now: verify with the chain quorum
			// before pinning.
			const chain = await verifyOnChain(peer);
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
			// Indexer reports a NEWER op than the one we pinned —
			// looks like a legitimate posting-key rotation.  Don't
			// take the indexer's word; go to the chain.
			const chain = await verifyOnChain(peer);
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
			// Chain has an op ≥ our pin.  Trust whatever the chain
			// says is current — that's the authoritative source.
			// Update pin to the chain's view (which may or may not
			// match the indexer's claim; the chain wins either way).
			const verifiedPin: ChatPubPin = {
				blockNum: chain.blockNum,
				trxId: chain.trxId,
				pubB64: chain.chatPubB64
			};
			setPin(peer, verifiedPin);
			return verifiedPin.pubB64;
		}
	}
}
