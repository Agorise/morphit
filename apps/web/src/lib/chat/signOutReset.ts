/**
 * Explicit Sign Out, the chat part: forget the account's conversations held IN
 * MEMORY, not only on disk.
 *
 * The sign-out sweep ($lib/storage/signOutSweep) removes the stored keys, but
 * the read-state and folder stores keep their maps in memory. The next update
 * from a still-mounted chat view (a conversation marked read as it unmounts)
 * wrote the whole old map straight back — peers and threads of the person who
 * just signed out. Resetting the stores first means such a late write can only
 * carry what happened after the sign-out, and the sweep is repeated once the
 * page has moved on ($stores/identity broadcastSignOut).
 */
import { clearReadState } from './readState';
import { clearChatFolders } from './chatFolders';
import { clearAllPins } from './pubPin';
import { clearRecentPeers } from './recentPeers';
import { resetBlocks } from './blocks';

export function resetChatOnSignOut(): void {
	for (const reset of [
		clearReadState,
		clearChatFolders,
		clearAllPins,
		clearRecentPeers,
		resetBlocks
	]) {
		try {
			reset();
		} catch {
			// Isolated: one failure must not keep the others.
		}
	}
}
