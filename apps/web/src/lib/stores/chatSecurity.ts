/**
 * Chat security preference.
 *
 * v1.23.2 — what Chat Security means now (owner's decision):
 *
 *   "This chat is encrypted on-chain so it's never lost, but if you share
 *    this computer with someone, they might be able to see this unencrypted
 *    copy. Do you want this chat deleted from this computer after you leave
 *    the chat?"  Yes, delete it / No, keep it.
 *
 *   Morphit never stores chat text on the computer: it is decrypted into the
 *   open tab's memory only. What a person sharing the computer could see is
 *   the chat on screen, or reopen it while Morphit is unlocked. So "delete it
 *   from this computer after you leave" = LOCK ON LEAVING: when you leave
 *   that chat (another page, another chat, closing or reloading the tab),
 *   Morphit locks on this computer, in every tab, and keeps no reload stash —
 *   the words are gone from memory and nobody can reopen any chat without
 *   your password (a session with no password to unlock is signed out, as a
 *   lock always does). PER CHAT (account, partner, order), LOCAL only: it is
 *   this computer's concern and publishing it would leak a privacy posture.
 *
 *   Your own messages ALWAYS carry their self-copy now, so you can reread
 *   the whole chat later, on any device ("never lost"). The old opt-out
 *   ('destroy': no self-copy, own messages unreadable to you after leaving)
 *   is gone; an account that had chosen it gets lock-on-leaving in every chat
 *   instead (its closest privacy intent), until it says No in a chat.
 *   `ChatSecurityMode` and `shouldAttachSelfCopy` stay as the send path's
 *   switch (chatService), but the store only ever answers 'keep'.
 *
 *   nudgeSeen:
 *     One-time flag. While false, the chat overflow menu shows a red dot
 *     inviting the user to discover the Chat Security setting. Set true the
 *     first time they open the Chat Security item.
 *
 * PER-ACCOUNT keys (Blurt account name): one browser can host several logins.
 * Stored via safeLocal, so unavailable storage degrades to the safe defaults
 * (keep the copy; no lock-on-leaving; a never-nagging nudge).
 */

import { safeLocal } from '../utils/safeStorage';

export type ChatSecurityMode = 'keep' | 'destroy';

const MODE_PREFIX = 'morphit.chatSecurity.mode.';
const NUDGE_PREFIX = 'morphit.chatSecurity.nudgeSeen.';

function modeKey(account: string): string {
	return MODE_PREFIX + account;
}
function nudgeKey(account: string): string {
	return NUDGE_PREFIX + account;
}

/**
 * The account's self-copy mode: always 'keep' (v1.23.2). A legacy stored
 * 'destroy' no longer turns the copy off — see readLockOnLeave instead.
 */
export function readChatSecurityMode(account: string): ChatSecurityMode {
	void account;
	return 'keep';
}

const LOCK_ON_LEAVE_PREFIX = 'morphit.chatSecurity.lockOnLeave.';

function lockOnLeaveKey(account: string, peer: string, order: string | null): string {
	return `${LOCK_ON_LEAVE_PREFIX}${account}\u0000${peer}\u0000${order ?? ''}`;
}

/**
 * Lock Morphit on this computer when this account leaves this chat (v1.23.2)?
 * Per chat: account, partner and order. Unset → the account's legacy choice
 * (the old 'destroy' mode → yes), else no.
 */
export function readLockOnLeave(account: string, peer: string, order: string | null): boolean {
	if (account.length === 0 || peer.length === 0) return false;
	const v = safeLocal.get(lockOnLeaveKey(account, peer, order));
	if (v === '1') return true;
	if (v === '0') return false;
	return safeLocal.get(modeKey(account)) === 'destroy';
}

/** Persist this chat's lock-on-leaving choice. No-op for an empty account. */
export function writeLockOnLeave(
	account: string,
	peer: string,
	order: string | null,
	on: boolean
): void {
	if (account.length === 0 || peer.length === 0) return;
	safeLocal.set(lockOnLeaveKey(account, peer, order), on ? '1' : '0');
}

/**
 * Has this account already seen (dismissed) the one-time Chat Security nudge?
 * Returns true (do NOT nag) for an empty account or unavailable storage.
 */
export function readChatSecurityNudgeSeen(account: string): boolean {
	if (account.length === 0) return true;
	return safeLocal.get(nudgeKey(account)) === '1';
}

/** Mark the one-time nudge as seen. No-op for an empty account. */
export function markChatSecurityNudgeSeen(account: string): void {
	if (account.length === 0) return;
	safeLocal.set(nudgeKey(account), '1');
}

/**
 * Whether a message sent under the given mode should carry a sender self-copy.
 *
 *   keep      → true  (attach the self-copy → readable own history)
 *   destroy   → false (omit it → the sender cannot reread it after leaving)
 *   undefined → true  (the safe default is keep)
 *
 * Centralised here so the send path and the retry path decide identically and
 * can never drift; both call this rather than inlining the comparison.
 */
export function shouldAttachSelfCopy(mode: ChatSecurityMode | undefined): boolean {
	return (mode ?? 'keep') !== 'destroy';
}
