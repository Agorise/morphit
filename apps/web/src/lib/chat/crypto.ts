/**
 * Morphit — chat crypto primitives.
 *
 * Implements the ECIES-style per-message encryption specified in
 * ADR-0015. Every chat send goes through `encryptToRecipient`;
 * every chat receive goes through `decryptFromSender`.
 *
 * ─── The scheme ─────────────────────────────────────────────────
 *
 * Each account has a long-term X25519 identity keypair derived
 * deterministically from its Blurt posting private key via
 * BLAKE2b-256. The public half is published on-chain (via a
 * separate `morphit_chat_identity_v1` op) so peers can look it up.
 *
 * v2 (sent by this version; `v: 2` in the envelope and op header).
 * The sender generates a fresh ephemeral X25519 keypair and derives
 * the message key from TWO Diffie-Hellman results:
 *
 *     dh1 = X25519(ephemeral, recipient)      — fresh per message
 *     dh2 = X25519(sender, recipient)         — static-static
 *     key = BLAKE2b-256(key = dh1 ‖ dh2,
 *                       msg = "morphit-chat-msg-v2/" sender 0 recipient 0
 *                             ‖ sender_pub ‖ recipient_pub ‖ ephemeral_pub)
 *
 * and encrypts under ChaCha20-Poly1305-IETF with a random 12-byte
 * nonce and the two account names as AAD. The recipient computes
 * dh2 from their own private key and the sender's PINNED chat key
 * (pubPin.ts), so only someone holding the sender's (or the
 * recipient's) private chat key can produce a message that opens:
 * that is the sender authentication. A hostile indexer, which knows
 * only public keys, can no longer mint a message "from" someone.
 * The sender's optional self-copy uses dh1' = X25519(ephemeral,
 * sender) and the same dh2, so it too can only have been written by
 * one of the two parties.
 *
 * v1 (older clients; no `v`). Anonymous ECIES: the key depends only
 * on the ephemeral and the recipient key. Still decrypted, so old
 * messages and messages from not-yet-updated clients stay readable,
 * but a v1 message is NEVER reported as authenticated: anyone with
 * the recipient's public key could have written it.
 *
 * ─── Security properties ────────────────────────────────────────
 *
 * Provides:
 *   - Confidentiality: no one without the recipient's (or, for v2,
 *     the sender's) chat private key can read a message.
 *   - Ciphertext integrity: ChaCha20-Poly1305 AEAD rejects any
 *     tampering, including stripping or changing the version.
 *   - Sender authentication (v2 only): see above. It is deniable —
 *     the recipient could have computed the same key, so a message
 *     proves its origin to the recipient, not to third parties. As
 *     with any DH-authenticated scheme, someone who steals the
 *     RECIPIENT's chat private key can also forge messages to them.
 *
 * Does NOT provide (per ADR-0015 — accepted tradeoffs):
 *   - Forward secrecy. The recipient's chat private key is the same
 *     until their posting key changes, and it decrypts every message
 *     ever sent to them. In the default 'keep' mode the sender's own
 *     chat key decrypts the self-copy of every message they sent.
 *     Only in 'destroy' mode (no self-copy) does a later leak of the
 *     sender's key alone not reopen what they sent — the recipient's
 *     key still does. In short: **no forward secrecy**.
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

/** Envelope version this client sends. */
export const CHAT_ENVELOPE_VERSION = 2;

/** On-wire envelope. Fields are all base64-encoded because the
 *  on-chain op stores JSON and the ciphertext column expects
 *  base64. */
