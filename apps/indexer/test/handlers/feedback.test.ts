import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/feedback';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

describe('feedback handler', () => {
	it('inserts a valid feedback record', async () => {
		const mock = makeMockClient([
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '2', from_subject: '2', span_seconds: '900', has_recip_flag: false }]
			},
			{ match: 'INSERT INTO feedback' }
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { subject: 'bob', rating: 5, comment: 'Smooth trade' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('rejects self-review', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { subject: 'alice', rating: 5 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'self_review' });
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects rating out of 1..5', async () => {
		const mock = makeMockClient();
		for (const bad of [0, 6, -1, 2.5]) {
			const r = await handler(
				makeCtx({
					signer: 'alice',
					payload: { subject: 'bob', rating: bad }
				}),
				mock.client
			);
			expect(r).toEqual({ ok: false, reason: 'rating_out_of_range' });
		}
	});

	it('rejects non-integer rating', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { subject: 'bob', rating: 3.7 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'rating_out_of_range' });
	});

	it('rejects invalid subject account name', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { subject: 'X', rating: 4 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'subject_invalid' });
	});

	it('translates pg unique-violation (23505) into duplicate_feedback', async () => {
		const pgErr = Object.assign(new Error('duplicate key'), { code: '23505' });
		const mock = makeMockClient([
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '2', from_subject: '2', span_seconds: '900', has_recip_flag: false }]
			},
			{ match: 'INSERT INTO feedback', throwError: pgErr }
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { subject: 'bob', rating: 5 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'duplicate_feedback' });
	});

	it('propagates non-unique-violation errors (poller will roll block back)', async () => {
		const pgErr = Object.assign(new Error('connection lost'), {
			code: '08006'
		});
		const mock = makeMockClient([
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '2', from_subject: '2', span_seconds: '900', has_recip_flag: false }]
			},
			{ match: 'INSERT INTO feedback', throwError: pgErr }
		]);
		await expect(
			handler(
				makeCtx({
					signer: 'alice',
					payload: { subject: 'bob', rating: 5 }
				}),
				mock.client
			)
		).rejects.toThrow('connection lost');
	});

	it('rejects oversized comment', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: {
					subject: 'bob',
					rating: 5,
					comment: 'x'.repeat(2049)
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'comment_too_long' });
	});
});

