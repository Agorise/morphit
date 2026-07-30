// @vitest-environment jsdom
/**
 * v1.7.7 adversarial pass — [KEN]: "when we do the walkthroughs and deep deep
 * before a release, this is exactly the type of thing that a black hat would try
 * to do. he wants to break things."
 *
 * Morphit is FEDERATED. `last_message_at` arrives from whichever operator's
 * indexer the user picked, and v1.7.7 made that value load-bearing in three
 * places at once: the read cursor, the archive watermark, and cap()'s eviction
 * order. "My operator is honest" is precisely the assumption this project
 * refuses to make anywhere else.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { markConversationRead, isUnread, readAckTimestamp, sanitizeBlockTime, clearReadState } from '$lib/chat/readState';
import { archiveThread, isArchived, resurrectArchivedOnNewActivity, clearChatFolders, __reloadChatFolders } from '$lib/chat/chatFolders';

const PEER = 'kentest2';
const ORDER = 'im-selling-200-mxn-of-xmr';
const NOW = new Date('2026-07-17T12:00:00.000Z');
const EVIL = '2099-01-01T00:00:00.000Z';

describe('hostile indexer timestamps', () => {
	beforeEach(() => {
		localStorage.clear();
		clearReadState();
		clearChatFolders();
		__reloadChatFolders();
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	it('THE BAD ONE: a far-future last_message_at cannot deafen the user', () => {
		// Poison the cursor by "opening" a thread the indexer claims is from 2099.
		markConversationRead(PEER, ORDER, readAckTimestamp(new Date(EVIL)));

		// A genuine message arrives a day later — and so the CLOCK is a day later
		// too. That pairing matters: an earlier draft of this test left the clock at
		// NOW and called a message from "tomorrow" genuine, which cannot happen. A
		// block time is a chain fact and never leads the clock; that is the entire
		// premise the sanitiser rests on. The test was modelling something
		// impossible, and it took the sanitiser landing to expose it.
		const tomorrow = new Date(NOW.getTime() + 86_400_000);
		vi.setSystemTime(tomorrow);
		const real = new Date(tomorrow.getTime() - 60_000).toISOString();

		// It MUST still be unread — otherwise a hostile operator has silently hidden
		// a counterparty's payment message.
		expect(isUnread(PEER, ORDER, real, false)).toBe(true);
	});

	it('a far-future watermark cannot make an archived thread unresurrectable', () => {
		archiveThread(PEER, ORDER, EVIL);
		const real = new Date(NOW.getTime() + 86_400_000).toISOString();
		resurrectArchivedOnNewActivity([{ peer: PEER, orderPermlink: ORDER, lastMessageAt: real }]);
		expect(isArchived(PEER, ORDER)).toBe(false);
	});

	it("CHARLIE: a hostile 2099 cannot pin a badge the user can never clear", () => {
		// The inverse of the deafening vector, and it was created BY the fix for it:
		// once the cursor is clamped to `now`, a raw `2099 > cursor` stays true
		// forever. Opening the thread must still clear it.
		expect(isUnread(PEER, ORDER, EVIL, false)).toBe(true); // shouts once…
		markConversationRead(PEER, ORDER, readAckTimestamp(new Date(EVIL)));
		expect(isUnread(PEER, ORDER, EVIL, false)).toBe(false); // …and then shuts up
	});

	it('a hostile PAST timestamp cannot silence a real message either', () => {
		// The sanitiser only bounds the future; both consumers floor at `now`, so a
		// past lie can only fail to advance the cursor — never move it forward.
		markConversationRead(PEER, ORDER, readAckTimestamp(new Date('1970-01-01T00:00:00.000Z')));
		const real = new Date(NOW.getTime() + 60_000).toISOString();
		expect(isUnread(PEER, ORDER, real, false)).toBe(true);
	});

	it('honest clock skew is still believed (30s ahead is normal, not an attack)', () => {
		const soon = new Date(NOW.getTime() + 30_000);
		expect(readAckTimestamp(soon).getTime()).toBe(soon.getTime());
	});

	it('sanitizeBlockTime: rejects only the implausible', () => {
		expect(sanitizeBlockTime(EVIL, NOW.getTime())).toBeNull();
		expect(sanitizeBlockTime('not-a-date', NOW.getTime())).toBeNull();
		expect(sanitizeBlockTime(null, NOW.getTime())).toBeNull();
		expect(sanitizeBlockTime(undefined, NOW.getTime())).toBeNull();
		// past + present + ordinary skew all survive
		expect(sanitizeBlockTime('2026-07-17T11:00:00.000Z', NOW.getTime())).not.toBeNull();
		expect(sanitizeBlockTime(new Date(NOW.getTime() + 59 * 60_000), NOW.getTime())).not.toBeNull();
		// just past the tolerance
		expect(sanitizeBlockTime(new Date(NOW.getTime() + 61 * 60_000), NOW.getTime())).toBeNull();
	});
});
