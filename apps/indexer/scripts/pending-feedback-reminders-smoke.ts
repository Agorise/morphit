/**
 * Pending-feedback-reminder helper smoke.
 *
 * Verifies the pure helper that detects "your counterparty
 * reviewed you N hours ago, you haven't reciprocated yet".
 */

import {
	computePendingFeedbackReminders,
	elapsedHours,
	PENDING_FEEDBACK_REMINDER_MS
} from '../../web/src/lib/feedback/pendingReminders';
import type { FeedbackRecord } from '../../../packages/indexer-client/src/index';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function makeFeedback(o: Partial<FeedbackRecord>): FeedbackRecord {
	return {
		id: 1,
		reviewer: 'bob',
		subject: 'alice',
		rating: 5,
		comment: null,
		order_permlink: 'order-abc',
		created_at: '2026-04-25T00:00:00Z',
		source_trx_id: 'trx-1',
		responses: [],
		...o
	} as FeedbackRecord;
}

const NOW = Date.parse('2026-04-29T00:00:00Z'); // 4 days after default created_at

console.log('\n── Pending-feedback reminders ────────────────────────────\n');

scenario('empty inputs → empty list', () => {
	const r = computePendingFeedbackReminders({
		myAccount: 'alice',
		feedbackReceived: [],
		feedbackGiven: [],
		nowMs: NOW
	});
	if (r.length !== 0) throw new Error(`got ${r.length}`);
});

scenario('counterparty reviewed > 48h ago, user has not reciprocated → reminder', () => {
	const r = computePendingFeedbackReminders({
		myAccount: 'alice',
		feedbackReceived: [
			makeFeedback({
				reviewer: 'bob',
				subject: 'alice',
				order_permlink: 'order-abc',
				created_at: '2026-04-26T00:00:00Z' // 72h ago
			})
		],
		feedbackGiven: [],
		nowMs: NOW
	});
	if (r.length !== 1) throw new Error(`got ${r.length}`);
	if (r[0]!.orderPermlink !== 'order-abc') throw new Error(`permlink=${r[0]!.orderPermlink}`);
	if (r[0]!.counterpartyAccount !== 'bob')
		throw new Error(`counterparty=${r[0]!.counterpartyAccount}`);
	if (elapsedHours(r[0]!) !== 72) throw new Error(`hours=${elapsedHours(r[0]!)}`);
});

scenario('counterparty reviewed < 48h ago → no reminder', () => {
	const r = computePendingFeedbackReminders({
		myAccount: 'alice',
		feedbackReceived: [
			makeFeedback({
				reviewer: 'bob',
				subject: 'alice',
				order_permlink: 'order-abc',
				created_at: '2026-04-28T13:00:00Z' // 11h ago
			})
		],
		feedbackGiven: [],
		nowMs: NOW
	});
	if (r.length !== 0) throw new Error(`got ${r.length}`);
});

scenario('counterparty reviewed > 48h ago AND user reciprocated → no reminder', () => {
	const r = computePendingFeedbackReminders({
		myAccount: 'alice',
		feedbackReceived: [
			makeFeedback({
				reviewer: 'bob',
				subject: 'alice',
				order_permlink: 'order-abc',
				created_at: '2026-04-26T00:00:00Z'
			})
		],
		feedbackGiven: [
			makeFeedback({
				reviewer: 'alice',
				subject: 'bob',
				order_permlink: 'order-abc',
				created_at: '2026-04-27T00:00:00Z',
				source_trx_id: 'trx-2'
			})
		],
		nowMs: NOW
	});
	if (r.length !== 0) throw new Error(`got ${r.length}`);
});

scenario('feedback without order_permlink does not trigger reminder', () => {
	const r = computePendingFeedbackReminders({
		myAccount: 'alice',
		feedbackReceived: [
			makeFeedback({
				reviewer: 'bob',
				subject: 'alice',
				order_permlink: null,
				created_at: '2026-04-26T00:00:00Z'
			})
		],
		feedbackGiven: [],
		nowMs: NOW
	});
	if (r.length !== 0) throw new Error(`got ${r.length}`);
});

scenario('suppressed feedback does not trigger reminder', () => {
	const r = computePendingFeedbackReminders({
		myAccount: 'alice',
		feedbackReceived: [
			makeFeedback({
				reviewer: 'bob',
				subject: 'alice',
				order_permlink: 'order-abc',
				created_at: '2026-04-26T00:00:00Z',
				suppressed: true
			})
		],
		feedbackGiven: [],
		nowMs: NOW
	});
	if (r.length !== 0) throw new Error(`got ${r.length}`);
});

