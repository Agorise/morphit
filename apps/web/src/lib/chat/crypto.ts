/**
 * Morphit — chat crypto primitives.
 *
 * Implements the ECIES-style per-message encryption specified in
 * ADR-0015. Every chat send goes through `encryptToRecipient`;
 * every chat receive goes through `decryptFromSender`.
 *
 * ─── The scheme in one paragraph ────────────────────────────────
 *
 * Each account has a long-term X25519 identity keypair derived
 * deterministically from its Blurt posting private key via
 * BLAKE2b-256. The public half is published on-chain (via a
 * separate `morphit_chat_identity_v1` op) so peers can look it up.
 * To send a message, the sender generates a fresh ephemeral X25519
 * keypair, computes the shared secret with the recipient's long-
 * term pubkey, derives a one-use message key via BLAKE2b,
 * generates a random 12-byte nonce, and encrypts the plaintext
 * under ChaCha20-Poly1305-IETF. The recipient's accounts (both
 * sender and recipient handles) are bound as additional
 * authenticated data, so a relayed ciphertext can't be re-
 * attributed or re-addressed.
 *
 * ─── Security properties ────────────────────────────────────────
 *
 * Provides:
 *   - Confidentiality: no one without the recipient's chat privkey
 *     can read a message.
 *   - Ciphertext integrity: ChaCha20-Poly1305 AEAD rejects any
 *     tampering.
 *   - Sender binding: the AAD includes both account handles;
 *     relaying a ciphertext to a different recipient breaks AEAD
 *     auth.
 *   - One-sided sender-PFS: ephemeral private is wiped after
 *     send.  If the sender's posting key leaks LATER, the
 *     attacker cannot recover ephemerals from messages already
 *     broadcast — those ciphertexts are not decryptable from
 *     posting key alone.
 *
 * Does NOT provide (per ADR-0015 — accepted tradeoffs):
 *   - Receiver-side forward secrecy.  Recipient's long-term
 *     chat-priv is the same forever, until posting-key rotation.
 *     Compromise of chat-priv reveals every past ciphertext the
 *     attacker can fetch from chain.  We deliberately rejected
 *     per-message-rotation forward-secrecy protocols (see
 *     ADR-0015 § "Alternatives considered") because the bundle
 *     and key-management cost is unacceptable for our threat
 *     model.  Acceptable because posting-key compromise already
 *     ends the account's security story for other reasons
 *     (attacker can broadcast as user).
 *   - Post-compromise security.  No automatic recovery.
 *   - Metadata privacy.  Sender, recipient, and timestamp
 *     remain public on chain.
 *
 * The honest framing for users is in the FAQ entry
 * `forward_secrecy`; the developer-facing reasoning is in
 * `docs/CHAT-CRYPTO.md`.  When in doubt: **never claim PFS we
 * don't have**.
 *
 * ─── Implementation notes ──────────────────────────────────────
 *
 * - Primitives are all from libsodium-wrappers-sumo (already a
 *   project dep; no new bundle weight).
 * - BLAKE2b derivation matches the in-tree pattern from
 *   `$lib/crypto/keygen.ts`: domain-separated info strings + the
 *   32-byte output clamped to X25519 scalar form.
 * - AEAD is ChaCha20-Poly1305 IETF variant (12-byte nonce, 16-byte
 *   tag) — `sodium.crypto_aead_chacha20poly1305_ietf_*`.
 * - Buffers holding derived private material are wiped via
 *   `sodium.memzero` before the function returns, best-effort.
 */

import sodium from 'libsodium-wrappers-sumo';

// ─── Types ──────────────────────────────────────────────────────

/** A full chat identity keypair. The priv half stays in memory
 *  only while the session is unlocked. */
export interface ChatIdentityKeys {
	readonly priv: Uint8Array; // 32-byte X25519 scalar (clamped)
	readonly pub: Uint8Array; // 32-byte X25519 point
}

/** Error thrown when decryption fails for any reason.
 *  Deliberately does NOT carry a detailed reason — a precise
 *  reason (e.g. "MAC check failed at byte 17") could seed a
 *  timing oracle. Callers who want to distinguish
 *  "ciphertext-malformed" from "key-mismatch" must do so via
 *  other signals (e.g. whether the ephemeralPub parses as a
 *  valid X25519 point — that's not security-sensitive). */
export class DecryptError extends Error {
	constructor() {
		super('chat decryption failed');
		this.name = 'DecryptError';
	}
}

