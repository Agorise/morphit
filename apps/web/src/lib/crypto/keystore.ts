/**
 * Morphit — encrypted keystore
 *
 * User password → Argon2id KDF → XSalsa20-Poly1305 AEAD → ciphertext
 *
 * This ciphertext is what lands in localStorage (normal mode) or
 * sessionStorage (Privacy Mode) — never the plaintext keys. A downloaded
 * keyfile is the same ciphertext in a JSON wrapper.
 */

import sodium from 'libsodium-wrappers-sumo';
import { ensureSodium, type Identity, type KeyRole, KEY_ROLES } from './keygen';
import {
	type WrappedCek,
	type WrappedCekPassphrase,
	isPassphraseWrap,
	CEK_BYTES,
	CEK_NONCE_BYTES,
	ARGON_SALT_BYTES,
	MAX_YUBIKEY_WRAPS
} from './yubikey/protocol';

/** On-disk / in-storage wrapper format.
 *
 * Two schemes coexist (Batch I, ADR-0017):
 *
 *   - 'simple-passphrase' (the original): one Argon2id-derived key
 *     directly encrypts the identity JSON.  This is what every pre-
 *     Batch-I keystore looks like, and what fresh seed-imports still
 *     produce until the user enrolls a YubiKey.
 *
 *   - 'layered-cek' (new): a random 32-byte CEK encrypts the identity
 *     JSON.  The CEK is then wrapped by one or more independent
 *     unwrap paths in `wraps[]`.  Each wrap produces the same CEK
 *     when unwrapped successfully.  This is the shape after YubiKey
 *     enrollment.
 *
 * Existing keystores in localStorage have no `scheme` field; readers
 * default to 'simple-passphrase' so they continue to load.
 */
export type KeystoreEnvelope = SimplePassphraseEnvelope | LayeredCekEnvelope;

/** Audit 2026-05 finding 1-4: typed error class so callers don't
 *  have to string-match on `Error.message` to distinguish wrong-
 *  password from envelope-tamper from identity-mismatch.  String
 *  matching is fragile to wording changes and across libsodium
 *  version bumps.  Switch on `kind` instead.
 *
 *  - 'bad_password'         — Argon2id-derived key did not decrypt
 *                             the wrap or envelope.  Retry with
 *                             different password is the right UX.
 *  - 'envelope_corrupt'     — structural tamper detected at parse/
 *                             validate time, or layered CEK had
 *                             wrong length, or the envelope's
 *                             stored KDF params were unsafe.  Retry
 *                             will not help; user should re-import
 *                             from seed/keyfile.
 *  - 'identity_mismatch'    — M6 envelope-replacement signature.
 *                             User should sign out and back in.
 *  - 'no_passphrase_wrap'   — layered envelope has no passphrase
 *                             wrap; user must use YubiKey unlock.
 *  - 'unsupported'          — version/scheme/KDF the code can't
 *                             handle.  Bug or future-format file. */
export type KeystoreErrorKind =
	| 'bad_password'
	| 'envelope_corrupt'
	| 'identity_mismatch'
	| 'no_passphrase_wrap'
	| 'unsupported';

export class KeystoreError extends Error {
	readonly kind: KeystoreErrorKind;
	constructor(kind: KeystoreErrorKind, message: string) {
		super(message);
		this.name = 'KeystoreError';
		this.kind = kind;
	}
}

/** The original single-wrap envelope.  Default when `scheme` is
 *  missing from a parsed envelope. */
export interface SimplePassphraseEnvelope {
	readonly scheme?: 'simple-passphrase';
	readonly v: 1;
	readonly kdf: 'argon2id';
	readonly kdfParams: {
		readonly opslimit: number;
		readonly memlimit: number;
	};
	readonly salt: string; // base64
	readonly nonce: string; // base64
	readonly ciphertext: string; // base64 — encrypted JSON of the identity
	readonly createdAt: number;
}

/** Layered envelope: CEK encrypts the identity, wraps[] each independently
 *  unlock the CEK.  See ADR-0017 for the threat-model rationale. */
export interface LayeredCekEnvelope {
	readonly scheme: 'layered-cek';
	readonly v: 1;
	/** Nonce for the AEAD that encrypts the identity-JSON to the CEK. */
	readonly cekNonce: string; // base64
	/** Identity-JSON ciphertext, encrypted with the CEK. */
	readonly ciphertext: string; // base64
	/** One or more independent unwrap paths to recover the CEK.
	 *  At least one must be present.  In the (A)→(B) progression:
	 *  state A has [passphrase, yubikey]; state B has [yubikey]. */
	readonly wraps: ReadonlyArray<WrappedCek>;
	readonly createdAt: number;
}

const DOMAIN = 'morphit-keystore-v1';

/**
 * Tuned for grandma's phone too — moderate Argon2id settings. Interactive
 * limits from libsodium (≈64MB memory, ~0.5s on a modern phone).
 *
 * IMPORTANT: these constants are only populated by libsodium AFTER
 * `sodium.ready` resolves. Reading them at module-import time would yield
 * `undefined`. Call `argonParams()` from inside an async function that has
 * already awaited `ensureSodium()`.
 */
