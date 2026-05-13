/**
 * Morphit — desktop-pairing crypto primitives (ADR-0022).
 *
 * Implements the QR-based desktop pairing protocol where a phone
 * (which holds the user's posting key) signs a one-time pairing
 * bundle for a desktop browser (which holds only an ephemeral
 * X25519 keypair).  Same primitives as chat/crypto.ts: X25519 key
 * agreement, BLAKE2b key derivation, ChaCha20-Poly1305 IETF AEAD
 * for the symmetric leg.  No new dependencies.
 *
 * ─── The flow in one paragraph ──────────────────────────────────
 *
 * Desktop generates ephemeral X25519 keypair (`epk_priv`,
 * `epk_pub`) and a 16-byte nonce.  Computes
 * `pid = SHA-256(epk_pub || nonce)`.  Encodes
 * `{v, pid, epk_pub, origin, exp, relay}` as a base64url QR.
 * Phone scans, validates, prompts user for confirmation, then
 * builds a `bundle = {v, pid, epk_echo, origin_echo, account,
 * account_chat_pubkey, signed_at, device_label}` and signs it
 * with the posting key.  Phone generates its own ephemeral X25519
 * keypair, derives a shared secret with `epk_pub`, derives a
 * domain-separated AEAD key via BLAKE2b, encrypts the
 * `{bundle, signature}` envelope with ChaCha20-Poly1305 (AAD =
 * pid bytes), and POSTs the resulting `delivery_payload` to the
 * relay.  Relay shuttles ciphertext to the desktop's SSE waiter.
 * Desktop decrypts, verifies signature against the on-chain
 * posting pubkey, validates echo-fields, accepts session.
 *
 * ─── Security properties ────────────────────────────────────────
 *
 * Provides:
 *   - The desktop only ever holds an EPHEMERAL key.  Posting key
 *     never leaves the phone.
 *   - The signed bundle binds the desktop's epk_pub and the
 *     origin URL — a relay shuffling bundles to wrong desktops or
 *     wrong origins fails the echo-check on the desktop side.
 *   - Replay defense via signed_at freshness window + single-shot
 *     pid + QR exp.
 *   - Cipertext is opaque to the relay (encrypted to the
 *     desktop's epk_pub, AAD-bound to the pid).
 *
 * Does NOT provide (per ADR-0022 — accepted tradeoffs):
 *   - Anti-phishing of the QR initiator URL beyond the user
 *     reading the origin shown in the confirmation card.  If the
 *     user trains themselves to tap "Yes" without checking, no
 *     protocol can save them.
 *   - Forward secrecy if the desktop's session credential is
 *     stolen by malware on the desktop AFTER pairing.  Same as
 *     any login system.
 *
 * ─── Implementation notes ──────────────────────────────────────
 *
 * - All primitives from libsodium-wrappers-sumo (existing dep).
 * - This module is PURE: no DOM, no fetch, no Svelte.  All I/O
 *   (camera, network, chain RPC) lives in the caller.  Direct
 *   testability from tsx without browser harness is the goal.
 * - The signing function is generic: `bundleSigner(canonicalBytes)
 *   => Uint8Array` is supplied by the caller.  This lets the
 *   module work with either an in-memory posting key or a
 *   YubiKey-backed signer without importing those modules.
 * - BLAKE2b key derivation uses domain separation
 *   `morphit-pairing-v1/aead-key` so the pairing AEAD key can
 *   never collide with the chat AEAD key, the release-trust-anchor
 *   key, or any other key derived from BLAKE2b in this codebase.
 */

import sodium from 'libsodium-wrappers-sumo';

// ─── Constants ──────────────────────────────────────────────────

/** Protocol version.  Phone and desktop must match. */
export const PAIRING_PROTOCOL_VERSION = 1;

/** QR is rejected if exp is more than this many seconds in the
 *  future at scan time.  Caps an attacker showing a 10-minute-old
 *  screenshot of someone's QR to a phone on a fresh schedule. */
export const QR_MAX_AGE_FUTURE_SECONDS = 5 * 60;

/** Bundle's signed_at must be within this window of the desktop's
 *  clock at verification time.  +30s tolerance for forward clock
 *  skew on the phone, -120s for plausible phone→relay→desktop hop
 *  delay. */
