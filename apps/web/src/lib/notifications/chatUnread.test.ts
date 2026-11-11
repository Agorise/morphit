// @vitest-environment jsdom
/**
 * a Web Push for an ARCHIVED thread must light the badge
 * AND pull the thread back into the Inbox, both inside the push's own latency.
 *
 * THE BUG THIS GUARDS AGAINST. on live morphit.io: tester2 sent a message
 * into a thread both parties had archived. tester3 got the system notification
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
 * The fix is not to weaken `badgeEligible` — that check is load-bearing
 * (a badge that outruns the visible cards nags about threads the inbox won't
 * show). It's that the push IS the new-activity signal, so it should un-archive
 * the thread, exactly as the ~60s indexer path already did.
 *
 * These tests drive the REAL `startChatUnreadChannel` and invoke the REAL
 * fast-push listener it registers, so they fail if the wiring is removed —
 * which a source-scanning smoke could be refactored around.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const ME = 'tester3';
const PEER = 'tester2';
const ORDER = 'im-selling-200-mxn-of-xmr';

/** The listener `startChatUnreadChannel` hands to `subscribeFastPush`. Captured
 *  so a test can fire a push without standing up a service worker. */
let fastPushListener: ((peer: string, orderPermlink: string, atMs?: number) => void) | null = null;

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
// Meanwhile in production `convos` is full, and the maintainer's badge never lit at all.
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

