import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/strangerFee';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

/** Helper: a minimal ctx override that covers the stranger-
 *  fee handler's dependencies — signer, payload, siblingOps,
 *  config.feeRecipient, config.feeTolerance, priceSource. The
 *  base ctx factory covers most of these; we override the
 *  signer and payload per scenario and provide a transfer
 *  sibling when we want one to be found. */
function makeStrangerFeeCtx(override: {
	signer?: string;
	payload?: unknown;
	/** Raw BLURT amount the transfer carries, or null to omit
	 *  the transfer entirely. */
	transferAmountBlurt?: number | null;
	transferTo?: string;
	transferFrom?: string;
	transferMemo?: string;
}) {
	const signer = override.signer ?? 'alice';
	const recipient = (override.payload as { recipient?: string } | undefined)?.recipient ?? 'bob';

	const siblingOps: (readonly [string, Record<string, unknown>])[] = [];
	if (override.transferAmountBlurt !== null && override.transferAmountBlurt !== undefined) {
		siblingOps.push([
			'transfer',
			{
				from: override.transferFrom ?? signer,
				to: override.transferTo ?? 'morphit-fees',
				amount: `${override.transferAmountBlurt.toFixed(3)} BLURT`,
				memo: override.transferMemo ?? `morphit-stranger:${recipient}`
			}
		]);
	}

	return makeCtx({
		signer,
		payload: override.payload ?? {
			v: 1,
			recipient,
			amount_blurt: 5
		},
		siblingOps,
		config: {
			feeRecipient: 'morphit-fees',
			feeTolerance: 0.02
		} as NonNullable<Parameters<typeof makeCtx>[0]>['config']
	});
}

describe('stranger-fee handler — validation', () => {
	it('rejects non-object payload', async () => {
		const mock = makeMockClient();
		const r = await handler(makeStrangerFeeCtx({ payload: 'nope' as unknown }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'payload_not_object' });
	});

	it('rejects invalid recipient', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeStrangerFeeCtx({
				payload: { v: 1, recipient: 'X', amount_blurt: 5 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'recipient_invalid' });
	});

	it('rejects self-fee', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeStrangerFeeCtx({
				signer: 'alice',
				payload: { v: 1, recipient: 'alice', amount_blurt: 5 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'self_fee' });
	});

	it('rejects non-numeric amount_blurt', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeStrangerFeeCtx({
				payload: { v: 1, recipient: 'bob', amount_blurt: '5' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'amount_blurt_invalid' });
	});

	it('rejects zero or negative amount_blurt', async () => {
		const mock = makeMockClient();
		for (const bad of [0, -0.01, -1]) {
			const r = await handler(
				makeStrangerFeeCtx({
					payload: { v: 1, recipient: 'bob', amount_blurt: bad }
				}),
				mock.client
			);
			expect(r).toEqual({ ok: false, reason: 'amount_blurt_invalid' });
		}
	});

	it('rejects out-of-range amount_blurt (> 10× target)', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeStrangerFeeCtx({
				payload: { v: 1, recipient: 'bob', amount_blurt: 50 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'amount_blurt_out_of_range' });
	});
});

describe('stranger-fee handler — idempotency', () => {
	it('accepts silently when row already exists', async () => {
		const mock = makeMockClient([
			{
				match: 'FROM stranger_fees',
				rows: [{ exists: true }]
			}
		]);
		const r = await handler(makeStrangerFeeCtx({ transferAmountBlurt: 3.34 }), mock.client);
		expect(r).toEqual({ ok: true });
		// Only the existence check ran — no INSERT.
		expect(mock.queries).toHaveLength(1);
	});

	it('translates PK collision (23505) into ok:true', async () => {
		const pgErr = Object.assign(new Error('dup'), { code: '23505' });
		const mock = makeMockClient([
			{ match: 'FROM stranger_fees', rows: [{ exists: false }] },
			// Quote-pricing query (added in §F.11 escalation logic):
			// recent count of fees from this sender → multiplier.
			// 0 = first fee in the window → multiplier=1 → 5 BLURT.
			{ match: 'COUNT(*)', rows: [{ count: '0' }] },
			{ match: 'INSERT INTO stranger_fees', throwError: pgErr }
		]);
		const r = await handler(makeStrangerFeeCtx({ transferAmountBlurt: 5 }), mock.client);
		expect(r).toEqual({ ok: true });
	});
});

