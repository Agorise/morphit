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
let fastPushListener: ((peer: string, orderPermlink: string, atMs?: number) => void) | null =
	null;

vi.mock('$lib/chat/globalChatActivityStream', () => ({
	startGlobalChatActivity: () => () => {},
	subscribeChatActivity: () => () => {},
	subscribeFastPush: (fn: (peer: string, orderPermlink: string, atMs?: number) => void) => {
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
// v1.7.7 — THE MOCK WAS LYING, AND IT HID A PRODUCTION BUG FOR TWO RELEASES.
//
// It returned a BARE ARRAY. The real poller does `if (cR.ok) { convos =
// cR.data.items… }` — so `cR.ok` was undefined, the branch never ran, and
// `convos` stayed EMPTY in every test in this file. Every fast-push test here
// was therefore exercising the empty-durable-list path only: `counted` was
// always empty, so nothing could ever be wrongly skipped, so the badge always
// lit and the suite was always green.
//
// Meanwhile in production `convos` is full, and Ken's badge never lit at all.
//
// A mock that returns the wrong SHAPE doesn't fail loudly — it fails silently by
// making the code under test skip the very branch you meant to exercise. Shape
// the mock like the real response, always.
vi.mock('$lib/indexer/client', () => ({
	getConversations: vi.fn(async () => ({
		ok: true as const,
		data: {
			items: [
				{
					peer: PEER,
					order: { permlink: ORDER },
					// Older than the archive below — the indexer has not caught up.
					last_message_at: '2026-07-14T10:00:00.000Z',
					last_message_is_mine: false
				}
			]
		}
	})),
	getChatReadState: vi.fn(async () => ({ ok: true as const, data: { items: [] } }))
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

import { getConversations } from '$lib/indexer/client';
import { markConversationRead } from '$lib/chat/readState';
import { startChatUnreadChannel, listFastPending, noteFastChatPush } from './chatUnread';
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

	// ── v1.7.7 — KEN'S REPRO, VERBATIM ─────────────────────────────────
	// "both kentest2 and kentest3 have the message sitting in their archive
	//  folders … kentest2 opens the old archived message thread and sends a
	//  'badge now?' message … kentest3 gets the system notification immediately
	//  … and does not receive any badge notifications at all … the message
	//  thread [is] revived automatically in his inbox … but the message is not
	//  marked as unread … and still no badges ever appeared at all."
	//
	// The 1054-test suite was green through all of this. It never caught it
	// because every existing fast-push test used a thread that was either absent
	// from the durable list or already unread in it — never the one shape that
	// breaks: PRESENT, STALE, and READ. That combination is not exotic; it is
	// what EVERY old archived conversation looks like the moment a reply lands.
	it("lights the badge for a push on an OLD thread whose durable row is stale-but-read (Ken's repro)", async () => {
		// kentest3 read this thread on the 14th, then archived it. The durable row
		// still says the 14th, because the fast path never writes chat_messages.
		vi.setSystemTime(new Date('2026-07-14T11:00:00.000Z'));
		markConversationRead(PEER, ORDER, new Date('2026-07-14T10:00:00.000Z'));
		archiveThread(PEER, ORDER);

		// A minute later, kentest2 sends "badge now?" — push only, no durable row.
		vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
		stop = startChatUnreadChannel();

		// LET THE DURABLE POLL LAND, and PROVE it landed.
		//
		// This await is the entire test. `convos` is what fills `counted`, and
		// every other fast-push test fires the push before the first poll
		// resolves — so `convos` is empty, `counted` is empty, nothing can be
		// wrongly skipped, and the bug is invisible. That is how 1054 green tests
		// missed a badge that never lit in production.
		//
		// Waiting on `unreadCount === 0` does NOT work and is worth remembering:
		// the store STARTS at 0, so vi.waitFor returns on the first tick having
		// waited for nothing. The first draft of this test did exactly that and
		// passed against the BUGGY code — a regression test that cannot catch the
		// regression. Wait on the fetch itself, which is unambiguous.
		await vi.waitFor(() => {
			expect(getConversations).toHaveBeenCalled();
		});
		await Promise.resolve();
		expect(get(unreadCount).chat).toBe(0); // read + archived → nothing lit

		fastPushListener!(PEER, ORDER);
		await Promise.resolve();

		// The thread must resurrect (this always worked — it is local state) …
		expect(isArchived(PEER, ORDER)).toBe(false);
		// … AND the badge must light. Before the fix this was 0: the durable loop
		// filed the thread in `counted` merely for being eligible, and the fast
		// loop then skipped it as "already counted as unread" when it had been
		// counted as nothing at all.
		expect(get(unreadCount).chat).toBe(1);
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

// ── cp514 (t.txt B) — listFastPending must round-trip fastKey ──────────
// THE BUG THIS GUARDS. The badge lit in ~5s but the conversation CARD only
// appeared on the ~60s durable poll: "kentest3 goes to his chat inbox, but
// there is nothing there. about a minute later, the … message … appears."
//
// The optimistic card is injected from listFastPending(). fastKey builds its
// keys with a REAL NUL separator (the `\u0000` escape → U+0000); the parser
// searched for the LITERAL 6-char string '\\u0000' (a doubled backslash), so
// indexOf() never matched, EVERY entry was skipped, and listFastPending()
// always returned [] — no card, ever. The prior fast-push tests drive the
// badge (unreadCount) but never call listFastPending(), so the whole suite
// stayed green while the inbox card was dead. This exercises the round-trip
// directly, so a re-broken separator fails loudly.
describe('cp514 (t.txt B) — listFastPending round-trips a fast push (optimistic inbox card)', () => {
	it('returns the (peer, order) a push filed, so the inbox can synthesise a card', () => {
		const peer = 'ken-fastb-peer';
		const order = 'im-buying-7-mxn-of-blurt';
		// Date.now() (not a fixed past time): recount() prunes fast-pending
		// entries older than the TTL, so a live push must be timestamped now.
		const atMs = Date.now();
		noteFastChatPush(peer, order, atMs);
		const hit = listFastPending().find((p) => p.peer === peer && p.orderPermlink === order);
		expect(hit).toBeDefined();
		expect(hit?.atMs).toBe(atMs);
	});

	it('round-trips an ORDER-LESS thread (empty permlink) — separator still present', () => {
		// A no-RE: thread pushes an empty permlink; the key is `peer\u0000`, and
		// the parser must yield peer + '' rather than dropping the entry.
		const peer = 'ken-noorder';
		noteFastChatPush(peer, '', Date.now());
		const hit = listFastPending().find((p) => p.peer === peer);
		expect(hit).toBeDefined();
		expect(hit?.orderPermlink).toBe('');
	});
});
