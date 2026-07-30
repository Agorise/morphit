/**
 * cp514 (t.txt D) — the chat inbox card's 3rd line must flip from the green
 * "Leave feedback" prompt to the ★ rating the instant feedback is broadcast,
 * without waiting for the durable /feedback-given poll ("show the truth
 * immediately … no matter how fast I decide to click back to the chat inbox").
 *
 * The inbox's feedbackStateFor looks up `${peer}\u0000${order}`; noteFeedbackGiven
 * files under the SAME key so the lookup hits the optimistic record before the
 * indexer catches up. These tests pin that round-trip + the key shape, so a
 * broken key (which would silently leave the stale prompt showing) fails loudly.
 */

import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { FeedbackRecord } from '@morphit/indexer-client';
import {
	noteFeedbackGiven,
	getOptimisticFeedbackGiven,
	optimisticFeedbackTick
} from './optimisticFeedbackGiven';

function rec(subject: string, order: string, rating: 1 | 2 | 3 | 4 | 5): FeedbackRecord {
	return {
		id: -1,
		reviewer: 'kentest3',
		subject,
		rating,
		comment: null,
		order_permlink: order,
		created_at: new Date().toISOString(),
		source_trx_id: 'deadbeef',
		responses: []
	};
}

describe('cp514 (t.txt D) — optimistic feedback-given store', () => {
	it('round-trips a just-left feedback under the inbox key (peer\\u0000order)', () => {
		const subject = 'kentest2';
		const order = 'im-selling-200-mxn-of-blurt';
		expect(getOptimisticFeedbackGiven(subject, order)).toBeNull();
		noteFeedbackGiven(rec(subject, order, 5));
		const hit = getOptimisticFeedbackGiven(subject, order);
		expect(hit).not.toBeNull();
		// The inbox template renders `fb.record.rating` as the stars — the only
		// field it reads — so the rating MUST survive the round-trip.
		expect(hit?.rating).toBe(5);
	});

	it('bumps the tick so inbox deriveds re-run the moment feedback lands', () => {
		const before = get(optimisticFeedbackTick);
		noteFeedbackGiven(rec('kentest4', 'some-order', 4));
		expect(get(optimisticFeedbackTick)).toBeGreaterThan(before);
	});

	it('keys by (subject, order): a different order for the same peer is a miss', () => {
		noteFeedbackGiven(rec('kentest5', 'order-a', 3));
		expect(getOptimisticFeedbackGiven('kentest5', 'order-a')?.rating).toBe(3);
		expect(getOptimisticFeedbackGiven('kentest5', 'order-b')).toBeNull();
	});

	it('ignores a record with no subject or no order (nothing to key on)', () => {
		const before = get(optimisticFeedbackTick);
		noteFeedbackGiven(rec('', 'order-x', 5));
		noteFeedbackGiven({ ...rec('kentest6', '', 5), order_permlink: '' });
		// No writes happened, so the tick is unchanged.
		expect(get(optimisticFeedbackTick)).toBe(before);
	});
});
