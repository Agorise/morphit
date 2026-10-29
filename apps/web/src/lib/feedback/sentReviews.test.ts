// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const answers: unknown[] = [];
const asks: unknown[] = [];
vi.mock('$lib/indexer/client', () => ({
	getFeedbackStatus: vi.fn(async (q: unknown) => {
		asks.push(q);
		const next = answers.length > 1 ? answers.shift() : answers[0];
		if (next instanceof Error) throw next;
		return next;
	})
}));

import { setPersonStorageTier } from '$lib/storage/personStorage';
import {
	_resetSentReviewsForTests,
	FIRST_TRADE_PROOF_FROM,
	NEEDS_TRANSFER_RECHECK_MS,
	rememberSentReview,
	reviewRefOf,
	SENT_REVIEW_LOST_AFTER_MS,
	SENT_REVIEW_RECHECK_FOR_MS,
	SENT_REVIEWS_KEY,
	SENT_REVIEW_RECHECK_MS,
	SENT_REVIEWS_KEEP_MS,
	SENT_REVIEWS_MAX,
	sentReviewAsRecord,
	sentReviewFor,
	sentReviewsBy,
	sentReviewsTick,
	sentReviewVerdict,
	watchSentReview,
	type SentReview
} from './sentReviews';
import { resetChatOnSignOut } from '$lib/chat/signOutReset';

const review = (over: Partial<SentReview> = {}): SentReview => ({
	reviewer: 'bob',
	subject: 'alice',
	order_permlink: 'order-bob1',
	rating: 5,
	comment: 'Smooth trade',
	trx_id: 'f'.repeat(40),
	sent_at: new Date().toISOString(),
	...over
});
const ok = (data: unknown) => ({ ok: true, data });

