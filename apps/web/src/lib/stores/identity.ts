/**
 * Morphit — session identity store.
 *
 * Holds the LiveIdentity (the posting private key; memo, owner and active
 * public keys) for the duration of a session. The encrypted KeystoreEnvelope
 * is also held here so that the JIT unlock of the active key (useActiveKey)
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
import {
	toLiveIdentity,
	wipeLiveIdentity,
	wipeDecryptedIdentity,
	wipeTotpSecret,
	type LiveIdentity
} from '$crypto/identity-core';
import {
	KEYSTORE_ENVELOPE_STORAGE_KEY,
	clearKeystore,
	isPersistedEnvelope,
	persistedKeystorePresent,
	writeEnvelope
} from '$crypto/persistentKeystore';
import { sodium, ensureSodium } from '$crypto/sodium';
import {
	LEGACY_RELOAD_STASH_KEYS,
	RELOAD_STASH_KEY,
	RELOAD_STASH_MAX_AGE_MS,
	SW_STASH_PUT,
	SW_STASH_TAKE,
	openStash,
	parseStashRecord,
	sealStash
} from '$lib/auth/reloadStash';
import {
	sweepAccountStorageOnSignOut,
	sweepSessionAccountKeysOnSignOut
} from '$lib/storage/signOutSweep';
import { setPersonStorageTier } from '$lib/storage/personStorage';
import { setUnsealPending } from '$lib/chat/unsealGate';
import { safeSession } from '../utils/safeStorage';
import {
	PAIRED_SESSION_STORAGE_KEY,
	writePairedSession,
	clearPairedSession,
	readPairedSession,
	type PairedSession
} from '$crypto/pairedSession';
import {
	bindSessionPostingKey,
	clearUserBlurtAccount,
	getUserBlurtAccount,
	setUserBlurtAccount
} from '$blurt/ops/profile';

export type IdentityState =
	| { state: 'locked' }
	| { state: 'unlocked'; live: LiveIdentity; envelope: KeystoreEnvelope }
	| { state: 'paired-readonly'; paired: PairedSession };

const internal = writable<IdentityState>({ state: 'locked' });

/**
 * the persisted Blurt account name is scoped to the posting key that
 * owns it (see `ops/profile.ts`). Every transition into or out of `unlocked`
 * must tell the storage layer which key is now in charge, or a second tab's
 * sign-in hands this tab the wrong account name — and the chain answers
 * "Missing Posting Authority <someone else>".
 *
 * It also says whether this session is the one remembered on this device: only
 * then are the account name and the person's chat state ($lib/storage/
 * personStorage) written to localStorage ("just this session" keeps them in
 * the tab). Re-evaluated when the remembered keystore changes, so
 * committing Remember-me after the unlock moves the name over.
 *
 * One subscription, so no `internal.set(...)` call site can forget to do it.
 */
derived([internal, persistedKeystorePresent], ([state]) => state).subscribe((state) => {
	if (state.state === 'unlocked') {
		const remembered = isPersistedEnvelope(state.envelope);
		bindSessionPostingKey(sessionKeyId(state.live.posting.publicKey), remembered);
		setPersonStorageTier(remembered ? 'local' : 'session');
	} else {
		bindSessionPostingKey(null);
		// A paired device is remembered on disk ($lib/pair); locked or signed
		// out, the person's chat state is neither read nor written.
		setPersonStorageTier(state.state === 'paired-readonly' ? 'local' : null);
	}
});

/**
 * Unlock restores the chat-key pins an explicit Lock sealed for this account
 * ($lib/chat/pubPin unsealPins), so a key the operator substitutes after a
 * lock still meets the "safety number changed" step. Runs once per entry into
 * `unlocked`; another account's seal is left alone.
 */
let wasUnlocked = false;
/** Bumped on every entry into and exit from `unlocked`: an unseal that was
 *  started for an earlier unlock finds a different number and stops. */
let unlockEpoch = 0;
internal.subscribe((state) => {
	const unlocked = state.state === 'unlocked';
	if (unlocked !== wasUnlocked) unlockEpoch++;
	if (unlocked && !wasUnlocked) {
		const epoch = unlockEpoch;
		const priv = Uint8Array.from(state.live.posting.privateKey);
		// Only while THIS unlock lasts: a Lock that lands first seals the pins
		// again, and a late unseal must not put them back readable (or let the
		// next account's Lock seal them under its own key).
		setUnsealPending(
			import('$lib/chat/pubPin')
				.then((m) => m.unsealPins(priv, () => epoch === unlockEpoch))
				.catch(() => false)
				.finally(() => priv.fill(0))
		);
	}
	wasUnlocked = unlocked;
});

/**
 * A stable, non-secret id for the posting key of THIS session.
 *
 * Deliberately a raw hex prefix of the public key rather than the BLT-formatted
 * string: `formatPublicKeyBLT` lives in `$crypto/keygen`, and this store is on
 * the every-page baseline — importing it would drag bip39 + secp256k1 into the
 * first paint of every route (`crypto-blurt-not-in-baseline-closure-smoke`
 * caught exactly that). We only need an identifier that differs between keys, and
 * the public key already is one.
 */