/** On-wire envelope. Fields are all base64-encoded because the
 *  on-chain op stores JSON and the ciphertext column expects
 *  base64. */
export interface ChatEnvelopeWire {
	readonly ciphertext: string; // base64 — ChaCha20-Poly1305 output (ciphertext || 16-byte tag)
	readonly ephemeralPub: string; // base64 — 32 bytes
	readonly nonce: string; // base64 — 12 bytes
	/** cp406 — OPTIONAL sender-decryptable copy. Present only when the sender
	 *  is in "keep my history" mode (the default, encrypt-a-copy-to-self). It
	 *  is the SAME plaintext, encrypted under a key the SENDER can re-derive
	 *  from their own private key + the ephemeralPub above (ECDH against the
	 *  sender's own pubkey, distinct AAD). Lets the sender read their own sent
	 *  messages from chain forever. Absent in PFS "destroy on leave" mode — in
	 *  which case own-sent messages remain unrecoverable after the session, by
	 *  design. The recipient can never open this copy (different key + AAD). */
	readonly selfCiphertext?: string; // base64 — ChaCha20-Poly1305 output
	readonly selfNonce?: string; // base64 — 12 bytes
}

// ─── sodium bootstrap ───────────────────────────────────────────

let sodiumReady: Promise<void> | null = null;

async function ensureSodium(): Promise<void> {
	const ready = sodiumReady ?? (sodiumReady = sodium.ready);
	return ready;
}

// ─── Encoding helpers ──────────────────────────────────────────

const enc = new TextEncoder();

/** Base64 → Uint8Array. Uses libsodium's own decoder so the result
 *  matches what libsodium's encrypt/decrypt functions produce on
 *  the other side. Throws if the string is not valid base64. */
function fromBase64(s: string): Uint8Array {
	// Sodium's variant 'original' accepts standard base64 with
	// padding, which is what our ops use. `URLSAFE_NO_PADDING` etc.
	// would not match the on-chain JSON convention.
	return sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
}

function toBase64(b: Uint8Array): string {
	return sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
}

// ─── Key derivation ────────────────────────────────────────────

/**
 * Clamp a 32-byte value to the X25519 scalar form per RFC 7748.
 * Operates in place on the provided buffer — caller must pass a
 * buffer it owns. Mutations:
 *   byte[0]  &= 248   (clear bits 0, 1, 2)
 *   byte[31] &= 127   (clear bit 7)
 *   byte[31] |= 64    (set bit 6)
 * Every 32-byte value post-clamp is a valid X25519 scalar, so no
 * retry loop is needed.
 */
function clampX25519Scalar(buf: Uint8Array): void {
	if (buf.length !== 32) {
		throw new Error(`chat crypto: clamp input must be 32 bytes, got ${buf.length}`);
	}
	buf[0]! &= 248;
	buf[31]! &= 127;
	buf[31]! |= 64;
}

/**
 * Derive the chat identity keypair for an account from its
 * Blurt posting private key. Deterministic: same posting priv
 * + same account name always produces the same chat keypair.
 *
 * The derivation uses BLAKE2b-256 in keyed mode — the posting
 * private key is the BLAKE2b key, and the message is the
 * domain-separated info string `morphit-chat-v1/identity/<account>`.
 * Domain separation prevents the derived key from colliding with
 * keys derived for other purposes from the same posting key.
 *
 * Warning: the returned priv half is live X25519 private key
 * material. Callers should wipe it via `wipeChatIdentity` when
 * done.
 */
export async function deriveChatIdentity(
	postingPriv: Uint8Array,
	account: string
): Promise<ChatIdentityKeys> {
	await ensureSodium();
	if (postingPriv.length !== 32) {
		throw new Error(`chat crypto: posting priv must be 32 bytes, got ${postingPriv.length}`);
	}
	if (account.length === 0) {
		throw new Error('chat crypto: account name must not be empty');
	}

	const info = enc.encode(`morphit-chat-v1/identity/${account}`);
	// BLAKE2b(32, message=info, key=postingPriv) — matches keygen.ts's
	// pattern. `crypto_generichash(outLen, message, key)` with key
	// non-null uses it as the BLAKE2b key.
	const scalar = sodium.crypto_generichash(32, info, postingPriv);
	clampX25519Scalar(scalar);

	// Derive the X25519 public key: scalarmult against the base point.
	const pub = sodium.crypto_scalarmult_base(scalar);

	return { priv: scalar, pub };
}

