/**
 * Morphit — session identity store.
 *
 * Holds the LiveIdentity (posting + memo privates; owner + active public
 * keys) for the duration of a session. The encrypted KeystoreEnvelope is
 * also held here so that JIT-unlock operations (useActiveKey / useOwnerKey)
 * can reach it without a separate round-trip.
 *
 * Three states:
 *   - 'locked' — no session. User must sign in.
 *   - 'unlocked' — full session with signing material (LiveIdentity +
 *     KeystoreEnvelope). Can sign Morphit ops, broadcast chat, etc.
 *   - 'paired-readonly' — verified-account session WITHOUT signing
 *     material (ADR-0022 QR-pair).  Account + chat pubkey only.
 *     Can READ everything an unlocked user can (orderbook, profile,
 *     chat history, etc.) but cannot BROADCAST anything.  Posting key
 *     stays on the phone; phone-side ops are how a paired-readonly
 *     user makes writes happen.
 *
 * Lifecycle:
 *   - bootFromEnvelope(env, password) after the user unlocks
 *   - bootFromPairedSession(session) after QR-pair handshake completes
 *   - reset() on sign-out — zeroes posting/memo privates, clears both
 *     persisted-keystore and persisted-paired-session on disk
 *   - The store becomes { state: 'locked' } again after reset
 *
 * State transitions are mutually exclusive: bootFromPairedSession
 * refuses if the store is already unlocked (the unlocked state is
 * strictly more capable; paired-readonly should never overwrite it).
 * bootFromEnvelope, by contrast, IS allowed to overwrite a paired-
 * readonly state — upgrading from QR-pair to full unlock is a
 * legitimate user action.
 *
 * SSR NOTE: this store is client-only. During SSG prerender the store is
 * initialized to `locked` and never touched.
 */

