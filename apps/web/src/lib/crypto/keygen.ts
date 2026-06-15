/**
 * Morphit — client-side key generation
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  KEY HANDLING CONTRACT — READ BEFORE TOUCHING THIS FILE
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *  Private keys produced by this module:
 *
 *    1. MUST NOT appear in any `fetch`, `XHR`, `WebSocket`, or
 *       `postMessage()` call destined off-device.
 *    2. MUST NOT be logged (no `console.log`, no error-reporter, no
 *       analytics — we have none, but belt-and-braces).
 *    3. MUST NOT be written to any storage other than an Argon2id-
 *       encrypted keystore (see `keystore.ts`).
 *    4. SHOULD be zeroed after use where the JS engine permits.
 *
 *  ─── POSTING / MEMO ONLY IN LIVE MEMORY ────────────────────────────────
 *
 *  Blurt has four key roles: owner, active, posting, memo. Morphit runs
 *  with a strict tier policy — sessions hold posting + memo private keys
 *  only; owner and active live exclusively in the encrypted keystore and
 *  are reached via `useActiveKey` / `useOwnerKey` JIT-unlock callbacks in
 *  keystore.ts. The LiveIdentity type enforces this structurally.
 *
 *  ─── BIP-39 (Phase 2) ──────────────────────────────────────────────────
 *
 *  Phase 1 shipped a placeholder 64-word wordlist. Phase 2 uses the
 *  canonical BIP-39 English wordlist via @scure/bip39 — so a Morphit
 *  seed phrase is a real BIP-39 mnemonic that any wallet/tool can
 *  understand. A user can back up their Morphit identity with hardware
 *  wallets or other BIP-39 tooling.
 *
 *  The derivation pipeline:
 *    BIP-39 mnemonic  →  BIP-39 seed (PBKDF2-HMAC-SHA-512, 2048 rounds)
 *                     →  master key (BLAKE2b, domain "morphit-v1/master")
 *                     →  per-role key (BLAKE2b, domain "morphit-v1/<role>")
 *                     →  secp256k1 keypair (@noble/secp256k1)
 *
 *  The per-role BLAKE2b expansion is Morphit-specific, but the SEED is
 *  interoperable: the same 12 words in any BIP-39 tool will produce the
 *  same master seed bytes. Phase 5 will add an option to export the
 *  identity as a BIP-32 xprv for interoperability with hardware wallets.
 *
 *  Note: Phase 2 originally used Ed25519 here, which was incompatible
 *  with Blurt's secp256k1 consensus. ADR-0007 records the migration.
 *  The only operational impact was on the final step (material → keypair);
 *  the upstream BIP-39 + BLAKE2b pipeline is unchanged.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

import { sodium, ensureSodium } from './sodium';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import * as secp256k1 from '@noble/secp256k1';
// Note (cp165 byte budget): we DELIBERATELY do NOT statically import
// `PublicKey` from `@beblurt/dblurt` here.  `keygen.ts` is reached
// transitively from `$lib/stores/identity.ts`, which is loaded on
// essentially every authenticated page; a static dblurt import here
// would pull the 2 MB / 424 KB Brotli dblurt+libsodium+secp256k1
// chunk onto every signed-in user's first paint even when they're
// not signing anything.  The single dblurt-using function
// (`formatPublicKeyBLT`) is action-triggered (account-name verify,
// onboarding register), so it dynamically imports dblurt on first
// call.  See cp165 audit + REVISIT-LIST.

/** Blurt's four key roles. */
export type KeyRole = 'owner' | 'active' | 'posting' | 'memo';
export const KEY_ROLES: readonly KeyRole[] = ['owner', 'active', 'posting', 'memo'] as const;

/** Roles permitted to live in the running session's memory. */
export const LIVE_ROLES: readonly ('posting' | 'memo')[] = ['posting', 'memo'] as const;

/** Roles that must only be handled just-in-time. */
export const JIT_ROLES: readonly ('owner' | 'active')[] = ['owner', 'active'] as const;

export interface Keypair {
	readonly role: KeyRole;
	readonly publicKey: Uint8Array;
	/** Never serialize this to network. See KEY HANDLING CONTRACT above. */
	readonly privateKey: Uint8Array;
}

