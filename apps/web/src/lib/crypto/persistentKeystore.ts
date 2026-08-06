/**
 * Persistent keystore storage.
 *
 * When the user chose "Password (fast)" during onboarding, we persist
 * their encrypted keystore envelope to localStorage so Lock Session
 * is meaningfully different from Sign Out: next visit, they can
 * unlock with just their password instead of re-entering their seed.
 *
 * When the user chose "Seed every time (most private)", we persist
 * NOTHING. Lock Session and Sign Out produce the same result because
 * there's no persisted keystore.
 *
 * Storage layout:
 *   morphit.keystore.mode       — 'password' | 'seed-only'
 *   morphit.keystore.envelope   — JSON-stringified KeystoreEnvelope
 *
 * Both go through safeStorage so Private Mode / Tor Browser / disabled
 * localStorage degrade gracefully: writes no-op, reads return null,
 * and the user falls through to seed-import every session.
 */

import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { safeLocal } from '../utils/safeStorage';
import type { KeystoreEnvelope, SimplePassphraseEnvelope } from '$crypto/keystore';
import { validateLayeredEnvelope, validateSimpleEnvelope } from '$crypto/keystore';

/** Storage key for the keystore mode (which path the user chose at
 *  onboarding).  Exported so the identity store's cross-tab
 *  listener can identify storage events targeting our keystore. */
export const KEYSTORE_MODE_STORAGE_KEY = 'morphit.keystore.mode';
/** Storage key for the encrypted envelope itself.  Same export
 *  rationale as KEYSTORE_MODE_STORAGE_KEY. */
export const KEYSTORE_ENVELOPE_STORAGE_KEY = 'morphit.keystore.envelope';
/** Storage key for the timestamp at which this device first
 *  persisted a keystore.  Set ONCE — subsequent re-keys (rotate,
 *  add yubikey, etc.) preserve the original timestamp.  Drives
 *  the 7-day backup-seed nudge; without it, the nudge can't
 *  determine "how long has this user been on this device." */
export const KEYSTORE_FIRST_PERSIST_AT_KEY = 'morphit.keystore.first_persist_at';
/** Storage key for the user's permanent dismissal of the
 *  seed-backup nudge.  Once set to '1', the nudge never fires
 *  again on this device.  Cleared by a full sign-out
 *  (clearKeystore) so a re-onboarding restarts the prompt
 *  schedule. */
export const KEYSTORE_BACKUP_NUDGE_DISMISSED_KEY = 'morphit.keystore.backup_nudge_dismissed';

const MODE_KEY = KEYSTORE_MODE_STORAGE_KEY;
const ENVELOPE_KEY = KEYSTORE_ENVELOPE_STORAGE_KEY;
const FIRST_PERSIST_KEY = KEYSTORE_FIRST_PERSIST_AT_KEY;
const NUDGE_DISMISSED_KEY = KEYSTORE_BACKUP_NUDGE_DISMISSED_KEY;

export type KeystoreMode = 'password' | 'seed-only';

/** Read the user's chosen keystore mode. null means no choice has
 *  been recorded yet — treat as seed-only (safer default). */
export function readKeystoreMode(): KeystoreMode | null {
	const v = safeLocal.get(MODE_KEY);
	if (v === 'password' || v === 'seed-only') return v;
	return null;
}

/** Record the user's keystore mode choice at onboarding. Called
 *  when the user picks password-fast vs seed-every-time. */
export function writeKeystoreMode(mode: KeystoreMode): void {
	safeLocal.set(MODE_KEY, mode);
	notifyKeystoreChanged();
}

/** Persist the encrypted envelope. Only called when mode is
 *  'password' — seed-only users never persist.
 *
 *  M8 fix: returns `true` on successful persist, `false` if the
 *  storage write failed (quota, private mode, disabled storage,
 *  JSON-stringify failure).  Callers that perform irreversible UI
 *  state changes (e.g. enrollment "success" toast, hardening) must
 *  check the return value and surface a "couldn't save to this
 *  device" error on `false` instead of optimistically claiming
 *  success.  Otherwise a user can think enrollment persisted, then
 *  reload to find the OLD envelope, potentially losing access. */
export function writeEnvelope(env: KeystoreEnvelope): boolean {
	let serialized: string;
	try {
		serialized = JSON.stringify(env);
	} catch {
		// JSON-stringify failure would be extraordinary (envelope is
		// plain serializable), but if it happens the right move is
		// to fail loudly.
		return false;
	}
	const ok = safeLocal.set(ENVELOPE_KEY, serialized);
	notifyKeystoreChanged();
	// Stamp the first-persist anchor ONCE — set on the first
	// successful write, untouched on subsequent writes (rotate,
	// add yubikey, etc.).  Cleared only by clearKeystore (full
	// sign-out).  Drives the 7-day seed-backup nudge.
	if (ok && safeLocal.get(FIRST_PERSIST_KEY) === null) {
		safeLocal.set(FIRST_PERSIST_KEY, String(Date.now()));
	}
	return ok;
}

/** Read the persisted envelope. Returns null when no envelope
 *  exists (fresh device, seed-only mode, cleared after sign-out).
 *
 *  L15 fix: pre-fix, a JSON.parse failure auto-wiped the envelope.
 *  A transient read corruption (storage glitch, encoding hiccup)
 *  could permanently destroy the user's only persisted keystore.
 *  Now we leave it alone and return null; the caller surfaces a
 *  clear error and the user can investigate (refresh, restart
 *  browser) before reaching the seed-import fallback. */
