/**
 * Settings → Offline Notifications: when a note is due.
 *
 * The app that carries a note (her mail provider, Telegram, a Matrix or XMPP
 * server) sees when it arrives, and chat messages are on a public chain. So a
 * note must not go out a fixed time after one message: it waits a random
 * 10–60 minutes and goes out on a UTC quarter hour, the same marks for every
 * user and every message.
 */
import { describe, expect, it } from 'vitest';
import {
	OFFLINE_NOTICE_MAX_AGE_MS,
	OFFLINE_NOTICE_MAX_WAIT_MS,
	OFFLINE_NOTICE_MIN_WAIT_MS,
	OFFLINE_NOTICE_SLOT_MS,
	offlineNoticeDueAt
} from '$indexer/offlineNoticeEnqueue';

const MIN = 60_000;
const at = (iso: string): Date => new Date(iso);

/** Every due time `offlineNoticeDueAt` can give for this message. */
function allDue(eventAt: Date, now: Date): number[] {
	let n = 0;
	offlineNoticeDueAt(eventAt, now, (k) => {
		n = k;
		return 0;
	});
	return Array.from({ length: n }, (_, i) => offlineNoticeDueAt(eventAt, now, () => i).getTime());
}

describe('offline notices: when the note is due', () => {
	it('always a UTC quarter hour, more than 10 and at most 60 minutes after the message', () => {
		const base = at('2026-10-15T12:00:00Z').getTime();
		// every seventh second across an hour and a quarter, the message just arrived
		for (let s = 0; s < 75 * 60; s += 7) {
			const e = new Date(base + s * 1000);
			const due = allDue(e, e);
			expect(due.length).toBeGreaterThanOrEqual(3);
			for (const d of due) {
				expect(d % OFFLINE_NOTICE_SLOT_MS).toBe(0);
				// The promise itself (10 and 60 minutes), not just the constants.
				expect(d - e.getTime()).toBeGreaterThan(10 * MIN);
				expect(d - e.getTime()).toBeLessThanOrEqual(60 * MIN);
				expect(d - e.getTime()).toBeGreaterThan(OFFLINE_NOTICE_MIN_WAIT_MS);
				expect(d - e.getTime()).toBeLessThanOrEqual(OFFLINE_NOTICE_MAX_WAIT_MS);
			}
		}
	});

	it('any of those quarter hours can be the one', () => {
		const e = at('2026-10-15T12:03:00Z');
		expect(allDue(e, e).map((d) => new Date(d).toISOString())).toEqual([
			'2026-10-15T12:15:00.000Z',
			'2026-10-15T12:30:00.000Z',
			'2026-10-15T12:45:00.000Z',
			'2026-10-15T13:00:00.000Z'
		]);
	});

	it('a message the node learns of late still waits for a quarter hour still to come', () => {
		const e = at('2026-10-15T12:00:00Z');
		const now = new Date(e.getTime() + 25 * MIN);
		expect(allDue(e, now).map((d) => new Date(d).toISOString())).toEqual([
			'2026-10-15T12:30:00.000Z',
			'2026-10-15T12:45:00.000Z',
			'2026-10-15T13:00:00.000Z'
		]);
		// the oldest message that is still queued has two to choose from
		const oldest = new Date(now.getTime() - OFFLINE_NOTICE_MAX_AGE_MS);
		const due = allDue(oldest, now);
		expect(due.length).toBeGreaterThanOrEqual(2);
		for (const d of due) expect(d).toBeGreaterThan(now.getTime());
	});

	it('messages minutes apart share the same due times', () => {
		const a = allDue(at('2026-10-15T12:01:00Z'), at('2026-10-15T12:01:00Z'));
		const b = allDue(at('2026-10-15T12:04:30Z'), at('2026-10-15T12:04:30Z'));
		expect(a).toEqual(b);
	});

	it('the pick is random, not the same every time', () => {
		const e = at('2026-10-15T12:03:00Z');
		const seen = new Set<number>();
		for (let i = 0; i < 400; i++) seen.add(offlineNoticeDueAt(e, e).getTime());
		expect(seen.size).toBe(4);
	});
});
