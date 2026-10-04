/**
 * Morphit — "Keep my Active key on this device".
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
 *  3. DISK ONLY IF DISK. The copy on disk is replaced only when it IS this
 *     session's keystore (Remember-me for this account). Otherwise — nothing
 *     remembered, or another account remembered on this device — the
 *     in-memory session is upgraded and the disk left exactly as it was.
 */

import { get } from 'svelte/store';
import * as secp256k1 from '@noble/secp256k1';
import sodium from 'libsodium-wrappers-sumo';

import { identity, updateUnlockedIdentity } from '$stores/identity';
import { KeystoreError, upgradeToPostingActive } from '$crypto/keystore';
import { isPersistedEnvelope, writeEnvelope } from '$crypto/persistentKeystore';
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

		// Persist ONLY if the keystore on disk is this session's. Otherwise the
		// session is memory-only by the user's own choice (or the disk holds
		// another account), and the disk stays as it was.
		if (isPersistedEnvelope(state.envelope)) writeEnvelope(nextEnv);

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
		if (e instanceof KeystoreError && e.kind === 'bad_password')
			return { ok: false, kind: 'bad_password' };
		return { ok: false, kind: 'failed' };
	} finally {
		try {
			sodium.memzero(activeScalar);
		} catch {
			/* already zeroed */
		}
	}
}
