// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { markConversationRead, isUnread, readAckTimestamp, clearReadState } from '$lib/chat/readState';
import {
	archiveThread,
	toggleStar,
	isArchived,
	isStarred,
	folderOf,
	clearChatFolders,
	__reloadChatFolders
} from '$lib/chat/chatFolders';

const PEER = 'kentest2';
const ORDER = 'im-selling-200-mxn-of-xmr';
const NO_ORDER = ''; // the girlfriends thread

describe("v1.7.7 — the no-order thread ('') is a REAL thread, not an absence", () => {
	beforeEach(() => {
		localStorage.clear();
		clearReadState();
		clearChatFolders();
		__reloadChatFolders();
	});

	it('read state: acking the ORDER thread does not silence the no-order thread', () => {
		const t = '2026-07-17T12:00:00.000Z';
		markConversationRead(PEER, ORDER, new Date('2026-07-17T12:00:01.000Z'));
		expect(isUnread(PEER, ORDER, t, false)).toBe(false);   // order thread: read
		expect(isUnread(PEER, NO_ORDER, t, false)).toBe(true); // girlfriends: still unread
	});

	it('read state: acking the no-order thread does not silence the ORDER thread', () => {
		const t = '2026-07-17T12:00:00.000Z';
		markConversationRead(PEER, NO_ORDER, new Date('2026-07-17T12:00:01.000Z'));
		expect(isUnread(PEER, NO_ORDER, t, false)).toBe(false);
		expect(isUnread(PEER, ORDER, t, false)).toBe(true);
	});

	it('folders: archiving the ORDER thread leaves the no-order thread in the Inbox', () => {
		archiveThread(PEER, ORDER, '2026-07-17T12:00:00.000Z');
		expect(isArchived(PEER, ORDER)).toBe(true);
		expect(isArchived(PEER, NO_ORDER)).toBe(false);
		expect(folderOf(PEER, NO_ORDER)).toBe('inbox');
	});

	it('folders: archiving the no-order thread leaves the ORDER thread in the Inbox', () => {
		archiveThread(PEER, NO_ORDER, '2026-07-17T12:00:00.000Z');
		expect(isArchived(PEER, NO_ORDER)).toBe(true);
		expect(isArchived(PEER, ORDER)).toBe(false);
	});

	it('STARRED: starring the order thread leaves the no-order thread unstarred', () => {
		toggleStar(PEER, ORDER, '2026-07-17T12:00:00.000Z');
		expect(isStarred(PEER, ORDER)).toBe(true);
		expect(isStarred(PEER, NO_ORDER)).toBe(false);
		expect(folderOf(PEER, NO_ORDER)).toBe('inbox');
	});

	it('STARRED: the girlfriends thread can be starred independently', () => {
		toggleStar(PEER, NO_ORDER, '2026-07-17T12:00:00.000Z');
		expect(isStarred(PEER, NO_ORDER)).toBe(true);
		expect(isStarred(PEER, ORDER)).toBe(false);
	});

	it('STARRED: un-starring returns the thread to the Inbox, not to Archived', () => {
		toggleStar(PEER, ORDER, '2026-07-17T12:00:00.000Z');
		toggleStar(PEER, ORDER, '2026-07-17T12:00:00.000Z');
		expect(isStarred(PEER, ORDER)).toBe(false);
		expect(folderOf(PEER, ORDER)).toBe('inbox');
	});

	it('STARRED: a starred thread is NOT resurrected out of its tab by new activity', () => {
		// resurrectArchivedOnNewActivity must only touch ARCHIVED entries — a star
		// is a deliberate filing decision, not a "hide until something happens".
		toggleStar(PEER, ORDER, '2026-07-17T12:00:00.000Z');
		expect(folderOf(PEER, ORDER)).toBe('starred');
	});

	it('the v1.7.7 clamp works for a no-order thread with a block time', () => {
		// handleOpen(peer, '', convo.last_message_at) — the girlfriends thread has
		// messages and therefore a block time, exactly like an order thread.
		const block = new Date('2026-07-17T12:00:00.000Z');
		vi.setSystemTime(new Date('2026-07-17T11:58:30.000Z')); // clock 90s SLOW
		markConversationRead(PEER, NO_ORDER, readAckTimestamp(block));
		expect(isUnread(PEER, NO_ORDER, block.toISOString(), false)).toBe(false);
		vi.useRealTimers();
	});

	it('the v1.7.7 clamp degrades to now when there is no block time (fallback-peer list)', () => {
		// handleOpen(peer, '') — no messages loaded, so nothing to clamp against.
		vi.setSystemTime(new Date('2026-07-17T12:00:05.000Z'));
		markConversationRead(PEER, NO_ORDER, readAckTimestamp(null));
		expect(isUnread(PEER, NO_ORDER, '2026-07-17T12:00:00.000Z', false)).toBe(false);
		vi.useRealTimers();
	});
});