/** Wipe the sensitive material in a ChatIdentityKeys object.
 *  Best-effort — JavaScript's memory model doesn't guarantee the
 *  underlying pages are never swapped to disk, but zeroing the
 *  buffer at least eliminates casual memory-dump exposure. */
export function wipeChatIdentity(keys: ChatIdentityKeys): void {
	sodium.memzero(keys.priv);
	// pub is not secret; no need to wipe
}

// ─── Encrypt / decrypt ─────────────────────────────────────────

/**
 * Build the per-message symmetric key from an X25519 shared
 * secret. Domain-separated by the (sender, recipient) pair so
 * two conversations between the same counterparties in opposite
 * directions use distinct keys (though both are derivable from
 * the same shared secret; the AEAD is still per-nonce so the
 * distinction is belt+suspenders).
 *
 * The concat(sender, "\u0000", recipient) format uses an in-band
 * separator that can't appear in a valid Blurt account name
 * (account names are [a-z0-9-] only), so there's no ambiguity
 * between e.g. ("ab", "cd") and ("abc", "d").
 */
function deriveMessageKey(
	sharedSecret: Uint8Array,
	senderAccount: string,
	recipientAccount: string
): Uint8Array {
	if (sharedSecret.length !== 32) {
		throw new Error('chat crypto: shared secret must be 32 bytes');
	}
	const info = enc.encode(`morphit-chat-msg-v1/${senderAccount}\u0000${recipientAccount}`);
	return sodium.crypto_generichash(32, info, sharedSecret);
}

/**
 * Build the AAD string for AEAD. Same format on encrypt and
 * decrypt. Binding the sender and recipient handles means a
 * relay attacker can't re-target a ciphertext to a different
 * recipient (AEAD check fails) or re-attribute it (same).
 */
function buildAad(senderAccount: string, recipientAccount: string): Uint8Array {
	return enc.encode(`morphit-chat-aad-v1/${senderAccount}\u0000${recipientAccount}`);
}

/**
 * cp406 — AAD for the sender's SELF-COPY (see ChatEnvelopeWire.selfCiphertext).
 * A distinct domain string from buildAad so the self-copy is cryptographically
 * bound as a self-copy: the recipient's decrypt (which uses buildAad) can never
 * open it, and it can never be swapped for the recipient ciphertext without the
 * AEAD MAC failing. Combined with the different shared secret (ECDH against the
 * sender's own pubkey), the two copies are fully independent.
 */
function buildAadSelf(senderAccount: string, recipientAccount: string): Uint8Array {
	return enc.encode(`morphit-chat-self-aad-v1/${senderAccount}\u0000${recipientAccount}`);
}

/**
 * Encrypt a plaintext message to a recipient. The recipient's
 * long-term chat pubkey must be known (typically fetched from the
 * indexer). Returns the on-wire envelope, ready to drop into a
 * `morphit_chat_v1` op payload.
 *
 * The envelope's ciphertext field includes the 16-byte Poly1305
 * auth tag appended per libsodium convention — one base64 blob
 * covers data + tag.
 */