beforeEach(() => {
	localStorage.clear();
	setPersonStorageTier('local');
	_resetSentReviewsForTests();
	answers.length = 0;
	asks.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('the sent reviews kept on this device', () => {
	it('survive a reload (stored), per reviewer, subject and order', () => {
		rememberSentReview(review());
		_resetSentReviewsForTests(); // a reload: memory gone, storage kept
		expect(sentReviewFor('bob', 'alice', 'order-bob1')?.comment).toBe('Smooth trade');
		expect(sentReviewFor('carol', 'alice', 'order-bob1')).toBeNull();
		expect(sentReviewFor('bob', 'alice', 'order-other')).toBeNull();
	});
	it('a newer one for the same trade replaces the older; the tick moves', () => {
		const t0 = get(sentReviewsTick);
		rememberSentReview(review({ rating: 3 }));
		rememberSentReview(review({ rating: 4 }));
		expect(sentReviewsBy('bob')).toHaveLength(1);
		expect(sentReviewFor('bob', 'alice', 'order-bob1')?.rating).toBe(4);
		expect(get(sentReviewsTick)).toBeGreaterThan(t0);
	});
	it('keeps at most SENT_REVIEWS_MAX, dropping the oldest', () => {
		for (let i = 0; i < SENT_REVIEWS_MAX + 5; i++) {
			rememberSentReview(review({ order_permlink: `order-${i}` }));
		}
		expect(sentReviewsBy('bob')).toHaveLength(SENT_REVIEWS_MAX);
		expect(sentReviewFor('bob', 'alice', 'order-0')).toBeNull();
		expect(sentReviewFor('bob', 'alice', `order-${SENT_REVIEWS_MAX + 4}`)).not.toBeNull();
	});
	it('forgets very old ones, and ignores junk in storage', () => {
		const old = new Date(Date.now() - SENT_REVIEWS_KEEP_MS - 1000).toISOString();
		localStorage.setItem(
			'morphit.sentReviews.v1',
			JSON.stringify([
				review({ sent_at: old }),
				{ reviewer: 'bob', rating: 9 },
				{ ...review({ order_permlink: 'order-x' }), rating: 9 },
				review()
			])
		);
		expect(sentReviewsBy('bob')).toHaveLength(1);
	});
	it('still works for the visit when storage throws', () => {
		const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		rememberSentReview(review());
		expect(sentReviewFor('bob', 'alice', 'order-bob1')).not.toBeNull();
		spy.mockRestore();
	});
	it('another tab’s review is not erased by this tab’s next one', () => {
		rememberSentReview(review({ order_permlink: 'order-a' })); // this tab reads + writes
		// Another tab writes its own review straight to storage.
		const other = JSON.parse(localStorage.getItem('morphit.sentReviews.v1') ?? '[]') as unknown[];
		other.push(review({ order_permlink: 'order-b' }));
		localStorage.setItem('morphit.sentReviews.v1', JSON.stringify(other));
		rememberSentReview(review({ order_permlink: 'order-c' }));
		_resetSentReviewsForTests();
		expect(
			sentReviewsBy('bob')
				.map((r) => r.order_permlink)
				.sort()
		).toEqual(['order-a', 'order-b', 'order-c']);
	});
	it('a storage event from another tab is picked up', () => {
		rememberSentReview(review({ order_permlink: 'order-a' }));
		localStorage.setItem(
			'morphit.sentReviews.v1',
			JSON.stringify([review({ order_permlink: 'order-z' })])
		);
		const t0 = get(sentReviewsTick);
		window.dispatchEvent(new StorageEvent('storage', { key: 'morphit.sentReviews.v1' }));
		expect(get(sentReviewsTick)).toBeGreaterThan(t0);
		expect(sentReviewFor('bob', 'alice', 'order-z')).not.toBeNull();
	});
	it('shows as a record: stars, comment, the order', () => {
		expect(sentReviewAsRecord(review())).toMatchObject({
			reviewer: 'bob',
			subject: 'alice',
			rating: 5,
			comment: 'Smooth trade',
			order_permlink: 'order-bob1'
		});
	});
});

describe('sentReviewVerdict', () => {
	const now = Date.parse('2026-10-26T20:00:00Z');
	it('indexed counts; unknown or no answer is pending', () => {
		expect(sentReviewVerdict({ state: 'indexed' }, now)).toEqual({ kind: 'counted' });
		expect(sentReviewVerdict({ state: 'unknown' }, now)).toEqual({ kind: 'pending' });
		expect(sentReviewVerdict(null, now)).toEqual({ kind: 'pending' });
	});
	it('refused with resend_from: later before it, resend from it', () => {
		const a = {
			state: 'refused' as const,
			reason: 'order_permlink_not_found_or_unverified',
			resend_from: '2026-11-01T00:00:00Z'
		};
		expect(sentReviewVerdict(a, now)).toEqual({
			kind: 'later',
			from: '2026-11-01T00:00:00Z',
			sent: null
		});
		expect(sentReviewVerdict(a, Date.parse('2026-11-01T00:00:00Z'))).toEqual({
			kind: 'resend',
			sent: null
		});
	});
	it('refused otherwise: refused, with its reason', () => {
		expect(
			sentReviewVerdict({ state: 'refused', reason: 'no_verified_counterparty' }, now)
		).toEqual({
			kind: 'refused',
			reason: 'no_verified_counterparty',
			sent: null
		});
	});
});

describe('sentReviewVerdict — what was sent, from the chain', () => {
	it('a refused review carries its stars and words; junk ratings are dropped', () => {
		const now = Date.parse('2026-10-26T20:00:00Z');
		expect(
			sentReviewVerdict(
				{
					state: 'refused',
					resend_from: '2026-11-01T00:00:00Z',
					rating: 5,
					comment: 'Smooth trade'
				},
				now
			)
		).toEqual({
			kind: 'later',
			from: '2026-11-01T00:00:00Z',
			sent: { rating: 5, comment: 'Smooth trade' }
		});
		expect(sentReviewVerdict({ state: 'refused', rating: 7 }, now)).toMatchObject({ sent: null });
		expect(sentReviewVerdict({ state: 'refused', rating: 4 }, now)).toMatchObject({
			sent: { rating: 4, comment: null }
		});
	});
});

describe('sentReviewVerdict — a first trade waiting for its proof', () => {
	it('names who must send whom 1 BLURT, from when; wins over resend_from', () => {
		const now = Date.parse('2026-10-26T20:00:00Z');
		const w = { from: 'alice', to: 'bob' };
		expect(
			sentReviewVerdict({ state: 'refused', waiting_for_transfer: w, rating: 5 }, now)
		).toEqual({
			kind: 'needs_transfer',
			from: 'alice',
			to: 'bob',
			after: FIRST_TRADE_PROOF_FROM,
			sent: { rating: 5, comment: null }
		});
		expect(
			sentReviewVerdict(
				{ state: 'refused', waiting_for_transfer: w, resend_from: '2026-11-01T00:00:00Z' },
				now
			).kind
		).toBe('needs_transfer');
	});
});

describe('watchSentReview', () => {
	it('waiting for the proof: asked again now and then, and "resend" once it is there', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
		answers.push(
			ok({ state: 'refused', reason: 'x', waiting_for_transfer: { from: 'alice', to: 'bob' } }),
			ok({ state: 'refused', reason: 'x', resend_from: '2026-11-01T00:00:00Z' })
		);
		const w = watchSentReview({ reviewer: 'bob', subject: 'alice', order_permlink: 'order-w' });
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(get(w)).toMatchObject({ kind: 'needs_transfer' });
		await vi.advanceTimersByTimeAsync(NEEDS_TRANSFER_RECHECK_MS);
		expect(get(w)).toMatchObject({ kind: 'resend' });
		stop();
	});

	it('asks again while not seen, then settles', async () => {
		vi.useFakeTimers();
		answers.push(ok({ state: 'unknown' }), ok({ state: 'indexed' }));
		const w = watchSentReview(review());
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(get(w)).toEqual({ kind: 'pending' });
		expect(asks[0]).toEqual({ reviewer: 'bob', subject: 'alice', order_permlink: 'order-bob1' });
		await vi.advanceTimersByTimeAsync(SENT_REVIEW_RECHECK_MS);
		expect(get(w)).toEqual({ kind: 'counted' });
		const n = asks.length;
		await vi.advanceTimersByTimeAsync(SENT_REVIEW_RECHECK_MS * 3);
		expect(asks.length).toBe(n);
		stop();
	});
	it('stops asking after a while when never seen', async () => {
		vi.useFakeTimers();
		answers.push(ok({ state: 'unknown' }));
		const stop = watchSentReview(review({ trx_id: 'e'.repeat(40) })).subscribe(() => {});
		await vi.advanceTimersByTimeAsync(SENT_REVIEW_RECHECK_FOR_MS + SENT_REVIEW_RECHECK_MS * 2);
		const n = asks.length;
		expect(n).toBeLessThanOrEqual(SENT_REVIEW_RECHECK_FOR_MS / SENT_REVIEW_RECHECK_MS + 2);
		await vi.advanceTimersByTimeAsync(SENT_REVIEW_RECHECK_MS * 5);
		expect(asks.length).toBe(n);
		stop();
	});
	it('"later" turns into "resend" when the day comes, without a reload', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-31T23:00:00Z'));
		// The refusal of THIS send (same transaction), with what it said.
		answers.push(
			ok({
				state: 'refused',
				reason: 'x',
				resend_from: '2026-11-01T00:00:00Z',
				trx_id: 'd'.repeat(40),
				rating: 4,
				comment: 'ok'
			})
		);
		const w = watchSentReview(review({ trx_id: 'd'.repeat(40) }));
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		const sent = { rating: 4, comment: 'ok' };
		expect(get(w)).toEqual({ kind: 'later', from: '2026-11-01T00:00:00Z', sent });
		await vi.advanceTimersByTimeAsync(60 * 60_000 + 2_000);
		expect(get(w)).toEqual({ kind: 'resend', sent });
		stop();
	});
	it('a "later" a month away asks again instead of flipping early', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
		answers.push(ok({ state: 'refused', reason: 'x', resend_from: '2026-11-01T00:00:00Z' }));
		const w = watchSentReview(review({ trx_id: 'c'.repeat(40) }));
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
		expect(get(w)).toEqual({ kind: 'later', from: '2026-11-01T00:00:00Z', sent: null });
		expect(asks.length).toBe(2);
		stop();
	});
	it('a refusal of an earlier send does not stand for this one', async () => {
		answers.push(
			ok({
				state: 'refused',
				reason: 'x',
				resend_from: '2026-11-01T00:00:00Z',
				trx_id: '0'.repeat(40)
			})
		);
		const w = watchSentReview(review({ trx_id: 'a'.repeat(40) }));
		const stop = w.subscribe(() => {});
		await new Promise((r) => setTimeout(r, 0));
		expect(get(w)).toEqual({ kind: 'pending' });
		stop();
	});
	it('starts as "checking"; a review never sent from here is asked about once', async () => {
		vi.useFakeTimers();
		answers.push(ok({ state: 'unknown' }));
		const w = watchSentReview({ reviewer: 'bob', subject: 'alice', order_permlink: 'order-z' });
		const seen: unknown[] = [];
		const stop = w.subscribe((v) => seen.push(v));
		expect(seen[0]).toEqual({ kind: 'checking' });
		await vi.advanceTimersByTimeAsync(0);
		expect(get(w)).toEqual({ kind: 'pending' });
		await vi.advanceTimersByTimeAsync(SENT_REVIEW_RECHECK_MS * 3);
		expect(asks).toHaveLength(1);
		stop();
	});
	it('without a send of its own, any refusal stands (a review sent before this version)', async () => {
		answers.push(
			ok({
				state: 'refused',
				reason: 'x',
				resend_from: '2026-11-01T00:00:00Z',
				trx_id: '0'.repeat(40)
			})
		);
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
		const w = watchSentReview({ reviewer: 'bob', subject: 'alice', order_permlink: 'order-y' });
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(get(w)).toMatchObject({ kind: 'later' });
		stop();
	});
	it('the instance down: shown as sent', async () => {
		answers.push(new Error('offline'));
		const w = watchSentReview(review({ trx_id: 'b'.repeat(40) }));
		const stop = w.subscribe(() => {});
		await new Promise((r) => setTimeout(r, 0));
		expect(get(w)).toEqual({ kind: 'pending' });
		stop();
	});
});

