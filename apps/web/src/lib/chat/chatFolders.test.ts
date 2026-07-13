// @vitest-environment jsdom
/**
 * Tests for the per-discussion chat folder store (t.txt — email inbox, now
 * on-chain synced). Covers the model: default = Inbox (absence from the map),
 * the star / archive / restore transitions, per-(peer, order) keying, mirror
 * roundtrip, corrupt-storage fallback, store reactivity, validation, and
 * full-clear.
 *
 * The on-chain broadcast is a no-op here: the identity store is locked in tests,
 * so scheduleBroadcast → broadcastNow returns early. We assert only the local
 * behaviour, which is the source of truth for rendering.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';

import {
	chatFolders,
	folderOf,
	isStarred,
	isArchived,
	setFolder,
	toggleStar,
	archiveThread,
	restoreThread,
	clearChatFolders,
	__reloadChatFolders,
	__chatFolderShape
} from './chatFolders';

const KEY = 'morphit.chat.folders';
const A = 'alice';
const B = 'bob';
const O1 = 'buying-btc-permlink';
const O2 = 'selling-xmr-permlink';

function wipe(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {
		/* best-effort */
	}
}

describe('chatFolders', () => {
	beforeEach(() => {
		wipe();
		clearChatFolders();
		__reloadChatFolders();
	});
	afterEach(() => {
		wipe();
		clearChatFolders();
	});

	it('defaults every discussion to INBOX — including a fresh account / brand-new thread', () => {
		expect(folderOf(A, O1)).toBe('inbox');
		expect(folderOf(A, '')).toBe('inbox');
		expect(folderOf('never-seen-peer', 'brand-new-order')).toBe('inbox');
		expect(isStarred(A, O1)).toBe(false);
		expect(isArchived(A, O1)).toBe(false);
	});

	it('setFolder to starred / archived stores; to inbox removes', () => {
		setFolder(A, O1, 'starred');
		expect(folderOf(A, O1)).toBe('starred');
		setFolder(A, O1, 'archived');
		expect(folderOf(A, O1)).toBe('archived');
		setFolder(A, O1, 'inbox');
		expect(folderOf(A, O1)).toBe('inbox');
	});

	it('toggleStar: inbox → starred → inbox (un-star returns to inbox, not archived)', () => {
		expect(folderOf(A, O1)).toBe('inbox');
		toggleStar(A, O1);
		expect(folderOf(A, O1)).toBe('starred');
		toggleStar(A, O1);
		expect(folderOf(A, O1)).toBe('inbox');
	});

	it('archive moves inbox|starred → archived; restore → inbox', () => {
		archiveThread(A, O1);
		expect(folderOf(A, O1)).toBe('archived');
		restoreThread(A, O1);
		expect(folderOf(A, O1)).toBe('inbox');
		setFolder(A, O1, 'starred');
		archiveThread(A, O1);
		expect(folderOf(A, O1)).toBe('archived');
	});

	it('keys per (peer, order): the same peer, different orders, are independent', () => {
		setFolder(A, O1, 'starred');
		setFolder(A, O2, 'archived');
		expect(folderOf(A, O1)).toBe('starred');
		expect(folderOf(A, O2)).toBe('archived');
		expect(folderOf(A, '')).toBe('inbox'); // the no-order thread — untouched
		expect(folderOf(B, O1)).toBe('inbox'); // a different peer — untouched
	});

	it('the no-order thread (order="") is a first-class, independent key', () => {
		setFolder(A, '', 'archived');
		expect(folderOf(A, '')).toBe('archived');
		expect(folderOf(A, O1)).toBe('inbox');
	});

	it('persists to the mirror and survives a reload', () => {
		setFolder(A, O1, 'starred');
		setFolder(A, O2, 'archived');
		__reloadChatFolders();
		expect(folderOf(A, O1)).toBe('starred');
		expect(folderOf(A, O2)).toBe('archived');
	});

	it('corrupt mirror falls back to empty (everything inbox)', () => {
		localStorage.setItem(KEY, 'not json {{');
		__reloadChatFolders();
		expect(folderOf(A, O1)).toBe('inbox');
		expect(get(chatFolders)).toEqual({});
	});

	it('the store is reactive — subscribers see folder changes', () => {
		const seen: number[] = [];
		const unsub = chatFolders.subscribe((m) => seen.push(Object.keys(m).length));
		setFolder(A, O1, 'starred');
		setFolder(A, O2, 'archived');
		setFolder(A, O1, 'inbox');
		unsub();
		expect(seen[seen.length - 1]).toBe(1);
		expect(seen).toContain(2);
	});

	it('ignores invalid peers (no-op, stays inbox)', () => {
		setFolder('BadName!', O1, 'starred');
		expect(folderOf('BadName!', O1)).toBe('inbox');
		expect(get(chatFolders)).toEqual({});
	});

	it('clearChatFolders wipes everything', () => {
		setFolder(A, O1, 'starred');
		setFolder(B, O2, 'archived');
		clearChatFolders();
		expect(get(chatFolders)).toEqual({});
		expect(folderOf(A, O1)).toBe('inbox');
	});

	// The on-chain ↔ local bridge. mapToState (what gets broadcast) and
	// stateToMap (what gets adopted from chain) must be exact inverses on the
	// folder assignment, or a sync silently corrupts a user's organization.
	it('shape bridge round-trips: map → on-chain state → map preserves folders', () => {
		const { mapToState, stateToMap } = __chatFolderShape;
		const map: Record<string, { folder: 'starred' | 'archived'; at: string }> = {
			[`${A}\u0000${O1}`]: { folder: 'starred', at: '2026-07-01T00:00:00.000Z' },
			[`${A}\u0000`]: { folder: 'starred', at: '2026-07-01T00:00:00.000Z' },
			[`${B}\u0000${O2}`]: { folder: 'archived', at: '2026-07-01T00:00:00.000Z' }
		};
		const state = mapToState(map);
		expect(new Set(state.starred)).toEqual(new Set([`${A}\u0000${O1}`, `${A}\u0000`]));
		expect(state.archived).toEqual([`${B}\u0000${O2}`]);
		// Back to a map: same keys, same folder assignment (the `at` is refreshed).
		const back = stateToMap(state);
		expect(Object.keys(back).sort()).toEqual(Object.keys(map).sort());
		for (const k of Object.keys(map)) {
			expect(back[k]!.folder).toBe(map[k]!.folder);
		}
	});

	it('shape bridge drops invalid keys defensively (bad peer names never adopted)', () => {
		const { stateToMap } = __chatFolderShape;
		const map = stateToMap({
			starred: ['GOODpeer-invalid!\u0000', `${A}\u0000${O1}`],
			archived: ['x'.repeat(300) /* no NUL → invalid key */]
		});
		// Only the one valid key survives.
		expect(Object.keys(map)).toEqual([`${A}\u0000${O1}`]);
	});
});