describe('feedback handler — delayed welcome bonus (ADR-0011)', () => {
	it('queues 10+10 welcome bonus when subject is a brand-new trader', async () => {
		// Mock sequence (post-§8 refactor): conformance SELECT →
		// feedback INSERT → SAVEPOINT → INSERT INTO accounts
		// ON CONFLICT DO UPDATE (rowCount=1 means the subject's
		// first_trade_complete_at just flipped) → INSERT into
		// relay_pending_transfers → RELEASE SAVEPOINT.  The
		// welcome bonus only fires when the feedback cites an
		// order_permlink (anti-Sybil gate).
		const mock = makeMockClient([
			{ match: 'FROM orders', rowCount: 1 },
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '2', from_subject: '2', span_seconds: '900', has_recip_flag: false }]
			},
			{ match: 'INSERT INTO feedback' },
			{ match: 'SAVEPOINT' },
			{
				match: 'FROM orders\n\t\t\t  WHERE account',
				rows: [{ operator_tag: 'morphit' }],
				rowCount: 1
			},
			{ match: 'INSERT INTO accounts', rowCount: 1 },
			{ match: 'INSERT INTO relay_pending_transfers' },
			{ match: 'RELEASE SAVEPOINT' }
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: {
					subject: 'grandma',
					rating: 5,
					order_permlink: 'sell-btc-eur-2026-04'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		// Verify the INSERT into relay_pending_transfers carries the
		// right subject and timestamp parameters.
		const rptInsert = mock.queries.find((q) =>
			q.text.includes('INSERT INTO relay_pending_transfers')
		);
		expect(rptInsert).toBeDefined();
		expect(rptInsert!.params[0]).toBe('grandma');
	});

	it('does NOT queue bonus when ON CONFLICT DO UPDATE returns rowCount=0 (subject not new)', async () => {
		// rowCount=0 means an existing accounts row already had a
		// non-NULL first_trade_complete_at, so the upsert's WHERE
		// clause didn't match.  Result: no welcome bonus fires.
		const mock = makeMockClient([
			{ match: 'FROM orders', rowCount: 1 },
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '2', from_subject: '2', span_seconds: '900', has_recip_flag: false }]
			},
			{ match: 'INSERT INTO feedback' },
			{ match: 'SAVEPOINT' },
			{
				match: 'FROM orders\n\t\t\t  WHERE account',
				rows: [{ operator_tag: 'morphit' }],
				rowCount: 1
			},
			{ match: 'INSERT INTO accounts', rowCount: 0 },
			{ match: 'RELEASE SAVEPOINT' }
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: {
					subject: 'established',
					rating: 5,
					order_permlink: 'sell-btc-eur-2026-04'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		// No relay_pending_transfers insert should have fired.
		const rptInsert = mock.queries.find((q) =>
			q.text.includes('INSERT INTO relay_pending_transfers')
		);
		expect(rptInsert).toBeUndefined();
	});

	it('welcome bonus failure is isolated — feedback still succeeds', async () => {
		// The accounts upsert throws. Our savepoint-rollback path
		// handles it.  Feedback INSERT succeeded before the savepoint
		// opened, so the overall op is still ok:true.
		const mock = makeMockClient([
			{ match: 'FROM orders', rowCount: 1 },
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '2', from_subject: '2', span_seconds: '900', has_recip_flag: false }]
			},
			{ match: 'INSERT INTO feedback' },
			{ match: 'SAVEPOINT' },
			{
				match: 'FROM orders\n\t\t\t  WHERE account',
				rows: [{ operator_tag: 'morphit' }],
				rowCount: 1
			},
			{
				match: 'INSERT INTO accounts',
				throwError: new Error('simulated db hiccup')
			},
			{ match: 'ROLLBACK TO SAVEPOINT' }
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: {
					subject: 'grandma',
					rating: 5,
					order_permlink: 'sell-btc-eur-2026-04'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		// The rollback must have fired to keep the outer transaction
		// from being poisoned.
		const rollback = mock.queries.find((q) => q.text.includes('ROLLBACK TO SAVEPOINT'));
		expect(rollback).toBeDefined();
	});

	it('writes both welcome bonus rows in a single INSERT statement', async () => {
		// Batching to minimise client round-trips. Check the SQL
		// contains both VALUES clauses.
		const mock = makeMockClient([
			{ match: 'FROM orders', rowCount: 1 },
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '2', from_subject: '2', span_seconds: '900', has_recip_flag: false }]
			},
			{ match: 'INSERT INTO feedback' },
			{ match: 'SAVEPOINT' },
			{
				match: 'FROM orders\n\t\t\t  WHERE account',
				rows: [{ operator_tag: 'morphit' }],
				rowCount: 1
			},
			{ match: 'INSERT INTO accounts', rowCount: 1 },
			{ match: 'INSERT INTO relay_pending_transfers' },
			{ match: 'RELEASE SAVEPOINT' }
		]);
		await handler(
			makeCtx({
				signer: 'alice',
				payload: {
					subject: 'grandma',
					rating: 5,
					order_permlink: 'sell-btc-eur-2026-04'
				}
			}),
			mock.client
		);
		const rptInsert = mock.queries.find((q) =>
			q.text.includes('INSERT INTO relay_pending_transfers')
		)!;
		// Both rows + kind labels should be visible in the SQL text.
		expect(rptInsert.text).toContain('welcome_bonus_liquid');
		expect(rptInsert.text).toContain('welcome_bonus_vesting');
	});
});

