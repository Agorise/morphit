/**
 * Paired-readonly session persistence.
 *
 * QR-pair sign-in (ADR-0022) verifies the user's identity on this
 * device without delivering any signing material — the posting key
 * stays on the phone, the desktop only learns the account name and
 * chat pubkey.  That state needs to survive a tab reload but it is
 * NOT the same shape as a keystore envelope: no ciphertext, no
 * password, no decrypt step.
 *
 * Stored shape — all public information, no secrets:
 *   morphit.paired.session — JSON {
 *     v: 1,
 *     account: <blurt account name>,
 *     chatPubkey: <pem-encoded chat pubkey from the pairing bundle>,
 *     pairingId: <one-time pairing id used during the handshake>,
 *     pairedAt: <unix-seconds timestamp>
 *   }
 *
 * Read/write goes through safeStorage so Private Mode / Tor Browser /
 * disabled localStorage degrade gracefully — same posture as the
 * keystore envelope persistence module next door.
 *
 * Lifecycle:
 *   - Written by bootFromPairedSession() in $stores/identity after a
 *     verified QR-pair handshake.
 *   - Read by the layout/login-page mount path so a tab reload
 *     re-establishes the paired-readonly session.
 *   - Cleared by signOut from a paired-readonly state, by switching
 *     to a real keystore unlock (paired and unlocked are mutually
 *     exclusive — see identity store), and by any reset() call.
 *
 * Note: This module persists ONLY public information.  No secret
 * material lives here.  Anyone reading localStorage learns the
 * Blurt account name + a public chat pubkey + a one-time pairing
 * id — all of which are public on chain or burnt after use.
 */

import { safeLocal } from '../utils/safeStorage';

/** Storage key for the paired-readonly session marker.  Exported so
 *  the identity store's cross-tab listener can identify storage
 *  events targeting paired-session state, the same way it identifies
 *  envelope-targeted events. */
export const PAIRED_SESSION_STORAGE_KEY = 'morphit.paired.session';

const KEY = PAIRED_SESSION_STORAGE_KEY;

/** A persisted paired-readonly session record. */
export interface PairedSession {
	readonly v: 1;
	readonly account: string;
	readonly chatPubkey: string;
	readonly pairingId: string;
	readonly pairedAt: number;
}

/** Read the paired-readonly session record, or null if none is
 *  persisted / the stored value fails validation. */
export function readPairedSession(): PairedSession | null {
	const raw = safeLocal.get(KEY);
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!isValidPairedSession(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Write the paired-readonly session record.  Idempotent — overwrites
 *  any previous record.  Returns true on success, false if the
 *  underlying storage refused (Private Mode, full quota, etc.) so
 *  callers can degrade gracefully. */
export function writePairedSession(session: PairedSession): boolean {
	const ok = safeLocal.set(KEY, JSON.stringify(session));
	return ok;
}

/** Clear the paired-readonly session record from disk.  Idempotent. */
export function clearPairedSession(): void {
	safeLocal.remove(KEY);
}

/** True iff a paired-readonly session is currently persisted. */
export function hasPairedSession(): boolean {
	return readPairedSession() !== null;
}

/** Maximum acceptable age for a persisted paired-session record.
 *  Anything older is rejected as "obviously bogus" — defends against
 *  a hostile same-origin tab (or compromised localStorage) writing
 *  a 1970-epoch timestamp to bypass a future expiration policy or
 *  to make a stale session look fresh.
 *
 *  365 days chosen as the cutoff: generous enough that an active
 *  user re-paired any time in the last year passes, tight enough
 *  that the 1970-epoch attack fails.  This is a sanity bound, NOT
 *  an active expiration policy — sessions don't expire after a year
 *  during normal use because the paired marker is refreshed every
 *  time the user re-pairs.  Pre-Part 122 cp4 this check was missing
 *  despite the docblock comment promising it ("Reject obviously-
 *  bogus timestamps (negative, far past, far future)").  F9 from
 *  Part 122 cp1's audit-pattern lesson: defense contracts in
 *  comments must match defense reality in code. */
const MAX_PAIRED_AGE_SECONDS = 365 * 86400;

/** Defensive validator.  The paired-session record is small and
 *  fully public, but we still validate shape + length so that a
 *  hostile same-origin tab writing garbage doesn't make the
 *  identity store boot a malformed session.  Account names and
 *  chat pubkeys both have known character classes and length
 *  bounds; we enforce them here. */
function isValidPairedSession(x: unknown): x is PairedSession {
	if (typeof x !== 'object' || x === null) return false;
	const r = x as Record<string, unknown>;
	if (r.v !== 1) return false;
	if (typeof r.account !== 'string') return false;
	// Blurt account regex: lowercase letter, then 1–14 of [a-z0-9.-],
	// ending alphanumeric (no trailing dash/dot).  Match the same
	// constraint payload validators use everywhere else.
	if (!/^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/.test(r.account)) return false;
	if (typeof r.chatPubkey !== 'string') return false;
	// Chat pubkey is base64-or-pem encoded.  No need to fully parse
	// here — it's never used as the basis for any signing operation
	// (paired sessions can't sign), so an invalid pubkey just means
	// chat won't decrypt right.  Cap length so localStorage doesn't
	// get bloated.
	if (r.chatPubkey.length < 16 || r.chatPubkey.length > 4096) return false;
	if (typeof r.pairingId !== 'string') return false;
	// Pairing IDs are opaque, but bounded.
	if (r.pairingId.length < 8 || r.pairingId.length > 256) return false;
	if (typeof r.pairedAt !== 'number' || !Number.isFinite(r.pairedAt)) return false;
	// Reject obviously-bogus timestamps (negative, far past, far future).
	const now = Math.floor(Date.now() / 1000);
	if (r.pairedAt < 0) return false;
	if (r.pairedAt > now + 86400) return false; // far future: > 24h ahead
	if (r.pairedAt < now - MAX_PAIRED_AGE_SECONDS) return false; // far past: > 365d behind (Part 122 cp4 F9 fix)
	return true;
}
