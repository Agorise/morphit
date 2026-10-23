// @vitest-environment jsdom
/**
 * v1.21.14 full chat audit, W-M3 / W-L4 — a read acknowledgement never
 * depends on the device clock, in either direction.
 *
 *   W-M3  A device clock running FAST became the read cursor (the later of the
 *         newest message seen and "now"), so every message arriving within
 *         the lead after the user left a thread was already "read": no badge,
 *         no border.
 *   W-L4  The inbox "Mark all read" (and Archive) acked with the bare device
 *         clock: on a clock running SLOW the threads stayed unread.
 *
 * The cursor is now the newest message's chain time. A fast-push badge — dated
 * by the device clock when the push arrived, since there is no chain time yet —
 * is judged against when this device last acknowledged the thread (device time
 * against device time).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const ME = 'tester3';
const PEER = 'tester2';
const ORDER = 'im-selling-200-mxn-of-xmr';
/** The chain's "now" in these tests. */
const CHAIN_NOW = Date.parse('2026-10-21T12:00:00.000Z');
let lastMessageAt = new Date(CHAIN_NOW - 60_000).toISOString();

vi.mock('$lib/chat/globalChatActivityStream', () => ({
	startGlobalChatActivity: () => () => {},
	subscribeChatActivity: () => () => {},
	subscribeFastPush: () => () => {}
}));
vi.mock('$lib/indexer/client', () => ({
	getConversations: vi.fn(async () => ({
		ok: true as const,
		data: {
			items: [
				{
					peer: PEER,
					order: { permlink: ORDER },
					last_message_at: lastMessageAt,
					last_message_is_mine: false
				}
			]
		}
	})),
	getChatReadState: vi.fn(async () => ({ ok: true as const, data: { items: [] } }))
}));
vi.mock('$blurt/ops/profile', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$blurt/ops/profile')>();
	return { ...actual, getUserBlurtAccount: () => ME };
});
vi.mock('$stores/identity', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$stores/identity')>();
	const { readable } = await import('svelte/store');
	return { ...actual, hasAnySession: readable(true) };
});
vi.mock('$lib/chat/blocks', async () => {
	const { writable } = await import('svelte/store');
	return { blockedAccounts: writable(new Set<string>()), loadBlocks: () => {} };
});
vi.mock('$lib/utils/hiddenAccounts', async () => {
	const { writable } = await import('svelte/store');
	return { hiddenAccounts: writable(new Set<string>()) };
});

import { setPersonStorageTier } from '$lib/storage/personStorage';
import {
	markConversationRead,
	readAckTimestamp,
	isUnread,
	clearReadState
} from '$lib/chat/readState';
import {
	startChatUnreadChannel,
	markAllChatRead,
	ackThreadRead,
	noteFastChatPush,
	threadIsUnread,
	listFastPending
} from './chatUnread';
import { unreadCount } from './index';
import { clearChatFolders, __reloadChatFolders } from '$lib/chat/chatFolders';

let stop: (() => void) | null = null;
beforeEach(() => {
	localStorage.clear();
	setPersonStorageTier('local');
	clearReadState();
	clearChatFolders();
	__reloadChatFolders();
	vi.useFakeTimers();
	lastMessageAt = new Date(CHAIN_NOW - 60_000).toISOString();
});
afterEach(() => {
	stop?.();
	stop = null;
	vi.useRealTimers();
});

describe('W-M3: leaving a thread on a FAST clock', () => {
	it('a message that arrives after the user left is still unread', () => {
		vi.setSystemTime(CHAIN_NOW + 10 * 60_000); // the phone runs 10 min fast
		const newestSeen = new Date(CHAIN_NOW - 5_000);
		markConversationRead(PEER, ORDER, readAckTimestamp(newestSeen)!);
		const threeMinLater = new Date(CHAIN_NOW + 3 * 60_000).toISOString();
		expect(isUnread(PEER, ORDER, threeMinLater, false)).toBe(true);
		// …and what was seen stays read.
		expect(isUnread(PEER, ORDER, newestSeen.toISOString(), false)).toBe(false);
	});
});

describe('W-L4: "Mark all read" on a SLOW clock', () => {
	it('the avatar menu’s Mark all read clears a thread whose last message is newer than the device clock', async () => {
		vi.setSystemTime(CHAIN_NOW - 6 * 60_000); // 6 min slow; message 1 min old on chain
		stop = startChatUnreadChannel();
		await vi.advanceTimersByTimeAsync(0);
		expect(get(unreadCount).chat).toBe(1);
		markAllChatRead();
		expect(isUnread(PEER, ORDER, lastMessageAt, false)).toBe(false);
		expect(get(unreadCount).chat).toBe(0);
	});

	it('…and on a FAST clock it does not silence what comes next', async () => {
		vi.setSystemTime(CHAIN_NOW + 10 * 60_000);
		stop = startChatUnreadChannel();
		await vi.advanceTimersByTimeAsync(0);
		markAllChatRead();
		const later = new Date(CHAIN_NOW + 2 * 60_000).toISOString();
		expect(isUnread(PEER, ORDER, later, false)).toBe(true);
	});

	it('the inbox’s Mark all read / Archive ack (ackThreadRead) uses the row’s time', () => {
		vi.setSystemTime(CHAIN_NOW - 6 * 60_000);
		ackThreadRead(PEER, ORDER, lastMessageAt);
		expect(isUnread(PEER, ORDER, lastMessageAt, false)).toBe(false);
		vi.setSystemTime(CHAIN_NOW + 10 * 60_000);
		ackThreadRead(PEER, ORDER, lastMessageAt);
		expect(isUnread(PEER, ORDER, new Date(CHAIN_NOW + 60_000).toISOString(), false)).toBe(true);
	});
});

describe('W-M3: a fast-push badge is judged on the device’s own clock', () => {
	it('a push that arrived before this device acked the thread is not unread; one after it is', () => {
		vi.setSystemTime(CHAIN_NOW + 10 * 60_000);
		noteFastChatPush(PEER, ORDER);
		// Viewing the thread acks the newest message seen (chain time, BEHIND
		// this device's clock).
		markConversationRead(PEER, ORDER, new Date(CHAIN_NOW));
		expect(threadIsUnread(PEER, ORDER, lastMessageAt, false)).toBe(false);
		vi.setSystemTime(CHAIN_NOW + 11 * 60_000);
		noteFastChatPush(PEER, ORDER);
		expect(threadIsUnread(PEER, ORDER, lastMessageAt, false)).toBe(true);
	});

	it('a thread only a push has announced: Mark all read clears it without moving any cursor', async () => {
		vi.setSystemTime(CHAIN_NOW);
		stop = startChatUnreadChannel();
		await vi.advanceTimersByTimeAsync(0);
		markAllChatRead();
		noteFastChatPush('newpeer', '');
		const pending = () => listFastPending().filter((p) => p.peer === 'newpeer');
		expect(pending()).toHaveLength(1);
		vi.setSystemTime(CHAIN_NOW + 1_000);
		markAllChatRead();
		// The push is seen (its placeholder card and its badge go)…
		expect(pending()).toEqual([]);
		// …and no read cursor was invented for the thread.
		expect(isUnread('newpeer', '', new Date(CHAIN_NOW - 60_000).toISOString(), false)).toBe(true);
	});
});