export const BUNDLE_FRESHNESS_PAST_SECONDS = 120;
export const BUNDLE_FRESHNESS_FUTURE_SECONDS = 30;

/** Domain-separation tags.  These collide with NOTHING else
 *  derived from BLAKE2b in this codebase (chat uses different
 *  tags; release-trust-anchor uses different tags).  If a future
 *  module wants to derive from the same input material, it MUST
 *  pick a tag that's neither these strings nor a prefix of them. */
const AEAD_KEY_INFO = 'morphit-pairing-v1/aead-key';

/** Signing-message domain prefix.  The phone signs
 *  SHA-256(SIGNING_DOMAIN_PREFIX || canonical_json_bundle_bytes).
 *  The desktop verifier hashes with the same prefix.  This
 *  domain-separates pairing signatures from chain-transaction
 *  signatures (which use chain_id || tx_bytes), so a signature
 *  captured from a pairing flow can NEVER be replayed as a
 *  chain transaction signature, and vice versa.
 *
 *  The trailing newline is intentional — it keeps the prefix a
 *  fixed-length string that can't be confused with a JSON
 *  structure (the canonical JSON always begins with `{`). */
export const SIGNING_DOMAIN_PREFIX = 'morphit-pairing-v1\n';

/** Compute the message digest the phone signs / the desktop
 *  verifies.  Pure helper; exported so tests can exercise the
 *  contract without going through the signer/verifier. */
export async function computeBundleSigningDigest(
	canonicalBundleBytes: Uint8Array
): Promise<Uint8Array> {
	await ensureSodium();
	const prefix = enc.encode(SIGNING_DOMAIN_PREFIX);
	const buf = new Uint8Array(prefix.length + canonicalBundleBytes.length);
	buf.set(prefix, 0);
	buf.set(canonicalBundleBytes, prefix.length);
	return sodium.crypto_hash_sha256(buf);
}

const enc = new TextEncoder();

// ─── sodium bootstrap ───────────────────────────────────────────

let sodiumReady: Promise<void> | null = null;
async function ensureSodium(): Promise<void> {
	const ready = sodiumReady ?? (sodiumReady = sodium.ready);
	return ready;
}

// ─── Types ──────────────────────────────────────────────────────

/** Wire shape of the QR payload (desktop → QR → phone).  Encoded
 *  as a single base64url JSON string in the QR. */
export interface PairingQrPayload {
	readonly v: 1;
	/** Pairing ID — 64 hex chars (SHA-256 output, lowercase). */
	readonly pid: string;
	/** Desktop's ephemeral X25519 pubkey, base64-encoded (44 chars
	 *  with standard padding for 32-byte input). */
	readonly epk: string;
	/** Origin the user is trying to log into.  Phone shows this
	 *  faithfully on the confirmation card. */
	readonly origin: string;
	/** Unix-seconds expiry.  Capped at +5min from generation. */
	readonly exp: number;
	/** Relay URL the phone POSTs to.  Lets a federated user route
	 *  through the operator the desktop is sitting on. */
	readonly relay: string;
}

/** Inner bundle the phone builds.  This is what the posting key
 *  signs.  Echo fields (`epk_echo`, `origin_echo`) bind the
 *  signature to the SPECIFIC pairing request — a relay shuffling
 *  bundles between pids fails the desktop-side echo-check. */
export interface PairingBundle {
	readonly v: 1;
	readonly pid: string;
	readonly epk_echo: string;
	readonly origin_echo: string;
	readonly account: string;
	readonly account_chat_pubkey: string;
	readonly signed_at: number;
	readonly device_label: string;
}

/** Outer envelope the phone signs and encrypts.  Posting-key
 *  signature wraps the JSON-canonicalized bundle bytes. */
export interface PairingEnvelope {
	readonly bundle: PairingBundle;
	/** Hex-encoded posting-key signature over the canonical JSON
	 *  serialization of `bundle`.  The recipient verifies against
	 *  the on-chain posting pubkey of `bundle.account`. */
	readonly signature: string;
}

/** Wire shape of the delivery payload (phone → relay → desktop).
 *  All bytes are base64-encoded for JSON transport. */
export interface DeliveryPayload {
	readonly v: 1;
	readonly pid: string;
	readonly ephemeral_pub: string; // base64 — 32-byte X25519
	readonly nonce: string; // base64 — 12-byte ChaCha20 nonce
	readonly ciphertext: string; // base64 — sealed envelope + 16-byte tag
}

