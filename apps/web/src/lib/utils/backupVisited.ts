/**
 * Backup-visited tracker.
 *
 * Drives the "Backup my keys" badge in the avatar menu: the badge
 * shows until the user has visited /backup-keys at least once. This
 * nudges new users toward backing up without being obnoxious about
 * it — one visit and the badge disappears forever on this device.
 *
 * Policy: the badge is a one-time nudge. We don't try to police
 * whether the user actually *downloaded* their keyfile — we can't
 * know that from client code, and a "did you really back up?"
 * nagbox would annoy users who already backed up on a different
 * device or already have their seed written down from onboarding.
 * A single visit to the page is enough to clear the badge.
 *
 * Storage: localStorage key `morphit.backupKeysVisited` = '1'. Uses
 * safeStorage, so Private Mode / Tor Browser users see the badge
 * forever (acceptable — those sessions are transient anyway and
 * the nudge doesn't hurt).
 */

import { writable, type Readable } from 'svelte/store';
import { safeLocal } from './safeStorage';

const STORAGE_KEY = 'morphit.backupKeysVisited';

/** Read the initial state from storage. Called once at module load. */
function readInitial(): boolean {
	return safeLocal.get(STORAGE_KEY) === '1';
}

const internal = writable<boolean>(readInitial());

/** Svelte-subscribable: true once the user has visited the backup
 *  page at least once on this device. Components use the `!$backupVisited`
 *  inverse to decide whether to show the nudge badge. */
export const backupVisited: Readable<boolean> = { subscribe: internal.subscribe };

/** Mark the backup page as visited. Idempotent — writes the flag
 *  and updates the store. Safe to call every time /backup-keys
 *  mounts; only the first call actually does anything visible. */
export function markBackupVisited(): void {
	safeLocal.set(STORAGE_KEY, '1');
	internal.set(true);
}

/** Reset the visited flag — used by Settings' "Remind me about key
 *  backup again" affordance, for users who want the nudge back. */
export function clearBackupVisited(): void {
	safeLocal.remove(STORAGE_KEY);
	internal.set(false);
}