export interface ChatEnvelopeWire {
	/** 2 for the sender-authenticated envelope; absent for v1. */
	readonly v?: 2;
	readonly ciphertext: string; // base64 — ChaCha20-Poly1305 output (ciphertext || 16-byte tag)
	readonly ephemeralPub: string; // base64 — 32 bytes
	readonly nonce: string; // base64 — 12 bytes
	/** OPTIONAL sender-decryptable copy. Present only when the sender is in
	 *  "keep my history" mode (the default). It is the SAME plaintext,
	 *  encrypted under a key the SENDER re-derives from their own private key,
	 *  the ephemeralPub above and (v2) the static-static term with the
	 *  recipient's key; distinct AAD. Lets the sender read their own sent
	 *  messages from chain forever. Absent in "destroy" mode — the sender then
	 *  cannot reread own messages after the session. The recipient can never
	 *  open this copy (different key + AAD). */
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
 * v1 per-message key from the ephemeral shared secret, domain-separated by
 * the (sender, recipient) pair. The concat(sender, "\u0000", recipient)
 * format uses an in-band separator that can't appear in a valid Blurt
 * account name, so ("ab", "cd") and ("abc", "d") never collide.
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

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/**
 * v2 per-message key: BLAKE2b keyed with dh1 ‖ dh2 (ephemeral and
 * static-static results), over a domain string that also binds both account
 * names and the three public keys, so a key derived for one pair of
 * identities can never serve another. `self` selects the self-copy domain.
 */
function deriveMessageKeyV2(
	dh1: Uint8Array,
	dh2: Uint8Array,
	senderAccount: string,
	recipientAccount: string,
	senderPub: Uint8Array,
	recipientPub: Uint8Array,
	ephPub: Uint8Array,
	self: boolean
): Uint8Array {
	if (dh1.length !== 32 || dh2.length !== 32) {
		throw new Error('chat crypto: shared secrets must be 32 bytes');
	}
	const ikm = concatBytes(dh1, dh2);
	try {
		const info = concatBytes(
			enc.encode(
				`${self ? 'morphit-chat-self-v2' : 'morphit-chat-msg-v2'}/${senderAccount}\u0000${recipientAccount}\u0000`
			),
			senderPub,
			recipientPub,
			ephPub
		);
		return sodium.crypto_generichash(32, info, ikm);
	} finally {
		sodium.memzero(ikm);
	}
}

/**
 * AAD for AEAD. Binding the sender and recipient handles means a relay
 * attacker can't re-target a ciphertext to a different recipient or
 * re-attribute it (the AEAD check fails). Versioned with the envelope.
 */
function buildAad(senderAccount: string, recipientAccount: string, v: 1 | 2 = 1): Uint8Array {
	return enc.encode(`morphit-chat-aad-v${v}/${senderAccount}\u0000${recipientAccount}`);
}

/**
 * AAD for the sender's SELF-COPY (see ChatEnvelopeWire.selfCiphertext). A
 * distinct domain string from buildAad, so the self-copy is bound as a
 * self-copy: the recipient's decrypt can never open it, and it can never be
 * swapped for the recipient ciphertext without the AEAD MAC failing.
 */
function buildAadSelf(senderAccount: string, recipientAccount: string, v: 1 | 2 = 1): Uint8Array {
	return enc.encode(`morphit-chat-self-aad-v${v}/${senderAccount}\u0000${recipientAccount}`);
}

/** X25519 that maps libsodium's low-order / all-zero failure to `onFail`. */
function dh(priv: Uint8Array, pub: Uint8Array, onFail: () => Error): Uint8Array {
	try {
		return sodium.crypto_scalarmult(priv, pub);
	} catch {
		throw onFail();
	}
}

/**
 * Encrypt a plaintext message to a recipient in the sender-authenticated v2
 * envelope — the only format this client sends. `sender` is the sender's own
 * chat identity (its private half takes part in the static-static DH).
 * `includeSelfCopy` adds a copy the sender can reread later ('keep' mode).
 *
 * The envelope's ciphertext field includes the 16-byte Poly1305 auth tag
 * appended per libsodium convention — one base64 blob covers data + tag.
 */
export async function encryptToRecipient(
	plaintext: string,
	recipientChatPub: Uint8Array,
	sender: ChatIdentityKeys,
	senderAccount: string,
	recipientAccount: string,
	includeSelfCopy = true
): Promise<ChatEnvelopeWire> {
	await ensureSodium();
	if (recipientChatPub.length !== 32) {
		throw new Error('chat crypto: recipient pub must be 32 bytes');
	}
	if (sender.priv.length !== 32 || sender.pub.length !== 32) {
		throw new Error('chat crypto: sender identity must be 32-byte keys');
	}
	if (senderAccount.length === 0 || recipientAccount.length === 0) {
		throw new Error('chat crypto: accounts must be non-empty');
	}

	const ephPriv = sodium.randombytes_buf(32);
	clampX25519Scalar(ephPriv);
	const ephPub = sodium.crypto_scalarmult_base(ephPriv);
	const wipe: Uint8Array[] = [ephPriv];
	try {
		const badKey = () => new Error('chat crypto: recipient key is not a usable X25519 key');
		const dh1 = dh(ephPriv, recipientChatPub, badKey);
		wipe.push(dh1);
		const dh2 = dh(sender.priv, recipientChatPub, badKey);
		wipe.push(dh2);
		const key = deriveMessageKeyV2(
			dh1,
			dh2,
			senderAccount,
			recipientAccount,
			sender.pub,
			recipientChatPub,
			ephPub,
			false
		);
		wipe.push(key);
		const nonce = sodium.randombytes_buf(12);
		const plaintextBytes = enc.encode(plaintext);
		const ciphertextWithTag = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
			plaintextBytes,
			buildAad(senderAccount, recipientAccount, 2),
			null,
			nonce,
			key
		);

		let selfCiphertext: string | undefined;
		let selfNonce: string | undefined;
		if (includeSelfCopy) {
			const dh1Self = dh(ephPriv, sender.pub, () => new Error('chat crypto: bad sender key'));
			wipe.push(dh1Self);
			const keySelf = deriveMessageKeyV2(
				dh1Self,
				dh2,
				senderAccount,
				recipientAccount,
				sender.pub,
				recipientChatPub,
				ephPub,
				true
			);
			wipe.push(keySelf);
			const selfNonceBytes = sodium.randombytes_buf(12);
			selfCiphertext = toBase64(
				sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
					plaintextBytes,
					buildAadSelf(senderAccount, recipientAccount, 2),
					null,
					selfNonceBytes,
					keySelf
				)
			);
			selfNonce = toBase64(selfNonceBytes);
		}
		return {
			v: 2,
			ciphertext: toBase64(ciphertextWithTag),
			ephemeralPub: toBase64(ephPub),
			nonce: toBase64(nonce),
			...(selfCiphertext !== undefined && selfNonce !== undefined
				? { selfCiphertext, selfNonce }
				: {})
		};
	} finally {
		// Wipe the ephemeral private key and every derived secret, on every
		// path.
		for (const b of wipe) sodium.memzero(b);
	}
}