describe('whose they are (v1.21.17)', () => {
	it('a "just this session" sign-in keeps them in the tab, never on the device', () => {
		setPersonStorageTier('session');
		_resetSentReviewsForTests();
		rememberSentReview(review());
		expect(localStorage.getItem(SENT_REVIEWS_KEY)).toBeNull();
		expect(sessionStorage.getItem(SENT_REVIEWS_KEY)).not.toBeNull();
		sessionStorage.clear();
	});
	it('read before the session was known, they are read again once it is', () => {
		rememberSentReview(review());
		const stored = localStorage.getItem(SENT_REVIEWS_KEY)!;
		setPersonStorageTier(null);
		_resetSentReviewsForTests();
		expect(sentReviewFor('bob', 'alice', 'order-bob1')).toBeNull();
		localStorage.setItem(SENT_REVIEWS_KEY, stored);
		setPersonStorageTier('local');
		expect(sentReviewFor('bob', 'alice', 'order-bob1')).not.toBeNull();
	});
	it('signed out: the next account in this tab neither sees them nor writes them back', () => {
		rememberSentReview(review());
		const before = watchSentReview(review());
		setPersonStorageTier(null);
		resetChatOnSignOut();
		localStorage.removeItem(SENT_REVIEWS_KEY);
		expect(sentReviewFor('bob', 'alice', 'order-bob1')).toBeNull();
		expect(watchSentReview(review())).not.toBe(before);
		// A late write from a view still open: nowhere to go without a session.
		rememberSentReview(review({ order_permlink: 'order-late' }));
		expect(localStorage.getItem(SENT_REVIEWS_KEY)).toBeNull();
	});
});

