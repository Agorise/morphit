/**
 * morphit_settings_v1 — mirror the user's device-local settings on chain,
 * ENCRYPTED with a posting-key-derived key (see settingsCrypto) so they follow
 * the user to a fresh device without leaking their preferences (or the accounts
 * they've hidden) to the operator or any observer.
 *
 * Wire body: `{ v: 1, enc: <base64 ciphertext> }`. The plaintext settings blob
 * never touches the chain; an outside observer sees only `enc`. Same shape,
 * cipher, and cross-device-sync pattern as morphit_chat_folders_v1.
 */
import type { LiveIdentity } from '$crypto/keygen';
import { OP_IDS } from '$net/config';
import { getUserBlurtAccount, BroadcastError } from './profile';
import { encryptSettingsState } from '$lib/settings/settingsCrypto';

/** The plaintext user-settings state mirrored on chain (encrypted). Every
 *  section is OPTIONAL so older/newer clients degrade gracefully — an absent
 *  section means "no on-chain value; keep the device default." Populated as
 *  each settings surface is wired into the mirror. */
export interface UserSettingsState {
	/** Web-push + in-app notification prefs (per-category on/off + quiet hours). */
	readonly notifications?: unknown;
	/** Privacy toggles (e.g. same-origin RPC routing, profile visibility). */
	readonly privacy?: unknown;
	/** Syndication targets (Blurt.media / Nostr URLs, blog-default). */
	readonly syndication?: unknown;
	/** Accounts the user has hidden from their OWN views (account names). */
	readonly hidden?: readonly string[];
	/** Misc UI preferences (the userPreferences store). */
	readonly preferences?: unknown;
}

/**
 * Encrypt + broadcast the user's settings state. Resolves with the block/trx
 * once the relay accepts it. The posting private key is used (posting-only
 * users supported); the operator only ever stores the opaque `enc` blob.
 */
export async function broadcastSettings(
	live: LiveIdentity,
	state: UserSettingsState
): Promise<{ block_num: number; trx_id: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered yet.');
	}
	const enc = await encryptSettingsState(live.posting.privateKey, account, state);
	// Dynamic import of '../sign' keeps dblurt out of the eager-load graph for
	// read-only routes — same pattern as broadcastChatFolders.
	const { broadcastCustomJson } = await import('../sign');
	return broadcastCustomJson(live, OP_IDS.settings, { v: 1, enc }, account);
}
