/**
 * Tests for morphit_fee_attest_v1 handler.
 *
 * Uses the shared mockClient with per-query expectations, so
 * I can assert the exact SQL pattern each branch emits.
 */

import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/feeAttest';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

describe('feeAttest handler — payload validation', () => {
	it('rejects non-object payload', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ payload: 'not-an-object' }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'payload_not_object' });
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects non-string order_account', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { order_account: 123, order_permlink: 'ok' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'order_account_not_string' });
	});

	it('rejects invalid order_account format', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					order_account: 'UPPERCASE',
					order_permlink: 'ok'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'order_account_invalid' });
	});

	it('rejects non-string order_permlink', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { order_account: 'bob', order_permlink: 42 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'order_permlink_not_string' });
	});

	it('rejects invalid order_permlink format', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { order_account: 'bob', order_permlink: 'BAD-CAPS' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'order_permlink_invalid' });
	});

	it('rejects over-long permlink', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					order_account: 'bob',
					order_permlink: 'a'.repeat(33)
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'order_permlink_too_long' });
	});
});

describe('feeAttest handler — order lookup', () => {
	it('rejects when the referenced order does not exist', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [],
				rowCount: 0
			}
		]);
		const r = await handler(
			makeCtx({
				signer: 'charlie',
				payload: { order_account: 'bob', order_permlink: 'order-1' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'order_not_found' });
	});
});