describe('feedback handler — provable-counterparty gate (cp420)', () => {
	it('rejects a ghost review: no chat with the subject', async () => {
		// from_reviewer/from_subject both 0 = the reviewer never had a
		// conversation with the subject. Pre-cp420 this inserted (chat
		// was only a badge); now it is a hard gate.
		const mock = makeMockClient([
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '0', from_subject: '0', span_seconds: null, has_recip_flag: false }]
			}
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { subject: 'bob', rating: 5 } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'no_verified_counterparty' });
		// The INSERT must never have run.
		expect(mock.queries.some((q) => q.text.includes('INSERT INTO feedback'))).toBe(false);
	});

	it('rejects a one-way review: subject never replied', async () => {
		// Reviewer sent 3 messages, subject sent 0 — a one-way blast, not
		// a two-way trade conversation. No inbound reply ⇒ no review.
		const mock = makeMockClient([
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '3', from_subject: '0', span_seconds: '600', has_recip_flag: false }]
			}
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { subject: 'bob', rating: 5 } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'no_verified_counterparty' });
	});

	it('rejects a review from a flagged suspicious-reciprocity pair', async () => {
		// Bidirectional chat exists, but the sockpuppet detector already
		// flagged this pair — blocked from reviewing each other.
		const mock = makeMockClient([
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '5', from_subject: '5', span_seconds: '9000', has_recip_flag: true }]
			}
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { subject: 'bob', rating: 5 } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'no_verified_counterparty' });
	});

	it('rejects a two-way chat below the verified-chat bar (1 each way, no 15-min span)', async () => {
		// 1 message each way, no 15-min span — a real but ultra-fast
		// exchange. Ken chose the STRICT gate (cp421): this is below the
		// ≥2-each-way + ≥15-min bar, so it is rejected. (Under the older
		// looser bidirectional-only gate this would have been accepted.)
		const mock = makeMockClient([
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '1', from_subject: '1', span_seconds: null, has_recip_flag: false }]
			}
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { subject: 'bob', rating: 5 } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'no_verified_counterparty' });
		expect(mock.queries.some((q) => q.text.includes('INSERT INTO feedback'))).toBe(false);
	});

	it('rejects a two-way chat with enough messages but under the 15-min span', async () => {
		// ≥2 each way but only a 5-minute span — fails the sustained-
		// conversation requirement of the strict gate.
		const mock = makeMockClient([
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '4', from_subject: '4', span_seconds: '300', has_recip_flag: false }]
			}
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { subject: 'bob', rating: 5 } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'no_verified_counterparty' });
	});

	it('accepts a substantiated conversation (≥2 each way, ≥15-min span, unflagged)', async () => {
		// The strict gate's accept case: 2 each way + a 900s (15-min)
		// span + no reciprocity flag = a real, verifiable trade convo.
		const mock = makeMockClient([
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '2', from_subject: '2', span_seconds: '900', has_recip_flag: false }]
			},
			{ match: 'INSERT INTO feedback' }
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { subject: 'bob', rating: 5 } }),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('order citation accepts an order posted by the REVIEWER (maker reviewing taker on /my/orders)', async () => {
		// The direction /my/orders uses: the maker (signer=alice, who
		// posted the order) reviews the taker (bob), citing the maker's
		// OWN order. Pre-cp420 the ownership check was `account = subject`
		// and rejected this (account=alice≠bob). Now it is
		// `account IN (subject, reviewer)`.
		const mock = makeMockClient([
			{ match: 'FROM orders', rowCount: 1 },
			{
				match: 'FROM chat_messages',
				rows: [{ from_reviewer: '2', from_subject: '2', span_seconds: '900', has_recip_flag: false }]
			},
			{ match: 'INSERT INTO feedback' },
			{ match: 'SAVEPOINT' },
			{
				match: 'FROM orders\n\t\t\t  WHERE account',
				rows: [{ operator_tag: 'morphit' }],
				rowCount: 1
			},
			{ match: 'INSERT INTO accounts', rowCount: 0 },
			{ match: 'RELEASE SAVEPOINT' }
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { subject: 'bob', rating: 5, order_permlink: 'buy-btc-usd-2026-07' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		// The ownership check must consult BOTH parties (account IN) and
		// pass the reviewer (signer) as a bound param — not just subject.
		const ownership = mock.queries.find(
			(q) => q.text.includes('FROM orders') && q.text.includes('account IN')
		);
		expect(ownership).toBeDefined();
		expect(ownership!.params).toContain('alice'); // reviewer/signer
		expect(ownership!.params).toContain('bob'); // subject
	});
});