/** Reasons a QR payload can be rejected by the phone before any
 *  user interaction.  Used to surface a generic "this isn't a
 *  valid Morphit login QR" error without hinting which gate
 *  failed (gates are public knowledge but error-channel
 *  exfiltration is bad form). */
export type QrValidationReject =
	| { kind: 'malformed_json' }
	| { kind: 'wrong_version'; got: unknown }
	| { kind: 'bad_pid' }
	| { kind: 'bad_epk' }
	| { kind: 'bad_origin' }
	| { kind: 'bad_relay' }
	| { kind: 'expired' }
	| { kind: 'exp_too_far_future' };

export type QrValidationResult =
	| { kind: 'ok'; payload: PairingQrPayload }
	| { kind: 'reject'; reason: QrValidationReject };

/** Reasons the desktop can reject a delivered bundle after
 *  decryption.  Same generic-message-to-user posture as
 *  QrValidationReject. */
export type BundleVerifyReject =
	| { kind: 'pid_mismatch' }
	| { kind: 'epk_echo_mismatch' }
	| { kind: 'origin_echo_mismatch' }
	| { kind: 'signed_at_too_old' }
	| { kind: 'signed_at_too_future' }
	| { kind: 'wrong_version' }
	| { kind: 'malformed_bundle' }
	| { kind: 'malformed_signature' }
	| { kind: 'signature_invalid' };

export type BundleVerifyResult =
	| { kind: 'ok'; envelope: PairingEnvelope }
	| { kind: 'reject'; reason: BundleVerifyReject };

// ─── Base64 helpers (mirrors chat/crypto.ts conventions) ────────

function fromBase64(s: string): Uint8Array {
	return sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
}

function toBase64(b: Uint8Array): string {
	return sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
}

