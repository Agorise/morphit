/**
 * Morphit — YubiKey-unlock protocol (Batch I, ADR-0017).
 *
 * Pure types + constants for the layered-CEK keystore extension.
 * Smoke-importable: no libsodium, no @noble, no WebHID — just
 * shapes the rest of the system constrains itself against.
 *
 * --- Architecture ---
 *
 * Today's keystore (Batch H and earlier):
 *
 *     ciphertext = AEAD(identity-json, key = Argon2id(passphrase, salt))
 *
 * Single-wrap: passphrase → key → identity.  Cannot represent
 * "either passphrase OR YubiKey" because there's only one wrap.
 *
 * Layered-CEK keystore (this batch):
 *
 *     CEK = random 32 bytes
 *     ciphertext = AEAD(identity-json, key = CEK)
 *     wraps[i].ciphertext = AEAD(CEK, key = derive_i)
 *
 * Each `wraps[i]` is an independent unwrap path that produces the
 * same CEK.  CEK then decrypts the identity blob.  Two wrap kinds
 * exist:
 *
 *   - 'passphrase' wrap: derive_i = Argon2id(passphrase, salt_i)
 *   - 'yubikey' wrap:    derive_i = Argon2id(
 *                            HMAC-SHA1(yubikey_slot_secret, challenge_i),
 *                            salt_i
 *                        )
 *
 * Wrap order isn't significant — readers try each wrap independently.
 * A typical layered envelope has exactly two wraps (one passphrase,
 * one yubikey) — that is "state A" in the user's roadmap, the
 * progressive enrollment default.  After hardening to "state B",
 * the passphrase wrap is removed; envelope has only the yubikey
 * wrap.  Re-importing from seed phrase recreates a simple-passphrase
 * keystore, no chain involvement.
 *
 * --- Threat model ---
 *
 * T1: Stolen device (no YubiKey present)
 *   - State A: passphrase wrap still works.  Defense: passphrase
 *     entropy + Argon2id cost.  Same as pre-Batch-I.
 *   - State B: no usable wrap; keystore is opaque bytes.  Even a
 *     full memory dump of the running app shows no usable secret.
 *
 * T2: Phished/keylogged passphrase (YubiKey not stolen)
 *   - State A: attacker has passphrase, defeats the keystore.  Same
 *     posture as pre-Batch-I.  YubiKey doesn't help here.
 *   - State B: attacker has only the passphrase, which doesn't
 *     decrypt anything.  YubiKey unwrap is the only path.
 *
 * T3: Stolen YubiKey (no passphrase, no device with keystore)
 *   - The YubiKey HMAC secret can be replayed forever, but the
 *     attacker also needs the encrypted keystore blob — which sits
 *     in the user's localStorage on their device.  No keystore = no
 *     ciphertext = nothing to decrypt.  YubiKey alone is insufficient.
 *
 * T4: Stolen YubiKey + access to encrypted keystore (via backup
 *     export, cloud sync of localStorage, etc.)
 *   - State A: attacker can use yubikey wrap to recover CEK.
 *     Argon2id over HMAC output is the only friction.  This is the
 *     known cost of (A) — the YubiKey gives you a SECOND unlock
 *     path, not a STRONGER one.
 *   - State B: same — YubiKey alone is sufficient with the
 *     ciphertext.  Defense: keep the YubiKey safe.  Same posture
 *     as a stolen passphrase in (A).
 *
 * T5: Browser exploit during YubiKey unwrap
 *   - HMAC-SHA1 output transits the WebHID layer in browser
 *     memory for one operation.  We Argon2id-stretch it before use
 *     so a brief read of the HMAC raw bytes still requires GPU
 *     time to brute-force the wrap key.  Wipe immediately after.
 *
 * T6: WebHID transport interception
 *   - Same-origin policy + USB-permission UX prevents cross-origin
 *     access.  No mitigation available against a malicious WebHID
 *     polyfill; users with that level of compromise have larger
 *     problems.
 *
 * --- Per-keystore challenge nonce ---
 *
 * Each YubiKey-wrap stores a random 32-byte challenge.  Sent to
 * the YubiKey's HMAC-SHA1 slot (slot 2 by convention; slot 1 is
 * usually reserved for the keyboard-emulating Yubico OTP), the key
 * returns HMAC-SHA1(slot_secret, challenge).  Different challenges
 * → different HMAC outputs → different derived keys → impossible
 * to substitute one keystore's CEK-wrap for another's.
 *
 * --- WebHID requirement ---
 *
 * Browser must expose `navigator.hid` (Chromium-only as of writing).
 * Firefox + Safari users see a feature-detect message at
 * /settings/hardware-key.  No fallback to U2F/CTAP2: those use
 * P-256 ECDSA, not HMAC-SHA1, and would be a different protocol.
 */

/** Schema version for the wrap-format itself.  Bump when wrap types
 *  add fields; readers reject unknown schema versions to fail loudly
 *  rather than try to interpret post-hoc additions. */
export const YUBIKEY_WRAP_SCHEMA_VERSION = 1;

/** YubiKey HMAC-SHA1 challenge size.  YubiKey accepts up to 64-byte
 *  challenges in HMAC-SHA1 mode; we use the full 64 to maximize the
 *  challenge space.  HMAC-SHA1 output is always 20 bytes regardless. */
