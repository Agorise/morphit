/**
 * Part 111 — federation-scope gating tests.
 *
 * Verifies that each operator's indexer queues payouts ONLY for
 * ops attributed to their own MORPHIT_INSTANCE_OPERATOR_TAG.
 * Closes a pre-Part-111 federation-cost gap where every operator
 * queued every op's payouts on every relay in the federation —
 * multiplying treasury spend by the federation count.
 *
 * Three queue-insert paths are exercised:
 *
 *   1. Operator-payout (90% BLURT-paid listing fee).
 *      In `operatorEarnings.attributeBlurtFeeToOperator`.
 *
 *   2. Loyalty BP (first-fee welcome + cumulative milestones).
 *      In `loyalty.trackVerifiedBlurtFee`.
 *
 *   3. Welcome bonus (20 BLURT on first-feedback).
 *      In `feedback` handler.
 *
 * The fourth payout path (low-balance refill) is covered in
 * lowBalanceScanner.test.ts via the candidate-query shape
 * assertion.
 */

import { describe, expect, it } from 'vitest';
import handler from '$indexer/handlers/feedback';
import { attributeBlurtFeeToOperator } from '$indexer/operatorEarnings';
import { trackVerifiedBlurtFee } from '$indexer/loyalty';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

describe('Part 111 — operator-payout federation gate', () => {
	it('skips queue insert when op.operator_tag !== instanceOperatorTag', async () => {
		const mock = makeMockClient(); // no queries expected
		const result = await attributeBlurtFeeToOperator({
			client: mock.client,
			operatorTagRaw: 'example-community',
			orderAccount: 'alice',
			orderPermlink: 'sell-btc-eur-2026-04',
			feeBlurt: 60,
			trxId: '0000000000000000000000000000000000000000',
			blockNum: 12_345,
			blockTime: new Date('2026-05-10T12:00:00Z'),
			instanceOperatorTag: 'morphit' // our tag, different from op's
		});
		expect(result.kind).toBe('attributed_other_instance');
		if (result.kind === 'attributed_other_instance') {
			expect(result.opTag).toBe('example-community');
			expect(result.instanceTag).toBe('morphit');
		}
		// Crucially — NO queries fired.  The op was for a different
		// instance; we recorded nothing.
		expect(mock.queries).toHaveLength(0);
	});

	it('skips queue insert when instanceOperatorTag is undefined (unregistered)', async () => {
		const mock = makeMockClient();
		const result = await attributeBlurtFeeToOperator({
			client: mock.client,
			operatorTagRaw: 'morphit',
			orderAccount: 'alice',
			orderPermlink: 'sell-btc-eur-2026-04',
			feeBlurt: 60,
			trxId: '0000000000000000000000000000000000000000',
			blockNum: 12_345,
			blockTime: new Date('2026-05-10T12:00:00Z'),
			instanceOperatorTag: undefined
		});
		expect(result.kind).toBe('attributed_other_instance');
		expect(mock.queries).toHaveLength(0);
	});

	it('proceeds to operator lookup when tags match (then exercises existing path)', async () => {
		// When tags match, we hit the DB to look up the operator
		// account.  Use a no-match operator to short-circuit cleanly
		// without needing the full attribution-event INSERT path
		// mocked.
		const mock = makeMockClient([
			{
				match: 'SELECT account FROM operators',
				rows: [],
				rowCount: 0
			}
		]);
		const result = await attributeBlurtFeeToOperator({
			client: mock.client,
			operatorTagRaw: 'morphit',
			orderAccount: 'alice',
			orderPermlink: 'sell-btc-eur-2026-04',
			feeBlurt: 60,
			trxId: '0000000000000000000000000000000000000000',
			blockNum: 12_345,
			blockTime: new Date('2026-05-10T12:00:00Z'),
			instanceOperatorTag: 'morphit'
		});
		expect(result.kind).toBe('tag_unknown');
		// The lookup SELECT fired — proving we passed the gate.
		expect(mock.queries).toHaveLength(1);
		expect(mock.queries[0]!.text).toContain('SELECT account FROM operators');
	});

	it('treats missing tag the same as before Part 111 (no_tag)', async () => {
		const mock = makeMockClient();
		const result = await attributeBlurtFeeToOperator({
			client: mock.client,
			operatorTagRaw: undefined,
			orderAccount: 'alice',
			orderPermlink: 'sell-btc-eur-2026-04',
			feeBlurt: 60,
			trxId: '0000000000000000000000000000000000000000',
			blockNum: 12_345,
			blockTime: new Date('2026-05-10T12:00:00Z'),
			instanceOperatorTag: 'morphit'
		});
		expect(result.kind).toBe('no_tag');
		// Missing tag aborts BEFORE the federation gate — same as
		// pre-Part-111 behavior.  No DB writes.
		expect(mock.queries).toHaveLength(0);
	});
});