/**
 * The full set of four keypairs. Created during keygen/import, written to
 * the encrypted keystore, then wiped from memory except for posting +
 * memo. No code path outside of keygen, import, keystore, or JIT unlock
 * should ever hold a FullIdentity.
 *
 * Seed handling (Finding K1.2):
 *  Previously this carried `seed: string` (the BIP-39 mnemonic).  JS
 *  strings are immutable — they can't be `sodium.memzero`'d — so the
 *  mnemonic survived in the heap until GC reclaimed it.  An attacker
 *  with memory access (browser exploit, malicious extension) could
 *  read it and re-derive every key.  We now carry `seedBytes`: the
 *  16- or 32-byte BIP-39 entropy, which IS a Uint8Array and CAN be
 *  zeroed when no longer needed.  The mnemonic string is reconstructed
 *  on demand via `mnemonicForBackup` only at the moment we need to
 *  display it to the user (during onboarding's "write this down"
 *  step).  Once converted to a string for display, that string is
 *  the user's responsibility from there — it's already on their
 *  screen anyway.
 */
export interface FullIdentity {
	readonly createdAt: number;
	/** What kind of identity this is.  Determines which slots are
	 *  populated (see field-level docs below).  Default 'morphit-seed'
	 *  for any identity created via generateFullIdentity or
	 *  importFullIdentityFromSeed; 'posting-only' only via
	 *  importPostingOnlyFullIdentity (Batch H — existing-Blurt-account
	 *  import path). */
	readonly origin: 'morphit-seed' | 'posting-only';
	/** Raw BIP-39 entropy bytes — 16 bytes for 12-word mnemonics
	 *  (the only form Morphit supports).  The mnemonic itself
	 *  (a string) is
	 *  not stored on the identity; reconstruct via `mnemonicForBackup`
	 *  when display is needed.  See Finding K1.2.  This Uint8Array is
	 *  intended to be wiped (`sodium.memzero`) when the identity is
	 *  destroyed.
	 *
	 *  NULL when origin === 'posting-only': the user imported a single
	 *  posting WIF, no mnemonic was ever derived. */
	readonly seedBytes: Uint8Array | null;
	/** All four key roles when origin === 'morphit-seed'; only the
	 *  `posting` role when origin === 'posting-only'.  The other three
	 *  slots are null in the posting-only case — owner/active/memo
	 *  can't be derived from a single role-key WIF. */
	readonly keys: {
		readonly owner: Keypair | null;
		readonly active: Keypair | null;
		readonly posting: Keypair;
		readonly memo: Keypair | null;
	};
	/** Optional TOTP enrollment.  When present, the keystore unlock
	 *  flow gates on a successful TOTP code verification AFTER the
	 *  password decrypts the envelope.  See `apps/web/src/lib/auth/totp.ts`
	 *  for the honest threat-model framing (session gate, not crypto
	 *  wrap — the secret lives in the same encrypted blob as the keys).
	 *
	 *  NULL means TOTP is not enrolled.  Field omitted on the JSON
	 *  wire for keystores that pre-date 2FA enrollment.
	 *
	 *  The shared secret is 20 raw bytes (160 bits, RFC 4226 §4).
	 *  Encoded base64 on the JSON wire. */
	readonly totpSecret?: Uint8Array | null;
	/** Optional backup-code slots, paired with `totpSecret`.  10
	 *  hashed slots (Argon2id MODERATE).  Each is single-use; the
	 *  `used` flag is flipped in-place after redemption and the
	 *  keystore is re-saved.
	 *
	 *  When `totpSecret` is null, this is also null/omitted.  When
	 *  the user re-generates backup codes (settings → "Regenerate"),
	 *  the entire slot array is replaced. */
	readonly totpBackupCodes?: ReadonlyArray<{
		readonly hash: string;
		readonly used: boolean;
		readonly usedAt: number;
	}> | null;
}

/**
 * The in-memory identity of a running Morphit session. Posting and memo
 * PRIVATE keys are live; owner and active are exposed only as public
 * keys (for display / lookup).
 */
