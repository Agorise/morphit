/**
 * Chat folder-state op broadcaster (t.txt v1.4.9 #5).
 *
 * Encrypts the user's chat folder organization (which threads are kept in
 * Inbox / Starred) with a posting-key-derived key (see folderCrypto) and
 * broadcasts it as a `morphit_chat_folders_v1` custom_json, posting-signed via
 * the relay — the identical path chat messages and the profile op take. Only
 * the posting key is ever used, so posting-only users are fully supported.
 *
 * Wire body: `{ v: 1, enc: <base64 ciphertext> }`. The plaintext (the thread
 * lists) never touches the chain; an outside observer sees only `enc`.
 */
import type { LiveIdentity } from '$crypto/keygen';
import { OP_IDS } from '$net/config';
import { getUserBlurtAccount, BroadcastError } from './profile';
import { encryptFolderState } from '$lib/chat/folderCrypto';

/** The plaintext folder state. Both lists hold thread keys
 *  (`peer\u0000order_permlink`, order empty for a no-order thread). Only the
 *  explicitly-filed folders are recorded; a thread in neither list is in the
 *  Inbox (the default). Disjoint: a thread is Starred OR Archived OR (by
 *  absence) Inbox. */
export interface ChatFolderState {
	readonly starred: readonly string[];
	readonly archived: readonly string[];
}

/**
 * Encrypt + broadcast the folder state. Resolves with the block/trx once the
 * relay accepts it.
 */
export async function broadcastChatFolders(
	live: LiveIdentity,
	state: ChatFolderState
): Promise<{ block_num: number; trx_id: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered yet.');
	}
	const enc = await encryptFolderState(live.posting.privateKey, account, state);
	// Dynamic import of '../sign' keeps dblurt out of the eager-load graph for
	// read-only routes — same pattern as broadcastProfile.
	const { broadcastCustomJson } = await import('../sign');
	return broadcastCustomJson(live, OP_IDS.chatFolders, { v: 1, enc }, account);
}