describe('Part 111 — loyalty BP federation gate', () => {
	it('skips first-fee welcome queue when op.operator_tag !== instanceOperatorTag', async () => {
		const mock = makeMockClient([
			{
				match: 'INSERT INTO account_loyalty',
				rows: [{ previous_total: '0', new_total: '75' }],
				rowCount: 1
			},
			{ match: 'SAVEPOINT first_fee_welcome_sp' },
			{ match: 'INSERT INTO account_loyalty_milestones' },
			{ match: 'RELEASE SAVEPOINT first_fee_welcome_sp' }
			// CRUCIALLY: no INSERT INTO relay_pending_transfers
		]);
		await trackVerifiedBlurtFee(
			mock.client,
			'alice',
			75,
			12_345,
			new Date('2026-05-10T12:00:00Z'),
			'example-community', // op attributed to another operator
			'morphit' // we are morphit
		);
		const rptInsert = mock.queries.find((q) =>
			q.text.includes('INSERT INTO relay_pending_transfers')
		);
		expect(rptInsert).toBeUndefined();
	});

	it('queues first-fee welcome when tags match', async () => {
		const mock = makeMockClient([
			{
				match: 'INSERT INTO account_loyalty',
				rows: [{ previous_total: '0', new_total: '75' }],
				rowCount: 1
			},
			{ match: 'SAVEPOINT first_fee_welcome_sp' },
			{ match: 'INSERT INTO account_loyalty_milestones' },
			{ match: 'RELEASE SAVEPOINT first_fee_welcome_sp' },
			{ match: 'SELECT COALESCE(SUM(bp_rewarded)', rows: [{ cumulative_bp: '1' }] },
			{ match: 'INSERT INTO relay_pending_transfers' }
		]);
		await trackVerifiedBlurtFee(
			mock.client,
			'alice',
			75,
			12_345,
			new Date('2026-05-10T12:00:00Z'),
			'morphit',
			'morphit'
		);
		const rptInsert = mock.queries.find((q) =>
			q.text.includes('INSERT INTO relay_pending_transfers')
		);
		expect(rptInsert).toBeDefined();
		expect(rptInsert!.params[0]).toBe('alice');
		expect(rptInsert!.params[1]).toBe(1); // 1 BP welcome
		expect(rptInsert!.params[2]).toBe('first_listing_fee_welcome');
	});

	it('keeps global loyalty state consistent even when not queueing (federation pays)', async () => {
		// The KEY property: even though we skip the queue insert,
		// the account_loyalty UPSERT and account_loyalty_milestones
		// INSERT still happen.  This ensures all federated indexers
		// share the same view of "who has earned what" — only the
		// payout-obligation side is per-operator.
		const mock = makeMockClient([
			{
				match: 'INSERT INTO account_loyalty',
				rows: [{ previous_total: '0', new_total: '75' }],
				rowCount: 1
			},
			{ match: 'SAVEPOINT first_fee_welcome_sp' },
			{ match: 'INSERT INTO account_loyalty_milestones' },
			{ match: 'RELEASE SAVEPOINT first_fee_welcome_sp' }
		]);
		await trackVerifiedBlurtFee(
			mock.client,
			'alice',
			75,
			12_345,
			new Date('2026-05-10T12:00:00Z'),
			'example-community',
			'morphit'
		);
		// Global state was updated.
		expect(
			mock.queries.find((q) => q.text.includes('INSERT INTO account_loyalty'))
		).toBeDefined();
		expect(
			mock.queries.find((q) => q.text.includes('INSERT INTO account_loyalty_milestones'))
		).toBeDefined();
	});
});