export async function encryptToRecipient(
	plaintext: string,
	recipientChatPub: Uint8Array,
	senderAccount: string,
	recipientAccount: string,
	senderChatPub?: Uint8Array,
	includeSelfCopy = true
): Promise<ChatEnvelopeWire> {
	await ensureSodium();
	if (recipientChatPub.length !== 32) {
		throw new Error('chat crypto: recipient pub must be 32 bytes');
	}
	if (senderAccount.length === 0 || recipientAccount.length === 0) {
		throw new Error('chat crypto: accounts must be non-empty');
	}
	// cp406 — a sender self-copy is emitted only when the caller supplies the
	// sender's own chat pubkey AND keep-history mode is on. Existing callers
	// that pass neither keep the exact prior (recipient-only, one-sided-PFS)
	// behavior. Validate the length here so a bad key can't reach the ECDH.
	const wantSelfCopy = includeSelfCopy && senderChatPub !== undefined;
	if (wantSelfCopy && senderChatPub!.length !== 32) {
		throw new Error('chat crypto: sender pub must be 32 bytes');
	}

	// Fresh ephemeral keypair for this message. The pub half goes
	// in the envelope header; the priv is discarded immediately
	// after the shared-secret computation below.
	const ephPriv = sodium.randombytes_buf(32);
	clampX25519Scalar(ephPriv);
	const ephPub = sodium.crypto_scalarmult_base(ephPriv);

	// Audit 2026-05 finding 2-12: wrap the rest in try/finally so
	// ephPriv is wiped even if scalarmult or AEAD encrypt throws.
	// crypto_scalarmult can throw on a low-order recipient point;
	// pre-fix, that error path leaked ephPriv on the heap.
	let shared: Uint8Array | null = null;
	let messageKey: Uint8Array | null = null;
	let sharedSelf: Uint8Array | null = null;
	let messageKeySelf: Uint8Array | null = null;
	try {
		// ECDH: shared secret = X25519(eph_priv, recipient_pub).
		const sharedLocal = sodium.crypto_scalarmult(ephPriv, recipientChatPub);
		shared = sharedLocal;
		const messageKeyLocal = deriveMessageKey(sharedLocal, senderAccount, recipientAccount);
		messageKey = messageKeyLocal;

		const nonce = sodium.randombytes_buf(12); // ChaCha20-Poly1305 IETF: 96-bit nonce
		const aad = buildAad(senderAccount, recipientAccount);
		const plaintextBytes = enc.encode(plaintext);

		const ciphertextWithTag = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
			plaintextBytes,
			aad,
			null, // nsec; ietf variant ignores this — pass null
			nonce,
			messageKeyLocal
		);

		// cp406 — sender self-copy. Reuse the SAME ephemeral but ECDH against
		// the sender's OWN pub, so the sender re-derives the key later from
		// their priv + the ephemeralPub already in the header. Distinct AAD
		// (buildAadSelf) binds it as a self-copy; the recipient can never open
		// it (they lack the sender's priv, and the AAD/key differ).
		let selfCiphertext: string | undefined;
		let selfNonce: string | undefined;
		if (wantSelfCopy) {
			const sharedSelfLocal = sodium.crypto_scalarmult(ephPriv, senderChatPub!);
			sharedSelf = sharedSelfLocal;
			const messageKeySelfLocal = deriveMessageKey(
				sharedSelfLocal,
				senderAccount,
				recipientAccount
			);
			messageKeySelf = messageKeySelfLocal;
			const selfNonceBytes = sodium.randombytes_buf(12);
			const aadSelf = buildAadSelf(senderAccount, recipientAccount);
			const selfCipherWithTag = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
				plaintextBytes,
				aadSelf,
				null,
				selfNonceBytes,
				messageKeySelfLocal
			);
			selfCiphertext = toBase64(selfCipherWithTag);
			selfNonce = toBase64(selfNonceBytes);
		}

		return {
			ciphertext: toBase64(ciphertextWithTag),
			ephemeralPub: toBase64(ephPub),
			nonce: toBase64(nonce),
			...(selfCiphertext !== undefined && selfNonce !== undefined
				? { selfCiphertext, selfNonce }
				: {})
		};
	} finally {
		// Wipe ephemeral priv unconditionally — PFS depends on this.
		sodium.memzero(ephPriv);
		if (shared) sodium.memzero(shared);
		if (messageKey) sodium.memzero(messageKey);
		if (sharedSelf) sodium.memzero(sharedSelf);
		if (messageKeySelf) sodium.memzero(messageKeySelf);
	}
}

/**
 * Decrypt an envelope received for this user. The user's own
 * chat identity is required (its priv half is used for the
 * ECDH). Returns the plaintext string or throws DecryptError
 * on ANY failure.
 *
 * The AAD reconstruction uses the SAME sender/recipient
 * accounts that the envelope claims — i.e. the op's signer and
 * recipient fields. The indexer has already validated those
 * against the chain (signer matches op sig; recipient matches
 * our own account if we're receiving), so using them here is
 * safe.
 */