scenario('multiple pending reminders → sorted newest first', () => {
	const r = computePendingFeedbackReminders({
		myAccount: 'alice',
		feedbackReceived: [
			makeFeedback({
				reviewer: 'bob',
				subject: 'alice',
				order_permlink: 'order-001',
				created_at: '2026-04-25T00:00:00Z',
				source_trx_id: 'trx-old'
			}),
			makeFeedback({
				reviewer: 'carol',
				subject: 'alice',
				order_permlink: 'order-002',
				created_at: '2026-04-26T00:00:00Z',
				source_trx_id: 'trx-newer'
			})
		],
		feedbackGiven: [],
		nowMs: NOW
	});
	if (r.length !== 2) throw new Error(`got ${r.length}`);
	if (r[0]!.orderPermlink !== 'order-002') throw new Error('newest should be first');
	if (r[1]!.orderPermlink !== 'order-001') throw new Error('older should be second');
});

scenario('threshold override is respected', () => {
	const r = computePendingFeedbackReminders({
		myAccount: 'alice',
		feedbackReceived: [
			makeFeedback({
				reviewer: 'bob',
				subject: 'alice',
				order_permlink: 'order-abc',
				created_at: '2026-04-28T13:00:00Z' // 11h ago
			})
		],
		feedbackGiven: [],
		nowMs: NOW,
		thresholdMs: 6 * 60 * 60 * 1000 // 6h threshold
	});
	if (r.length !== 1) throw new Error(`got ${r.length}`);
});

scenario('feedback whose subject is not the user is filtered (defensive)', () => {
	const r = computePendingFeedbackReminders({
		myAccount: 'alice',
		feedbackReceived: [
			makeFeedback({
				reviewer: 'bob',
				subject: 'someone-else',
				order_permlink: 'order-abc',
				created_at: '2026-04-26T00:00:00Z'
			})
		],
		feedbackGiven: [],
		nowMs: NOW
	});
	if (r.length !== 0) throw new Error(`got ${r.length}`);
});

scenario('unparseable created_at is skipped, not crashes', () => {
	const r = computePendingFeedbackReminders({
		myAccount: 'alice',
		feedbackReceived: [
			makeFeedback({
				reviewer: 'bob',
				subject: 'alice',
				order_permlink: 'order-abc',
				created_at: 'not-a-date'
			})
		],
		feedbackGiven: [],
		nowMs: NOW
	});
	if (r.length !== 0) throw new Error(`got ${r.length}`);
});

scenario('threshold constant is exactly 48h in ms', () => {
	if (PENDING_FEEDBACK_REMINDER_MS !== 48 * 60 * 60 * 1000)
		throw new Error(String(PENDING_FEEDBACK_REMINDER_MS));
});

scenario('elapsedHours rounds correctly', () => {
	const reminder = {
		orderPermlink: 'x',
		counterpartyAccount: 'bob',
		counterpartyFeedbackTrxId: 't',
		counterpartyFeedbackAt: '2026-04-26T00:00:00Z',
		elapsedMs: 49.4 * 60 * 60 * 1000
	};
	if (elapsedHours(reminder) !== 49) throw new Error(String(elapsedHours(reminder)));
});

scenario('reciprocation matches by order_permlink, not by counterparty', () => {
	// Edge case: alice reviewed bob on a DIFFERENT order in the
	// past — that does NOT count as reciprocating bob's review on
	// THIS order.  The match must be order-permlink-keyed.
	const r = computePendingFeedbackReminders({
		myAccount: 'alice',
		feedbackReceived: [
			makeFeedback({
				reviewer: 'bob',
				subject: 'alice',
				order_permlink: 'order-this-trade',
				created_at: '2026-04-26T00:00:00Z'
			})
		],
		feedbackGiven: [
			makeFeedback({
				reviewer: 'alice',
				subject: 'bob',
				order_permlink: 'order-different-trade', // Different!
				created_at: '2026-04-20T00:00:00Z'
			})
		],
		nowMs: NOW
	});
	if (r.length !== 1) throw new Error(`got ${r.length}`);
	if (r[0]!.orderPermlink !== 'order-this-trade') throw new Error('mismatch');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