describe('which refusal is about this send (v1.21.17)', () => {
	// Sent just now (an hour later it would count as lost).
	const sentMs = Date.now();
	const SENT = new Date(sentMs).toISOString();
	const minutes = (m: number) => new Date(sentMs + m * 60_000).toISOString();
	const refusedAt = (blockTime: string) =>
		ok({
			state: 'refused',
			reason: 'no_verified_counterparty',
			trx_id: '9'.repeat(40),
			block_time: blockTime
		});
	it('a refusal of a NEWER send (another device) stands', async () => {
		answers.push(refusedAt(minutes(30)));
		const w = watchSentReview(review({ trx_id: '1'.repeat(40), sent_at: SENT }));
		const stop = w.subscribe(() => {});
		await new Promise((r) => setTimeout(r, 0));
		expect(get(w)).toMatchObject({ kind: 'refused', reason: 'no_verified_counterparty' });
		stop();
	});
	it('a refusal of an OLDER send does not', async () => {
		answers.push(refusedAt(minutes(-30)));
		const w = watchSentReview(review({ trx_id: '2'.repeat(40), sent_at: SENT }));
		const stop = w.subscribe(() => {});
		await new Promise((r) => setTimeout(r, 0));
		expect(get(w)).toEqual({ kind: 'pending' });
		stop();
	});
});

describe('a review sent from here that never arrives (v1.21.17)', () => {
	it('is asked for again an hour after it was sent, not shown as sent for good', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-26T18:00:00Z'));
		answers.push(ok({ state: 'unknown' }));
		const w = watchSentReview(
			review({ trx_id: '3'.repeat(40), sent_at: '2026-10-26T18:00:00.000Z' })
		);
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(get(w)).toEqual({ kind: 'pending' });
		await vi.advanceTimersByTimeAsync(SENT_REVIEW_LOST_AFTER_MS - 60_000);
		expect(get(w)).toEqual({ kind: 'pending' });
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(get(w)).toEqual({ kind: 'resend', sent: null });
		stop();
	});
	it('already an hour old when looked at: asked for again at once', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-26T20:00:00Z'));
		answers.push(ok({ state: 'unknown' }));
		const w = watchSentReview(
			review({ trx_id: '4'.repeat(40), sent_at: '2026-10-26T18:00:00.000Z' })
		);
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(get(w)).toEqual({ kind: 'resend', sent: null });
		stop();
	});
});

describe('reviewRefOf', () => {
	it('carries this device’s send: its transaction and when it reached a block', () => {
		const r = review({ trx_id: '5'.repeat(40), sent_at: '2026-10-26T18:00:00.000Z' });
		expect(reviewRefOf('bob', 'alice', 'order-bob1', r)).toEqual({
			reviewer: 'bob',
			subject: 'alice',
			order_permlink: 'order-bob1',
			trx_id: '5'.repeat(40),
			sent_at: '2026-10-26T18:00:00.000Z'
		});
		expect(reviewRefOf('bob', 'alice', 'order-bob1', null)).toEqual({
			reviewer: 'bob',
			subject: 'alice',
			order_permlink: 'order-bob1'
		});
	});
});