function argonParams(): { ops: number; mem: number } {
	return {
		ops: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
		mem: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
	};
}

function toB64(bytes: Uint8Array): string {
	return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}
function fromB64(s: string): Uint8Array {
	return sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
}

/** Serialize an Identity to its canonical JSON form. Pubkeys as hex, privkeys as base64.
 *
 *  Schema:
 *    - `origin: 'morphit-seed' | 'posting-only'` (added Batch H — defaults to
 *      'morphit-seed' on read for any pre-Batch-H keystore that lacks it).
 *    - `seedBytes`: base64 of raw BIP-39 entropy, OR null for posting-only.
 *      We canonically store `null` (not omitted) so the schema stays explicit.
 *    - `keys`: per-role { pub, priv } pairs.  For posting-only origin,
 *      owner / active / memo are encoded as `null`.  For morphit-seed all four
 *      are present.
 */
function identityToJson(id: Identity): string {
	const keyObj: Record<string, { pub: string; priv: string } | null> = {};
	for (const role of KEY_ROLES) {
		const kp = id.keys[role];
		if (kp) {
			keyObj[role] = {
				pub: toB64(kp.publicKey),
				priv: toB64(kp.privateKey)
			};
		} else {
			keyObj[role] = null;
		}
	}
	return JSON.stringify({
		createdAt: id.createdAt,
		origin: id.origin,
		// K1.2 — store as bytes (base64) so we can zero them on
		// load.  The mnemonic string is reconstructed only when the
		// user explicitly wants to back it up via mnemonicForBackup.
		seedBytes: id.seedBytes ? toB64(id.seedBytes) : null,
		keys: keyObj
	});
}

/** Inverse of `identityToJson`. Returns a re-hydrated Identity.
 *
 *  Tolerates pre-Batch-H keystores that lack `origin` and have all four
 *  role slots populated — those are treated as `origin: 'morphit-seed'`.
 *  Defends against malformed schemas (a keystore claiming posting-only
 *  origin but with an `owner` key, or claiming morphit-seed origin but
 *  missing roles) by throwing.
 */
function jsonToIdentity(json: string): Identity {
	// Residual leak (SECURITY.md §1b): the `json` parameter is an
	// immutable JS string holding base64-encoded private keys; we
	// can't memzero it, it lives until GC.  What we CAN do is
	// minimize the number of object-property references to its
	// substrings so they're eligible for GC sooner.  After
	// fromB64() converts each priv string to a Uint8Array we own,
	// we null the `parsed.keys[role].priv` and `parsed.seedBytes`
	// fields so the only references to the priv substrings are
	// the ones rooted in `json` itself (which goes out of scope
	// when this function returns).  This doesn't fix the string-
	// immutability issue but it tightens the reference graph.
	const parsed = JSON.parse(json) as {
		createdAt: number;
		origin?: 'morphit-seed' | 'posting-only';
		seedBytes: string | null;
		keys: Record<string, { pub: string; priv: string } | null>;
	};

	const origin: 'morphit-seed' | 'posting-only' = parsed.origin ?? 'morphit-seed';
	if (origin !== 'morphit-seed' && origin !== 'posting-only') {
		throw new Error(`Unknown keystore origin: ${origin}`);
	}

	const keys: {
		owner: { role: KeyRole; publicKey: Uint8Array; privateKey: Uint8Array } | null;
		active: { role: KeyRole; publicKey: Uint8Array; privateKey: Uint8Array } | null;
		posting: { role: KeyRole; publicKey: Uint8Array; privateKey: Uint8Array };
		memo: { role: KeyRole; publicKey: Uint8Array; privateKey: Uint8Array } | null;
	} = {
		owner: null,
		active: null,
		// Posting is always required.
		posting: null as never,
		memo: null
	};

	for (const role of KEY_ROLES) {
		const raw = parsed.keys[role];
		if (raw === null || raw === undefined) {
			if (origin === 'morphit-seed') {
				throw new Error(`Missing key role in morphit-seed keystore: ${role}`);
			}
			if (role === 'posting') {
				throw new Error('posting-only keystore is missing the posting role');
			}
			// posting-only + non-posting role → legitimately null.
			continue;
		}
		const kp = {
			role,
			publicKey: fromB64(raw.pub),
			privateKey: fromB64(raw.priv)
		};
		// Drop the parsed object's references to the base64
		// strings.  The substrings themselves are still rooted
		// in `json` until GC, but `parsed.keys[role]` no longer
		// holds them in a freezable, long-lived structure.  The
		// type-cast to any is local; this function's return type
		// is unaffected.
		(raw as { priv?: string; pub?: string }).priv = undefined;
		(raw as { priv?: string; pub?: string }).pub = undefined;
		keys[role] = kp;
	}

	if (!keys.posting) {
		throw new Error('Keystore has no posting key');
	}

	let seedBytes: Uint8Array | null;
	if (parsed.seedBytes === null || parsed.seedBytes === undefined) {
		if (origin === 'morphit-seed') {
			throw new Error('morphit-seed keystore is missing seedBytes');
		}
		seedBytes = null;
	} else if (typeof parsed.seedBytes !== 'string') {
		throw new Error('Keystore seedBytes has wrong type');
	} else {
		seedBytes = fromB64(parsed.seedBytes);
		// Drop the parsed reference to the base64 seedBytes.
		(parsed as { seedBytes: string | null }).seedBytes = null;
	}

	return {
		createdAt: parsed.createdAt,
		origin,
		seedBytes,
		keys: Object.freeze(keys)
	};
}