export interface LiveIdentity {
	readonly createdAt: number;
	/** Mirrors FullIdentity.origin.  Posting-only sessions cannot use
	 *  the JIT-unlock owner/active flow (those keys do not exist), so
	 *  any future feature that needs an active-key signature must
	 *  guard with `live.origin === 'morphit-seed'`. */
	readonly origin: 'morphit-seed' | 'posting-only';
	readonly posting: Keypair;
	/** Null for posting-only imports.  Chat encryption today uses
	 *  posting (deriveChatIdentity), not memo, so chat works with
	 *  posting-only sessions; this field exists for forward-compat
	 *  if a future chain op requires the memo private. */
	readonly memo: Keypair | null;
	/** Null for posting-only imports. */
	readonly ownerPublicKey: Uint8Array | null;
	/** Null for posting-only imports. */
	readonly activePublicKey: Uint8Array | null;
}

// ensureSodium now lives in ./sodium (lazy dynamic import of libsodium).
// Re-exported here so existing `import { ensureSodium } from './keygen'`
// call sites (keystore, wif, backupCodes, yubikey, …) keep working.
export { ensureSodium };

// ────────────────────────────────────────────────────────────────────────────
// BIP-39 layer
// ────────────────────────────────────────────────────────────────────────────

/** Generate a fresh 12-word (128-bit) BIP-39 mnemonic. */
export function generateMnemonic(): string {
	return bip39.generateMnemonic(wordlist, 128);
}

/**
 * Validate a user-supplied mnemonic against BIP-39: must be exactly 12
 * words from the English wordlist, with a valid checksum.
 *
 * Morphit only generates and supports 12-word seeds.  Although BIP-39
 * itself defines 12/15/18/21/24-word forms, we accept ONLY 12 to keep
 * the supported surface tight, the user-facing copy honest ("12 words.
 * In order. On paper."), and the import-validation path consistent
 * with what Morphit ever produces.  A user who has a 24-word mnemonic
 * from another wallet should use that wallet — Morphit is not a
 * cross-format BIP-39 import tool.
 */
export function validateMnemonic(seed: string): boolean {
	const normalized = seed.trim().toLowerCase().split(/\s+/).join(' ');
	const words = normalized.split(' ');
	if (words.length !== 12) return false;
	return bip39.validateMnemonic(normalized, wordlist);
}

/**
 * BIP-39 seed derivation — PBKDF2-HMAC-SHA-512, 2048 rounds, no passphrase.
 * The returned 64-byte seed is the standard BIP-39 output that all
 * BIP-39 tools produce; Morphit's own derivation continues from here.
 */
async function mnemonicToBip39Seed(mnemonic: string): Promise<Uint8Array> {
	return await bip39.mnemonicToSeed(mnemonic);
}

// ────────────────────────────────────────────────────────────────────────────
// Per-role derivation — Morphit-specific, domain-separated
// ────────────────────────────────────────────────────────────────────────────

async function deriveKeyForRole(seed: Uint8Array, role: KeyRole): Promise<Keypair> {
	await ensureSodium();
	const info = new TextEncoder().encode(`morphit-v1/${role}`);
	// Initial attempt uses the raw domain-separated BLAKE2b output.
	// If that happens to be 0 or >= curve-order (combined probability
	// ~2⁻¹²⁸), we rehash with a counter suffix until we find valid
	// material. Deterministic: same mnemonic always produces the same
	// keys, even through the retry path.
	let material = sodium.crypto_generichash(32, info, seed);
	let counter = 0;
	while (!secp256k1.utils.isValidPrivateKey(material)) {
		sodium.memzero(material);
		const infoWithCounter = new TextEncoder().encode(`morphit-v1/${role}/${counter}`);
		material = sodium.crypto_generichash(32, infoWithCounter, seed);
		counter++;
		// Defensive: should never happen, but cap the loop so a
		// pathologically bad seed can't hang the browser tab.
		if (counter > 1024) {
			sodium.memzero(material);
			throw new Error(
				`keygen: could not derive a valid secp256k1 scalar for role "${role}" after 1024 attempts`
			);
		}
	}
	// Public key: 33-byte compressed secp256k1 point (matches BLT format).
	const publicKey = secp256k1.getPublicKey(material, true);
	// Private key: we keep the raw 32-byte scalar. dblurt's PrivateKey
	// accepts Uint8Array and treats it as the scalar.
	const privateKey = new Uint8Array(material);
	sodium.memzero(material);
	return {
		role,
		publicKey,
		privateKey
	};
}