function fromBase64UrlNoPad(s: string): Uint8Array {
	return sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function toBase64UrlNoPad(b: Uint8Array): string {
	return sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function toHex(b: Uint8Array): string {
	let out = '';
	for (let i = 0; i < b.length; i++) {
		out += (b[i]! >> 4).toString(16) + (b[i]! & 0xf).toString(16);
	}
	return out;
}

function fromHex(s: string): Uint8Array {
	if (s.length % 2 !== 0) throw new Error('hex: odd length');
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) {
		const hi = parseInt(s[i * 2]!, 16);
		const lo = parseInt(s[i * 2 + 1]!, 16);
		if (Number.isNaN(hi) || Number.isNaN(lo)) {
			throw new Error('hex: non-hex char');
		}
		out[i] = (hi << 4) | lo;
	}
	return out;
}

// ─── Canonical JSON ─────────────────────────────────────────────

/** Stable JSON serialization with sorted keys.  This is what
 *  gets signed.  Both signer and verifier MUST use this exact
 *  serialization or signatures won't verify across runtimes that
 *  produce different key orderings.  Implemented by hand instead
 *  of relying on the JS engine's iteration order because the spec
 *  guarantees insertion order, not lexicographic. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) {
		return '[' + value.map(canonicalJson).join(',') + ']';
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const parts: string[] = [];
	for (const k of keys) {
		parts.push(JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]));
	}
	return '{' + parts.join(',') + '}';
}

// ─── Pairing-ID derivation ──────────────────────────────────────

/** Compute the pairing ID from the desktop's epk_pub + nonce.
 *  Deterministic — same inputs always produce the same pid.
 *  Output is 64 lowercase hex chars (SHA-256 output). */
export async function derivePairingId(epkPub: Uint8Array, nonce: Uint8Array): Promise<string> {
	await ensureSodium();
	if (epkPub.length !== 32) {
		throw new Error(`pairing: epk_pub must be 32 bytes, got ${epkPub.length}`);
	}
	if (nonce.length !== 16) {
		throw new Error(`pairing: nonce must be 16 bytes, got ${nonce.length}`);
	}
	const concat = new Uint8Array(48);
	concat.set(epkPub, 0);
	concat.set(nonce, 32);
	const hash = sodium.crypto_hash_sha256(concat);
	return toHex(hash);
}

// ─── QR payload construction (desktop side) ─────────────────────

/** Generate a fresh ephemeral X25519 keypair for a pairing
 *  attempt.  Caller is responsible for wiping the private half
 *  when the session ends or pairing fails.  Returns base64-
 *  encoded values for direct use in the QR payload. */
export async function generateDesktopEphemeralKeys(): Promise<{
	readonly epk_priv: Uint8Array;
	readonly epk_pub: Uint8Array;
}> {
	await ensureSodium();
	// Match the chat/crypto.ts pattern: random 32-byte scalar +
	// scalar-base multiplication.  This is what the rest of the
	// codebase uses; staying consistent avoids divergence in how
	// X25519 keypairs are produced.
	const epk_priv = sodium.randombytes_buf(32);
	const epk_pub = sodium.crypto_scalarmult_base(epk_priv);
	return { epk_priv, epk_pub };
}

/** Build the QR payload for a fresh pairing attempt.  Caller
 *  passes in the origin URL (typically `window.location.origin`)
 *  and the relay URL (the operator the user is logging into).
 *
 *  Returns the JSON payload AND the base64url-encoded compact
 *  form suitable for embedding in a QR.  The two encodings carry
 *  the same data; the wire form is what the QR contains. */
export async function buildQrPayload(args: {
	readonly epk_pub: Uint8Array;
	readonly origin: string;
	readonly relay: string;
	readonly nowSeconds: number;
	readonly ttlSeconds?: number; // default = QR_MAX_AGE_FUTURE_SECONDS
}): Promise<{
	readonly payload: PairingQrPayload;
	readonly compactWire: string;
	readonly nonce: Uint8Array;
}> {
	await ensureSodium();
	const ttl = args.ttlSeconds ?? QR_MAX_AGE_FUTURE_SECONDS;
	if (ttl <= 0 || ttl > QR_MAX_AGE_FUTURE_SECONDS) {
		throw new Error(`pairing: ttl out of range`);
	}
	const nonce = sodium.randombytes_buf(16);
	const pid = await derivePairingId(args.epk_pub, nonce);
	const payload: PairingQrPayload = {
		v: PAIRING_PROTOCOL_VERSION,
		pid,
		epk: toBase64(args.epk_pub),
		origin: args.origin,
		exp: args.nowSeconds + ttl,
		relay: args.relay
	};
	// Compact wire: canonical JSON → bytes → base64url-no-pad.
	// The phone reverses this on scan.
	const json = canonicalJson(payload);
	const compactWire = toBase64UrlNoPad(enc.encode(json));
	return { payload, compactWire, nonce };
}

// ─── QR payload validation (phone side) ─────────────────────────

/** Phone-side: parse and validate the wire form before showing
 *  the user any confirmation card.  Returns either the validated
 *  payload or a structured rejection reason.  Caller maps any
 *  rejection to a single user-facing error message — do NOT
 *  branch user-visible copy on the rejection kind, just log it
 *  for debugging. */
export function validateQrWireForm(compactWire: string, nowSeconds: number): QrValidationResult {
	let json: string;
	let parsed: unknown;
	try {
		const bytes = fromBase64UrlNoPad(compactWire);
		json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		parsed = JSON.parse(json);
	} catch {
		return { kind: 'reject', reason: { kind: 'malformed_json' } };
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return { kind: 'reject', reason: { kind: 'malformed_json' } };
	}
	const p = parsed as Record<string, unknown>;
	if (p.v !== PAIRING_PROTOCOL_VERSION) {
		return { kind: 'reject', reason: { kind: 'wrong_version', got: p.v } };
	}
	if (typeof p.pid !== 'string' || !/^[0-9a-f]{64}$/.test(p.pid)) {
		return { kind: 'reject', reason: { kind: 'bad_pid' } };
	}
	if (typeof p.epk !== 'string') {
		return { kind: 'reject', reason: { kind: 'bad_epk' } };
	}
	try {
		const epkBytes = fromBase64(p.epk);
		if (epkBytes.length !== 32) {
			return { kind: 'reject', reason: { kind: 'bad_epk' } };
		}
	} catch {
		return { kind: 'reject', reason: { kind: 'bad_epk' } };
	}
	if (typeof p.origin !== 'string' || !isValidHttpsUrl(p.origin)) {
		return { kind: 'reject', reason: { kind: 'bad_origin' } };
	}
	if (typeof p.relay !== 'string' || !isValidHttpsUrl(p.relay)) {
		return { kind: 'reject', reason: { kind: 'bad_relay' } };
	}
	if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) {
		return { kind: 'reject', reason: { kind: 'expired' } };
	}
	if (p.exp <= nowSeconds) {
		return { kind: 'reject', reason: { kind: 'expired' } };
	}
	if (p.exp - nowSeconds > QR_MAX_AGE_FUTURE_SECONDS) {
		return { kind: 'reject', reason: { kind: 'exp_too_far_future' } };
	}
	return {
		kind: 'ok',
		payload: {
			v: 1,
			pid: p.pid,
			epk: p.epk,
			origin: p.origin,
			exp: p.exp,
			relay: p.relay
		}
	};
}