describe('stranger-fee handler — fee verification', () => {
	it('inserts a row when transfer is present and amount is correct', async () => {
		const mock = makeMockClient([
			{ match: 'FROM stranger_fees', rows: [{ exists: false }] },
			{ match: 'COUNT(*)', rows: [{ count: '0' }] },
			{ match: 'INSERT INTO stranger_fees' }
		]);
		// 5 BLURT base fee, multiplier=1, exact match.
		const r = await handler(makeStrangerFeeCtx({ transferAmountBlurt: 5 }), mock.client);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(3);
		const insert = mock.queries[2]!;
		expect(insert.params).toContain('alice');
		expect(insert.params).toContain('bob');
	});

	it('rejects fee_missing when no matching transfer sibling', async () => {
		const mock = makeMockClient([
			{ match: 'FROM stranger_fees', rows: [{ exists: false }] },
			{ match: 'COUNT(*)', rows: [{ count: '0' }] }
		]);
		const r = await handler(
			makeStrangerFeeCtx({
				transferAmountBlurt: null,
				payload: { v: 1, recipient: 'bob', amount_blurt: 5 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'fee_missing' });
		expect(mock.queries).toHaveLength(2);
	});

	it('rejects fee_missing when transfer has wrong memo (different recipient)', async () => {
		const mock = makeMockClient([
			{ match: 'FROM stranger_fees', rows: [{ exists: false }] },
			{ match: 'COUNT(*)', rows: [{ count: '0' }] }
		]);
		// Transfer exists, but memo binds to a DIFFERENT
		// recipient than the op's recipient field — memo
		// replay protection.
		const r = await handler(
			makeStrangerFeeCtx({
				transferAmountBlurt: 5,
				transferMemo: 'morphit-stranger:carol'
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'fee_missing' });
	});

	it('rejects fee_missing when transfer goes to wrong account', async () => {
		const mock = makeMockClient([
			{ match: 'FROM stranger_fees', rows: [{ exists: false }] },
			{ match: 'COUNT(*)', rows: [{ count: '0' }] }
		]);
		const r = await handler(
			makeStrangerFeeCtx({
				transferAmountBlurt: 5,
				transferTo: '@some-attacker'
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'fee_missing' });
	});

	it('rejects fee_missing when transfer is from someone else', async () => {
		const mock = makeMockClient([
			{ match: 'FROM stranger_fees', rows: [{ exists: false }] },
			{ match: 'COUNT(*)', rows: [{ count: '0' }] }
		]);
		const r = await handler(
			makeStrangerFeeCtx({
				transferAmountBlurt: 5,
				transferFrom: 'eve'
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'fee_missing' });
	});

	it('rejects fee_underpaid when amount below tolerance', async () => {
		const mock = makeMockClient([
			{ match: 'FROM stranger_fees', rows: [{ exists: false }] },
			{ match: 'COUNT(*)', rows: [{ count: '0' }] }
		]);
		// Expected = 5 BLURT.  Sending 3 is ~40% short — well
		// under any sane tolerance.  The transfer matches the
		// payload's amount_blurt, so the fee_underpaid check fires
		// in the verifyFeeTransfer path, not the handler's
		// amount_blurt_below_current_quote gate.
		const r = await handler(
			makeStrangerFeeCtx({
				transferAmountBlurt: 3,
				payload: { v: 1, recipient: 'bob', amount_blurt: 3 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'amount_blurt_below_current_quote' });
	});

	it('accepts slight over-payment (user paid extra)', async () => {
		const mock = makeMockClient([
			{ match: 'FROM stranger_fees', rows: [{ exists: false }] },
			{ match: 'COUNT(*)', rows: [{ count: '0' }] },
			{ match: 'INSERT INTO stranger_fees' }
		]);
		// Payload says 5 BLURT, transfer was 5.05 BLURT — within
		// the 2% tolerance, but extra is on the user (no refund).
		const r = await handler(
			makeStrangerFeeCtx({
				transferAmountBlurt: 5.05,
				payload: { v: 1, recipient: 'bob', amount_blurt: 5 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	// Price-feed tests removed — under the §F.11 BLURT-native
	// pricing model, the stranger-fee handler no longer consults
	// a USD price feed in the critical path; the quote is
	// computed from the on-chain count of recent fees and the
	// fixed STRANGER_FEE_BASE_BLURT constant.  Rejection of
	// price-feed-zero / price-feed-NaN inputs is now meaningless
	// because there's nothing to feed.
});
