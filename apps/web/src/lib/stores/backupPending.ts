/**
 * Morphit — "you have keys you haven't backed up yet".
 *
 * Set when a posting-only account keeps its Active key on this device: it now
 * holds key material that exists NOWHERE else, and losing the device loses it.
 * Ken: put a red dot on the avatar and beside "Back up my keys".
 *
 * Cleared when the user visits /backup-keys. Deliberately local-only and
 * account-scoped-by-nature (the keystore is per-device); nothing is broadcast,
 * nothing is fetched.
 */
import { writable } from 'svelte/store';
import { safeLocal } from '$lib/utils/safeStorage';

const KEY = 'morphit.backup_material_pending';

function read(): boolean {
	return safeLocal.get(KEY) === '1';
}

export const backupMaterialPending = writable<boolean>(read());

export function markBackupMaterialPending(): void {
	safeLocal.set(KEY, '1');
	backupMaterialPending.set(true);
}

export function clearBackupMaterialPending(): void {
	safeLocal.remove(KEY);
	backupMaterialPending.set(false);
}