/** Derive the symmetric key from password + salt via Argon2id. */
async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
	await ensureSodium();
	const { ops, mem } = argonParams();
	return sodium.crypto_pwhash(
		sodium.crypto_secretbox_KEYBYTES,
		password,
		salt,
		ops,
		mem,
		sodium.crypto_pwhash_ALG_ARGON2ID13
	);
}

/** Encrypt an identity under a user password.  Produces a simple-
 *  passphrase envelope (the original keystore format).  YubiKey
 *  enrollment migrates this to a layered envelope via
 *  upgradeToLayered() in keystoreYubikey.ts. */
export async function encryptIdentity(
	id: Identity,
	password: string
): Promise<SimplePassphraseEnvelope> {
	await ensureSodium();
	// Minimum length backstop — the UI's passwordStrength.ts
	// enforces 10 chars (or 12 + 3 character classes) for new
	// passwords on the post-page.  This 10-char floor is the
	// last-line-of-defense for any code path that didn't go
	// through that UI check (programmatic key-generation tests,
	// import-from-keystore flows, etc).  10 chars is the
	// MINIMUM that any keystore in this codebase will accept;
	// the UI is free to demand more.
	if (password.length < 10) {
		throw new Error('Password must be at least 10 characters');
	}
	const { ops, mem } = argonParams();
	const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const key = await deriveKey(password, salt);

	// Residual leak (documented in SECURITY.md §1b): identityToJson
	// returns a JS string that contains every private key base64-
	// encoded. JS strings are immutable; we cannot zero them.
	// TextEncoder.encode produces a Uint8Array we CAN zero
	// (memzero(plaintext) below), but the JSON string itself
	// lingers in the heap until GC — same fundamental K1.2
	// constraint that affected the mnemonic before seedBytes.
	// Cannot be eliminated without dropping JSON.
	const plaintext = new TextEncoder().encode(identityToJson(id));
	const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);

	// Zero the derived key and plaintext after use.
	sodium.memzero(key);
	sodium.memzero(plaintext);

	return {
		scheme: 'simple-passphrase',
		v: 1,
		kdf: 'argon2id',
		kdfParams: { opslimit: ops, memlimit: mem },
		salt: toB64(salt),
		nonce: toB64(nonce),
		ciphertext: toB64(ciphertext),
		createdAt: Date.now()
	};
}

/** Decrypt a keystore envelope back into an Identity using a passphrase.
 *
 * Handles both schemes:
 *   - simple-passphrase: passphrase-Argon2id derives the AEAD key
 *     that decrypts the identity directly.  (Pre-Batch-I behavior.)
 *   - layered-cek: passphrase-Argon2id derives a wrap key that
 *     unwraps the CEK.  CEK then decrypts the identity.  Tries each
 *     'passphrase' wrap until one succeeds; throws if none do.
 *
 * Throws on wrong password or corruption.  For layered envelopes
 * with no passphrase wrap (state B — yubikey-only), throws a
 * specific error so the UI can route to the YubiKey unlock flow.
 */
export async function decryptIdentity(env: KeystoreEnvelope, password: string): Promise<Identity> {
	await ensureSodium();
	if (env.v !== 1) throw new Error(`Unsupported keystore version: ${env.v}`);

	if (env.scheme === 'layered-cek') {
		return decryptLayeredWithPassphrase(env, password);
	}
	// scheme === 'simple-passphrase' or missing (legacy default).
	return decryptSimplePassphrase(env, password);
}

async function decryptSimplePassphrase(
	env: SimplePassphraseEnvelope,
	password: string
): Promise<Identity> {
	// Audit 2026-05 finding 1-1: structural validation parity with
	// the layered path.  Catches type/shape tampering up front
	// instead of failing late inside libsodium with a confusing
	// error.  validateSimpleEnvelope also calls assertSafeKdfParams.
	validateSimpleEnvelope(env);

	const salt = fromB64(env.salt);
	const nonce = fromB64(env.nonce);
	const ciphertext = fromB64(env.ciphertext);
	const key = await deriveKey(password, salt);

	let plaintext: Uint8Array;
	try {
		plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
	} catch {
		sodium.memzero(key);
		throw new KeystoreError('bad_password', 'Wrong password, or keystore is corrupt');
	}
	sodium.memzero(key);

	// Residual leak (documented in SECURITY.md §1b): the
	// TextDecoder.decode below produces a JS string holding the
	// full identity JSON (with base64-encoded private keys).  JS
	// strings are immutable — they cannot be sodium.memzero'd —
	// and live on the heap until GC.  JSON.parse in jsonToIdentity
	// then creates further immutable strings for the base64 'priv'
	// values.  Same fundamental K1.2 constraint that affected the
	// mnemonic string before we switched to seedBytes.  Cannot be
	// eliminated without dropping JSON entirely.  Exposure window
	// is short (microseconds for the bytes, until GC for the
	// strings).  An attacker with arbitrary heap read has already
	// won by being able to hook the KDF.  Nothing to do here
	// beyond documenting it.
	const id = jsonToIdentity(new TextDecoder().decode(plaintext));
	sodium.memzero(plaintext);
	return id;
}