async function masterSeedFromBip39Seed(bip39Seed: Uint8Array): Promise<Uint8Array> {
	await ensureSodium();
	return sodium.crypto_generichash(32, new TextEncoder().encode('morphit-v1/master'), bip39Seed);
}

async function deriveAllFromMasterSeed(masterSeed: Uint8Array): Promise<Record<KeyRole, Keypair>> {
	return {
		owner: await deriveKeyForRole(masterSeed, 'owner'),
		active: await deriveKeyForRole(masterSeed, 'active'),
		posting: await deriveKeyForRole(masterSeed, 'posting'),
		memo: await deriveKeyForRole(masterSeed, 'memo')
	};
}

// ────────────────────────────────────────────────────────────────────────────
// FullIdentity factories
// ────────────────────────────────────────────────────────────────────────────

export async function generateFullIdentity(): Promise<FullIdentity> {
	await ensureSodium();
	// We unavoidably have the mnemonic as a string here for one
	// micro-moment to call mnemonicToBip39Seed.  After this function
	// returns, no reference to the string is retained — it becomes
	// GC-eligible.  This is the residual K1.2 surface during
	// generation (vs the persistent surface that the fix targets,
	// which was the mnemonic living for the full session in
	// FullIdentity.seed).
	const mnemonic = generateMnemonic();
	const seedBytes = bip39.mnemonicToEntropy(mnemonic, wordlist);
	const bip39Seed = await mnemonicToBip39Seed(mnemonic);
	const masterSeed = await masterSeedFromBip39Seed(bip39Seed);
	const keys = await deriveAllFromMasterSeed(masterSeed);
	sodium.memzero(bip39Seed);
	sodium.memzero(masterSeed);
	return {
		createdAt: Date.now(),
		origin: 'morphit-seed',
		seedBytes,
		keys: Object.freeze(keys)
	};
}

export async function importFullIdentityFromSeed(seed: string): Promise<FullIdentity> {
	await ensureSodium();
	const normalized = seed.trim().toLowerCase().split(/\s+/).join(' ');
	const words = normalized.split(' ');
	if (words.length !== 12) {
		throw new Error('Seed must be 12 words');
	}
	if (!validateMnemonic(normalized)) {
		throw new Error('Invalid seed phrase (bad word or checksum)');
	}
	const seedBytes = bip39.mnemonicToEntropy(normalized, wordlist);
	const bip39Seed = await mnemonicToBip39Seed(normalized);
	const masterSeed = await masterSeedFromBip39Seed(bip39Seed);
	const keys = await deriveAllFromMasterSeed(masterSeed);
	sodium.memzero(bip39Seed);
	sodium.memzero(masterSeed);
	return {
		createdAt: Date.now(),
		origin: 'morphit-seed',
		seedBytes,
		keys: Object.freeze(keys)
	};
}

/**
 * Posting-key-only import (Batch H).
 *
 * Constructs a FullIdentity from a single Blurt posting WIF.  The
 * other three role slots (owner / active / memo) are left null —
 * Morphit's existing signing paths (orders, comments, chat) only
 * consume `posting`, so a posting-only identity remains fully
 * functional.  Future features that genuinely require an active
 * key MUST guard with `live.origin === 'morphit-seed'` and surface
 * a clear "this account doesn't have its active key on Morphit"
 * message, not silently produce a broken signature.
 *
 * IMPORTANT: this function does NOT verify the WIF against the
 * chain.  The caller (the import route) is responsible for fetching
 * the account-by-name and confirming the derived public key matches
 * `account.posting.key_auths[0]`.  See WifVerifyError in the route
 * for the screaming-error case where a user pasted their ACTIVE
 * key by mistake — that defense lives there, not here, because
 * keygen has no chain-fetch capability and we don't want to add
 * one.
 *
 * Caller responsibilities:
 *   - The `rawScalar` parameter is the 32-byte secp256k1 scalar
 *     produced by wifToRawPrivateKey.  This function takes ownership;
 *     the caller must not zero or reuse it after the call returns.
 *     We clone before sealing so the FullIdentity holds an
 *     independent buffer.
 */