function isValidHttpsUrl(s: string): boolean {
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:') return false;
	if (!u.host) return false;
	return true;
}

// ─── Phone-side: build & sign & encrypt ─────────────────────────

/** Build the inner pairing bundle.  Caller fills in the user's
 *  account name, the chat-identity pubkey for that account, and
 *  a short device label (≤32 ASCII chars).  Echo fields are taken
 *  from the validated QR payload — phone faithfully reflects what
 *  it scanned, so the desktop can verify echo-against-self. */
export function buildPairingBundle(args: {
	readonly qr: PairingQrPayload;
	readonly account: string;
	readonly accountChatPubkey: string;
	readonly nowSeconds: number;
	readonly deviceLabel: string;
}): PairingBundle {
	if (args.account.length === 0 || args.account.length > 64) {
		throw new Error('pairing: account name length invalid');
	}
	if (args.deviceLabel.length > 32) {
		throw new Error('pairing: device label too long (max 32)');
	}
	if (!/^[\x20-\x7e]*$/.test(args.deviceLabel)) {
		throw new Error('pairing: device label must be ASCII printable');
	}
	return {
		v: PAIRING_PROTOCOL_VERSION,
		pid: args.qr.pid,
		epk_echo: args.qr.epk,
		origin_echo: args.qr.origin,
		account: args.account,
		account_chat_pubkey: args.accountChatPubkey,
		signed_at: args.nowSeconds,
		device_label: args.deviceLabel
	};
}

/** Caller-supplied signing function.  Given the canonical-JSON
 *  bytes of a bundle, return the signature bytes.  Implementation
 *  is a posting-key sign in production (in-memory key or YubiKey-
 *  backed); tests inject a stub. */
export type BundleSigner = (canonicalBytes: Uint8Array) => Promise<Uint8Array>;

/** Phone-side: sign the bundle, then encrypt the
 *  {bundle, signature} envelope to the desktop's epk_pub.
 *  Returns the wire-shape DeliveryPayload ready to POST.
 *
 *  Steps:
 *    1. Canonical-JSON-serialize the bundle, sign with caller-
 *       supplied signer.
 *    2. Generate a fresh ephemeral X25519 keypair on the phone
 *       side (we don't reuse the long-term chat keys; pairing
 *       is a separate cryptographic context).
 *    3. Compute the X25519 shared secret with the desktop's
 *       epk_pub.
 *    4. Derive a 32-byte AEAD key via BLAKE2b with domain-
 *       separated info string.
 *    5. Generate a fresh 12-byte nonce, encrypt the envelope
 *       with ChaCha20-Poly1305-IETF.  AAD = pid hex bytes.
 *    6. Wipe the phone-side ephemeral private and the AEAD key.
 *    7. Return the DeliveryPayload. */