describe('feeAttest handler — insertion + promotion', () => {
	it('inserts an attestation; first attestation alone does NOT promote', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [{ fee_status: 'pending_external', account: 'bob' }],
				rowCount: 1
			},
			{
				match: 'created_block_time',
				rows: [
					{
						created_block_time: new Date('2026-01-01T00:00:00Z'),
						cumulative_blurt_paid: '500'
					}
				]
			},
			{ match: 'INSERT INTO fee_attestations', rowCount: 1 },
			{
				match: 'SELECT DISTINCT fa.attestor',
				// The non-poster, non-related attestors; each is then checked for the
				// reciprocity pattern with the poster (none here).
				rows: [{ attestor: 'att0', as_of: new Date('2026-04-19T12:00:00Z') }]
			},
			{ match: 'WITH moments AS', rows: [{ held: false }] }
		]);
		const r = await handler(
			makeCtx({
				signer: 'charlie',
				payload: { order_account: 'bob', order_permlink: 'order-1' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		// Order lookup, eligibility, INSERT, attestors, one reciprocity check.
		// No UPDATE.
		expect(mock.queries).toHaveLength(5);
		expect(mock.queries[3]!.text).toContain('SELECT DISTINCT fa.attestor');
	});

	// The poster can never attest their own order: the
	// op is rejected before eligibility or any INSERT (it used to be recorded
	// and count as one of the two required attestors).
	it('self-attestation is rejected outright (attestor_is_poster)', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [{ fee_status: 'pending_external', account: 'bob' }],
				rowCount: 1
			}
		]);
		const r = await handler(
			makeCtx({
				signer: 'bob', // same as order_account
				payload: { order_account: 'bob', order_permlink: 'order-1' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'attestor_is_poster' });
		expect(mock.queries).toHaveLength(1);
		expect(mock.queries.some((q) => q.text.includes('INSERT INTO fee_attestations'))).toBe(false);
	});

	it('promotes when ≥2 independent (non-poster, unflagged) attestors', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [{ fee_status: 'pending_external', account: 'bob' }],
				rowCount: 1
			},
			{
				match: 'created_block_time',
				rows: [
					{
						created_block_time: new Date('2026-01-01T00:00:00Z'),
						cumulative_blurt_paid: '500'
					}
				]
			},
			{ match: 'INSERT INTO fee_attestations', rowCount: 1 },
			{
				match: 'SELECT DISTINCT fa.attestor',
				// The non-poster, non-related attestors; each is then checked for the
				// reciprocity pattern with the poster (none here).
				rows: [
					{ attestor: 'att0', as_of: new Date('2026-04-19T12:00:00Z') },
					{ attestor: 'att1', as_of: new Date('2026-04-19T12:00:00Z') }
				]
			},
			{ match: 'WITH moments AS', rows: [{ held: false }] },
			{ match: 'WITH moments AS', rows: [{ held: false }] },
			{ match: 'UPDATE orders', rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({
				signer: 'charlie',
				payload: { order_account: 'bob', order_permlink: 'order-1' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(7);
		// The UPDATE should scope to pending_external to avoid
		// accidentally overwriting other states.  Index 6: order
		// SELECT (0), eligibility (1), attestation INSERT (2),
		// attestors (3), two reciprocity checks (4, 5), UPDATE (6).
		const update = mock.queries[6]!;
		expect(update.text).toContain('verified_by_attestation');
		expect(update.text).toContain('pending_external');
	});

	it('two distinct attestors but both non-posters → also promotes', async () => {
		// Two unrelated parties both attest without the poster — the
		// only shape that can promote since.
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [{ fee_status: 'pending_external', account: 'bob' }],
				rowCount: 1
			},
			{
				match: 'created_block_time',
				rows: [
					{
						created_block_time: new Date('2026-01-01T00:00:00Z'),
						cumulative_blurt_paid: '500'
					}
				]
			},
			{ match: 'INSERT INTO fee_attestations', rowCount: 1 },
			{
				match: 'SELECT DISTINCT fa.attestor',
				// The non-poster, non-related attestors; each is then checked for the
				// reciprocity pattern with the poster (none here).
				rows: [
					{ attestor: 'att0', as_of: new Date('2026-04-19T12:00:00Z') },
					{ attestor: 'att1', as_of: new Date('2026-04-19T12:00:00Z') }
				]
			},
			{ match: 'WITH moments AS', rows: [{ held: false }] },
			{ match: 'WITH moments AS', rows: [{ held: false }] },
			{ match: 'UPDATE orders', rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({
				signer: 'charlie',
				payload: { order_account: 'bob', order_permlink: 'order-1' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		// ... attestors (3), two reciprocity checks (4, 5), UPDATE (6).
		expect(mock.queries).toHaveLength(7);
	});

	it('does NOT promote when order is already verified', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [{ fee_status: 'verified', account: 'bob' }],
				rowCount: 1
			},
			{
				match: 'created_block_time',
				rows: [
					{
						created_block_time: new Date('2026-01-01T00:00:00Z'),
						cumulative_blurt_paid: '500'
					}
				]
			},
			{ match: 'INSERT INTO fee_attestations', rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({
				signer: 'charlie',
				payload: { order_account: 'bob', order_permlink: 'order-1' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		// Attestation recorded but no count/update since fee_status
		// was not pending_external to begin with.
		expect(mock.queries).toHaveLength(3);
	});

	it('duplicate attestation returns already_attested', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [{ fee_status: 'pending_external', account: 'bob' }],
				rowCount: 1
			},
			{
				match: 'created_block_time',
				rows: [
					{
						created_block_time: new Date('2026-01-01T00:00:00Z'),
						cumulative_blurt_paid: '500'
					}
				]
			},
			{
				match: 'INSERT INTO fee_attestations',
				throwError: Object.assign(new Error('duplicate'), { code: '23505' })
			}
		]);
		const r = await handler(
			makeCtx({
				signer: 'charlie',
				payload: { order_account: 'bob', order_permlink: 'order-1' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'already_attested' });
	});
});

describe('feeAttest handler — Finding I eligibility gate', () => {
	it('rejects attestor_account_not_found when accounts row is absent', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [{ fee_status: 'pending_external', account: 'bob' }],
				rowCount: 1
			},
			// Eligibility LEFT JOIN returns zero rows.
			{ match: 'created_block_time', rows: [], rowCount: 0 }
		]);
		const r = await handler(
			makeCtx({
				signer: 'ghost',
				payload: { order_account: 'bob', order_permlink: 'order-1' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'attestor_account_not_found' });
		// Order lookup + eligibility check ran; INSERT did NOT.
		expect(mock.queries).toHaveLength(2);
	});

	it('rejects attestor_young_account in steady phase when age is short', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [{ fee_status: 'pending_external', account: 'bob' }],
				rowCount: 1
			},
			{
				match: 'created_block_time',
				rows: [
					{
						// 10 days old — below 30-day threshold.
						created_block_time: new Date('2026-04-14T12:00:00Z'),
						cumulative_blurt_paid: '500' // sufficient loyalty
					}
				]
			}
		]);
		const r = await handler(
			makeCtx({
				signer: 'charlie',
				payload: { order_account: 'bob', order_permlink: 'order-1' },
				blockTime: new Date('2026-04-24T12:00:00Z'),
				config: { attestationPhase: 'steady' } as unknown as NonNullable<
					Parameters<typeof makeCtx>[0]
				>['config']
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'attestor_young_account' });
	});

	it('rejects attestor_insufficient_loyalty in steady phase when loyalty low', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [{ fee_status: 'pending_external', account: 'bob' }],
				rowCount: 1
			},
			{
				match: 'created_block_time',
				rows: [
					{
						// 100 days old (passes age), 10 BLURT (fails loyalty).
						created_block_time: new Date('2026-01-14T12:00:00Z'),
						cumulative_blurt_paid: '10'
					}
				]
			}
		]);
		const r = await handler(
			makeCtx({
				signer: 'charlie',
				payload: { order_account: 'bob', order_permlink: 'order-1' },
				blockTime: new Date('2026-04-24T12:00:00Z'),
				config: { attestationPhase: 'steady' } as unknown as NonNullable<
					Parameters<typeof makeCtx>[0]
				>['config']
			}),
			mock.client
		);
		expect(r).toEqual({
			ok: false,
			reason: 'attestor_insufficient_loyalty'
		});
	});

	it('rejects attestor_insufficient_loyalty_and_young_account in launch phase when both fail', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [{ fee_status: 'pending_external', account: 'bob' }],
				rowCount: 1
			},
			{
				match: 'created_block_time',
				rows: [
					{
						created_block_time: new Date('2026-04-14T12:00:00Z'), // 10 days
						cumulative_blurt_paid: '10' // far short
					}
				]
			}
		]);
		const r = await handler(
			makeCtx({
				signer: 'charlie',
				payload: { order_account: 'bob', order_permlink: 'order-1' },
				blockTime: new Date('2026-04-24T12:00:00Z'),
				config: { attestationPhase: 'launch' } as unknown as NonNullable<
					Parameters<typeof makeCtx>[0]
				>['config']
			}),
			mock.client
		);
		expect(r).toEqual({
			ok: false,
			reason: 'attestor_insufficient_loyalty_and_young_account'
		});
	});

	it('admits in launch phase when EITHER gate passes (age only)', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT fee_status, account FROM orders',
				rows: [{ fee_status: 'pending_external', account: 'bob' }],
				rowCount: 1
			},
			{
				match: 'created_block_time',
				rows: [
					{
						// 60 days old, no loyalty — launch OR gate: passes.
						created_block_time: new Date('2026-02-23T12:00:00Z'),
						cumulative_blurt_paid: '0'
					}
				]
			},
			{ match: 'INSERT INTO fee_attestations', rowCount: 1 },
			{
				match: 'SELECT DISTINCT fa.attestor',
				// The non-poster, non-related attestors; each is then checked for the
				// reciprocity pattern with the poster (none here).
				rows: [{ attestor: 'att0', as_of: new Date('2026-04-19T12:00:00Z') }]
			},
			{ match: 'WITH moments AS', rows: [{ held: false }] }
		]);
		const r = await handler(
			makeCtx({
				signer: 'charlie',
				payload: { order_account: 'bob', order_permlink: 'order-1' },
				blockTime: new Date('2026-04-24T12:00:00Z'),
				config: { attestationPhase: 'launch' } as unknown as NonNullable<
					Parameters<typeof makeCtx>[0]
				>['config']
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});
});