/**
 * The legacy v1 envelope (anonymous ECIES, no sender authentication). This
 * client never SENDS it; it exists so the v1 read path — messages from
 * before v2 and from clients not yet updated — stays exercised by tests.
 * `senderChatPub` + `includeSelfCopy` add the v1 self-copy.
 */
export async function encryptToRecipientV1(
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
	const wantSelfCopy = includeSelfCopy && senderChatPub !== undefined;
	if (wantSelfCopy && senderChatPub!.length !== 32) {
		throw new Error('chat crypto: sender pub must be 32 bytes');
	}
	const ephPriv = sodium.randombytes_buf(32);
	clampX25519Scalar(ephPriv);
	const ephPub = sodium.crypto_scalarmult_base(ephPriv);
	const wipe: Uint8Array[] = [ephPriv];
	try {
		const shared = sodium.crypto_scalarmult(ephPriv, recipientChatPub);
		wipe.push(shared);
		const key = deriveMessageKey(shared, senderAccount, recipientAccount);
		wipe.push(key);
		const nonce = sodium.randombytes_buf(12);
		const plaintextBytes = enc.encode(plaintext);
		const ciphertextWithTag = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
			plaintextBytes,
			buildAad(senderAccount, recipientAccount),
			null,
			nonce,
			key
		);
		let selfCiphertext: string | undefined;
		let selfNonce: string | undefined;
		if (wantSelfCopy) {
			const sharedSelf = sodium.crypto_scalarmult(ephPriv, senderChatPub!);
			wipe.push(sharedSelf);
			const keySelf = deriveMessageKey(sharedSelf, senderAccount, recipientAccount);
			wipe.push(keySelf);
			const selfNonceBytes = sodium.randombytes_buf(12);
			selfCiphertext = toBase64(
				sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
					plaintextBytes,
					buildAadSelf(senderAccount, recipientAccount),
					null,
					selfNonceBytes,
					keySelf
				)
			);
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
		for (const b of wipe) sodium.memzero(b);
	}
}

/** A decrypted message and whether its sender is PROVED (v2, opened with the
 *  sender's pinned chat key). `authenticated: false` means v1: readable, but
 *  anyone with the recipient's public key could have written it. */
export interface OpenedMessage {
	readonly text: string;
	readonly authenticated: boolean;
}

function parseCommon(
	ephB64: string,
	ctB64: string,
	nonceB64: string
): { ephPub: Uint8Array; ct: Uint8Array; nonce: Uint8Array } {
	let ephPub: Uint8Array;
	let ct: Uint8Array;
	let nonce: Uint8Array;
	try {
		ephPub = fromBase64(ephB64);
		ct = fromBase64(ctB64);
		nonce = fromBase64(nonceB64);
	} catch {
		// Malformed base64 is indistinguishable (to the attacker) from a
		// failed MAC — return the same generic error.
		throw new DecryptError();
	}
	if (ephPub.length !== 32 || nonce.length !== 12 || ct.length < 16) {
		throw new DecryptError();
	}
	return { ephPub, ct, nonce };
}

function aeadOpen(
	ct: Uint8Array,
	aad: Uint8Array,
	nonce: Uint8Array,
	key: Uint8Array
): Uint8Array | null {
	try {
		return sodium.crypto_aead_chacha20poly1305_ietf_decrypt(null, ct, aad, nonce, key);
	} catch {
		return null;
	}
}