export async function importPostingOnlyFullIdentity(rawScalar: Uint8Array): Promise<FullIdentity> {
	await ensureSodium();
	if (rawScalar.length !== 32) {
		throw new Error(
			`importPostingOnlyFullIdentity: expected 32-byte scalar, got ${rawScalar.length}`
		);
	}
	// Reject zero / invalid scalars before invoking secp256k1.
	let allZero = 0;
	for (let i = 0; i < 32; i++) allZero |= rawScalar[i] ?? 0;
	if (allZero === 0) {
		throw new Error('importPostingOnlyFullIdentity: zero scalar is not a valid private key');
	}
	const publicKey = secp256k1.getPublicKey(rawScalar, true);
	const privateKey = new Uint8Array(rawScalar);
	const posting: Keypair = {
		role: 'posting',
		publicKey,
		privateKey
	};
	return {
		createdAt: Date.now(),
		origin: 'posting-only',
		seedBytes: null,
		keys: Object.freeze({
			owner: null,
			active: null,
			posting,
			memo: null
		})
	};
}

/**
 * Reconstruct the BIP-39 mnemonic from the stored entropy bytes for
 * display to the user (e.g., during the onboarding "write this down"
 * step, or a future "show me my seed phrase again" feature).
 *
 * The resulting STRING is unavoidable — the user has to read it.
 * Once it's on their screen, mitigation is the user's responsibility
 * (don't screenshot, don't paste into a chat, etc.).  Caller-side
 * exposure ends as soon as Svelte renders it; the string lives in
 * the DOM until the page unmounts.
 *
 * Per Finding K1.2, this is the ONLY function that should produce a
 * mnemonic string from a stored identity.  Everything else uses
 * `seedBytes` directly.
 */
export function mnemonicForBackup(full: FullIdentity): string {
	if (full.seedBytes === null) {
		throw new Error('mnemonicForBackup: this identity has no seed phrase (posting-only import)');
	}
	return bip39.entropyToMnemonic(full.seedBytes, wordlist);
}

// ────────────────────────────────────────────────────────────────────────────
// LiveIdentity transformation
// ────────────────────────────────────────────────────────────────────────────

export function toLiveIdentity(full: FullIdentity): LiveIdentity {
	if (full.origin === 'posting-only') {
		// Posting-only: no owner/active/memo to wipe-and-strip; no
		// seedBytes; just promote `posting` to live.
		return Object.freeze({
			createdAt: full.createdAt,
			origin: 'posting-only',
			posting: full.keys.posting,
			memo: null,
			ownerPublicKey: null,
			activePublicKey: null
		});
	}
	// origin === 'morphit-seed': all four slots populated.
	const ownerKp = full.keys.owner;
	const activeKp = full.keys.active;
	const memoKp = full.keys.memo;
	if (!ownerKp || !activeKp || !memoKp) {
		// Defensive — shouldn't happen for morphit-seed origin, but
		// the type permits it.  Fail loudly rather than silently
		// dropping a key.
		throw new Error('toLiveIdentity: morphit-seed identity is missing owner/active/memo slots');
	}
	const ownerPub = ownerKp.publicKey;
	const activePub = activeKp.publicKey;
	sodium.memzero(ownerKp.privateKey);
	sodium.memzero(activeKp.privateKey);
	// K1.2 — zero the source FullIdentity's seedBytes too.  The
	// returned LiveIdentity doesn't carry seedBytes; if the caller
	// kept a clone (cloneFullIdentity) for the keystore, that
	// clone's seedBytes is independently allocated and survives.
	if (full.seedBytes) sodium.memzero(full.seedBytes);
	return Object.freeze({
		createdAt: full.createdAt,
		origin: 'morphit-seed',
		posting: full.keys.posting,
		memo: memoKp,
		ownerPublicKey: ownerPub,
		activePublicKey: activePub
	});
}

/**
 * Onboarding convenience. Returns a cloned snapshot (for keystore
 * persistence) and a live subset (for the session).
 */
export async function generateIdentity(): Promise<{ full: FullIdentity; live: LiveIdentity }> {
	const original = await generateFullIdentity();
	const snapshot = cloneFullIdentity(original);
	const live = toLiveIdentity(original);
	return { full: snapshot, live };
}

export async function importIdentityFromSeed(
	seed: string
): Promise<{ full: FullIdentity; live: LiveIdentity }> {
	const original = await importFullIdentityFromSeed(seed);
	const snapshot = cloneFullIdentity(original);
	const live = toLiveIdentity(original);
	return { full: snapshot, live };
}