/** Recover the CEK from a layered envelope using one of the
 *  passphrase wraps.  Tries each 'passphrase' kind in order; if any
 *  of them unwraps successfully, returns the CEK.  Throws with
 *  'no-passphrase-wrap' if there are no passphrase wraps (state B,
 *  yubikey-only) so the caller can show a YubiKey-required UI.
 *  Throws with 'wrong-password' if there are wraps but none of them
 *  matched the supplied password. */
async function recoverCekViaPassphrase(
	env: LayeredCekEnvelope,
	password: string
): Promise<Uint8Array> {
	const ppWraps = env.wraps.filter(isPassphraseWrap);
	if (ppWraps.length === 0) {
		throw new KeystoreError(
			'no_passphrase_wrap',
			'no-passphrase-wrap: this keystore is locked to a hardware key — use Unlock with YubiKey'
		);
	}
	for (const wrap of ppWraps) {
		assertSafeKdfParams(wrap.kdfParams);
		const salt = fromB64(wrap.salt);
		const wrapNonce = fromB64(wrap.nonce);
		const wrapCt = fromB64(wrap.ciphertext);
		const wrapKey = await deriveKey(password, salt);
		try {
			const cek = sodium.crypto_secretbox_open_easy(wrapCt, wrapNonce, wrapKey);
			sodium.memzero(wrapKey);
			if (cek.length !== CEK_BYTES) {
				sodium.memzero(cek);
				throw new KeystoreError('envelope_corrupt', 'layered: unwrapped CEK has wrong length');
			}
			return cek;
		} catch (e) {
			sodium.memzero(wrapKey);
			// Re-throw envelope_corrupt — it's not a "try the next
			// wrap" condition; it's a structural problem with this
			// specific wrap that the caller must surface.
			if (e instanceof KeystoreError && e.kind === 'envelope_corrupt') {
				throw e;
			}
			// Try the next passphrase wrap.  Multiple passphrase wraps
			// is unusual but legal — e.g., a user who set the same
			// passphrase across two enrollment sessions ends up with
			// two functionally-equivalent wraps.
		}
	}
	throw new KeystoreError('bad_password', 'Wrong password, or keystore is corrupt');
}

async function decryptLayeredWithPassphrase(
	env: LayeredCekEnvelope,
	password: string
): Promise<Identity> {
	// H3 fix: structurally validate before iterating wraps.  Without
	// this, a hostile envelope with many passphrase wraps causes
	// many Argon2id derivations on each unlock attempt — DoS vector.
	validateLayeredEnvelope(env);
	const cek = await recoverCekViaPassphrase(env, password);
	try {
		return decryptIdentityFromCek(env, cek);
	} finally {
		sodium.memzero(cek);
	}
}

/** Decrypt the layered envelope's identity-blob given an already-
 *  recovered CEK.  Internal helper used by both the passphrase
 *  unwrap path and (in keystoreYubikey.ts) the YubiKey unwrap path.
 *  Caller owns the CEK — does NOT zero it; that's the caller's job
 *  in their own finally. */
export function decryptIdentityFromCek(env: LayeredCekEnvelope, cek: Uint8Array): Identity {
	const cekNonce = fromB64(env.cekNonce);
	const ciphertext = fromB64(env.ciphertext);
	if (cek.length !== CEK_BYTES) {
		throw new Error('layered: CEK has wrong length');
	}
	let plaintext: Uint8Array;
	try {
		plaintext = sodium.crypto_secretbox_open_easy(ciphertext, cekNonce, cek);
	} catch {
		throw new KeystoreError('envelope_corrupt', 'layered: CEK does not decrypt the identity blob');
	}
	// Residual leak (SECURITY.md §1b): same JS-string-immutability
	// constraint as decryptSimplePassphrase — TextDecoder.decode +
	// JSON.parse produce immutable strings holding base64 priv keys
	// that live until GC.  Cannot be zeroed.
	const id = jsonToIdentity(new TextDecoder().decode(plaintext));
	sodium.memzero(plaintext);
	return id;
}

/** Reverse of decryptIdentityFromCek.  Encrypts the identity to a
 *  caller-provided CEK and produces the partial layered envelope
 *  fields (cekNonce + ciphertext).  The wraps[] array is the
 *  caller's responsibility, since it depends on whether the user
 *  is enrolling a passphrase, a YubiKey, or both. */