export function readEnvelope(): KeystoreEnvelope | null {
	const raw = safeLocal.get(ENVELOPE_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as KeystoreEnvelope;
		// P5-6 + audit 2026-05 finding 1-1: validate at read time
		// for BOTH schemes so a tampered localStorage value can't
		// slip through and surface as a confusing decrypt failure
		// later.  Layered uses validateLayeredEnvelope; simple-
		// passphrase (default scheme) uses validateSimpleEnvelope.
		if (parsed && typeof parsed === 'object') {
			const scheme = (parsed as { scheme?: string }).scheme;
			if (scheme === 'layered-cek') {
				validateLayeredEnvelope(parsed as KeystoreEnvelope & { scheme: 'layered-cek' });
			} else {
				// Default = simple-passphrase (scheme missing or set explicitly).
				validateSimpleEnvelope(parsed as SimplePassphraseEnvelope);
			}
		}
		return parsed;
	} catch {
		// Don't wipe — preserve the stored bytes so a transient
		// read failure isn't catastrophic.  Return null so the
		// caller falls through to import-needed UI; the user keeps
		// their option to re-import from seed.
		return null;
	}
}

/** True when a persisted envelope exists and is readable. The
 *  login page uses this to decide "unlock with password" vs
 *  "import seed / keyfile" UI. */
export function hasPersistedKeystore(): boolean {
	return readKeystoreMode() === 'password' && readEnvelope() !== null;
}

/** Reactive mirror of `hasPersistedKeystore()`.
 *
 *  v1.8.11 (Ken) — the header CTA read the plain function inside a `$derived`
 *  keyed on `$hasAnySession`, which works for lock (session flips true→false)
 *  but NOT for signing out while ALREADY locked: `hasAnySession` is false both
 *  before and after, so the derived never re-ran and the button stayed on
 *  "Unlock" when it should have become "Start". That path is reachable — the
 *  welcome-back/unlock screen offers sign-out.
 *
 *  localStorage is not reactive, so every mutator below notifies this store.
 *  Read it from UI instead of calling the function directly. */
export const persistedKeystorePresent = writable<boolean>(
	browser ? readKeystoreMode() === 'password' && readEnvelope() !== null : false
);

/** Re-read the real state and publish it. Called by every keystore mutator so
 *  the store can never drift from what is actually on disk. */
function notifyKeystoreChanged(): void {
	persistedKeystorePresent.set(hasPersistedKeystore());
}

/** Wipe the persisted envelope but keep the mode. Used by Lock
 *  Session — wait, actually Lock Session KEEPS the envelope so the
 *  user can unlock next session. This is actually used by Sign Out. */
export function clearEnvelope(): void {
	safeLocal.remove(ENVELOPE_KEY);
	notifyKeystoreChanged();
}

/** Full wipe — mode AND envelope. The nuclear option, used by Sign
 *  Out to leave no trace on this device. */
export function clearKeystore(): void {
	safeLocal.remove(ENVELOPE_KEY);
	safeLocal.remove(MODE_KEY);
	notifyKeystoreChanged();
	// Clear the nudge anchors too — a sign-out is a full
	// session reset, and a future re-onboarding should restart
	// the 7-day prompt schedule.
	safeLocal.remove(FIRST_PERSIST_KEY);
	safeLocal.remove(NUDGE_DISMISSED_KEY);
}

/** ── Seed-backup nudge ─────────────────────────────────────────
 *
 * After a user has had a persisted keystore on this device for
 * 7+ days without dismissing the nudge, we surface a banner
 * encouraging them to write down their seed phrase somewhere
 * durable.  The risk we're addressing: a user who set up Morphit
 * with "password fast" mode, never wrote down their seed, and
 * then loses the device or clears their browser data — they
 * cannot recover.
 *
 * The nudge fires at most once: a "Got it, dismiss" click
 * persists `morphit.keystore.backup_nudge_dismissed = '1'` and
 * the nudge never returns on this device.
 *
 * Falls cleanly when:
 *   - localStorage disabled (Private Mode) → first_persist_at is
 *     never set, nudge never fires (and the user is in a tab
 *     that vanishes when they close it, so the failure mode is
 *     different).
 *   - User chose 'seed-only' mode → no envelope was persisted,
 *     no first_persist_at was stamped, nudge never fires.
 *   - Less than 7 days since first persist → nudge does not fire.
 */

const NUDGE_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Returns true when the seed-backup banner SHOULD render in the
 *  current session.  Pure function of localStorage state. */
export function shouldShowSeedBackupNudge(): boolean {
	// Already dismissed → never show again.
	if (safeLocal.get(NUDGE_DISMISSED_KEY) === '1') return false;
	// No first-persist anchor → user never persisted a keystore on
	// this device (seed-only mode, fresh install, or pre-anchor
	// install).  No nudge.
	const stampRaw = safeLocal.get(FIRST_PERSIST_KEY);
	if (stampRaw === null) return false;
	const stamp = Number.parseInt(stampRaw, 10);
	if (!Number.isFinite(stamp) || stamp <= 0) return false;
	// 7-day threshold check.
	return Date.now() - stamp >= NUDGE_DELAY_MS;
}

/** Permanently dismiss the seed-backup nudge on this device.
 *  Called when the user clicks "Got it" in the banner. */
export function dismissSeedBackupNudge(): void {
	safeLocal.set(NUDGE_DISMISSED_KEY, '1');
}