/**
 * Posting-only convenience wrapper.  Takes the raw scalar produced
 * by wifToRawPrivateKey and returns both a keystore-bound snapshot
 * and a session-bound LiveIdentity.  The caller is responsible for
 * zeroing the input scalar after this returns; we clone internally.
 */
export async function importPostingOnlyIdentity(
	rawScalar: Uint8Array
): Promise<{ full: FullIdentity; live: LiveIdentity }> {
	const original = await importPostingOnlyFullIdentity(rawScalar);
	const snapshot = cloneFullIdentity(original);
	const live = toLiveIdentity(original);
	return { full: snapshot, live };
}

function cloneKeypair(kp: Keypair): Keypair {
	return {
		role: kp.role,
		publicKey: kp.publicKey.slice(),
		privateKey: kp.privateKey.slice()
	};
}
function cloneFullIdentity(full: FullIdentity): FullIdentity {
	return Object.freeze({
		createdAt: full.createdAt,
		origin: full.origin,
		// Clone seedBytes so the snapshot and the live copy zero
		// independently.  Original gets wiped right after
		// toLiveIdentity strips it, snapshot persists into the
		// keystore.  Posting-only identities have no seedBytes.
		seedBytes: full.seedBytes ? full.seedBytes.slice() : null,
		keys: Object.freeze({
			owner: full.keys.owner ? cloneKeypair(full.keys.owner) : null,
			active: full.keys.active ? cloneKeypair(full.keys.active) : null,
			posting: cloneKeypair(full.keys.posting),
			memo: full.keys.memo ? cloneKeypair(full.keys.memo) : null
		})
	});
}

/**
 * Hex encoding of a raw public key's bytes. Primarily used for stable
 * test assertions and as the body of the abbreviated "fingerprint"
 * rendered throughout the UI. Does NOT produce a real Blurt-format key
 * string — for that, use `formatPublicKeyBLT`.
 */
export function formatPublicKey(pk: Uint8Array): string {
	return Array.from(pk, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Format a 33-byte secp256k1 compressed public key as Blurt's
 * canonical BLT-prefixed string (base58check over RIPEMD160 checksum).
 * This is the format the chain expects in account-create ops and the
 * format the relay's availability/create endpoints parse.
 *
 * Wraps dblurt's PublicKey class rather than re-implementing
 * base58check — one less thing to get wrong.
 *
 * **Async + dynamic dblurt import** (cp165 byte-budget fix).  All
 * callers are user-action handlers (settings account verify,
 * onboarding register-name); none need this at first paint.  The
 * dynamic import keeps the 2 MB dblurt chunk out of the identity-
 * store transitive load graph.
 */
export async function formatPublicKeyBLT(pk: Uint8Array): Promise<string> {
	if (pk.length !== 33) {
		throw new Error(
			`formatPublicKeyBLT: expected 33-byte compressed point, got ${pk.length} bytes`
		);
	}
	const { PublicKey } = await import('@beblurt/dblurt');
	return new PublicKey(pk as unknown as Buffer).toString();
}

export function wipeLiveIdentity(id: LiveIdentity): void {
	sodium.memzero(id.posting.privateKey);
	if (id.memo) sodium.memzero(id.memo.privateKey);
}

export function wipeFullIdentity(full: FullIdentity): void {
	for (const role of KEY_ROLES) {
		const kp = full.keys[role];
		if (kp) sodium.memzero(kp.privateKey);
	}
	// K1.2 — zero the entropy bytes too.  Pre-fix this was the
	// mnemonic STRING which we couldn't zero; bytes we can.
	if (full.seedBytes) sodium.memzero(full.seedBytes);
}

export function wipeIdentity(id: FullIdentity | LiveIdentity): void {
	if ('keys' in id) wipeFullIdentity(id);
	else wipeLiveIdentity(id);
}

/**
 * Pick N unique random indices in [0, len). Uses libsodium's CSPRNG. Used
 * by onboarding's "confirm your seed" step to quiz the user on random
 * words from their newly generated mnemonic.
 */
export function pickRandomIndices(len: number, n: number): number[] {
	const out = new Set<number>();
	while (out.size < Math.min(n, len)) {
		out.add(sodium.randombytes_uniform(len));
	}
	return [...out].sort((a, b) => a - b);
}

export type Identity = FullIdentity;