export async function encryptIdentityToCek(
	id: Identity,
	cek: Uint8Array
): Promise<{ cekNonce: Uint8Array; ciphertext: Uint8Array }> {
	await ensureSodium();
	if (cek.length !== CEK_BYTES) {
		throw new Error(`encryptIdentityToCek: CEK must be ${CEK_BYTES} bytes`);
	}
	const cekNonce = sodium.randombytes_buf(CEK_NONCE_BYTES);
	// Residual leak (SECURITY.md §1b): identityToJson produces a JS
	// string with base64-encoded privates, immutable, lives until
	// GC.  TextEncoder produces a zeroable Uint8Array but the
	// upstream string lingers.  Same K1.2 constraint.
	const plaintext = new TextEncoder().encode(identityToJson(id));
	const ciphertext = sodium.crypto_secretbox_easy(plaintext, cekNonce, cek);
	sodium.memzero(plaintext);
	return { cekNonce, ciphertext };
}

/** Build a passphrase wrap for a layered envelope.  The CEK is
 *  encrypted under an Argon2id-derived key so that the wrap can
 *  later be unwrapped via passphrase alone. */
export async function buildPassphraseWrap(
	cek: Uint8Array,
	password: string
): Promise<WrappedCekPassphrase> {
	await ensureSodium();
	// 10-char floor — see encryptIdentity for the rationale.
	// The UI enforces 10/12 + classes; the keystore enforces 10
	// as a backstop so non-UI callers still get a meaningful
	// minimum.
	if (password.length < 10) {
		throw new Error('Password must be at least 10 characters');
	}
	if (cek.length !== CEK_BYTES) {
		throw new Error('buildPassphraseWrap: CEK has wrong length');
	}
	const { ops, mem } = argonParams();
	const salt = sodium.randombytes_buf(ARGON_SALT_BYTES);
	const wrapNonce = sodium.randombytes_buf(CEK_NONCE_BYTES);
	const wrapKey = await deriveKey(password, salt);
	const wrapCt = sodium.crypto_secretbox_easy(cek, wrapNonce, wrapKey);
	sodium.memzero(wrapKey);
	return {
		kind: 'passphrase',
		kdf: 'argon2id',
		kdfParams: { opslimit: ops, memlimit: mem },
		salt: toB64(salt),
		nonce: toB64(wrapNonce),
		ciphertext: toB64(wrapCt)
	};
}

/** Generate a fresh CEK.  Caller owns the buffer and must zero it
 *  after use.  Convenience wrapper to keep CEK generation in one
 *  place — every layered-envelope writer uses this. */
export async function generateCek(): Promise<Uint8Array> {
	await ensureSodium();
	return sodium.randombytes_buf(CEK_BYTES);
}

/** Defensive minimums for KDF parameters in a stored envelope. */
const MIN_KDF_OPSLIMIT = 1;
const MIN_KDF_MEMLIMIT = 1 << 20; // 1 MB

function assertSafeKdfParams(p: { opslimit: number; memlimit: number } | undefined): void {
	if (
		!p ||
		typeof p.opslimit !== 'number' ||
		typeof p.memlimit !== 'number' ||
		p.opslimit < MIN_KDF_OPSLIMIT ||
		p.memlimit < MIN_KDF_MEMLIMIT
	) {
		throw new Error('Keystore envelope has invalid or unsafe KDF parameters');
	}
}

/** Validate the structure of a layered-cek envelope.  Called by any
 *  reader before it acts on the envelope; defends against tampered
 *  on-disk JSON.  Throws on any structural problem so callers don't
 *  have to repeat the same checks.
 *
 *  Per audit findings (M7, L9):
 *  - At most one passphrase wrap permitted (production never creates
 *    more than one; multiple-passphrase wraps in an envelope smell of
 *    tampering).
 *  - At most MAX_YUBIKEY_WRAPS yubikey wraps.
 *  - Per-wrap fields validated (slot, schemaVersion, base64 lengths)
 *    not just kdfParams. */
/** Audit 2026-05 finding 1-1: structural validator for the
 *  simple-passphrase envelope, parallel to validateLayeredEnvelope.
 *  Pre-fix, only KDF params were checked at decrypt time;
 *  malformed-shape envelopes (wrong field types, missing fields)
 *  failed late inside libsodium with confusing errors, and the
 *  early-out path in `blobToEnvelope` / `readEnvelope` did not run
 *  this check at all.  Now both call sites validate at parse time
 *  for both schemes. */
