// @vitest-environment jsdom
/**
 * cp474 (t.txt #3 + #4) — a Web Push for an ARCHIVED thread must light the badge
 * AND pull the thread back into the Inbox, both inside the push's own latency.
 *
 * THE BUG THIS GUARDS AGAINST. Ken, on live morphit.io: kentest2 sent a message
 * into a thread both parties had archived. kentest3 got the system notification
 * in 6 seconds — and then waited about a MINUTE for the badge, and the message
 * never moved to his Inbox at all; he had to open the Archived folder to find
 * it, and had to hard-refresh before it appeared in the Inbox.
 *
 * One root cause under both symptoms. `noteFastChatPush` filed the thread in
 * `fastPending`, but `recount()` ran it through `badgeEligible`, which ends in
 * `!isArchived(...)` — so the push was counted, judged, and dropped on the
 * floor. Nothing could light until the MAIN indexer wrote `chat_messages`
 * (~60s), `poll()` read a fresh `last_message_at`, and only THEN did
 * `resurrectArchivedOnNewActivity` un-archive the thread. The fast path
 * deliberately never writes `chat_messages`, so the push was structurally
 * incapable of resurrecting anything.
 *
 * The fix is not to weaken `badgeEligible` — that check is load-bearing (cp452:
 * a badge that outruns the visible cards nags about threads the inbox won't
 * show). It's that the push IS the new-activity signal, so it should un-archive
 * the thread, exactly as the ~60s indexer path already did.
 *
 * These tests drive the REAL `startChatUnreadChannel` and invoke the REAL
 * fast-push listener it registers, so they fail if the wiring is removed —
 * which a source-scanning smoke could be refactored around.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const ME = 'kentest3';
const PEER = 'kentest2';
const ORDER = 'im-selling-200-mxn-of-xmr';

/** The listener `startChatUnreadChannel` hands to `subscribeFastPush`. Captured
 *  so a test can fire a push without standing up a service worker. */
let fastPushListener: ((peer: string, orderPermlink: string) => void) | null = null;

vi.mock('$lib/chat/globalChatActivityStream', () => ({
	startGlobalChatActivity: () => () => {},
	subscribeChatActivity: () => () => {},
	subscribeFastPush: (fn: (peer: string, orderPermlink: string) => void) => {
		fastPushListener = fn;
		return () => {
			fastPushListener = null;
		};
	}
}));

// The indexer is deliberately EMPTY of the new message: that is the entire
// point. The fast path does not write `chat_messages`, so for ~60s after the
// push the conversation list still carries the OLD last_message_at. If a test
// let the poll return the new message, it would prove nothing.
vi.mock('$lib/indexer/client', () => ({
	getConversations: vi.fn(async () => [
		{
			peer: PEER,
			order: { permlink: ORDER },
			// Older than the archive below — the indexer has not caught up.
			last_message_at: '2026-07-14T10:00:00.000Z'
		}
	]),
	getChatReadState: vi.fn(async () => null)
}));

// Spread the real module: `identity.ts` (pulled in transitively by chatFolders)
// binds `bindSessionPostingKey` at import time, so replacing the whole module
// breaks the import chain. Only the signed-in account is stubbed.
vi.mock('$blurt/ops/profile', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$blurt/ops/profile')>();
	return { ...actual, getUserBlurtAccount: () => ME };
});

vi.mock('$lib/chat/blocks', async () => {
	const { writable } = await import('svelte/store');
	return {
		blockedAccounts: writable(new Set<string>()),
		loadBlocks: () => {}
	};
});

vi.mock('$lib/utils/hiddenAccounts', async () => {
	const { writable } = await import('svelte/store');
	return { hiddenAccounts: writable(new Set<string>()) };
});

import { startChatUnreadChannel } from './chatUnread';
import { unreadCount } from './index';
import {
	archiveThread,
	isArchived,
	chatFolders,
	clearChatFolders,
	__reloadChatFolders
} from '$lib/chat/chatFolders';

describe('cp474 — fast push into an ARCHIVED thread (t.txt #3 + #4)', () => {
	let stop: (() => void) | null = null;

	beforeEach(() => {
		localStorage.clear();
		clearChatFolders();
		__reloadChatFolders();
		fastPushListener = null;
	});

	afterEach(() => {
		stop?.();
		stop = null;
		vi.useRealTimers();
	});

	it('un-archives the thread and lights the badge, without the indexer', async () => {
		// Ken's setup: both parties had the thread archived DAYS ago, and the
		// message arrives now. `resurrectArchivedOnNewActivity` only acts when the
		// activity strictly postdates the archive, so the clock has to move — and
		// modelling that gap is the point, not a workaround: a thread you archived
		// AFTER reading it must stay archived.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-13T09:00:00.000Z'));
		archiveThread(PEER, ORDER);
		expect(isArchived(PEER, ORDER)).toBe(true);
		vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));

		stop = startChatUnreadChannel();
		expect(fastPushListener).not.toBeNull();

		// Before the push: archived, so it feeds nothing. This is correct — and it
		// is also exactly the state Ken sat in for a minute.
		expect(get(unreadCount).chat).toBe(0);

		// kentest2 sends "good morning". The Web Push lands ~6s later. The indexer
		// still knows nothing (see the mock above).
		fastPushListener!(PEER, ORDER);

		// t.txt #4 — the thread must be back in the Inbox, dynamically. The chat
		// page's $derived reads $chatFolders, so this is what re-renders the card
		// out of Archived and into Inbox with no refresh.
		expect(isArchived(PEER, ORDER)).toBe(false);

		// t.txt #3 — and the badge must be lit NOW, not in ~60s.
		expect(get(unreadCount).chat).toBe(1);
	});

	it('leaves a thread archived when the push is for a DIFFERENT thread', async () => {
		// The resurrect must be targeted. A push about one discussion must not
		// dump the whole Archived tab into the Inbox — that property is what makes
		// archiving worth doing at all.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-13T09:00:00.000Z'));
		archiveThread(PEER, ORDER);
		archiveThread('someone-else', 'unrelated-order');
		vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));

		stop = startChatUnreadChannel();
		fastPushListener!(PEER, ORDER);

		expect(isArchived(PEER, ORDER)).toBe(false);
		expect(isArchived('someone-else', 'unrelated-order')).toBe(true);
	});

	it('does not disturb a thread that was never archived', async () => {
		stop = startChatUnreadChannel();
		const before = get(chatFolders);
		fastPushListener!(PEER, ORDER);
		// Inbox is ABSENCE from the map, so a push for an inbox thread must leave
		// the map untouched rather than writing an entry (which would then be
		// broadcast on chain for no reason).
		expect(get(chatFolders)).toEqual(before);
	});
});
