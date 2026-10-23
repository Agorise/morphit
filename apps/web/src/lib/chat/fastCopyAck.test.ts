// @vitest-environment jsdom
/**
 * Reading a message on its FAST copy and leaving must not make the thread
 * unread again when the chain copy lands (v1.21.14 review C, M3).
 *
 * A fast copy (local delivery, a federation push) is dated with the head time
 * the sender signed at (the transaction's expiry minus 60 s); the chain copy
 * carries its block's time, a few seconds later and never past the expiry.
 * Since W-M3 the read cursor is the newest message SEEN, so the ack named the
 * fast copy's time, and the durable row's later `last_message_at` lit the
 * badge, the favicon and the inbox border again for a message already read.
 *
 * The cure must not hide a DIFFERENT message: any later message on the thread
 * reaches this device as a push or a live ping, and that cancels the cover.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

import { isUnread, markConversationRead } from './readState';
import { noteFastChatPush } from '$lib/notifications/chatUnread';

const A = new Date('2026-10-21T12:00:00.000Z'); // the fast copy's time (signing head)
const iso = (ms: number) => new Date(A.getTime() + ms).toISOString();
let n = 0;
let peer = 'bob';

beforeEach(() => {
	peer = `bob${++n}`;
});

describe('fast copy read, then its chain copy lands (review C, M3)', () => {
	it('the chain copy of the message read is not unread', () => {
		markConversationRead(peer, 'o1', A, { newestIsFast: true });
		expect(isUnread(peer, 'o1', iso(3_000), false)).toBe(false);
		expect(isUnread(peer, 'o1', iso(59_000), false)).toBe(false);
	});

	it('a later live push on the thread cancels the cover: a new message is unread', () => {
		markConversationRead(peer, 'o1', A, { newestIsFast: true });
		noteFastChatPush(peer, 'o1');
		expect(isUnread(peer, 'o1', iso(6_000), false)).toBe(true);
	});

	it('a later live ping dated after the read message cancels it too', () => {
		markConversationRead(peer, 'o1', A, { newestIsFast: true });
		noteFastChatPush(peer, 'o1', A.getTime() + 4_000);
		expect(isUnread(peer, 'o1', iso(4_000), false)).toBe(true);
	});

	it('a replay of the very message read (same time) keeps the cover', () => {
		markConversationRead(peer, 'o1', A, { newestIsFast: true });
		noteFastChatPush(peer, 'o1', A.getTime());
		expect(isUnread(peer, 'o1', iso(3_000), false)).toBe(false);
	});

	it('a durable time past the transaction expiry window is a different message: unread', () => {
		markConversationRead(peer, 'o1', A, { newestIsFast: true });
		expect(isUnread(peer, 'o1', iso(5 * 60_000), false)).toBe(true);
	});

	it('an ack of a DURABLE newest message covers nothing past it', () => {
		markConversationRead(peer, 'o1', A);
		expect(isUnread(peer, 'o1', iso(3_000), false)).toBe(true);
	});

	it('another thread with the same peer is not covered', () => {
		markConversationRead(peer, 'o1', A, { newestIsFast: true });
		markConversationRead(peer, 'o2', A);
		expect(isUnread(peer, 'o2', iso(3_000), false)).toBe(true);
	});
});
