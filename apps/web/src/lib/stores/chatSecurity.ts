/**
 * Chat security preference (cp406).
 *
 * Two persisted, per-account settings that govern the chat "self-copy"
 * behavior introduced in cp406:
 *
 *   mode:
 *     'keep'    (DEFAULT) — encrypt-a-copy-to-self. Every message the user
 *               sends also carries a second ciphertext only THEY can open, so
 *               they can reread their own history from chain forever, like a
 *               normal messenger. Weakens sender-side forward secrecy only
 *               (the recipient's is untouched).
 *     'destroy' (opt-in PFS) — no self-copy is written. Own sent messages are
 *               readable only during the live session; once the user leaves
 *               the chat / reloads / the session ends, they can no longer be
 *               decrypted (the ephemeral private key was wiped and nothing was
 *               persisted). This is the "destroyed after you leave" mode.
 *
 *   nudgeSeen:
 *     One-time flag. While false, the chat overflow menu shows a red dot
 *     inviting the user to discover the Chat Security setting. Set true the
 *     first time they open the Chat Security item.
 *
 * PER-ACCOUNT (keyed by Blurt account name), not device-global: one browser
 * can host several logins (Bob's multi-account flow), and a security posture
 * is a property of the account, not the machine.
 *
 * LOCAL, not on-chain: the mode is the SENDER's own choice, read at send time
 * to decide whether to attach a self-copy. It never needs to be published, and
 * publishing it would leak the user's privacy posture. Stored via safeLocal so
 * a storage-unavailable environment degrades to the safe default ('keep') and
 * a never-nagging nudge.
 *
 * FORWARD-LOOKING: switching modes only affects messages sent AFTERWARD.
 * Turning on 'destroy' does not retroactively strip self-copies already on
 * chain; turning on 'keep' does not add self-copies to messages already sent.
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
 * Read the account's chat-security mode. Returns 'keep' (the default) for a
 * missing/unknown value, an empty account, or unavailable storage — i.e. the
 * safe, readable-history default is the fallback in every ambiguous case.
 */
export function readChatSecurityMode(account: string): ChatSecurityMode {
	if (account.length === 0) return 'keep';
	return safeLocal.get(modeKey(account)) === 'destroy' ? 'destroy' : 'keep';
}

/** Persist the account's chat-security mode. No-op for an empty account. */
export function writeChatSecurityMode(account: string, mode: ChatSecurityMode): void {
	if (account.length === 0) return;
	safeLocal.set(modeKey(account), mode === 'destroy' ? 'destroy' : 'keep');
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
 *   destroy   → false (omit it → PFS, unreadable after leaving)
 *   undefined → true  (the safe default is keep)
 *
 * Centralised here so the send path and the retry path decide identically and
 * can never drift; both call this rather than inlining the comparison.
 */
export function shouldAttachSelfCopy(mode: ChatSecurityMode | undefined): boolean {
	return (mode ?? 'keep') !== 'destroy';
}