export async function buildDeliveryPayload(args: {
	readonly bundle: PairingBundle;
	readonly signer: BundleSigner;
	readonly desktopEpkPub: Uint8Array;
}): Promise<DeliveryPayload> {
	await ensureSodium();
	if (args.desktopEpkPub.length !== 32) {
		throw new Error('pairing: desktopEpkPub must be 32 bytes');
	}
	// Step 1: canonical-JSON + sign.
	const canonical = enc.encode(canonicalJson(args.bundle));
	const signature = await args.signer(canonical);
	const envelope: PairingEnvelope = {
		bundle: args.bundle,
		signature: toHex(signature)
	};
	const envelopeBytes = enc.encode(canonicalJson(envelope));

	// Step 2-4: ephemeral keypair, X25519, BLAKE2b key derivation.
	// Same pattern as chat/crypto.ts to stay consistent with the
	// rest of the codebase.
	const phoneEphemeralPriv = sodium.randombytes_buf(32);
	const phoneEphemeralPub = sodium.crypto_scalarmult_base(phoneEphemeralPriv);
	const sharedSecret = sodium.crypto_scalarmult(phoneEphemeralPriv, args.desktopEpkPub);
	// 32-byte AEAD key, derived with domain-separated info string
	// so this key cannot collide with any other BLAKE2b-derived
	// key in the codebase.
	const aeadKey = sodium.crypto_generichash(32, sharedSecret, enc.encode(AEAD_KEY_INFO));
	// Wipe the shared secret as soon as we've derived the AEAD key.
	sodium.memzero(sharedSecret);

	// Step 5: encrypt with ChaCha20-Poly1305 IETF, AAD = pid bytes.
	const nonce = sodium.randombytes_buf(12);
	const aad = enc.encode(args.bundle.pid);
	const ciphertext = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
		envelopeBytes,
		aad,
		null, // nsec — unused in this construction
		nonce,
		aeadKey
	);

	// Step 6: wipe sensitive buffers.
	sodium.memzero(phoneEphemeralPriv);
	sodium.memzero(aeadKey);

	// Step 7: package.
	return {
		v: PAIRING_PROTOCOL_VERSION,
		pid: args.bundle.pid,
		ephemeral_pub: toBase64(phoneEphemeralPub),
		nonce: toBase64(nonce),
		ciphertext: toBase64(ciphertext)
	};
}

// ─── Desktop-side: decrypt, verify, accept ──────────────────────

/** Caller-supplied signature verifier.  Given the canonical-JSON
 *  bytes of a bundle, the signature, and the account name,
 *  return true if the signature verifies against the on-chain
 *  posting pubkey of `account`.  In production this fetches the
 *  pubkey via the existing chain-rotation logic; tests inject
 *  a stub. */
export type SignatureVerifier = (
	account: string,
	canonicalBytes: Uint8Array,
	signatureBytes: Uint8Array
) => Promise<boolean>;

/** Desktop-side: decrypt the delivery payload with the desktop's
 *  ephemeral private key, then verify the inner signature
 *  against the on-chain posting pubkey.  Returns the validated
 *  envelope or a structured rejection.
 *
 *  The caller MUST pass:
 *    - desktopEpkPriv: the private half of the ephemeral keypair
 *      that produced the QR's epk field.  Wiped by this function
 *      via sodium.memzero before return — the caller's reference
 *      becomes a zero-buffer (defense against later leaks).
 *    - desktopEpkPub: the public half (used for echo-check on the
 *      bundle's `epk_echo` field).
 *    - desktopOrigin: window.location.origin at verification time
 *      (used for echo-check on the bundle's `origin_echo` field).
 *    - expectedPid: the pid this desktop is waiting for. */