function sessionKeyId(publicKey: Uint8Array): string {
	let out = '';
	for (let i = 0; i < 8 && i < publicKey.length; i++) {
		out += publicKey[i]!.toString(16).padStart(2, '0');
	}
	return out;
}

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
	// v1.20.0 review (F-8): `full` holds EVERY secret (owner/active/memo/
	// posting private keys, seed entropy, TOTP secret). If the 2FA gate stops
	// the unlock ('totp_required' on every 2FA user's first attempt,
	// 'totp_invalid' on a typo) or anything else throws before the keys are
	// handed to the live session, zero it here — like every other decrypt
	// site does — instead of leaving it for the garbage collector.
	let handedOff = false;
	try {
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
				// A backup code was consumed — re-encrypt the updated identity
				// (keeping the keystore's shape and every wrap, so an enrolled
				// YubiKey keeps working) so the same code can't be replayed.
				// The copy on disk is replaced only when it IS this keystore:
				// unlocking another account's keyfile must never overwrite the
				// one remembered on this device.
				const { reencryptIdentityKeepingWraps } = await import('$crypto/keystore');
				const newEnv = await reencryptIdentityKeepingWraps(env, password, result.updatedIdentity);
				// If the disk write fails, the session stays on the keystore that
				// is on disk, so the two never diverge.
				if (!isPersistedEnvelope(env) || writeEnvelope(newEnv)) env = newEnv;
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
		handedOff = true;
	} finally {
		if (!handedOff) {
			wipeDecryptedIdentity(full);
		} else if (full.totpSecret) {
			// toLiveIdentity zeroed owner/active/seed and the live session now
			// owns posting/memo; the TOTP secret is not needed past the gate.
			wipeTotpSecret(full);
		}
	}
}

/**
 * Unlock a layered keystore with the YubiKey (an ALTERNATIVE to the
 * password, not an additional factor). Same end-state as bootFromEnvelope.
 *
 *   - 2FA applies here exactly as on the password path: a keystore with
 *     TOTP enrolled needs the authenticator or a backup code
 *     ('totp_required' / 'totp_invalid'); the caller asks for it and calls
 *     again (one more touch of the key).
 *   - After the gate, the wrap that opened the keystore is rebuilt under a
 *     fresh challenge (one more touch), so a recorded response never
 *     unlocks it again. If the key does not answer that second time the
 *     unlock still succeeds and the challenge moves on the next unlock.
 *   - The copy on disk is replaced only when it IS this keystore.
 *
 * Caller is responsible for building the HMAC callback (typically via
 * requestYubikey from $crypto/yubikey/transport) and closing the device
 * after this returns, successful or not.
 */