export function validateSimpleEnvelope(env: SimplePassphraseEnvelope): void {
	if (env.scheme !== undefined && env.scheme !== 'simple-passphrase') {
		throw new Error(`Wrong scheme for simple validator: ${String(env.scheme)}`);
	}
	if (env.v !== 1) throw new Error(`Unsupported envelope version: ${env.v}`);
	if (env.kdf !== 'argon2id') throw new Error(`Unsupported KDF: ${env.kdf}`);
	if (typeof env.salt !== 'string' || env.salt.length === 0) {
		throw new Error('Envelope salt must be a non-empty string');
	}
	if (typeof env.nonce !== 'string' || env.nonce.length === 0) {
		throw new Error('Envelope nonce must be a non-empty string');
	}
	if (typeof env.ciphertext !== 'string' || env.ciphertext.length === 0) {
		throw new Error('Envelope ciphertext must be a non-empty string');
	}
	if (typeof env.createdAt !== 'number' || !Number.isFinite(env.createdAt)) {
		throw new Error('Envelope createdAt must be a finite number');
	}
	assertSafeKdfParams(env.kdfParams);
}

export function validateLayeredEnvelope(env: LayeredCekEnvelope): void {
	if (env.scheme !== 'layered-cek') throw new Error('not a layered envelope');
	if (env.v !== 1) throw new Error(`Unsupported layered envelope version: ${env.v}`);
	if (typeof env.cekNonce !== 'string' || typeof env.ciphertext !== 'string') {
		throw new Error('Layered envelope cekNonce/ciphertext must be strings');
	}
	if (!Array.isArray(env.wraps) || env.wraps.length === 0) {
		throw new Error('Layered envelope must have at least one wrap');
	}
	let passphraseCount = 0;
	let yubikeyCount = 0;
	for (const w of env.wraps) {
		if (w.kind === 'passphrase') {
			passphraseCount++;
		} else if (w.kind === 'yubikey') {
			yubikeyCount++;
			// L3 + L9: verify slot is one of {1, 2}
			if (w.slot !== 1 && w.slot !== 2) {
				throw new Error(`Yubikey wrap has invalid slot: ${w.slot}`);
			}
			if (w.schemaVersion !== 1) {
				throw new Error(`Unsupported yubikey wrap schema: ${w.schemaVersion}`);
			}
			if (typeof w.challenge !== 'string') {
				throw new Error('Yubikey wrap challenge must be a string');
			}
			if (typeof w.label !== 'string') {
				throw new Error('Yubikey wrap label must be a string');
			}
		} else {
			throw new Error(`Unknown wrap kind: ${(w as { kind: string }).kind}`);
		}
		if (
			typeof w.salt !== 'string' ||
			typeof w.nonce !== 'string' ||
			typeof w.ciphertext !== 'string'
		) {
			throw new Error('Wrap salt/nonce/ciphertext must be strings');
		}
		assertSafeKdfParams(w.kdfParams);
	}
	// M7: at most one passphrase wrap.  Production code never creates
	// two; multiple = tampering signal.
	if (passphraseCount > 1) {
		throw new Error('Layered envelope has multiple passphrase wraps (only one permitted)');
	}
	if (yubikeyCount > MAX_YUBIKEY_WRAPS) {
		throw new Error(`Layered envelope has too many yubikey wraps (max ${MAX_YUBIKEY_WRAPS})`);
	}
}

/**
 * Produce a downloadable keyfile blob. The browser hands this to the user
 * as a Save dialog; it never travels over the network.
 */
export function envelopeToBlob(env: KeystoreEnvelope): Blob {
	const wrapper = {
		format: DOMAIN,
		...env
	};
	return new Blob([JSON.stringify(wrapper, null, 2)], { type: 'application/json' });
}

/** Maximum size of a keyfile we'll attempt to parse.  Real
 *  Morphit envelopes are ~1 KB; the cap gives plenty of room
 *  for envelope-format growth while preventing pathological
 *  imports.  A user clicking "import" on a 10 GB file would
 *  otherwise hang their browser allocating the buffer.  See
 *  Finding K1.4. */
const MAX_KEYFILE_BYTES = 64 * 1024;

/** Parse a user-supplied keyfile back into an envelope. */
export async function blobToEnvelope(blob: Blob): Promise<KeystoreEnvelope> {
	if (blob.size > MAX_KEYFILE_BYTES) {
		throw new Error(`Keyfile too large (${blob.size} bytes; cap is ${MAX_KEYFILE_BYTES})`);
	}
	const text = await blob.text();
	const parsed = JSON.parse(text) as { format?: string } & KeystoreEnvelope;
	if (parsed.format !== DOMAIN) {
		throw new Error('Not a Morphit keyfile');
	}
	// P5-2 + audit 2026-05 finding 1-1: defense-in-depth — validate
	// structure at parse time for BOTH schemes so callers don't
	// have to remember.  Layered → validateLayeredEnvelope;
	// simple-passphrase (default scheme) → validateSimpleEnvelope.
	if (parsed.scheme === 'layered-cek') {
		validateLayeredEnvelope(parsed);
	} else {
		validateSimpleEnvelope(parsed as SimplePassphraseEnvelope);
	}
	return parsed;
}