export async function verifyDeliveryPayload(args: {
	readonly delivery: DeliveryPayload;
	readonly desktopEpkPriv: Uint8Array;
	readonly desktopEpkPub: Uint8Array;
	readonly desktopOrigin: string;
	readonly expectedPid: string;
	readonly nowSeconds: number;
	readonly verifier: SignatureVerifier;
}): Promise<BundleVerifyResult> {
	await ensureSodium();

	// Cheap validation gates first — version, pid, basic shapes.
	if (args.delivery.v !== PAIRING_PROTOCOL_VERSION) {
		return { kind: 'reject', reason: { kind: 'wrong_version' } };
	}
	if (args.delivery.pid !== args.expectedPid) {
		return { kind: 'reject', reason: { kind: 'pid_mismatch' } };
	}

	// Decrypt.
	let envelopeBytes: Uint8Array;
	try {
		const ephemeralPub = fromBase64(args.delivery.ephemeral_pub);
		const nonce = fromBase64(args.delivery.nonce);
		const ciphertext = fromBase64(args.delivery.ciphertext);
		if (ephemeralPub.length !== 32 || nonce.length !== 12) {
			return { kind: 'reject', reason: { kind: 'malformed_bundle' } };
		}
		const sharedSecret = sodium.crypto_scalarmult(args.desktopEpkPriv, ephemeralPub);
		const aeadKey = sodium.crypto_generichash(32, sharedSecret, enc.encode(AEAD_KEY_INFO));
		sodium.memzero(sharedSecret);
		const aad = enc.encode(args.expectedPid);
		envelopeBytes = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
			null, // nsec — unused
			ciphertext,
			aad,
			nonce,
			aeadKey
		);
		sodium.memzero(aeadKey);
	} catch {
		return { kind: 'reject', reason: { kind: 'malformed_bundle' } };
	} finally {
		// Wipe the desktop's ephemeral priv regardless of
		// success/failure — single-use only.
		sodium.memzero(args.desktopEpkPriv);
	}

	// Parse envelope.
	let envelope: PairingEnvelope;
	try {
		const parsed = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(envelopeBytes)
		) as unknown;
		if (typeof parsed !== 'object' || parsed === null) {
			return { kind: 'reject', reason: { kind: 'malformed_bundle' } };
		}
		const p = parsed as Record<string, unknown>;
		if (typeof p.bundle !== 'object' || p.bundle === null) {
			return { kind: 'reject', reason: { kind: 'malformed_bundle' } };
		}
		if (typeof p.signature !== 'string' || !/^[0-9a-f]+$/.test(p.signature)) {
			return { kind: 'reject', reason: { kind: 'malformed_signature' } };
		}
		const b = p.bundle as Record<string, unknown>;
		if (
			b.v !== PAIRING_PROTOCOL_VERSION ||
			typeof b.pid !== 'string' ||
			typeof b.epk_echo !== 'string' ||
			typeof b.origin_echo !== 'string' ||
			typeof b.account !== 'string' ||
			typeof b.account_chat_pubkey !== 'string' ||
			typeof b.signed_at !== 'number' ||
			typeof b.device_label !== 'string'
		) {
			return { kind: 'reject', reason: { kind: 'malformed_bundle' } };
		}
		envelope = {
			bundle: {
				v: 1,
				pid: b.pid,
				epk_echo: b.epk_echo,
				origin_echo: b.origin_echo,
				account: b.account,
				account_chat_pubkey: b.account_chat_pubkey,
				signed_at: b.signed_at,
				device_label: b.device_label
			},
			signature: p.signature
		};
	} catch {
		return { kind: 'reject', reason: { kind: 'malformed_bundle' } };
	}

	// Echo checks — these defeat a relay shuffling bundles between
	// pids or origins.  The desktop only accepts a bundle that was
	// SIGNED for THIS specific desktop's epk_pub and THIS specific
	// origin.
	const desktopEpkBase64 = toBase64(args.desktopEpkPub);
	if (envelope.bundle.epk_echo !== desktopEpkBase64) {
		return { kind: 'reject', reason: { kind: 'epk_echo_mismatch' } };
	}
	if (envelope.bundle.origin_echo !== args.desktopOrigin) {
		return { kind: 'reject', reason: { kind: 'origin_echo_mismatch' } };
	}
	if (envelope.bundle.pid !== args.expectedPid) {
		return { kind: 'reject', reason: { kind: 'pid_mismatch' } };
	}

	// Freshness window — replay defense.
	if (envelope.bundle.signed_at < args.nowSeconds - BUNDLE_FRESHNESS_PAST_SECONDS) {
		return { kind: 'reject', reason: { kind: 'signed_at_too_old' } };
	}
	if (envelope.bundle.signed_at > args.nowSeconds + BUNDLE_FRESHNESS_FUTURE_SECONDS) {
		return { kind: 'reject', reason: { kind: 'signed_at_too_future' } };
	}

	// Verify the posting-key signature against the on-chain
	// pubkey of `bundle.account`.  Caller's responsibility to
	// implement the actual chain RPC; we just hand off the bytes.
	const canonicalBundle = enc.encode(canonicalJson(envelope.bundle));
	let signatureBytes: Uint8Array;
	try {
		signatureBytes = fromHex(envelope.signature);
	} catch {
		return { kind: 'reject', reason: { kind: 'malformed_signature' } };
	}
	const sigOk = await args.verifier(envelope.bundle.account, canonicalBundle, signatureBytes);
	if (!sigOk) {
		return { kind: 'reject', reason: { kind: 'signature_invalid' } };
	}

	return { kind: 'ok', envelope };
}
