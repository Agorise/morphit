/**
 * Where this tab keeps the signed-in person's local state that has to follow
 * the sign-in's own lifetime — today the chat read state and recent peers,
 * both of which name the people this person talks to.
 *
 *   - a session remembered on this device (Remember me, or a paired device)
 *     → localStorage, so it survives closing the browser, like the session;
 *   - a "just this session" sign-in → this tab's sessionStorage, so closing
 *     the tab forgets it, like the session (nothing naming a peer is left on
 *     disk for the next person at the machine);
 *   - no live session (locked, signed out — here or in another tab) → nowhere:
 *     a late write (a conversation view marking itself read as it unmounts)
 *     must not put the old person's peers back after the sign-out sweep.
 *
 * Set by the identity store on every session change. When a running session
 * becomes the remembered one (Remember me committed), this tab's state
 * replaces the device copy. When it stops being the remembered one (another
 * account was remembered from another tab), nothing is copied from the device
 * — that copy may already be the other account's — and the tab carries on
 * from what it holds itself.
 */
import { writable, get, type Readable } from 'svelte/store';
import { safeLocal, safeSession } from '$utils/safeStorage';

export type PersonStorageTier = 'local' | 'session' | null;

/** The keys kept in person storage. */
export const PERSON_STORAGE_KEYS: readonly string[] = [
	'morphit.chat.read_state',
	'morphit.chat.recent_peers'
];

const tierStore = writable<PersonStorageTier>(null);

/** The current tier. A subscriber re-reads its state when a session starts or
 *  ends (to or from null), and keeps what it holds across local ↔ session. */
export const personStorageTier: Readable<PersonStorageTier> = { subscribe: tierStore.subscribe };

type Area = typeof safeLocal;
const areaOf = (t: PersonStorageTier): Area | null =>
	t === 'local' ? safeLocal : t === 'session' ? safeSession : null;

export function setPersonStorageTier(next: PersonStorageTier): void {
	const prev = get(tierStore);
	if (prev === next) return;
	if (prev === 'session' && next === 'local') {
		// This session is now the one remembered here: its state is the device's.
		for (const k of PERSON_STORAGE_KEYS) {
			const v = safeSession.get(k);
			if (v === null) safeLocal.remove(k);
			else if (safeLocal.set(k, v)) safeSession.remove(k);
		}
	}
	tierStore.set(next);
}

export function personGet(key: string): string | null {
	return areaOf(get(tierStore))?.get(key) ?? null;
}

/** Stores `value` where the session's state lives; nowhere without a session. */
export function personSet(key: string, value: string): void {
	areaOf(get(tierStore))?.set(key, value);
}

/** Removes `key` from both areas (a reset is never partial). */
export function personRemove(key: string): void {
	safeLocal.remove(key);
	safeSession.remove(key);
}