/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  ELI5 — what is "active key" here?  (NOT YubiKey-related!)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *  This function has nothing to do with YubiKey unlock.  The naming
 *  collision is unfortunate: Morphit also has YubiKey unlock paths,
 *  and they both use the word "active" but mean different things.
 *
 *  Here, "active" refers to one of Blurt's four CHAIN-LEVEL ROLE KEYS:
 *
 *    owner   — highest authority.  Can change ALL keys including itself.
 *              The "nuclear" key.  Used for account recovery only.
 *    active  — second highest.  Can move funds (transfer BLURT).  Used
 *              by exchanges and trading.
 *    posting — third.  Can post, comment, vote.  The "social" key.
 *    memo    — encrypts memos in private transfers.
 *
 *  Blurt requires DIFFERENT key tiers for different operations.  A
 *  comment is signed with `posting`; a fund transfer is signed with
 *  `active`; an account-create or key-rotation is signed with `owner`.
 *
 *  ─── Morphit's policy on these tiers ────────────────────────────────
 *
 *  • OWNER key — Morphit will NEVER use this in normal operation.
 *    Account creation is the ONLY conceivable trigger, and even that
 *    is a new-account-creation flow we haven't shipped yet.  Once a
 *    Morphit account exists, the owner key sits encrypted in the
 *    keystore and is NEVER touched again.  If you find yourself
 *    writing code that calls `useOwnerKey`, stop and double-check.
 *
 *  • ACTIVE key — Morphit AVOIDS this in normal operation too.  The
 *    only legitimate triggers in current code:
 *      - The user is paying a BLURT transfer fee for a trade (this
 *        IS active-key signing — required by the chain).
 *      - The user is bidding on a Featured-listing slot (also a
 *        BLURT transfer, also active-key).
 *      - The user is paying a stranger-fee escrow.
 *      - First-time account signup (when we wire that — not shipped).
 *    All of these prompt the user for their password and run for
 *    ~10ms then wipe.  No long-lived active-key state.
 *
 *  • POSTING key — used CONSTANTLY (every order, every chat message,
 *    every comment).  Lives in memory for the session via the
 *    LiveIdentity store.  See keygen.ts's KEY HANDLING CONTRACT.
 *
 *  ─── What this function does ────────────────────────────────────────
 *
 *  Just-in-time unlock of the active-tier private key.  The caller
 *  provides their password and a callback that needs the key for
 *  exactly one signing operation.  We decrypt the whole keystore,
 *  extract ONLY the active role, wipe the rest immediately, hand the
 *  key to the callback, and then wipe it whether the callback
 *  resolved or threw.
 *
 *  Why this shape: calling code cannot forget to zero the key.  It is
 *  physically impossible to keep a reference alive past the await —
 *  the finally block runs first.
 *
 *  Typical usage (BLURT fee payment):
 *
 *    const signedTx = await useActiveKey(envelope, password,
 *      async (activePriv) => {
 *        return await signBlurtTransfer(activePriv, transferOp);
 *      },
 *      liveIdentity.posting.publicKey  // M6: pin to live session
 *    );
 *
 *  The user's active private key lives in JS memory for ~milliseconds.
 *
 *  @param expectedPostingPub Optional posting-key pubkey of the live
 *    session.  When supplied, useJitKey verifies that the freshly
 *    decrypted envelope's posting pubkey matches.  Used as the M6
 *    defense against cross-tab envelope replacement attacks.  Callers
 *    that have access to the running session's pubkey SHOULD pass it.
 *
 *  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */
export async function useActiveKey<T>(
	env: KeystoreEnvelope,
	password: string,
	fn: (activePrivateKey: Uint8Array) => Promise<T>,
	expectedPostingPub: Uint8Array
): Promise<T> {
	return useJitKey(env, password, 'active', fn, expectedPostingPub);
}

/** P5-4 audit fix: variant of useActiveKey that SKIPS the M6
 *  pubkey-pin check.  Reserved for the password-change flow which
 *  by definition doesn't have a running session to compare against
 *  — the user is decrypting an envelope they just supplied (e.g.
 *  from a keyfile) before re-encrypting under a new password.
 *
 *  DO NOT call this from any other code path.  If you have a
 *  running session, use useActiveKey and pass
 *  liveIdentity.posting.publicKey. */
export async function useActiveKeyForPasswordChange<T>(
	env: KeystoreEnvelope,
	password: string,
	fn: (activePrivateKey: Uint8Array) => Promise<T>
): Promise<T> {
	return useJitKey(env, password, 'active', fn, undefined);
}

/**
 * Just-in-time unlock of the BLURT OWNER private key.
 *
 * ELI5: the owner key is Blurt's "nuclear" credential — it can
 * change every other key on the account including itself.  Compromising
 * it = full account takeover.  Morphit's policy is to NEVER use this
 * key in normal operation.  See useActiveKey above for the full role-
 * key tier explainer.
 *
 * The only legitimate trigger is account creation (one signature, once
 * in the lifetime of the account, never again) or key rotation (a
 * recovery operation the user explicitly initiates).  Account creation
 * isn't shipped yet; key rotation isn't shipped yet either.  In the
 * current code path, this function is effectively dead — it exists for
 * the future flows that will need it.
 *
 * If you're reading this comment because you just landed in the
 * function, ask yourself whether the path you're on is REALLY one of
 * those two scenarios.  If it isn't, you should be using
 * `useActiveKey` (for BLURT transfers) or just the live posting key
 * (for chat/orders/comments) instead.
 *
 * Same safety contract as `useActiveKey`: decrypt → extract one role
 * → wipe everything else → run callback → wipe the role's key on
 * success or throw.  The owner private lives in JS memory for
 * ~milliseconds.
 */