describe('Part 111 — welcome bonus federation gate (feedback handler)', () => {
	function feedbackMock(
		opts: { citedOrderOperatorTag: string | null; accountsRowCount: 1 | 0 } = {
			citedOrderOperatorTag: 'morphit',
			accountsRowCount: 1
		}
	) {
		return makeMockClient([
			// Order-ownership gate (different SELECT than the
			// cited-order operator-tag lookup; both query FROM
			// orders).
			{ match: 'FROM orders', rowCount: 1 },
			// Trade-completion gate via chat-messages. cp421: the
			// feedback handler now requires a verified counterparty
			// conversation (≥2 msgs each way, ≥15min span, unflagged)
			// before it will record feedback — so this fixture must
			// clear that bar for the welcome-bonus path underneath to
			// run at all.
			{
				match: 'FROM chat_messages',
				rows: [{ from_a: '2', from_b: '2', span_seconds: '900', has_recip_flag: false }]
			},
			// Feedback row insert.
			{ match: 'INSERT INTO feedback' },
			// Welcome-bonus savepoint.
			{ match: 'SAVEPOINT welcome_bonus_sp' },
			// Part 111 cited-order operator_tag lookup.
			{
				match: 'FROM orders\n\t\t\t  WHERE account',
				rows: [{ operator_tag: opts.citedOrderOperatorTag }],
				rowCount: 1
			},
			// First-trade upsert.
			{ match: 'INSERT INTO accounts', rowCount: opts.accountsRowCount },
			// Only present if we expect the queue insert to fire.
			...(opts.citedOrderOperatorTag === 'morphit' && opts.accountsRowCount === 1
				? [{ match: 'INSERT INTO relay_pending_transfers' }]
				: []),
			{ match: 'RELEASE SAVEPOINT welcome_bonus_sp' }
		]);
	}

	it('skips welcome bonus queue when cited order belongs to a different operator', async () => {
		const mock = feedbackMock({
			citedOrderOperatorTag: 'example-community',
			accountsRowCount: 1
		});
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
		const rptInsert = mock.queries.find((q) =>
			q.text.includes('INSERT INTO relay_pending_transfers')
		);
		expect(rptInsert).toBeUndefined();
	});

	it('skips welcome bonus queue when cited order has no operator_tag (null)', async () => {
		const mock = feedbackMock({
			citedOrderOperatorTag: null,
			accountsRowCount: 1
		});
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
		expect(
			mock.queries.find((q) => q.text.includes('INSERT INTO relay_pending_transfers'))
		).toBeUndefined();
	});

	it('queues welcome bonus when cited order matches our instance', async () => {
		const mock = feedbackMock({
			citedOrderOperatorTag: 'morphit',
			accountsRowCount: 1
		});
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
		const rptInsert = mock.queries.find((q) =>
			q.text.includes('INSERT INTO relay_pending_transfers')
		);
		expect(rptInsert).toBeDefined();
		expect(rptInsert!.params[0]).toBe('grandma');
	});

	it('still records first_trade_complete_at on non-our-instance feedback (global state)', async () => {
		// Even though we skip the bonus, the accounts row should
		// flip — every federated indexer agrees on "this user has
		// done their first trade."
		const mock = feedbackMock({
			citedOrderOperatorTag: 'example-community',
			accountsRowCount: 1
		});
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
		const accountsInsert = mock.queries.find((q) =>
			q.text.includes('INSERT INTO accounts')
		);
		expect(accountsInsert).toBeDefined();
	});
});
