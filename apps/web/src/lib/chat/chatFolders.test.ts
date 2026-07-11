// @vitest-environment jsdom
/**
 * Tests for the per-discussion chat folder store (cp450 — t.txt email inbox).
 *
 * Covers: default = inbox (absence from the map), the star / archive / restore
 * transitions, per-(peer, order) keying, storage roundtrip, corrupt-storage
 * fallback, store reactivity, validation, and full-clear semantics.
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
	__reloadChatFolders
} from './chatFolders';

const KEY = 'morphit.chat.folders';
const A = 'alice';
const B = 'bob';
const O1 = 'buying-btc-permlink';
const O2 = 'selling-xmr-permlink';

describe('chatFolders', () => {
	beforeEach(() => {
		try {
			localStorage.removeItem(KEY);
		} catch {
			/* best-effort */
		}
		__reloadChatFolders();
	});
	afterEach(() => {
		try {
			localStorage.removeItem(KEY);
		} catch {
			/* best-effort */
		}
	});

	it('defaults every discussion to inbox (absence from the map)', () => {
		expect(folderOf(A, O1)).toBe('inbox');
		expect(folderOf(A, '')).toBe('inbox');
		expect(isStarred(A, O1)).toBe(false);
		expect(isArchived(A, O1)).toBe(false);
		// A default discussion writes nothing.
		setFolder(A, O1, 'inbox');
		expect(localStorage.getItem(KEY)).toBeNull();
	});

	it('stars and un-stars (inbox <-> starred)', () => {
		toggleStar(A, O1);
		expect(folderOf(A, O1)).toBe('starred');
		expect(isStarred(A, O1)).toBe(true);
		toggleStar(A, O1);
		expect(folderOf(A, O1)).toBe('inbox');
		expect(isStarred(A, O1)).toBe(false);
	});

	it('archives and restores (inbox <-> archived)', () => {
		archiveThread(A, O1);
		expect(folderOf(A, O1)).toBe('archived');
		expect(isArchived(A, O1)).toBe(true);
		restoreThread(A, O1);
		expect(folderOf(A, O1)).toBe('inbox');
		expect(isArchived(A, O1)).toBe(false);
	});

	it('starring an archived discussion moves it to starred; un-starring goes to inbox (t.txt 11)', () => {
		archiveThread(A, O1);
		expect(folderOf(A, O1)).toBe('archived');
		toggleStar(A, O1);
		expect(folderOf(A, O1)).toBe('starred'); // NOT still archived
		toggleStar(A, O1);
		expect(folderOf(A, O1)).toBe('inbox'); // un-star -> inbox, never back to archived
	});

	it('archiving a starred discussion moves it to archived', () => {
		toggleStar(A, O1);
		expect(folderOf(A, O1)).toBe('starred');
		archiveThread(A, O1);
		expect(folderOf(A, O1)).toBe('archived');
		expect(isStarred(A, O1)).toBe(false);
	});

	it('keys per (peer, order) — different orders are independent discussions', () => {
		toggleStar(A, O1);
		archiveThread(A, O2);
		expect(folderOf(A, O1)).toBe('starred');
		expect(folderOf(A, O2)).toBe('archived');
		expect(folderOf(A, '')).toBe('inbox');
		// Same order, different peer is a different discussion too.
		expect(folderOf(B, O1)).toBe('inbox');
	});

	it('persists across a reload from storage', () => {
		toggleStar(A, O1);
		archiveThread(B, O2);
		__reloadChatFolders();
		expect(folderOf(A, O1)).toBe('starred');
		expect(folderOf(B, O2)).toBe('archived');
	});

	it('falls back to inbox on corrupt storage', () => {
		localStorage.setItem(KEY, '{not valid json');
		__reloadChatFolders();
		expect(folderOf(A, O1)).toBe('inbox');
		expect(get(chatFolders)).toEqual({});
	});

	it('ignores entries with an invalid account name or an over-long permlink', () => {
		setFolder('A', O1, 'starred'); // uppercase = invalid account name
		expect(get(chatFolders)).toEqual({});
		setFolder(A, 'x'.repeat(300), 'starred'); // permlink too long
		expect(get(chatFolders)).toEqual({});
	});

	it('notifies subscribers on every folder change', () => {
		let ticks = 0;
		const unsub = chatFolders.subscribe(() => {
			ticks++;
		});
		const base = ticks; // one immediate fire on subscribe
		toggleStar(A, O1);
		archiveThread(B, O2);
		restoreThread(B, O2);
		unsub();
		expect(ticks).toBe(base + 3);
	});

	it('clearChatFolders wipes everything', () => {
		toggleStar(A, O1);
		archiveThread(B, O2);
		clearChatFolders();
		expect(folderOf(A, O1)).toBe('inbox');
		expect(folderOf(B, O2)).toBe('inbox');
		expect(localStorage.getItem(KEY)).toBeNull();
		expect(get(chatFolders)).toEqual({});
	});
});