export async function useOwnerKey<T>(
	env: KeystoreEnvelope,
	password: string,
	fn: (ownerPrivateKey: Uint8Array) => Promise<T>,
	expectedPostingPub: Uint8Array
): Promise<T> {
	return useJitKey(env, password, 'owner', fn, expectedPostingPub);
}

/** Internal: shared JIT pattern for either recovery-tier role.
 *
 *  M6 fix: optional `expectedPostingPub` lets the caller pin the
 *  identity that's allowed to come out of the decrypt.  If a
 *  cross-tab attacker (M6 in audit) replaced the persisted
 *  envelope with one decrypting to a different account under the
 *  same password, the pubkey mismatch fires here and we refuse to
 *  hand the JIT key to the callback.  The mismatch case wipes the
 *  decrypted identity before throwing so attacker-chosen private
 *  keys don't linger.
 *
 *  When `expectedPostingPub` is undefined, the pubkey-match check
 *  is skipped — used only by callers that don't have a live
 *  identity to compare against (none in current code; reserved for
 *  future password-change flows that operate on a freshly-supplied
 *  envelope rather than the running session). */
async function useJitKey<T>(
	env: KeystoreEnvelope,
	password: string,
	role: 'active' | 'owner',
	fn: (privateKey: Uint8Array) => Promise<T>,
	expectedPostingPub?: Uint8Array
): Promise<T> {
	await ensureSodium();
	const full = await decryptIdentity(env, password);

	// M6: posting-pubkey continuity check.  A hostile cross-tab
	// XSS that knows the user's password could have planted a new
	// envelope decrypting to a DIFFERENT identity under that same
	// password.  Without this check, the JIT path would happily
	// hand the attacker's active key to the broadcast callback —
	// the callback would sign a chain op with the WRONG keys for
	// the user's account, the chain would reject, and the user's
	// transaction would fail mysteriously.  Worse, in scenarios
	// where the live session's posting pubkey is also displayed in
	// chat, the user might think they signed as themselves.
	if (expectedPostingPub) {
		const decryptedPub = full.keys.posting?.publicKey;
		if (
			!decryptedPub ||
			decryptedPub.length !== expectedPostingPub.length ||
			!constantTimeEqual(decryptedPub, expectedPostingPub)
		) {
			// Wipe everything before throwing — don't leak the
			// attacker's private keys onto the heap longer than
			// necessary.
			for (const r of ['owner', 'active', 'posting', 'memo'] as const) {
				const kp = full.keys[r];
				if (kp) sodium.memzero(kp.privateKey);
			}
			if (full.seedBytes) sodium.memzero(full.seedBytes);
			throw new KeystoreError(
				'identity_mismatch',
				'useJitKey: envelope decrypted to a different identity than the live session — ' +
					'the persisted keystore may have been tampered with.  Sign out and sign in again.'
			);
		}
	}

	// Posting-only identities (Batch H) genuinely lack owner/active.
	// Surface a precise error rather than dereferencing a null slot.
	const target = full.keys[role];
	if (!target) {
		// Wipe what we did decrypt before throwing.
		if (full.keys.posting) sodium.memzero(full.keys.posting.privateKey);
		if (full.seedBytes) sodium.memzero(full.seedBytes);
		throw new Error(
			`useJitKey: this account was imported posting-only — ${role} key is not available on Morphit`
		);
	}

	// We only need the one role. Isolate its private key bytes as our own
	// copy, then zero EVERYTHING else in `full` immediately.
	const wanted = target.privateKey.slice();
	for (const r of ['owner', 'active', 'posting', 'memo'] as const) {
		const kp = full.keys[r];
		if (kp) sodium.memzero(kp.privateKey);
	}
	// K1.2 — zero seedBytes too.  Each JIT unlock allocates a
	// fresh full identity via decryptIdentity → jsonToIdentity;
	// without this wipe each unlock leaves a copy of the seed
	// in heap until GC.  Posting-only identities have no seedBytes.
	if (full.seedBytes) sodium.memzero(full.seedBytes);

	try {
		return await fn(wanted);
	} finally {
		// Always wipe — success or exception.
		sodium.memzero(wanted);
	}
}

/** Constant-time bytewise equality.  Used in M6's pubkey-match
 *  check.  Pubkeys are 33-byte compressed points; the comparison
 *  is on public material so leakage isn't a real concern, but
 *  using constant-time keeps the pattern consistent and avoids
 *  setting a bad example. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return diff === 0;
}
