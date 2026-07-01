/**
 * Lightweight identity core — types, role constants, and the two
 * sync LiveIdentity helpers, with ZERO elliptic-crypto dependency.
 *
 * Why this module exists (cp271 byte budget, sibling to the cp267
 * `./sodium` lazy split):
 *   `keygen.ts` statically imports `@scure/bip39` + `@noble/secp256k1`
 *   (~19 KB Brotli combined) at module top. The shared `[lang]` layout
 *   reaches `keygen` on EVERY page via two chains —
 *     • `$stores/identity` → `toLiveIdentity` / `wipeLiveIdentity`
 *     • `$stores/identity` → `$crypto/keystore` → `ensureSodium` /
 *       `Identity` / `KeyRole` / `KEY_ROLES`
 *   — none of which touch bip39 or secp256k1. Yet importing ANY symbol
 *   from `keygen` drags its static bip39+secp256k1 into the per-page
 *   modulepreload closure (measured in the home-page baseline).
 *
 *   The two baseline chains only need the items in THIS module, so they
 *   import from here instead of from `keygen`. `keygen` re-exports all of
 *   these (so its many non-baseline importers — onboarding, import, chat,
 *   settings, blurt/ops — are unchanged), and keeps the bip39/secp256k1
 *   work in the heavy functions that actually sign / derive keys. Those
 *   functions only load on the routes that call them, so the elliptic
 *   crypto leaves the home/orderbook/etc. first-paint closure entirely.
 *
 * This module imports ONLY `./sodium` (for `memzero` in the wipes) — it
 * must never import `./keygen` (that would re-introduce the cycle and the
 * bloat). Keep it dependency-light.
 */

import { sodium } from './sodium';

// `ensureSodium` originates in ./sodium; re-exported here so the baseline
// keystore import (`import { ensureSodium } from '$crypto/identity-core'`)
// resolves without reaching keygen.
export { ensureSodium } from './sodium';

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

/** Alias kept for the many call sites that import `Identity`. */
export type Identity = FullIdentity;

// ────────────────────────────────────────────────────────────────────────────
// LiveIdentity transformation (sodium-only; no bip39 / secp256k1)
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

export function wipeLiveIdentity(id: LiveIdentity): void {
	sodium.memzero(id.posting.privateKey);
	if (id.memo) sodium.memzero(id.memo.privateKey);
}