export async function bootFromEnvelopeWithYubikey(
	env: KeystoreEnvelope,
	hmacFn: (challenge: Uint8Array) => Promise<Uint8Array>,
	totpCode?: string
): Promise<void> {
	// Lazy import keeps the cold-path crypto out of the identity
	// store's import graph for users who never touch a YubiKey.
	const { openWithYubikey, rotateYubikeyChallenge } = await import('$crypto/keystoreYubikey');
	const opened = await openWithYubikey(env, hmacFn);
	const full = opened.identity;
	let handedOff = false;
	try {
		let next: KeystoreEnvelope = opened.env;
		if (full.totpSecret) {
			const { KeystoreError, reencryptLayeredWithCek } = await import('$crypto/keystore');
			if (!totpCode) {
				throw new KeystoreError(
					'totp_required',
					'This keystore has 2FA enabled. Provide your authenticator code or a backup code.'
				);
			}
			const { verifyTotpOrBackup } = await import('$crypto/keystoreTotp');
			const result = await verifyTotpOrBackup(full, totpCode);
			if (result.kind === 'backup_redeemed') {
				next = await reencryptLayeredWithCek(opened.env, opened.cek, result.updatedIdentity);
			}
		}
		try {
			next = await rotateYubikeyChallenge(
				next as typeof opened.env,
				opened.wrapIndex,
				opened.cek,
				hmacFn
			);
		} catch {
			// The key did not answer the second time; keep the current wrap.
		}
		// If the disk write fails, the session stays on the keystore that is
		// on disk, so the two never diverge.
		if (next !== env && isPersistedEnvelope(env) && !writeEnvelope(next)) next = env;

		const live = toLiveIdentity(full);
		// Same upgrade-supersedes-paired rationale as bootFromEnvelope.
		const prev = get(internal);
		if (prev.state === 'paired-readonly') {
			clearPairedSession();
		}
		internal.set({ state: 'unlocked', live, envelope: next });
		handedOff = true;
	} finally {
		opened.cek.fill(0);
		if (!handedOff) {
			wipeDecryptedIdentity(full);
		} else if (full.totpSecret) {
			wipeTotpSecret(full);
		}
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Sessions encrypted under a password the user never saw
// ────────────────────────────────────────────────────────────────────────────
//
// A seed import without "Remember me" keeps the session's keystore encrypted
// under a RANDOM password (onboarding/import): nothing is written to disk and
// the user is never asked for a password. That keystore is useless as a
// backup — a keyfile exported from it opens with a password nobody knows, and
// "Show seed" asks for one that does not exist. So the random password is
// remembered here, in memory only, next to the envelope it opens, and
// `protectSessionWithPassword` re-encrypts the session's keystore under a
// password the user chooses before anything is exported. Cleared on lock and
// sign-out with the session.

let ephemeral: { envelope: KeystoreEnvelope; password: string } | null = null;

/** onboarding/import: this session's keystore is encrypted under `password`,
 *  a random one the user has not seen. */
export function noteEphemeralSessionPassword(envelope: KeystoreEnvelope, password: string): void {
	ephemeral = { envelope, password };
}

/** True while this session's keystore opens only with a password the user
 *  never saw (set one with protectSessionWithPassword before a backup). */
export function sessionPasswordIsEphemeral(): boolean {
	const s = get(internal);
	return s.state === 'unlocked' && ephemeral !== null && s.envelope === ephemeral.envelope;
}

/** Re-encrypt this session's keystore under `newPassword` (the caller has
 *  checked it against the password policy). The session keeps running; the
 *  disk is not touched (the session was never remembered). */
export async function protectSessionWithPassword(
	newPassword: string
): Promise<'ok' | 'not_ephemeral' | 'failed'> {
	if (!sessionPasswordIsEphemeral() || ephemeral === null) return 'not_ephemeral';
	const { envelope, password } = ephemeral;
	try {
		const full = await decryptIdentity(envelope, password);
		try {
			// The import made a simple-passphrase keystore; a new one under the
			// user's password replaces it.
			const { encryptIdentity } = await import('$crypto/keystore');
			const reKeyed = await encryptIdentity(full, newPassword);
			const outcome = commitSessionEnvelope(reKeyed);
			if (outcome === 'locked') return 'failed';
			ephemeral = null;
			return 'ok';
		} finally {
			wipeDecryptedIdentity(full);
		}
	} catch {
		return 'failed';
	}
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
	//
	// the own-sent plaintext cache IS cleared here: unlike the
	// chat-identity name cache above, it holds message CONTENT, so it must
	// not linger in memory past a lock. Dynamic import keeps chatService's
	// deps out of this store's static graph (the same dynamic-import
	// approach the sign-out path uses for the self-profile cache).
	void import('$lib/chat/chatService').then((m) => m.clearOwnSentPlaintextCache());
}

/**
 * In-memory session wipe, with OPTIONAL deterministic disk-clear.
 *
 * Always (synchronously): scrubs live private-key bytes in place and
 * sets the store to `locked`.
 *
 * With `{ clearDisk: true }`: ALSO wipes the persisted keystore envelope
 * and the paired-readonly marker from disk. Use this only for an
 * EXPLICIT, user-initiated "leave this device" action (Sign Out, or the
 * paired→keystore upgrade). After a disk-clear the user needs their seed
 * phrase or keyfile to get back in — no password shortcut.
 *
 * Without `clearDisk` (the default): disk is left intact. This is what
 * `pagehide` (tab close / refresh) and the cross-tab storage mirror use —
 * the persisted envelope / paired marker must SURVIVE so the next page load
 * can re-establish the session (password unlock, paired auto-restore, or
 * cross-tab handoff). Locking ≠ signing out. (The idle auto-lock is a
 * SEPARATE path — `+layout` wires it to `lockSession()`, not reset(); that
 * keeps the keystore envelope too but deliberately CLEARS a paired-readonly
 * marker, since a QR-pair session has no password to re-unlock with, so
 * keeping the marker would just auto-restore it and make the lock pointless.)
 *
 * History: disk-clear used to fire unconditionally and rely on `pagehide`
 * tearing the page down before the dynamic import resolved. That race was
 * unsafe (persistentKeystore is already loaded, so the import resolves on
 * the microtask queue and could win on a reload, wiping a "Remember me"
 * envelope on refresh). It is now an explicit flag.
 */
export function reset(opts?: { clearDisk?: boolean }): void {
	const current = get(internal);
	if (current.state === 'unlocked') {
		wipeLiveIdentity(current.live);
	}
	ephemeral = null;
	internal.set({ state: 'locked' });
	// clear the own-sent plaintext cache (message content must
	// not survive a lock/sign-out in memory). In-memory only; dynamic
	// import avoids pulling chatService's deps into this store's static
	// graph (the same dynamic-import approach the sign-out path uses for
	// the self-profile cache).
	void import('$lib/chat/chatService').then((m) => m.clearOwnSentPlaintextCache());
	// Disk-clear is now EXPLICIT and deterministic (opts.clearDisk),
	// NOT a fire-and-forget that we hope loses a race against page
	// teardown. The old approach — always firing the dynamic-import
	// clear and relying on `pagehide` to kill the context first — was
	// fragile: `$crypto/persistentKeystore` is already loaded on every
	// page, so its `import()` resolves on the microtask queue and could
	// WIN the race on a reload, wiping a "Remember me" envelope and
	// dropping the user to the import screen on refresh. So:
	//   - pagehide / cross-tab storage mirror → clearDisk omitted
	//     (false): the persisted envelope and paired marker SURVIVE,
	//     so the next load re-establishes the session (password
	//     unlock, paired auto-restore, or cross-tab handoff).  (The
	//     idle auto-lock is NOT a reset() caller — it uses
	//     lockSession(), which keeps the keystore envelope too but
	//     clears a paired-readonly marker on purpose.)
	//   - explicit Sign Out (broadcastSignOut) and the paired→keystore
	//     upgrade → clearDisk: true, wiping disk for real.
	// The dynamic import is kept (kept out of reset()'s static graph for
	// callers that only need the in-memory wipe); it runs only when
	// clearDisk is set, and the page is NOT tearing down on those paths,
	// so the clear completes deterministically.
	if (opts?.clearDisk) {
		void import('$crypto/persistentKeystore').then((mod) => {
			mod.clearKeystore();
		});
		void import('$crypto/pairedSession').then((mod) => {
			mod.clearPairedSession();
		});
	}
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

/** Outcome of {@link commitSessionEnvelope}. */
export type EnvelopeCommit =
	/** Session and the device's remembered keystore both hold `next`. */
	| 'persisted'
	/** Only the session holds `next`: this session's keystore is not the one
	 *  the device remembers (Remember me off, or another account remembered). */
	| 'session_only'
	/** `requirePersisted` was set and this session is not the remembered one:
	 *  nothing changed. */
	| 'not_remembered'
	/** The disk write failed: nothing changed. */
	| 'persist_failed'
	/** No unlocked session: nothing changed. */
	| 'locked';

/**
 * Commit a re-keyed keystore for the unlocked session — the ONE way to change
 * it (password, YubiKey wraps, 2FA, backup-code redemption, Active key).
 *
 * The session's copy and the device's remembered copy move together, or
 * neither does. The remembered copy is written only when it IS this session's
 * keystore (byte-identical before the change), so a session that was never
 * remembered can never overwrite another account's keystore on this device.
 * `live`, when given, replaces the live identity too (capabilities changed).
 *
 * Before this existed, the YubiKey card wrote only the disk copy and the
 * password change wrote the session's stale copy back over it — a removed
 * (lost) YubiKey unlocked again, and a YubiKey-only keystore opened with the
 * password again.
 */
export function commitSessionEnvelope(
	next: KeystoreEnvelope,
	opts: { readonly requirePersisted?: boolean; readonly live?: LiveIdentity } = {}
): EnvelopeCommit {
	const current = get(internal);
	if (current.state !== 'unlocked') return 'locked';
	const remembered = isPersistedEnvelope(current.envelope);
	if (!remembered && opts.requirePersisted === true) return 'not_remembered';
	if (remembered && !writeEnvelope(next)) return 'persist_failed';
	internal.set({ state: 'unlocked', live: opts.live ?? current.live, envelope: next });
	return remembered ? 'persisted' : 'session_only';
}

/**
 * Replace BOTH halves of an unlocked session.
 *
 * `updateEnvelope` alone is not enough when the identity's CAPABILITIES change:
 * the money paths gate on `live.activePublicKey`, so a keystore that gained an
 * active key while `live` kept the stale `activePublicKey: null` would leave the
 * user holding a key the UI refuses to believe in. Both move together or
 * neither does.
 */
export function updateUnlockedIdentity(env: KeystoreEnvelope, live: LiveIdentity): void {
	const current = get(internal);
	if (current.state !== 'unlocked') return;
	internal.set({ state: 'unlocked', live, envelope: env });
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
	// Paired-session cross-tab sync.  Symmetric to the
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
		// Envelope deleted — the other tab signed out and
		// already removed the persisted envelope.  Mirror it
		// here with a bare reset(): newer a bare reset
		// wipes only the in-memory live keys and deliberately
		// does NOT touch disk — which is exactly right here,
		// since the envelope is already gone.  (Disk-clearing
		// is reserved for explicit reset({ clearDisk: true })
		// on real sign-out / passphrase-change / account
		// upgrade.)
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

// ────────────────────────────────────────────────────────────────────────────
// Cross-tab in-memory session handoff (BroadcastChannel)
// ────────────────────────────────────────────────────────────────────────────
//
// Opening a Morphit link in a NEW tab — or reloading one tab while others
// stay open — should not force a re-login (not even a password prompt) when
// another tab in this same browser already holds a session. The live keys
// are handed tab-to-tab IN MEMORY via postMessage (structured clone): they
// never touch disk, and they vanish once the last tab closes. This is the
// privacy-preserving alternative to persisting the decrypted session — no
// on-disk plaintext keys, and it does NOT weaken the "Remember me" opt-in
// (which is the separate, deliberate control for surviving a full close /
// a lone-tab cold reload).
//
// Protocol on channel 'morphit-session-handoff-v1':
//   a freshly-booted LOCKED tab broadcasts  { t: 'request' }
//   any tab WITH a session replies          { t: 'offer', payload: IdentityState }
//   a tab whose user EXPLICITLY signs out   { t: 'signout' }
// A tab only ADOPTS an offer while it is still locked (a live session is
// never clobbered) and only OFFERS while it actually holds one. The channel
// is same-origin only, so it exposes nothing a same-origin XSS couldn't
// already read straight out of the page.
//
// The 'signout' message closes a gap this in-memory handoff opened: once a
// session can be cloned tab-to-tab, an explicit Sign Out in one tab MUST
// revoke it in the siblings too. The pre-existing `storage`-event mirror
// (handleStorageEvent below) only fires when the on-disk envelope CHANGES,
// so it covers a "Remember me" (persisted) session but NOT an in-memory-only
// one (the default): there is no disk key to delete, hence no storage event,
// hence the siblings used to keep their cloned live keys after a Sign Out.
// broadcastSignOut() fills that gap. CRITICAL SAFETY INVARIANT: the signout
// broadcast lives ONLY in broadcastSignOut(), NEVER in reset() or the
// pagehide handler — closing or locking one tab must never sign the user
// out of the others (reset() is also called from pagehide on tab-close).

type SessionHandoffMessage =
	| { t: 'request' }
	/** `account`: the session's account name — a "just this session" name
	 *  lives only in the offering tab's sessionStorage. */
	| { t: 'offer'; payload: IdentityState; account?: string | null }
	| { t: 'signout' }
	| { t: 'lock' };

const SESSION_HANDOFF_CHANNEL = 'morphit-session-handoff-v1';
let sessionHandoffChannel: BroadcastChannel | null = null;

function getSessionHandoffChannel(): BroadcastChannel | null {
	if (!browser || typeof BroadcastChannel === 'undefined') return null;
	if (!sessionHandoffChannel) {
		try {
			sessionHandoffChannel = new BroadcastChannel(SESSION_HANDOFF_CHANNEL);
		} catch {
			sessionHandoffChannel = null;
		}
	}
	return sessionHandoffChannel;
}

/** Adopt a session offered by a sibling tab. No-op unless we're locked —
 *  a live session is never clobbered by an inbound offer (so a stale offer
 *  arriving after we've unlocked some other way is harmless). */
function adoptOfferedSession(payload: unknown, account?: unknown): void {
	if (get(internal).state !== 'locked') return;
	const p = payload as IdentityState | null;
	if (!p || typeof p !== 'object' || typeof (p as { state?: unknown }).state !== 'string') return;
	if (p.state === 'unlocked' && p.live && p.envelope) {
		internal.set({ state: 'unlocked', live: p.live, envelope: p.envelope });
		// A "just this session" account name is only in the offering tab.
		if (
			getUserBlurtAccount() === null &&
			typeof account === 'string' &&
			/^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/.test(account)
		) {
			setUserBlurtAccount(account);
		}
		// The reload stash seals with libsodium, synchronously, at pagehide;
		// a tab unlocked by a handoff may not have loaded it yet.
		void ensureSodium().catch(() => {});
	} else if (p.state === 'paired-readonly' && p.paired) {
		internal.set({ state: 'paired-readonly', paired: p.paired });
	}
}

/** Handle one inbound session-handoff message. Exported (pure-ish, like
 *  handleStorageEvent) so vitest can drive the request/offer/signout
 *  dispatch directly without two real BroadcastChannels — the `post`
 *  callback is how an 'offer' reply is sent (the real channel's
 *  postMessage in production, a spy in tests). No DOM access beyond the
 *  injected post. */
export function handleSessionHandoffMessage(
	data: unknown,
	post: (msg: SessionHandoffMessage) => void
): void {
	const msg = data as { t?: unknown; payload?: unknown } | null;
	if (!msg || typeof msg.t !== 'string') return;
	if (msg.t === 'request') {
		// A sibling tab booted locked and wants a session. Offer ours if
		// we have one. Several unlocked tabs may all reply; the requester
		// adopts the first and ignores the rest (it's no longer locked).
		const s = get(internal);
		if (s.state === 'unlocked' || s.state === 'paired-readonly') {
			try {
				post({ t: 'offer', payload: s, account: getUserBlurtAccount() });
			} catch {
				// Structured-clone or channel error — drop silently.
			}
		}
	} else if (msg.t === 'offer') {
		adoptOfferedSession(msg.payload, (msg as { account?: unknown }).account);
	} else if (msg.t === 'lock') {
		// v1.20.0 review (F-5): another tab's user EXPLICITLY locked (avatar
		// menu → Lock session). Lock here too, keeping the Remember-me
		// envelope — this is a lock, not a sign-out. Without it this tab stayed
		// unlocked and handed its keys straight back to the locked tab on its
		// next load. Only an unlocked session is locked: lockSession() on a
		// paired-readonly tab would sign that one out. Never re-broadcasts.
		if (get(internal).state === 'unlocked') lockSession();
	} else if (msg.t === 'signout') {
		// Another tab's user EXPLICITLY signed out. Wipe our in-memory
		// session too — this is the whole point of the signout message
		// (the storage-event mirror can't see an in-memory-only sign-out).
		// reset() is idempotent and does NOT re-broadcast (the broadcast
		// lives only in broadcastSignOut, never in reset), so this can't
		// loop. Fires only on an explicit sign-out, never on tab-close.
		reset({ clearDisk: true });
		// And everything else the sign-out forgets that lives in THIS tab: its
		// account name, chat maps, cached self-avatar and profile cache
		// (reset() deliberately keeps them: lock and pagehide must).
		forgetAccountInThisTab();
	}
}

function initSessionHandoff(): void {
	const ch = getSessionHandoffChannel();
	if (!ch) return;
	ch.onmessage = (ev: MessageEvent) => {
		handleSessionHandoffMessage(ev.data, (m) => ch.postMessage(m));
	};
}

/** Post one message to the other open tabs of this site (no-op without a
 *  BroadcastChannel). */
function postToOtherTabs(msg: SessionHandoffMessage): void {
	const ch = getSessionHandoffChannel();
	if (ch) ch.postMessage(msg);
}

/** EXPLICIT, user-initiated Lock (avatar menu → Lock session): lock this tab
 *  AND every other open tab of this site. (v1.20.0 review, F-5.)
 *
 *  lockSession() alone locks one tab; the others kept their keys and, since a
 *  freshly loaded tab asks its siblings for a session, reloading the locked
 *  tab got them straight back without a password. The Remember-me envelope
 *  stays on disk everywhere (Lock is not Sign Out). The idle auto-lock keeps
 *  calling lockSession() directly — it stays per-tab, so a tab you are using
 *  is not locked because another one sat idle.
 *
 *  `post` is injectable for tests; production uses the handoff channel. */
export function lockAllTabs(post: (msg: SessionHandoffMessage) => void = postToOtherTabs): void {
	try {
		post({ t: 'lock' });
	} catch {
		// Channel unavailable — this tab still locks below.
	}
	lockSession();
}

/** Ask any already-open tab for its session. Fire-and-forget: if a sibling
 *  replies, the listener flips this tab's store to unlocked/paired-readonly
 *  reactively (no password, no disk read). No-op when this tab already has a
 *  session, when no sibling answers, or when BroadcastChannel is unavailable. */
export function requestSessionFromOpenTabs(): void {
	const ch = getSessionHandoffChannel();
	if (!ch) return;
	if (get(internal).state !== 'locked') return;
	try {
		ch.postMessage({ t: 'request' });
	} catch {
		// no-op
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Reload self-handoff — Remember-me-gated, hard-reload carve-out
// ────────────────────────────────────────────────────────────────────────────
//
// If the user CHECKED "Remember me", a plain page refresh (F5 / the reload
// button) keeps them logged in WITHOUT a password — the convenience they opted
// into. A HARD refresh (Ctrl+Shift+R) is an explicit "clean slate" → LOCK. If
// Remember-me is OFF, EVERY refresh locks (the in-memory-only default is
// untouched).
//
// The cross-tab handoff above already covers a refresh while a SIBLING tab is
// open. This covers the LONE-tab refresh, and the decrypted keys never reach
// disk on the way ($lib/auth/reloadStash): on `pagehide` the session is
// encrypted under a fresh random key; this tab's sessionStorage gets only the
// ciphertext (browsers do write sessionStorage to disk — Chromium's session
// database, Firefox's session-restore file), and the key goes to the service
// worker, which keeps it in memory for at most RELOAD_STASH_MAX_AGE_MS and
// hands it out once. The next load asks for it, decrypts, and both are gone.
// After the worker stops, the browser closes or 30 s pass, what is on disk is
// ciphertext nobody can open.
//
// Written only when:
//   • the session is unlocked and its keystore IS the remembered one on disk
//     (isPersistedEnvelope) — a "just this session" sign-in, or a second
//     account used while another is remembered, is never stashed;
//   • a service worker controls the page (none → nothing could hold the key);
//   • the page is not going into the back/forward cache (never a reload).
// Restored only when this load is a reload (navigation type 'reload'), the
// stash is at most RELOAD_STASH_MAX_AGE_MS old, the service worker still has
// its key, and the decrypted keystore is still the remembered one. The stash
// is removed on the next load, used or not. Same-origin script could ask for
// the key, as it could read the live in-memory session.
//
// Hard-reload detection: a hard reload BYPASSES the service worker, so
// `navigator.serviceWorker.controller` is null on that load; a normal reload
// keeps it set. We FAIL CLOSED — null controller (hard reload, the rare
// pre-SW-activation first load, or a browser with service workers off, e.g.
// Tor Browser) → discard the stash and lock.

/** How long the next load waits for the service worker to hand over the key. */
const STASH_KEY_WAIT_MS = 3_000;

// LiveIdentity carries Uint8Array key bytes, which JSON does not — base64 them.
function reloadStashReplacer(_k: string, v: unknown): unknown {
	if (v instanceof Uint8Array) {
		let s = '';
		for (const b of v) s += String.fromCharCode(b);
		return { __u8__: btoa(s) };
	}
	return v;
}
function reloadStashReviver(_k: string, v: unknown): unknown {
	if (v && typeof v === 'object' && typeof (v as { __u8__?: unknown }).__u8__ === 'string') {
		const bin = atob((v as { __u8__: string }).__u8__);
		const u = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
		return u;
	}
	return v;
}

/** How this document was loaded ('reload', 'navigate', 'back_forward', …),
 *  or null when the browser does not say. */
function currentNavigationType(): string | null {
	try {
		if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
			return null;
		}
		const nav = performance.getEntriesByType('navigation')[0] as { type?: unknown } | undefined;
		return typeof nav?.type === 'string' ? nav.type : null;
	} catch {
		return null;
	}
}

/** The service worker controlling this page, or null (hard reload, none). */
function serviceWorkerController(): ServiceWorker | null {
	try {
		if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
		return navigator.serviceWorker.controller ?? null;
	} catch {
		return null;
	}
}

/** Remove any stash this tab holds, including the plaintext ones older builds
 *  wrote. */
function dropReloadStash(): void {
	for (const k of LEGACY_RELOAD_STASH_KEYS) safeSession.remove(k);
	safeSession.remove(RELOAD_STASH_KEY);
}

/** Stash the live session for a same-tab reload. Called from `pagehide`
 *  (see handlePageHide) BEFORE reset() wipes the in-memory keys. Writes only
 *  ciphertext, and only for the remembered session (see above); a
 *  paired-readonly session has its own disk marker (autoRestorePairedSession)
 *  and is never stashed here. Synchronous: pagehide cannot wait. */
export function stashSessionForReload(): void {
	// No `browser` guard: safeSession is SSR-safe and the sole caller is the
	// browser-gated pagehide listener; omitting it lets vitest exercise this.
	dropReloadStash();
	const s = get(internal);
	if (s.state !== 'unlocked' || !s.live || !s.envelope) return;
	if (!isPersistedEnvelope(s.envelope)) return;
	const controller = serviceWorkerController();
	if (controller === null || sodium === undefined) return;
	let plain: Uint8Array | null = null;
	let key: Uint8Array | null = null;
	try {
		plain = new TextEncoder().encode(
			JSON.stringify({ live: s.live, envelope: s.envelope }, reloadStashReplacer)
		);
		const sealed = sealStash(sodium, plain, Date.now());
		key = sealed.key;
		// postMessage copies the key at once; ours is zeroed below.
		controller.postMessage({ type: SW_STASH_PUT, id: sealed.record.id, key });
		safeSession.set(RELOAD_STASH_KEY, JSON.stringify(sealed.record));
	} catch {
		safeSession.remove(RELOAD_STASH_KEY);
	} finally {
		plain?.fill(0);
		key?.fill(0);
	}
}

/** Ask the service worker for (and so remove) the key of stash `id`. */
function takeStashKey(controller: ServiceWorker, id: string): Promise<Uint8Array | null> {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		let settled = false;
		const finish = (key: Uint8Array | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				channel.port1.close();
			} catch {
				// already closed
			}
			resolve(key);
		};
		const timer = setTimeout(() => finish(null), STASH_KEY_WAIT_MS);
		channel.port1.onmessage = (ev: MessageEvent) => {
			const key = (ev.data as { key?: unknown } | null)?.key;
			// Checked by tag, not instanceof: a cloned buffer may come from
			// another realm. Copied into ours; the received copy is wiped.
			if (Object.prototype.toString.call(key) !== '[object Uint8Array]') return finish(null);
			const received = key as Uint8Array;
			const own = received.length === 32 ? new Uint8Array(received) : null;
			received.fill(0);
			finish(own);
		};
		try {
			controller.postMessage({ type: SW_STASH_TAKE, id }, [channel.port2]);
		} catch {
			finish(null);
		}
	});
}

/** Consume a reload stash on the next load. CONSUME-ONCE: the stash is
 *  removed before anything else. Restores only when ALL hold: (a) we're still
 *  locked (never clobber a live session, e.g. a sibling handoff already won);
 *  (b) a service-worker controller is present (a hard reload has none → lock,
 *  failing closed) and still holds the stash's key; (c) this load IS a reload
 *  (navigation type 'reload'); (d) the stash is at most
 *  RELOAD_STASH_MAX_AGE_MS old; (e) the decrypted keystore is still the one
 *  remembered on disk. */
export async function restoreSessionFromReloadStash(): Promise<void> {
	const raw = safeSession.get(RELOAD_STASH_KEY);
	dropReloadStash();
	if (raw === null) return;
	if (get(internal).state !== 'locked') return;
	const controller = serviceWorkerController();
	if (controller === null) return; // hard reload (Ctrl+Shift+R) or pre-activation → lock
	// A new visit, a reopened/restored tab, Back/Forward → password prompt.
	if (currentNavigationType() !== 'reload') return;
	const record = parseStashRecord(raw);
	if (record === null) return;
	const age = Date.now() - record.at;
	// Too old, or from the future (clock moved back by more than a little).
	if (!(age >= -5_000 && age <= RELOAD_STASH_MAX_AGE_MS)) return;
	const key = await takeStashKey(controller, record.id);
	if (key === null) return;
	let plain: Uint8Array | null = null;
	try {
		await ensureSodium();
		plain = openStash(sodium, record, key);
		if (plain === null) return;
		const parsed = JSON.parse(new TextDecoder().decode(plain), reloadStashReviver) as {
			live?: LiveIdentity;
			envelope?: KeystoreEnvelope;
		};
		if (!parsed.live || !parsed.envelope) return;
		if (!isPersistedEnvelope(parsed.envelope) || get(internal).state !== 'locked') {
			wipeLiveIdentity(parsed.live);
			return;
		}
		internal.set({ state: 'unlocked', live: parsed.live, envelope: parsed.envelope });
	} catch {
		// Malformed stash — stay locked; the envelope is still persisted, so
		// the user can unlock with their password.
	} finally {
		key.fill(0);
		plain?.fill(0);
	}
}

/** The `pagehide` handler. Wipes the in-memory keys (reset) on every
 *  pagehide; stashes them for a reload first — but NOT when the page is
 *  going into the back/forward cache (`persisted`), which is never a reload.
 *  Exported for tests. */
export function handlePageHide(persisted: boolean): void {
	if (!persisted) stashSessionForReload();
	reset();
}

/** Explicit, user-initiated Sign Out that propagates to every open tab.
 *  Posts a one-shot 'signout' over the handoff channel (so sibling tabs
 *  holding the SAME in-memory session wipe their keys too) and then resets
 *  THIS tab.
 *
 *  Use this — NOT reset() alone — for the Sign Out button. Without it, an
 *  in-memory-only session (Remember-me unchecked → no disk envelope → no
 *  `storage` event to mirror) stays alive in any sibling tab the cross-tab
 *  handoff cloned it into, which contradicts an explicit "sign me out".
 *
 *  Deliberately NOT wired into reset(), pagehide, or lockSession(): closing
 *  one tab, the idle auto-lock, or a per-tab Lock must never sign the user
 *  out of their other tabs. The broadcast is the single distinguishing act
 *  of an EXPLICIT sign-out. Idempotent and safe to call when already locked
 *  (siblings receiving the message just reset() a locked store — a no-op). */
export function broadcastSignOut(): void {
	// Stop this browser's push notifications for the
	// account BEFORE the session is wiped: reset() zeroes the posting key, and
	// the relay-side unsubscribe should be signed with it. So take a COPY of the
	// key and the account name now; push.ts signs, unsubscribes (browser and
	// relay) and zeroes the copy. Without this, the next person at a shared
	// browser kept getting notifications naming who messaged this account.
	// Dynamically imported (push.ts imports this store) and never awaited: a
	// sign-out must not wait on the network.
	let pushKey: Uint8Array | null = null;
	let pushAccount: string | null = null;
	try {
		const cur = get(internal);
		if (cur.state === 'unlocked') pushKey = cur.live.posting.privateKey.slice();
		pushAccount = getUserBlurtAccount();
	} catch {
		// Best-effort; the browser-side unsubscribe still runs without these.
	}
	const pushKeyCopy = pushKey;
	const pushAccountName = pushAccount;
	void import('$lib/notifications/push')
		.then((mod) => mod.unsubscribeOnSignOut(pushAccountName, pushKeyCopy))
		.catch(() => {
			(pushKeyCopy as Uint8Array | null)?.fill(0);
		});

	const ch = getSessionHandoffChannel();
	if (ch) {
		try {
			ch.postMessage({ t: 'signout' });
		} catch {
			// Channel error — local reset still runs below.
		}
	}
	// A sign-out MUST fully complete. Leaving any one of these clears un-run is
	// a security/UX bug: identity wiped but account-name still remembered (so
	// the login page keeps offering to "sign out of @you"), or the reverse.
	// Some browsers throw on localStorage / crypto access in private or
	// storage-restricted contexts, so each step is ISOLATED — a throw in one
	// can never abort the rest. Best-effort, matching the channel-post catch
	// above. Order preserved: clearKeystore/clearPairedSession run BEFORE
	// reset() so hasPersistedKeystore() is already false when the signed-out
	// header CTA's $derived re-runs on the $hasAnySession flip inside reset()
	// (otherwise the header button sticks on "Unlock"). No import cycle:
	// persistentKeystore/pairedSession don't import this store.
	const bestEffort = (fn: () => void): void => {
		try {
			fn();
		} catch {
			// Isolated: a failure here must not prevent the other clears.
		}
	};
	// EXPLICIT sign-out wipes disk for real, SYNCHRONOUSLY (not via reset()'s
	// clearDisk dynamic-import path, which lands a microtask later).
	bestEffort(clearKeystore);
	bestEffort(clearPairedSession);
	bestEffort(() => reset());
	forgetAccountInThisTab();
}

/** Explicit Sign Out, the part every open tab must do for itself — the tab
 *  that signed out (broadcastSignOut) and each sibling that hears its
 *  'signout' message. A sibling may hold its own "just this session" account
 *  name (its sessionStorage, which no other tab can reach), conversation maps
 *  in memory that a still-mounted view would write back, and a profile cache
 *  filed under the account: left alone, it kept naming the account to the
 *  operator on every chat poll and wrote peers back to disk after the
 *  sweep. Never called from reset(), lock or pagehide. */
function forgetAccountInThisTab(): void {
	const bestEffort = (fn: () => void): void => {
		try {
			fn();
		} catch {
			// Isolated: a failure here must not prevent the other clears.
		}
	};
	// Forget the persisted account name on an EXPLICIT sign-out so the login
	// page's signed-in gate (getUserBlurtAccount(), reading the shared-across-
	// tabs `morphit.blurtAccount` localStorage key) no longer reports an
	// account anywhere. A remembered name is in localStorage (per origin); a
	// "just this session" name is in each tab's own sessionStorage, which is
	// why every tab runs this. Deliberately here and NOT in reset():
	// reset() also runs on pagehide/lockSession(), where wiping this
	// convenience cache would force the user to re-enter their account name
	// every session — the name-clear is the mark of an EXPLICIT sign-out.
	bestEffort(clearUserBlurtAccount);
	// This tab's own sessionStorage: a "just this session" name, and the chat
	// state such a sign-in keeps there instead of on disk.
	bestEffort(sweepSessionAccountKeysOnSignOut);
	// Forget every OTHER account-derived key too (display name, bio, links,
	// chat peers/pins/read-state, unsent drafts, and the NOT-account-scoped
	// `morphit.userPreferences.v1`). Before this, all of that survived an
	// explicit sign-out: the maintainer watched his tester3 region setting carry into a
	// fresh testowner session, and a signed-out person's bio and chat peers sat
	// in localStorage on a shared machine. Allow-list based, so a NEW
	// per-account key is forgotten by default rather than surviving until
	// someone remembers to add it. See $lib/storage/signOutSweep.
	bestEffort(sweepAccountStorageOnSignOut);
	// The chat stores keep their maps in memory too, and a view still mounted
	// (a conversation marked read as it unmounts) would write the whole old map
	// back. Reset them, then sweep again once the page has moved on, so nothing
	// of this account is left on disk a second after the sign-out.
	void import('$lib/chat/signOutReset')
		.then((mod) => mod.resetChatOnSignOut())
		.catch(() => {})
		.finally(() => {
			bestEffort(sweepAccountStorageOnSignOut);
			for (const ms of [300, 900]) {
				setTimeout(() => bestEffort(sweepAccountStorageOnSignOut), ms);
			}
		});
	// Also drop the cached self-avatar (shown in the menu + IdentityLabels).
	// Dynamically imported to keep selfProfile's deps out of this store's
	// static graph; EXPLICIT sign-out only (reset()/lockSession keep it —
	// public data, re-shown on unlock). Chunk-load failure is harmless: the
	// avatar cache is refreshed per account on the next unlock anyway.
	void import('$lib/stores/selfProfile').then((mod) => mod.clearSelfProfile()).catch(() => {});
	// And the on-disk profile cache: which accounts this browser looked up is
	// the signed-out person's history, not the device's.
	void import('$lib/indexer/profileCache')
		.then((mod) => mod.forgetProfilesOnSignOut())
		.catch(() => {});
}

if (browser) {
	autoRestorePairedSession();

	// Lone-tab refresh restore (Remember-me-gated). Consumes any reload stash
	// this tab's own pagehide left; a hard reload discards it (controller
	// null → lock). Runs after the paired restore so a disk-restored paired
	// session short-circuits it. It finishes asynchronously (the service
	// worker hands over the stash key), so it may race the sibling request
	// below: both act only on a locked store, so whichever lands first wins
	// and the other is ignored.
	void restoreSessionFromReloadStash();

	// Set up the cross-tab handoff listener (so this tab can ANSWER sibling
	// requests) and immediately ask any open tab to hand us a session.
	initSessionHandoff();
	requestSessionFromOpenTabs();

	// Best-effort: wipe keys when the tab closes/reloads. JS engines don't
	// guarantee this runs, but when it does, it reduces the window in which
	// keys sit in freed-but-not-scrubbed heap. We STASH first (Remember-me-
	// gated, a no-op otherwise) so a plain refresh can re-establish the
	// session on the next load, THEN reset() wipes the in-memory copy.
	window.addEventListener('pagehide', (e) => {
		handlePageHide((e as PageTransitionEvent).persisted === true);
	});

	// A page restored from the back/forward cache comes back LOCKED: pagehide
	// wiped its keys and (v1.20.0, F-4) left no stash, because going into the
	// bfcache is never a reload. The user unlocks with their password (or a
	// sibling tab hands the session over on the next full load).

	// Cross-tab unlock state propagation (§F.17 + for paired).
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
