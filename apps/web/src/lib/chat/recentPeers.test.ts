// @vitest-environment jsdom
/**
 * Tests for the chat recent-peers tracker.
 *
 * recentPeers wraps safeLocal (the localStorage facade). We test
 * via direct localStorage manipulation — safeLocal reads/writes
 * real localStorage when available, and vitest provides jsdom
 * with a working localStorage by default.
 *
 * Tests cover:
 *   - Empty state
 *   - Record → load round-trip
 *   - Dedup on re-add (moves to front)
 *   - Cap at MAX_RECENT_PEERS
 *   - Validation of invalid account names
 *   - Clear wipes the slot
 *   - Graceful fallback to [] for corrupt JSON
 *   - Graceful fallback for non-array JSON
 *   - Graceful filter of invalid names mid-list
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordRecentPeer, loadRecentPeers, clearRecentPeers } from './recentPeers';

const KEY = 'morphit.chat.recent_peers';

describe('recentPeers', () => {
	beforeEach(() => {
		// Clear the slot before each test so cross-test state
		// doesn't leak.
		try {
			localStorage.removeItem(KEY);
		} catch {
			// localStorage may be disabled in SSR / restricted
			// contexts; not a test failure.
		}
	});

	afterEach(() => {
		try {
			localStorage.removeItem(KEY);
		} catch {
			// noop
		}
	});

	// ─── Empty state ──────────────────────────────────────────

	it('returns empty array when no peers recorded', () => {
		expect(loadRecentPeers()).toEqual([]);
	});

	it('returns empty array when storage contains non-array value', () => {
		localStorage.setItem(KEY, '"not an array"');
		expect(loadRecentPeers()).toEqual([]);
	});

	it('returns empty array when storage contains corrupt JSON', () => {
		localStorage.setItem(KEY, '{this is not json}');
		expect(loadRecentPeers()).toEqual([]);
	});

	it('returns empty array when storage contains null', () => {
		localStorage.setItem(KEY, 'null');
		expect(loadRecentPeers()).toEqual([]);
	});

	// ─── Record + load round-trip ─────────────────────────────

	it('records a peer and loads it back', () => {
		recordRecentPeer('alice');
		expect(loadRecentPeers()).toEqual(['alice']);
	});

	it('records multiple peers in most-recent-first order', () => {
		recordRecentPeer('alice');
		recordRecentPeer('bob');
		recordRecentPeer('charlie');
		expect(loadRecentPeers()).toEqual(['charlie', 'bob', 'alice']);
	});

	// ─── Dedup on re-add ──────────────────────────────────────

	it('moves a re-added peer to the front and dedupes', () => {
		recordRecentPeer('alice');
		recordRecentPeer('bob');
		recordRecentPeer('charlie');
		// Re-add alice — should move to front, no duplicate.
		recordRecentPeer('alice');
		expect(loadRecentPeers()).toEqual(['alice', 'charlie', 'bob']);
	});

	it('records the same peer three times without creating duplicates', () => {
		recordRecentPeer('alice');
		recordRecentPeer('alice');
		recordRecentPeer('alice');
		expect(loadRecentPeers()).toEqual(['alice']);
	});

	// ─── Cap ──────────────────────────────────────────────────

	it('caps at 20 peers, dropping the oldest', () => {
		// Add 25 peers.
		for (let i = 0; i < 25; i += 1) {
			recordRecentPeer(`user${i.toString().padStart(2, '0')}`);
		}
		const loaded = loadRecentPeers();
		expect(loaded).toHaveLength(20);
		// The most recent 20 are user05..user24, with user24 at front.
		expect(loaded[0]).toBe('user24');
		expect(loaded[19]).toBe('user05');
	});

	// ─── Name validation ──────────────────────────────────────

	it('rejects peers with invalid account-name format', () => {
		recordRecentPeer('Alice'); // uppercase — invalid
		recordRecentPeer('a'); // too short
		recordRecentPeer('toolong'.repeat(10)); // too long
		recordRecentPeer('has space'); // contains space
		recordRecentPeer('has_underscore'); // underscore — invalid (only `-` and `.` allowed)
		recordRecentPeer('9start'); // starts with digit
		expect(loadRecentPeers()).toEqual([]);
	});

	it('accepts Blurt-namespaced account names containing dots', () => {
		// Per ACCOUNT_NAME_RE in recentPeers.ts, Blurt account
		// names allow lowercase letters, digits, hyphens, AND
		// dots — community accounts like `agorise.witness` are
		// real and must pass validation.
		recordRecentPeer('agorise.witness');
		expect(loadRecentPeers()).toEqual(['agorise.witness']);
	});

	it('accepts valid account names of varying length', () => {
		recordRecentPeer('abc'); // min length (3)
		recordRecentPeer('abc123-xyz');
		recordRecentPeer('aaaaaaaaaaaaaaaa'); // max length (16)
		const loaded = loadRecentPeers();
		expect(loaded).toEqual(['aaaaaaaaaaaaaaaa', 'abc123-xyz', 'abc']);
	});

	it('filters invalid names out of stored list on load', () => {
		// Directly inject a list with some invalid names (could
		// happen if the storage was tampered with, or a bug in
		// an older version wrote bad data).
		localStorage.setItem(KEY, JSON.stringify(['alice', 'Bad-Name', 'bob', 'has space', 'carol']));
		expect(loadRecentPeers()).toEqual(['alice', 'bob', 'carol']);
	});

	// ─── Clear ────────────────────────────────────────────────

	it('clearRecentPeers wipes the storage slot', () => {
		recordRecentPeer('alice');
		recordRecentPeer('bob');
		clearRecentPeers();
		expect(loadRecentPeers()).toEqual([]);
	});

	it('clearRecentPeers is safe to call when no peers recorded', () => {
		clearRecentPeers();
		expect(loadRecentPeers()).toEqual([]);
	});
});