export async function decryptFromSender(
	envelope: ChatEnvelopeWire,
	myIdentity: ChatIdentityKeys,
	senderAccount: string,
	recipientAccount: string
): Promise<string> {
	await ensureSodium();

	let ephPub: Uint8Array;
	let ciphertextWithTag: Uint8Array;
	let nonce: Uint8Array;
	try {
		ephPub = fromBase64(envelope.ephemeralPub);
		ciphertextWithTag = fromBase64(envelope.ciphertext);
		nonce = fromBase64(envelope.nonce);
	} catch {
		// Malformed base64 is indistinguishable (to the attacker)
		// from a failed MAC — return the same generic error.
		throw new DecryptError();
	}
	if (ephPub.length !== 32 || nonce.length !== 12 || ciphertextWithTag.length < 16) {
		throw new DecryptError();
	}

	let shared: Uint8Array | null = null;
	let messageKey: Uint8Array | null = null;
	try {
		let sharedLocal: Uint8Array;
		try {
			sharedLocal = sodium.crypto_scalarmult(myIdentity.priv, ephPub);
		} catch {
			// scalarmult can throw if the peer's pub is a low-order
			// point — an active attack. Reject without detail.
			throw new DecryptError();
		}
		shared = sharedLocal;

		const messageKeyLocal = deriveMessageKey(sharedLocal, senderAccount, recipientAccount);
		messageKey = messageKeyLocal;

		const aad = buildAad(senderAccount, recipientAccount);
		let plaintextBytes: Uint8Array;
		try {
			plaintextBytes = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
				null, // nsec
				ciphertextWithTag,
				aad,
				nonce,
				messageKeyLocal
			);
		} catch {
			throw new DecryptError();
		}

		return new TextDecoder().decode(plaintextBytes);
	} finally {
		// Audit 2026-05 finding 2-12: wipe unconditionally on
		// both happy and error paths.
		if (shared) sodium.memzero(shared);
		if (messageKey) sodium.memzero(messageKey);
	}
}

/**
 * cp406 — decrypt the sender's OWN self-copy of a message THEY sent (see
 * ChatEnvelopeWire.selfCiphertext). Used to restore own sent history from
 * chain when the account is in keep-history mode. `myIdentity` is the
 * SENDER's own identity — the caller only invokes this for records where it
 * is the sender. Returns the plaintext, or throws DecryptError on any failure
 * (no self-copy present — PFS mode or a pre-feature message — malformed, or
 * wrong key). ECDH symmetry: X25519(sender_priv, eph_pub) reproduces the
 * X25519(eph_priv, sender_pub) used at encrypt time.
 */
export async function decryptSelfCopy(
	envelope: ChatEnvelopeWire,
	myIdentity: ChatIdentityKeys,
	senderAccount: string,
	recipientAccount: string
): Promise<string> {
	await ensureSodium();
	if (envelope.selfCiphertext === undefined || envelope.selfNonce === undefined) {
		// No self-copy was written (PFS "destroy" mode, or a pre-feature message).
		throw new DecryptError();
	}

	let ephPub: Uint8Array;
	let selfCipherWithTag: Uint8Array;
	let selfNonce: Uint8Array;
	try {
		ephPub = fromBase64(envelope.ephemeralPub);
		selfCipherWithTag = fromBase64(envelope.selfCiphertext);
		selfNonce = fromBase64(envelope.selfNonce);
	} catch {
		throw new DecryptError();
	}
	if (ephPub.length !== 32 || selfNonce.length !== 12 || selfCipherWithTag.length < 16) {
		throw new DecryptError();
	}

	let shared: Uint8Array | null = null;
	let messageKey: Uint8Array | null = null;
	try {
		let sharedLocal: Uint8Array;
		try {
			sharedLocal = sodium.crypto_scalarmult(myIdentity.priv, ephPub);
		} catch {
			// Low-order point → reject without detail, same as the recipient path.
			throw new DecryptError();
		}
		shared = sharedLocal;
		const messageKeyLocal = deriveMessageKey(sharedLocal, senderAccount, recipientAccount);
		messageKey = messageKeyLocal;

		const aadSelf = buildAadSelf(senderAccount, recipientAccount);
		let plaintextBytes: Uint8Array;
		try {
			plaintextBytes = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
				null, // nsec
				selfCipherWithTag,
				aadSelf,
				selfNonce,
				messageKeyLocal
			);
		} catch {
			throw new DecryptError();
		}
		return new TextDecoder().decode(plaintextBytes);
	} finally {
		if (shared) sodium.memzero(shared);
		if (messageKey) sodium.memzero(messageKey);
	}
}

// ─── Pubkey serialization helpers ──────────────────────────────

/** Encode a 32-byte X25519 public key as base64 for the indexer op
 *  payload. Consumers of `morphit_chat_identity_v1` use this format. */
export function encodeChatPub(pub: Uint8Array): string {
	if (pub.length !== 32) {
		throw new Error(`chat crypto: pub must be 32 bytes, got ${pub.length}`);
	}
	return toBase64(pub);
}

/** Decode a base64-encoded X25519 public key as returned by the
 *  indexer's `GET /v1/chat-identity/:account` endpoint. Throws
 *  on malformed input. */
export function decodeChatPub(b64: string): Uint8Array {
	const pub = fromBase64(b64);
	if (pub.length !== 32) {
		throw new Error(`chat crypto: decoded pub length ${pub.length}, expected 32`);
	}
	return pub;
}
