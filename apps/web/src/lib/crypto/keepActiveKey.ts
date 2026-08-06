/**
 * Morphit — "Keep my Active key on this device" (tt.txt #11).
 *
 * Orchestrates the one moment a posting-only account becomes able to spend:
 * decrypt with the user's Morphit password, store the verified Active key
 * alongside the Posting key, persist, and promote the live session.
 *
 * Three rules, in priority order — privacy, security, grandma:
 *
 *  1. NEVER SILENT. Only ever called from an explicit "Yes, keep it" choice.
 *     A posting-only user chose posting-only; promoting them behind their back
 *     would widen their password from "can post" to "can spend" without asking.
 *  2. THE PASSWORD IS THE GATE. The upgrade decrypts the existing envelope
 *     first, so possession of the Active key alone cannot rewrite a keystore.
 *  3. DISK ONLY IF DISK. If the user never chose to persist a keystore, we
 *     upgrade the in-memory session and leave the disk exactly as we found it.
 *     "Keep on this device" must not quietly start writing keys to a device
 *     the user deliberately kept clean.
 */

import { get } from 'svelte/store';
import * as secp256k1 from '@noble/secp256k1';
import sodium from 'libsodium-wrappers-sumo';

import { identity, updateUnlockedIdentity } from '$stores/identity';
import { upgradeToPostingActive } from '$crypto/keystore';
import { hasPersistedKeystore, writeEnvelope } from '$crypto/persistentKeystore';
import { ensureSodium } from '$crypto/keygen';
import { markBackupMaterialPending } from '$lib/stores/backupPending';

export type KeepActiveKeyResult =
	| { ok: true }
	| { ok: false; kind: 'locked' | 'bad_password' | 'not_posting_only' | 'failed' };

/**
 * @param password     the user's Morphit password (unlocks the keystore).
 * @param activeScalar a VERIFIED active key (see `activeKeyUnlock.ts`). This
 *                     function takes ownership and wipes it.
 */
export async function keepActiveKeyOnThisDevice(
	password: string,
	activeScalar: Uint8Array
): Promise<KeepActiveKeyResult> {
	await ensureSodium();
	const state = get(identity);
	if (state.state !== 'unlocked') {
		sodium.memzero(activeScalar);
		return { ok: false, kind: 'locked' };
	}
	if (state.live.origin !== 'posting-only') {
		sodium.memzero(activeScalar);
		return { ok: false, kind: 'not_posting_only' };
	}

	const activePub = secp256k1.getPublicKey(activeScalar, true);
	try {
		const nextEnv = await upgradeToPostingActive(state.envelope, password, activeScalar, activePub);

		// Persist ONLY if this device already holds a keystore. Otherwise the
		// session is memory-only by the user's own choice, and it stays that way.
		if (hasPersistedKeystore()) writeEnvelope(nextEnv);

		// Both halves move together: envelope + the capability the UI reads.
		updateUnlockedIdentity(nextEnv, {
			...state.live,
			origin: 'posting-active',
			activePublicKey: activePub
		});

		// The user now has key material they have never backed up.
		markBackupMaterialPending();
		return { ok: true };
	} catch (e) {
		const msg = e instanceof Error ? e.message : '';
		if (/refusing to upgrade/.test(msg)) return { ok: false, kind: 'not_posting_only' };
		// decryptIdentity throws on a wrong password.
		return { ok: false, kind: /password|decrypt|bad/i.test(msg) ? 'bad_password' : 'failed' };
	} finally {
		try {
			sodium.memzero(activeScalar);
		} catch {
			/* already zeroed */
		}
	}
}