import { writable, derived, get, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { decryptIdentity, type KeystoreEnvelope } from '$crypto/keystore';
import { toLiveIdentity, wipeLiveIdentity, type LiveIdentity } from '$crypto/keygen';
import { KEYSTORE_ENVELOPE_STORAGE_KEY } from '$crypto/persistentKeystore';
import {
	PAIRED_SESSION_STORAGE_KEY,
	writePairedSession,
	clearPairedSession,
	readPairedSession,
	type PairedSession
} from '$crypto/pairedSession';

export type IdentityState =
	| { state: 'locked' }
	| { state: 'unlocked'; live: LiveIdentity; envelope: KeystoreEnvelope }
	| { state: 'paired-readonly'; paired: PairedSession };

const internal = writable<IdentityState>({ state: 'locked' });

/** The current identity state. Subscribe in components with the normal
 *  `$` syntax: `{#if $identity.state === 'unlocked'} ...`. */
export const identity: Readable<IdentityState> = {
	subscribe: internal.subscribe
};

/** Convenience: the LiveIdentity, or null if locked or paired-readonly.
 *  Paired-readonly sessions have NO LiveIdentity because the keys live
 *  on the user's phone — `null` here is the correct signal that no
 *  signing material is available locally. */
export const liveIdentity: Readable<LiveIdentity | null> = derived(internal, ($s) =>
	$s.state === 'unlocked' ? $s.live : null
);

/** Convenience: boolean for "is a session unlocked right now?".
 *  Paired-readonly sessions are NOT unlocked (no signing material) — every
 *  existing call site that gates write ops on $isUnlocked keeps working
 *  correctly under QR-pair, refusing the broadcast because there's nothing
 *  to sign with. */
export const isUnlocked: Readable<boolean> = derived(internal, ($s) => $s.state === 'unlocked');

/** Convenience: boolean for "is this a paired-readonly session?".  Used
 *  by UI surfaces to swap a normal write affordance ("Post order") for a
 *  read-only affordance ("Use Morphit on your phone to post"). */
export const isPairedReadOnly: Readable<boolean> = derived(
	internal,
	($s) => $s.state === 'paired-readonly'
);

/** Convenience: the paired-session record, or null when not in
 *  paired-readonly state.  Components that need to render the paired
 *  account name (AvatarMenu, top-of-page banner) read this. */
export const pairedReadOnly: Readable<PairedSession | null> = derived(internal, ($s) =>
	$s.state === 'paired-readonly' ? $s.paired : null
);

/** Convenience: "is there ANY active session of any kind?" — useful for
 *  components that want to flip between signed-out and signed-in UI
 *  without caring which sub-flavor the session is.  True for both
 *  'unlocked' AND 'paired-readonly'; false for 'locked'. */
export const hasAnySession: Readable<boolean> = derived(
	internal,
	($s) => $s.state === 'unlocked' || $s.state === 'paired-readonly'
);

/** Convenience: the current encrypted keystore envelope, or null
 *  if locked OR paired-readonly. Used by the backup page to offer the
 *  encrypted keyfile for re-download without requiring the user's
 *  password (the envelope is already decrypted in memory as
 *  LiveIdentity, the envelope ciphertext itself is just opaque bytes).
 *  Returns null for paired-readonly because there's no envelope on
 *  this device — the keys live on the phone. */
export const currentEnvelope: Readable<KeystoreEnvelope | null> = derived(internal, ($s) =>
	$s.state === 'unlocked' ? $s.envelope : null
);

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────────────────

/**
 * Decrypt a keystore envelope with the user's password, stash both the
 * LiveIdentity and the envelope in the store. The envelope stays so that
 * subsequent JIT unlocks (signing a BLURT transfer, etc.) don't force
 * the user to re-upload a keyfile.
 *
 * If the store is currently paired-readonly, the paired-session record
 * is cleared from disk as part of the upgrade — paired and unlocked are
 * mutually exclusive, and a successful keystore unlock supersedes the
 * paired pseudonymous session.
 */
/**
 * Unlock the keystore via the password path.
 *
 * Per ADR-0043, two-factor authentication is **OPT-IN ONLY**.
 * Users who never enroll a TOTP secret will never see a 2FA prompt
 * here — this function takes the standard password path, returns
 * successfully, and the rest of the app runs identically to a
 * pre-2FA Morphit session.  The only users affected by the 2FA
 * gate are those who have explicitly clicked "Set up 2FA" in
 * Settings.  Morphit will never nag, banner, or interrupt to
 * push enrollment.  This is a privacy/agency stance: requiring
 * a second factor on a non-custodial wallet is contradictory
 * with the design — losing the second factor must never lock
 * the user out, and a forced second factor whose secret lives
 * on the same device adds friction without cryptographic gain.
 *
 * If 2FA IS enrolled and the caller didn't supply a `totpCode`,
 * a KeystoreError with kind 'totp_required' is thrown.  The
 * caller (the login UI) is expected to prompt the user for
 * their authenticator code or a backup code, and re-invoke
 * with the code attached.  See `keystoreTotp.ts` for the
 * gate implementation and threat-model framing.
 */
export async function bootFromEnvelope(
	env: KeystoreEnvelope,
	password: string,
	totpCode?: string
): Promise<void> {
	const full = await decryptIdentity(env, password);

	// 2FA gate — if this keystore has TOTP enrolled, require a
	// verified TOTP code or backup code before exposing the keys
	// to the rest of the app via the identity store.  Caller is
	// expected to handle the 'totp_required' error by prompting
	// the user and re-calling bootFromEnvelope with the code.
	if (full.totpSecret) {
		if (!totpCode) {
			const { KeystoreError } = await import('$crypto/keystore');
			throw new KeystoreError(
				'totp_required',
				'This keystore has 2FA enabled. Provide your authenticator code or a backup code.'
			);
		}
		const { verifyTotpOrBackup } = await import('$crypto/keystoreTotp');
		const result = await verifyTotpOrBackup(full, totpCode);
		if (result.kind === 'backup_redeemed') {
			// A backup code was consumed — re-encrypt and persist the
			// updated identity so the same code can't be replayed by
			// an attacker who reads the keystore before the user
			// notices the redemption.
			const { encryptIdentity } = await import('$crypto/keystore');
			const { writeEnvelope } = await import('$crypto/persistentKeystore');
			const newEnv = await encryptIdentity(result.updatedIdentity, password);
			writeEnvelope(newEnv);
			env = newEnv;
		}
	}

	const live = toLiveIdentity(full);
	// If we were paired-readonly, an envelope unlock is an upgrade.
	// Wipe the paired marker so the next reload doesn't ambiguously
	// have both anchors set.
	const prev = get(internal);
	if (prev.state === 'paired-readonly') {
		clearPairedSession();
	}
	internal.set({ state: 'unlocked', live, envelope: env });
}

/**
 * Decrypt a layered keystore envelope using the YubiKey HMAC
 * callback (Batch I, ADR-0017).  Same end-state as bootFromEnvelope:
 * LiveIdentity + envelope stashed in the store.
 *
 * Caller is responsible for:
 *   - Building the HMAC callback (typically via requestYubikey from
 *     $crypto/yubikey/transport).
 *   - Closing the YubiKey transport device after this returns,
 *     successful or not.
 */
export async function bootFromEnvelopeWithYubikey(
	env: KeystoreEnvelope,
	hmacFn: (challenge: Uint8Array) => Promise<Uint8Array>
): Promise<void> {
	// Lazy import keeps the cold-path crypto out of the identity
	// store's import graph for users who never touch a YubiKey.
	const { unlockWithYubikey } = await import('$crypto/keystoreYubikey');
	const full = await unlockWithYubikey(env, hmacFn);
	const live = toLiveIdentity(full);
	// Same upgrade-supersedes-paired rationale as bootFromEnvelope.
	const prev = get(internal);
	if (prev.state === 'paired-readonly') {
		clearPairedSession();
	}
	internal.set({ state: 'unlocked', live, envelope: env });
}

/**
 * Establish a paired-readonly session (ADR-0022 QR-pair).  Caller has
 * already verified the bundle's signature against the on-chain posting
 * authority; this function just commits the verified state to the
 * identity store and persists it to disk so a tab reload re-establishes
 * the session.
 *
 * Refuses (no-op) if the store is currently `unlocked` — a fully-keyed
 * session is strictly more capable than a paired-readonly one, and the
 * caller is presumed to have hit a logic error if they reach for the
 * downgrade.  Allowed to overwrite a previous paired-readonly state
 * (e.g. Bob paired this device earlier today, then re-pairs after
 * clearing the tab; the freshly-verified record supersedes the stale
 * one).
 *
 * @returns true if the new session was committed, false if the call
 *   was refused due to an existing unlocked session.
 */
export function bootFromPairedSession(session: PairedSession): boolean {
	const prev = get(internal);
	if (prev.state === 'unlocked') {
		// Paired-readonly is strictly weaker than unlocked — refuse
		// rather than overwrite a real session.  Defensive: nothing
		// in the current call graph should hit this path.
		return false;
	}
	// Best-effort persist.  Even if disk write fails (Private Mode,
	// full quota), the in-memory session is still valid for THIS tab —
	// just won't survive a reload.
	writePairedSession(session);
	internal.set({ state: 'paired-readonly', paired: session });
	return true;
}

/**
 * Lock session. Wipes live private key bytes in place and clears
 * the in-memory identity, but KEEPS the encrypted envelope on disk
 * (if one was persisted at onboarding). The user can unlock again
 * on this device with just their password — no seed phrase needed.
 *
 * For paired-readonly sessions there is no live key material to
 * wipe AND the persisted paired-session record is the entire reason
 * the session can survive a reload, so "lock" without "sign out"
 * doesn't make sense for QR-pair (there's no password to gate a
 * subsequent unlock).  In that case we treat lockSession() as a
 * full sign-out: in-memory state cleared, paired marker wiped.
 * Components offering Lock Session should hide the option when the
 * current state is paired-readonly (canLock = false), so this
 * fallback path should only fire on race or stale UI.
 *
 * This is the "walking away from my own device" action. Contrast
 * with reset(), which is the "leaving this device entirely" action.
 * For users who chose seed-every-time at onboarding, no envelope was
 * persisted, so lock() has the same visible effect as reset().
 */
export function lockSession(): void {
	const current = get(internal);
	if (current.state === 'unlocked') {
		wipeLiveIdentity(current.live);
	}
	if (current.state === 'paired-readonly') {
		// Treat as full sign-out — see comment above.  Clearing the
		// paired marker is the right thing because without a password
		// or other gate, "locked but unlockable" has no meaning for
		// QR-pair sessions.
		clearPairedSession();
	}
	internal.set({ state: 'locked' });
	// Envelope on disk is KEPT — that's the whole point of Lock vs Sign Out
	// for keystore-mode sessions.
	// The chat-identity published-in-this-session cache is NOT cleared
	// here: it holds public account names (not secrets), and its only
	// effect is to skip an indexer round-trip. A stale entry just means
	// the next unlocked session pays one extra GET to re-confirm — fine.
}

/**
 * Sign out. Wipes live private key bytes in place, clears the store,
 * AND wipes the persisted envelope from disk. Next time the user
 * opens Morphit on this device, they'll need their seed phrase or
 * keyfile to get back in — no password shortcut available. This is
 * the nuclear option; use lockSession() for "stepping away briefly."
 * Safe to call even if already locked (no-op on live, still clears
 * any leftover persisted state).
 *
 * Also clears the paired-readonly session marker — sign-out from a
 * QR-paired device leaves no trace of the pairing.
 *
 * NOTE on the dynamic imports: this function is called from the
 * `pagehide` event handler, where the browser is tearing the page
 * down.  Dynamic-import-then-call gives the page-teardown a chance
 * to win the race — in-memory wipe always runs (synchronous, before
 * the await point), but the disk-clear effectively only happens when
 * the user explicitly clicked Sign Out (not when they're just
 * closing the tab).  This is intentional: tab close should not
 * destroy the persistent envelope or the paired-session marker.
 * Both the keystore clear and the paired-session clear use dynamic
 * imports for the same reason.
 */
export function reset(): void {
	const current = get(internal);
	if (current.state === 'unlocked') {
		wipeLiveIdentity(current.live);
	}
	internal.set({ state: 'locked' });
	// Wipe persistent keystore from disk. Imported lazily so that
	// modules that only need reset()'s in-memory behavior don't pull
	// in the safeStorage + crypto chain — AND so the dynamic-import
	// loses the race against page teardown on `pagehide` (intentional;
	// see jsdoc note above).
	void import('$crypto/persistentKeystore').then((mod) => {
		mod.clearKeystore();
	});
	// Wipe paired-readonly marker from disk.  Same dynamic-import
	// race-against-teardown pattern as clearKeystore above: a deliberate
	// Sign Out wipes the marker, but a tab close (where `reset` runs
	// from `pagehide`) loses the race and leaves the marker intact so
	// the next tab open re-establishes the paired session.
	void import('$crypto/pairedSession').then((mod) => {
		mod.clearPairedSession();
	});
}

/**
 * Replace the stored envelope only (e.g. after a password change or key
 * rotation). The live keypairs are preserved — the user does not have to
 * re-sign-in.
 */
export function updateEnvelope(env: KeystoreEnvelope): void {
	const current = get(internal);
	if (current.state !== 'unlocked') return;
	internal.set({ state: 'unlocked', live: current.live, envelope: env });
}

// ────────────────────────────────────────────────────────────────────────────
// Browser sign-out hook + cross-tab sync
// ────────────────────────────────────────────────────────────────────────────

/** Cheap structural validator for cross-tab envelope swaps (M6).
 *
 *  We can't decrypt the envelope here (no password available), so
 *  this only enforces the JSON-shape invariants that any honest
 *  envelope satisfies.  A hostile same-origin tab could still write
 *  a technically-valid but cryptographically-attacker-controlled
 *  envelope; that case is caught downstream in `useJitKey`, which
 *  decrypts and verifies the resulting identity's posting pubkey
 *  matches the live session's pubkey.  Two layers of defense.
 *
 *  Returns true if the envelope LOOKS like one we could plausibly
 *  use; false if it's obviously malformed and we should stick with
 *  the pre-event state. */
function isStructurallyValidEnvelope(env: unknown): env is KeystoreEnvelope {
	if (typeof env !== 'object' || env === null) return false;
	const e = env as Record<string, unknown>;
	if (e.v !== 1) return false;
	// Branch on scheme.  Missing scheme = legacy simple-passphrase.
	if (e.scheme === undefined || e.scheme === 'simple-passphrase') {
		// Fields required for simple-passphrase decrypt:
		if (e.kdf !== 'argon2id') return false;
		if (typeof e.salt !== 'string') return false;
		if (typeof e.nonce !== 'string') return false;
		if (typeof e.ciphertext !== 'string') return false;
		if (typeof e.kdfParams !== 'object' || e.kdfParams === null) return false;
		const k = e.kdfParams as Record<string, unknown>;
		if (typeof k.opslimit !== 'number' || typeof k.memlimit !== 'number') return false;
		// Reasonable size cap on ciphertext + salt + nonce so a
		// hostile MB-scale envelope doesn't bloat memory.
		if (e.salt.length + e.nonce.length + e.ciphertext.length > 256 * 1024) {
			return false;
		}
		return true;
	}
	if (e.scheme === 'layered-cek') {
		if (typeof e.cekNonce !== 'string') return false;
		if (typeof e.ciphertext !== 'string') return false;
		if (!Array.isArray(e.wraps) || e.wraps.length === 0) return false;
		// Cap total envelope-string size.  validateLayeredEnvelope
		// (called at decrypt time) does deeper per-wrap validation;
		// this is the cheap pre-decrypt gate.
		const wrapStringLen = e.wraps.reduce((acc: number, w: unknown) => {
			if (typeof w !== 'object' || w === null) return acc + 1024;
			const ww = w as Record<string, unknown>;
			return (
				acc +
				(typeof ww.salt === 'string' ? ww.salt.length : 0) +
				(typeof ww.nonce === 'string' ? ww.nonce.length : 0) +
				(typeof ww.ciphertext === 'string' ? ww.ciphertext.length : 0) +
				(typeof ww.challenge === 'string' ? ww.challenge.length : 0)
			);
		}, 0);
		if (wrapStringLen + e.cekNonce.length + e.ciphertext.length > 512 * 1024) {
			return false;
		}
		return true;
	}
	return false;
}

/** Auto-restore a persisted paired-readonly session.  Unlike keystore
 *  envelopes (which require a password to decrypt), paired sessions are
 *  just verified public-state markers — if one exists on disk, we can
 *  re-establish it without user interaction.  This is what makes Bob's
 *  "I QR-paired this device" experience survive a tab close.
 *
 *  Only auto-boots if the store is currently 'locked' — defensive: we
 *  don't want to silently overwrite an unlocked session if some future
 *  code path beats us to it.
 *
 *  Exported (not auto-invoked here) so it can be called from the
 *  `if (browser)` block in production AND directly from tests, since
 *  SvelteKit's `browser` flag is false under vitest's jsdom env.
 *  Calling it under SSR (where `window` is undefined) is a no-op —
 *  readPairedSession returns null via safeStorage.  Safe to invoke
 *  repeatedly; the early-return on `prev.state !== 'locked'` makes it
 *  idempotent. */
export function autoRestorePairedSession(): void {
	try {
		const persisted = readPairedSession();
		if (persisted !== null && get(internal).state === 'locked') {
			internal.set({ state: 'paired-readonly', paired: persisted });
			// Reconcile the morphit.blurtAccount anchor so consumers like
			// AvatarMenu's canViewProfile and chat's getUserBlurtAccount
			// (apps/web/src/lib/blurt/ops/profile.ts) see the right
			// account immediately after auto-restore.  Direct localStorage
			// write rather than calling setUserBlurtAccount to avoid an
			// import cycle (profile.ts consumes identity store readables).
			try {
				if (typeof window !== 'undefined') {
					window.localStorage.setItem('morphit.blurtAccount', persisted.account);
				}
			} catch {
				// Private Mode or quota — non-fatal.  The paired session
				// itself is restored; consumers that need the account
				// name will fall back to reading the paired record
				// directly when needed.
			}
		}
	} catch {
		// Read failure (corrupt JSON, etc.) is non-fatal — user just
		// stays locked and has to re-pair / sign in.  No partial state.
	}
}

/** The cross-tab storage-event handler.  Fires when another tab writes
 *  to localStorage and reaches keys we care about (paired session
 *  marker or keystore envelope).
 *
 *  Exported so production can `addEventListener('storage', ...)` it AND
 *  tests can invoke it directly with a synthesized StorageEvent — the
 *  SvelteKit `browser` flag is false under vitest's jsdom env so the
 *  listener registration below is skipped in tests, but the underlying
 *  function still does its job when called.  Pure function of (current
 *  store state, event) → new store state; no DOM access beyond what
 *  the event itself carries. */
export function handleStorageEvent(e: StorageEvent): void {
	// Paired-session cross-tab sync (Part 114).  Symmetric to the
	// envelope listener below: pick up sign-ins/sign-outs that
	// happened in another tab.
	if (e.key === PAIRED_SESSION_STORAGE_KEY) {
		const current = get(internal);
		if (e.newValue === null) {
			// Paired marker deleted in another tab — mirror here.
			// Only act if WE are currently paired-readonly; an
			// unlocked session is strictly more capable and shouldn't
			// be torn down by a sibling-tab paired sign-out.
			if (current.state === 'paired-readonly') {
				internal.set({ state: 'locked' });
			}
			return;
		}
		// Paired marker written/updated — only adopt if we're locked.
		// Don't downgrade a real unlocked session into paired-readonly
		// just because a sibling tab paired the device.
		if (current.state === 'locked') {
			try {
				// Validate by re-reading via the canonical validator;
				// readPairedSession does its own parse + validate, so
				// the value reflects what passed validation, not the
				// raw event payload.
				const session = readPairedSession();
				if (session !== null) {
					internal.set({ state: 'paired-readonly', paired: session });
				}
			} catch {
				// Corrupt JSON written by some hostile tab — ignore.
			}
		}
		return;
	}

	// Only react to the envelope key.  We deliberately don't
	// react to MODE_KEY: it's a one-shot at onboarding and
	// isn't expected to change mid-session.
	if (e.key !== KEYSTORE_ENVELOPE_STORAGE_KEY) return;

	const current = get(internal);
	if (current.state !== 'unlocked') {
		// Already locked or paired-readonly here — nothing to do.
		// The other tab's sign-out is mirrored implicitly because
		// the envelope on disk is gone; if the user later tries
		// to log in here they'll go through the welcome-back
		// path and find no envelope.
		return;
	}

	if (e.newValue === null) {
		// Envelope deleted — other tab signed out.  Mirror
		// here.  Calling reset() is safe: it wipes the
		// in-memory live keys and tries to clear the
		// persisted envelope (already gone — clearKeystore
		// is idempotent, no-op on missing keys).
		reset();
		return;
	}

	// Envelope value changed — likely a password change in
	// another tab.  Swap the envelope reference so subsequent
	// JIT unlocks use the right ciphertext.  Live keys stay
	// valid (same identity, just different password gating
	// the same plaintext).  The user will need the new
	// password for the next JIT unlock; they changed it
	// themselves a moment ago, they remember it.
	//
	// M6 fix: structurally validate the parsed envelope
	// before swapping.  A hostile same-origin tab (XSS) could
	// write garbage; without this, we'd hand garbage to the
	// next useActiveKey, which would surface as a confusing
	// error.  The downstream pubkey-match check in useJitKey
	// is the second line of defense — if the new envelope
	// decrypts to a DIFFERENT identity than the live session,
	// useJitKey refuses.
	try {
		const parsed = JSON.parse(e.newValue) as KeystoreEnvelope;
		if (!isStructurallyValidEnvelope(parsed)) {
			// Don't update — keep the existing envelope.
			// Next JIT unlock continues to work with the
			// pre-event state.
			return;
		}
		updateEnvelope(parsed);
	} catch {
		// Corrupted envelope payload from the other tab.
		// Don't update — the worst case is the next JIT
		// unlock here uses the old envelope and shows
		// "wrong password" if the user enters the new one.
		// That's recoverable; corrupting our store with
		// invalid JSON is not.
	}
}

if (browser) {
	autoRestorePairedSession();

	// Best-effort: wipe keys when the tab closes. JS engines don't
	// guarantee this runs, but when it does, it reduces the window in
	// which keys sit in freed-but-not-scrubbed heap.
	window.addEventListener('pagehide', () => {
		reset();
	});

	// Cross-tab unlock state propagation (§F.17 + Part 114 for paired).
	//
	// Pre-fix: tab 1 signs out, wipes the persisted envelope.
	// Tab 2's in-memory live identity is untouched — user
	// remains "signed in" on tab 2 even though they explicitly
	// signed out somewhere.  Worse for password change: tab 1
	// rotates the password, tab 2 still holds the OLD envelope
	// reference, and the next JIT unlock there would fail.
	//
	// Storage events fire only on changes from OTHER tabs (same-
	// tab writes are silent), so this listener won't recurse on
	// our own reset() / updateEnvelope() / writeEnvelope() calls.
	window.addEventListener('storage', handleStorageEvent);
}