export const YUBIKEY_CHALLENGE_BYTES = 64;
export const YUBIKEY_HMAC_OUTPUT_BYTES = 20;

/** YubiKey slot used for HMAC-SHA1 challenge-response.  Slot 1 is
 *  Yubico OTP by factory default and most users don't change it.
 *  Slot 2 is empty by factory default and is the conventional
 *  user-programmable slot for HMAC-SHA1 (KeePassXC, age-yubikey,
 *  pam_yubico all default here).  We let the user pick at enrollment
 *  time, but slot 2 is the default. */
export type YubikeySlot = 1 | 2;
export const DEFAULT_YUBIKEY_SLOT: YubikeySlot = 2;

/** Argon2id parameters used for the YubiKey-derived wrap key.
 *  Identical to the passphrase wrap's parameters by design — the
 *  YubiKey's HMAC output is high-entropy already, but we run it
 *  through Argon2id anyway so a brief memory read of the HMAC
 *  bytes during unwrap still costs the attacker GPU time to brute-
 *  force the wrap key.  See T5 in the threat model. */
export interface YubikeyArgonParams {
	readonly opslimit: number;
	readonly memlimit: number;
}

/** A single CEK-unwrap path in a layered-CEK keystore.  Discriminated
 *  union; readers branch on `kind`. */
export type WrappedCek = WrappedCekPassphrase | WrappedCekYubikey;

export interface WrappedCekPassphrase {
	readonly kind: 'passphrase';
	readonly kdf: 'argon2id';
	readonly kdfParams: YubikeyArgonParams;
	readonly salt: string; // base64
	readonly nonce: string; // base64
	readonly ciphertext: string; // base64
}

export interface WrappedCekYubikey {
	readonly kind: 'yubikey';
	readonly schemaVersion: 1;
	readonly slot: YubikeySlot;
	readonly challenge: string; // base64, 64 bytes raw
	readonly kdf: 'argon2id';
	readonly kdfParams: YubikeyArgonParams;
	readonly salt: string; // base64
	readonly nonce: string; // base64
	readonly ciphertext: string; // base64
	/** Optional friendly label the user gave at enrollment time
	 *  ("Work Yubikey").  Display-only.  Empty string when the
	 *  user skipped the label step. */
	readonly label: string;
	/** When this wrap was added to the keystore.  Display-only
	 *  ("enrolled three weeks ago").  Trusted from the writer
	 *  side; not security-bearing. */
	readonly enrolledAt: number;
}

/** Cheap shape predicates for runtime branching.  TypeScript would
 *  refine these for free in a fully-typed flow, but the keystore
 *  is also reached via JSON.parse which strips static typing. */
export function isPassphraseWrap(w: WrappedCek): w is WrappedCekPassphrase {
	return w.kind === 'passphrase';
}

export function isYubikeyWrap(w: WrappedCek): w is WrappedCekYubikey {
	return w.kind === 'yubikey';
}

/** Constants shared between the writer and reader.  Centralized so
 *  envelope-shape changes happen in one place. */
export const CEK_BYTES = 32;
/** Nonce size for the layered-CEK AEAD.
 *
 *  The keystore's CEK encrypt + passphrase/yubikey-wrap path uses
 *  libsodium `crypto_secretbox_easy` (XSalsa20-Poly1305), whose nonce is
 *  24 bytes (`crypto_secretbox_NONCEBYTES`).  This constant was previously
 *  12 (a ChaCha20-Poly1305-IETF size), which `crypto_secretbox_easy`
 *  rejects with "invalid nonce length" — so `encryptIdentityToCek` /
 *  `buildPassphraseWrap`, and therefore the entire layered-cek / YubiKey
 *  enrollment write path, threw at runtime.  That path is only reachable
 *  via real-hardware YubiKey enrollment, so it had no automated coverage
 *  and the defect went unnoticed.  Because no layered envelope could ever
 *  be written under the old value, there is no stored-data migration
 *  concern in raising it to 24.  (Readers use the nonce length stored on
 *  the envelope, not this constant.) */
export const CEK_NONCE_BYTES = 24;
/** Salt size for Argon2id — libsodium's default. */
export const ARGON_SALT_BYTES = 16;

/** Minimum and maximum number of YubiKey-wraps we permit on one
 *  keystore.  Min 0 because state A starts with zero (passphrase-
 *  only) and grows to one (passphrase + yubikey).  Max 4 to bound
 *  enrollment storage and the unwrap loop's worst case.  A user
 *  with 4 YubiKeys enrolled would be unusual but not pathological. */
export const MAX_YUBIKEY_WRAPS = 4;

/** Maximum length of the user-supplied YubiKey label.  Defends the
 *  envelope size cap from abuse (the label is user-controlled and
 *  serializes into the keystore JSON which lives in localStorage). */
export const MAX_YUBIKEY_LABEL_LEN = 64;

/** Validate a user-supplied YubiKey label.  Returns the trimmed
 *  string if acceptable, or null if the label is too long.  Empty
 *  is acceptable (user-skipped). */
export function normalizeYubikeyLabel(s: string): string | null {
	const trimmed = s.trim();
	if (trimmed.length > MAX_YUBIKEY_LABEL_LEN) return null;
	return trimmed;
}