// A live session (polling names the account, so it needs one); a test can lock it.
const session = vi.hoisted(() => ({ live: null as null | { set(v: boolean): void } }));
vi.mock('$stores/identity', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$stores/identity')>();
	const { writable } = await import('svelte/store');
	const live = writable(true);
	session.live = live;
	return { ...actual, hasAnySession: live };
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

import { getConversations, getChatReadState } from '$lib/indexer/client';
import { setPersonStorageTier } from '$lib/storage/personStorage';
import { clearReadState, markConversationRead, getLastVisited } from '$lib/chat/readState';
import {
	startChatUnreadChannel,
	listFastPending,
	noteFastChatPush,
	__resetChatUnreadForTests,
	threadIsUnread,
	markAllChatRead
} from './chatUnread';
import { unreadCount } from './index';
import {
	archiveThread,
	isArchived,
	chatFolders,
	clearChatFolders,
	__reloadChatFolders
} from '$lib/chat/chatFolders';

describe('cp474 — fast push into an ARCHIVED thread', () => {
	let stop: (() => void) | null = null;

	beforeEach(() => {
		localStorage.clear();
		setPersonStorageTier('local');
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
		// The maintainer's setup: both parties had the thread archived DAYS ago, and the
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
		// is also exactly the state the maintainer sat in for a minute.
		expect(get(unreadCount).chat).toBe(0);

		// tester2 sends "good morning". The Web Push lands ~6s later. The indexer
		// still knows nothing (see the mock above).
		fastPushListener!(PEER, ORDER);

		// the thread must be back in the Inbox, dynamically. The chat
		// page's $derived reads $chatFolders, so this is what re-renders the card
		// out of Archived and into Inbox with no refresh.
		expect(isArchived(PEER, ORDER)).toBe(false);

		// and the badge must be lit NOW, not in ~60s.
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

	// ── v1.7.7 — THE REPORTED REPRO, VERBATIM ─────────────────────────────────
	// "both tester2 and tester3 have the message sitting in their archive
	//  folders … tester2 opens the old archived message thread and sends a
	//  'badge now?' message … tester3 gets the system notification immediately
	//  … and does not receive any badge notifications at all … the message
	//  thread [is] revived automatically in his inbox … but the message is not
	//  marked as unread … and still no badges ever appeared at all."
	//
	// The 1054-test suite was green through all of this. It never caught it
	// because every existing fast-push test used a thread that was either absent
	// from the durable list or already unread in it — never the one shape that
	// breaks: PRESENT, STALE, and READ. That combination is not exotic; it is
	// what EVERY old archived conversation looks like the moment a reply lands.
	it('lights the badge for a push on an OLD thread whose durable row is stale-but-read', async () => {
		// tester3 read this thread on the 14th, then archived it. The durable row
		// still says the 14th, because the fast path never writes chat_messages.
		vi.setSystemTime(new Date('2026-07-14T11:00:00.000Z'));
		markConversationRead(PEER, ORDER, new Date('2026-07-14T10:00:00.000Z'));
		archiveThread(PEER, ORDER);

		// A minute later, tester2 sends "badge now?" — push only, no durable row.
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

// ── listFastPending must round-trip fastKey ──────────
// THE BUG THIS GUARDS. The badge lit in ~5s but the conversation CARD only
// appeared on the ~60s durable poll: "tester3 goes to his chat inbox, but
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
describe('cp514 — listFastPending round-trips a fast push (optimistic inbox card)', () => {
	it('returns the (peer, order) a push filed, so the inbox can synthesise a card', () => {
		const peer = 'fastb-peer';
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
		const peer = 'noorder-peer';
		noteFastChatPush(peer, '', Date.now());
		const hit = listFastPending().find((p) => p.peer === peer);
		expect(hit).toBeDefined();
		expect(hit?.orderPermlink).toBe('');
	});
});

// ── v1.24.1 — the morning "(2)" ──────────────────────────────────────────────
// Owner: "every morning … that browser tab says that i have 2 notifications. i
// click on that tab … the badge disappears and there's nothing new in my inbox."
//
// Three causes, each with its test below:
//  1. A live push carried no time, so it was dated by THIS device's clock on
//     arrival: later than the message's block time, so never reached by the
//     durable row's `last_message_at`. A message read ELSEWHERE (the phone,
//     another tab) stayed counted against the chain-time cursor until the TTL.
//     Pushes now carry the message's time (the plumbing is tested where it is
//     sent: the service worker, the activity stream, the indexer's ping).
//  2. A hidden tab polled and recounted only on activity, so neither a read
//     elsewhere nor the TTL's end reached it until it was looked at.
//  3. A locked tab (the idle timeout) still counted pushes, against an empty
//     read state; looking at it ran the poll, which found no session: 0.
describe('v1.24.1 — a background or locked tab shows only what is unread', () => {
	let stop: (() => void) | null = null;
	const T0 = '2026-11-09T20:00:00.000Z'; // an old message, read
	const T1 = '2026-11-10T03:00:00.000Z'; // tonight's first message (chain time)
	const T2 = '2026-11-10T03:00:30.000Z'; // and its second
	const ms = (iso: string): number => new Date(iso).getTime();
	const plus = (iso: string, s: number): string => new Date(ms(iso) + s * 1000).toISOString();

	function durable(lastMessageAt: string) {
		vi.mocked(getConversations).mockResolvedValue({
			ok: true,
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
		} as never);
	}
	function readElsewhere(at: string) {
		vi.mocked(getChatReadState).mockResolvedValue({
			ok: true,
			data: { items: [{ peer: PEER, order_permlink: ORDER, last_read_at: at }] }
		} as never);
	}
	function hide(hidden: boolean) {
		Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => (hidden ? 'hidden' : 'visible')
		});
	}
	async function start(atIso: string) {
		vi.setSystemTime(ms(atIso));
		stop = startChatUnreadChannel();
		await vi.advanceTimersByTimeAsync(0);
	}
	/** A push for a message of chain time `msgIso`, reaching this device `lagMs` later. */
	function push(msgIso: string | null, lagMs = 3_000, from?: string) {
		vi.setSystemTime(ms(from ?? msgIso ?? T1) + lagMs);
		fastPushListener!(PEER, ORDER, msgIso === null ? undefined : ms(msgIso));
	}
	const chat = (): number => get(unreadCount).chat;

	beforeEach(() => {
		localStorage.clear();
		setPersonStorageTier('local');
		clearChatFolders();
		__reloadChatFolders();
		fastPushListener = null;
		__resetChatUnreadForTests();
		clearReadState();
		vi.useFakeTimers();
		durable(T0);
		readElsewhere(T0);
	});

	afterEach(() => {
		stop?.();
		stop = null;
		hide(false);
		session.live!.set(true);
		vi.useRealTimers();
		vi.mocked(getConversations).mockReset();
		vi.mocked(getChatReadState).mockReset();
	});

	it('1. a message read on another device clears once its durable row lands', async () => {
		await start(T0);
		push(T1);
		expect(chat()).toBe(1);
		durable(T1);
		readElsewhere(T1);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(chat()).toBe(0);
	});

	it('1b. …and so does one only the push knew of, read elsewhere before its row lands', async () => {
		await start(T0);
		push(T1);
		readElsewhere(T1);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(chat()).toBe(0);
	});

	it('2. a hidden tab learns of a read made elsewhere within about a minute', async () => {
		await start(T0);
		hide(true);
		push(T1);
		expect(chat()).toBe(1);
		durable(T1);
		readElsewhere(T1);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(chat()).toBe(0);
	});

	it('2b. a hidden tab drops a push its records never confirm, once its 10 minutes end', async () => {
		await start(T0);
		hide(true);
		push(null);
		expect(chat()).toBe(1);
		// The poll is answered with the same old row: nothing for it to reconcile.
		await vi.advanceTimersByTimeAsync(11 * 60_000);
		expect(chat()).toBe(0);
	});

	it('2c. control: an unread message stays on the hidden tab', async () => {
		await start(T0);
		hide(true);
		push(T1);
		durable(T1);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(chat()).toBe(1);
	});

	it('3. a locked tab counts no push, the lock clears the count at once, unlock brings it back', async () => {
		await start(T0);
		hide(true);
		push(T1);
		expect(chat()).toBe(1);
		session.live!.set(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(chat()).toBe(0);
		push(T2);
		await vi.advanceTimersByTimeAsync(0);
		expect(chat()).toBe(0);
		session.live!.set(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(chat(), 'the message pushed while locked is unread').toBe(1);
	});

	it('a second message stays lit when the first one’s row lands (read here)', async () => {
		await start(T0);
		push(T1);
		markConversationRead(PEER, ORDER, new Date(T1)); // read here
		expect(chat()).toBe(0);
		push(T2);
		expect(chat()).toBe(1);
		durable(T1); // the first message's row: the second is not in it
		await vi.advanceTimersByTimeAsync(6_000);
		expect(chat()).toBe(1);
		durable(T2);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(chat(), 'now judged by its own row').toBe(1);
	});

	it('an older message announced late does not pull the newer one back', async () => {
		await start(T0);
		push(T2);
		push(T1, 5_000, T2); // T1's Web Push arrives after T2's ping
		durable(T1);
		readElsewhere(T1); // the first one read on the phone, not the second
		await vi.advanceTimersByTimeAsync(6_000);
		expect(chat()).toBe(1);
	});

	it('a push delivered hours late (a computer waking) for a message already read lights nothing', async () => {
		durable(T1);
		readElsewhere(T1);
		await start(T1);
		push(T1, 3 * 60 * 60_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(chat()).toBe(0);
	});

	it('a device clock running fast still lights the badge, and a read here still clears it', async () => {
		// This device is 15 minutes ahead of the chain. The read here happens
		// before the message (device time), so it must not cover it; the 10
		// minutes are counted on this device's clock from the push's arrival.
		const SKEW = 15 * 60_000;
		await start(T0);
		vi.setSystemTime(ms(T1) - 60_000 + SKEW);
		markConversationRead(PEER, ORDER, new Date(T0));
		push(T1, 3_000 + SKEW);
		expect(chat()).toBe(1);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(chat()).toBe(1);
		markConversationRead(PEER, ORDER, new Date(T1));
		expect(chat()).toBe(0);
	});

	it('a far-future time is not trusted: the push still ends after 10 minutes', async () => {
		await start(T0);
		hide(true);
		vi.setSystemTime(ms(T1));
		fastPushListener!(PEER, ORDER, ms(T1) + 30 * 24 * 60 * 60_000);
		expect(chat()).toBe(1);
		await vi.advanceTimersByTimeAsync(11 * 60_000);
		expect(chat()).toBe(0);
	});

	it('a time too large to be a date does not break the count', async () => {
		await start(T0);
		vi.setSystemTime(ms(T1));
		fastPushListener!(PEER, ORDER, 1e16);
		expect(chat()).toBe(1);
	});

	// The inbox card asks threadIsUnread, the badge recount(): the same rule.
	const card = (lastMessageAt: string): boolean =>
		threadIsUnread(PEER, ORDER, lastMessageAt, false);

	it('the card: a message read on another device is not unread, before or after its row', async () => {
		await start(T0);
		push(T1);
		expect(card(T0)).toBe(true);
		readElsewhere(T1);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(card(T0), 'judged by the read cursor while only the push knows it').toBe(false);
		expect(card(T1), 'and by its row once it lands').toBe(false);
	});

	it('the card: a device clock running fast, and a duplicate after a read here', async () => {
		const SKEW = 15 * 60_000;
		await start(T0);
		vi.setSystemTime(ms(T1) - 60_000 + SKEW);
		markConversationRead(PEER, ORDER, new Date(T0));
		push(T1, 3_000 + SKEW);
		await vi.advanceTimersByTimeAsync(9 * 60_000);
		expect(card(T0), 'still within its 10 minutes on this clock').toBe(true);
		// Read here, as the thread view acks it: the copy's own time.
		markConversationRead(PEER, ORDER, new Date(T1), { newestIsFast: true });
		expect(card(T0)).toBe(false);
		// The same message announced again a moment later (its Web Push after
		// its live ping): it must not count as news.
		vi.setSystemTime(Date.now() + 2_000);
		fastPushListener!(PEER, ORDER, ms(T1));
		expect(card(T0), 'the same message announced again is still read').toBe(false);
	});

	it('Mark all read acks a pushed-only thread at the message’s own time, and its row stays read', async () => {
		await start(T0);
		push(T1);
		expect(chat()).toBe(1);
		markAllChatRead();
		expect(chat()).toBe(0);
		expect(getLastVisited(PEER, ORDER), 'a read cursor at the message’s own time').toBe(T1);
		durable(plus(T1, 4));
		await vi.advanceTimersByTimeAsync(6_000);
		expect(chat(), 'its row, a few seconds later, is the message read').toBe(0);
	});

	it('Mark all read never moves a cursor back over a pushed thread already read', async () => {
		await start(T0);
		push(T1);
		markConversationRead(PEER, ORDER, new Date(T2)); // read further
		markAllChatRead();
		expect(getLastVisited(PEER, ORDER)).toBe(T2);
	});

	it('Mark all read leaves a pushed thread the badge does not count (archived)', async () => {
		await start(T0);
		push(T1);
		archiveThread(PEER, ORDER);
		const before = getLastVisited(PEER, ORDER);
		markAllChatRead();
		expect(getLastVisited(PEER, ORDER)).toBe(before);
	});

	it('a push before the first poll answers is judged when it does', async () => {
		vi.setSystemTime(ms(T1) + 3_000);
		let answer: (v: unknown) => void = () => {};
		vi.mocked(getConversations).mockReturnValueOnce(
			new Promise((r) => {
				answer = r;
			}) as never
		);
		stop = startChatUnreadChannel();
		fastPushListener!(PEER, ORDER, ms(T1));
		answer({
			ok: true,
			data: {
				items: [
					{
						peer: PEER,
						order: { permlink: ORDER },
						last_message_at: T0,
						last_message_is_mine: false
					}
				]
			}
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(chat()).toBe(1);
	});
});