/**
 * Decrypt an envelope received by this user.
 *
 * v2: `senderChatPubs` are the sender's pinned chat keys to try (the current
 * pin first, then keys pinned before an accepted key change, so older
 * messages still open). The message opens only with one of them — that is the
 * proof of origin — and comes back `authenticated: true`. With no matching
 * key it throws DecryptError.
 *
 * v1: decrypted as before and returned `authenticated: false`.
 *
 * Throws DecryptError on ANY failure, without detail.
 */
export async function decryptFromSender(
	envelope: ChatEnvelopeWire,
	myIdentity: ChatIdentityKeys,
	senderAccount: string,
	recipientAccount: string,
	senderChatPubs: readonly Uint8Array[] = []
): Promise<OpenedMessage> {
	await ensureSodium();
	const { ephPub, ct, nonce } = parseCommon(
		envelope.ephemeralPub,
		envelope.ciphertext,
		envelope.nonce
	);
	const wipe: Uint8Array[] = [];
	try {
		const dh1 = dh(myIdentity.priv, ephPub, () => new DecryptError());
		wipe.push(dh1);
		if (envelope.v === 2) {
			for (const senderPub of senderChatPubs) {
				if (senderPub.length !== 32) continue;
				let dh2: Uint8Array;
				try {
					dh2 = sodium.crypto_scalarmult(myIdentity.priv, senderPub);
				} catch {
					continue;
				}
				wipe.push(dh2);
				const key = deriveMessageKeyV2(
					dh1,
					dh2,
					senderAccount,
					recipientAccount,
					senderPub,
					myIdentity.pub,
					ephPub,
					false
				);
				wipe.push(key);
				const pt = aeadOpen(ct, buildAad(senderAccount, recipientAccount, 2), nonce, key);
				if (pt !== null) return { text: new TextDecoder().decode(pt), authenticated: true };
			}
			throw new DecryptError();
		}
		if (envelope.v !== undefined) throw new DecryptError();
		const key = deriveMessageKey(dh1, senderAccount, recipientAccount);
		wipe.push(key);
		const pt = aeadOpen(ct, buildAad(senderAccount, recipientAccount), nonce, key);
		if (pt === null) throw new DecryptError();
		return { text: new TextDecoder().decode(pt), authenticated: false };
	} finally {
		for (const b of wipe) sodium.memzero(b);
	}
}

/**
 * Decrypt the sender's OWN self-copy of a message THEY sent (see
 * ChatEnvelopeWire.selfCiphertext), to restore own sent history from chain.
 * `myIdentity` is the SENDER's own identity. For v2, `recipientChatPubs` are
 * the recipient's pinned chat keys to try: the self-copy key also needs the
 * static-static term, so a self-copy forged by someone who knows only the
 * sender's public key does not open. Throws DecryptError on any failure (no
 * self-copy — 'destroy' mode or a pre-feature message — malformed, or wrong
 * key).
 */
export async function decryptSelfCopy(
	envelope: ChatEnvelopeWire,
	myIdentity: ChatIdentityKeys,
	senderAccount: string,
	recipientAccount: string,
	recipientChatPubs: readonly Uint8Array[] = []
): Promise<string> {
	await ensureSodium();
	if (envelope.selfCiphertext === undefined || envelope.selfNonce === undefined) {
		throw new DecryptError();
	}
	const { ephPub, ct, nonce } = parseCommon(
		envelope.ephemeralPub,
		envelope.selfCiphertext,
		envelope.selfNonce
	);
	const wipe: Uint8Array[] = [];
	try {
		const dh1 = dh(myIdentity.priv, ephPub, () => new DecryptError());
		wipe.push(dh1);
		if (envelope.v === 2) {
			for (const recipientPub of recipientChatPubs) {
				if (recipientPub.length !== 32) continue;
				let dh2: Uint8Array;
				try {
					dh2 = sodium.crypto_scalarmult(myIdentity.priv, recipientPub);
				} catch {
					continue;
				}
				wipe.push(dh2);
				const key = deriveMessageKeyV2(
					dh1,
					dh2,
					senderAccount,
					recipientAccount,
					myIdentity.pub,
					recipientPub,
					ephPub,
					true
				);
				wipe.push(key);
				const pt = aeadOpen(ct, buildAadSelf(senderAccount, recipientAccount, 2), nonce, key);
				if (pt !== null) return new TextDecoder().decode(pt);
			}
			throw new DecryptError();
		}
		if (envelope.v !== undefined) throw new DecryptError();
		const key = deriveMessageKey(dh1, senderAccount, recipientAccount);
		wipe.push(key);
		const pt = aeadOpen(ct, buildAadSelf(senderAccount, recipientAccount), nonce, key);
		if (pt === null) throw new DecryptError();
		return new TextDecoder().decode(pt);
	} finally {
		for (const b of wipe) sodium.memzero(b);
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
