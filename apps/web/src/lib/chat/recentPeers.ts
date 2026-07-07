/**
 * Recent-peers tracker for the /chat inbox stub.
 *
 * Session 1 of chat ships without a proper "list my conversations"
 * backend endpoint. In the meantime, we remember which peers the
 * local user has opened a conversation with, so the inbox has
 * SOMETHING to show. When the real endpoint lands, this module
 * becomes dead code.
 *
 * Storage:
 *   safeLocal key 'morphit.chat.recent_peers' — a JSON array of
 *   Blurt account names, most-recently-opened first. Capped at
 *   MAX_RECENT_PEERS.
 *
 * Invariants:
 *   - Only valid account names stored.
 *   - No duplicates (an existing entry is moved to the front on
 *     re-open).
 *   - List order is newest-open first.
 *   - Read errors (corrupt JSON, non-array, etc.) fall back to
 *     empty — the inbox renders an empty state rather than
 *     breaking.
 */

import { safeLocal } from '$utils/safeStorage';

const KEY = 'morphit.chat.recent_peers';
const MAX_RECENT_PEERS = 20;
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

function readRaw(): string[] {
	const raw = safeLocal.get(KEY);
	if (raw === null) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((v): v is string => typeof v === 'string' && ACCOUNT_NAME_RE.test(v));
	} catch {
		return [];
	}
}

function writeRaw(peers: readonly string[]): void {
	try {
		safeLocal.set(KEY, JSON.stringify(peers));
	} catch {
		// safeLocal is best-effort; writes can fail in quota-exceeded
		// or private-mode contexts. Silently ignore — the inbox will
		// just show an empty or stale list.
	}
}

/**
 * Record that the user opened a conversation with `peer`. Moves it
 * to the front of the list, deduplicates, caps at MAX_RECENT_PEERS.
 * Caller should have already validated that peer is a real account
 * name (SvelteKit's `account` matcher does this at route
 * resolution).
 */
export function recordRecentPeer(peer: string): void {
	if (!ACCOUNT_NAME_RE.test(peer)) return;
	const current = readRaw();
	const filtered = current.filter((p) => p !== peer);
	filtered.unshift(peer);
	if (filtered.length > MAX_RECENT_PEERS) filtered.length = MAX_RECENT_PEERS;
	writeRaw(filtered);

	// Phase F.5 audit fix (F-29) — notify subscribers (the trade-
	// event listener) that the recent-peers list changed.  Without
	// this, the listener doesn't pick up new conversations until
	// the next lock/unlock cycle.  Custom event keeps the modules
	// decoupled — recentPeers doesn't import the listener.
	if (typeof window !== 'undefined') {
		window.dispatchEvent(new CustomEvent('morphit:recent-peers-changed'));
	}
}

/**
 * Read the recent-peers list. Most-recent-first. Empty array if no
 * peers or storage is unavailable.
 */
export function loadRecentPeers(): readonly string[] {
	return readRaw();
}

/**
 * Clear the recent-peers list. Called by the lock-session flow
 * alongside other conversation-related local state.
 */
export function clearRecentPeers(): void {
	safeLocal.remove(KEY);
}
