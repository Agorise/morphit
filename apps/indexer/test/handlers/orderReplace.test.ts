import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/orderReplace';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

function validPayload() {
	return {
		permlink: 'sell-btc-eur-2026-04',
		side: 'sell',
		asset: 'BTC',
		fiat_currency: 'EUR',
		amount_min: 50,
		amount_max: 5000,
		price_model: { kind: 'spread', percent: 1 },
		payment_methods: ['sepa']
	};
}

describe('orderReplace handler', () => {
	it('updates an order within the 15-minute window', async () => {
		// Target was created at T=0; block time is T+120s (2 minutes).
		// Window is 15 minutes, so replace should succeed.
		const createdAt = new Date('2026-04-19T12:00:00Z');
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([
			{
				match: 'SELECT status, created_at',
				rows: [
					{
						status: 'live',
						created_at: createdAt,
						side: 'sell',
						asset: 'BTC',
						fiat_currency: 'EUR',
						fee_method: 'blurt'
					}
				]
			},
			{ match: 'UPDATE orders', rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: validPayload()
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(2);
	});

	it('rejects with replace_window_expired at exactly 15:00:01', async () => {
		// Just past the 15-minute window.  Window extended from 3
		// to 15 minutes 2026-05-07 per ADR-0001 Amendment.
		const createdAt = new Date('2026-04-19T12:00:00Z');
		const blockTime = new Date('2026-04-19T12:15:01Z');
		const mock = makeMockClient([
			{
				match: 'SELECT status, created_at',
				rows: [
					{
						status: 'live',
						created_at: createdAt,
						side: 'sell',
						asset: 'BTC',
						fiat_currency: 'EUR',
						fee_method: 'blurt'
					}
				]
			}
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: validPayload()
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'replace_window_expired' });
		// Only the SELECT ran; no UPDATE was attempted.
		expect(mock.queries).toHaveLength(1);
	});

	it('accepts a replace at exactly 15:00 (inclusive boundary)', async () => {
		// Exactly at the window boundary — should still succeed.
		const createdAt = new Date('2026-04-19T12:00:00Z');
		const blockTime = new Date('2026-04-19T12:15:00Z');
		const mock = makeMockClient([
			{
				match: 'SELECT status, created_at',
				rows: [
					{
						status: 'live',
						created_at: createdAt,
						side: 'sell',
						asset: 'BTC',
						fiat_currency: 'EUR',
						fee_method: 'blurt'
					}
				]
			},
			{ match: 'UPDATE orders', rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: validPayload()
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('rejects with target_not_found if no matching order exists', async () => {
		const mock = makeMockClient([{ match: 'SELECT status, created_at', rows: [] }]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: validPayload()
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'target_not_found' });
		// Window check isn't reached.
		expect(mock.queries).toHaveLength(1);
	});

	it('rejects with target_not_live if target is cancelled', async () => {
		const createdAt = new Date('2026-04-19T12:00:00Z');
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([
			{
				match: 'SELECT status, created_at',
				rows: [{ status: 'cancelled', created_at: createdAt }]
			}
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: validPayload()
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'target_not_live' });
	});

	it('validates payload before touching the DB', async () => {
		// Malformed payload should short-circuit before the SELECT.
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { ...validPayload(), asset: 'ETH' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'asset_invalid' });
		expect(mock.queries).toHaveLength(0);
	});

	// Finding L regression: price_model size cap enforced at
	// validation time, before the DB SELECT even runs.
	it('rejects price_model exceeding 4KB serialized', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: {
					...validPayload(),
					price_model: { padding: 'x'.repeat(4100) }
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'price_model_too_large' });
		expect(mock.queries).toHaveLength(0);
	});

	// ─── §F.21 O3.4 — text-field hardening ────────────────────────

	it('O3.4: rejects location_region with bidi override', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { ...validPayload(), location_region: 'EU\u202E' }
			}),
			mock.client
		);
		expect(r).toEqual({
			ok: false,
			reason: 'location_region_forbidden_char'
		});
	});

	it('O3.4: rejects terms with control char', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { ...validPayload(), terms: 'cash\u0007only' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'terms_forbidden_char' });
	});

	// ─── B1 regression: waiver substance protection ────────────────

	it('B1: rejects replace below waiver floor when target is waived_first_buy', async () => {
		// User created a 500-BLURT waived first-buy order (passes waiver
		// floor in order.ts handler), now tries to replace with
		// amount_min=1 to dial back the commitment.
		const createdAt = new Date('2026-05-01T12:00:00Z');
		const blockTime = new Date('2026-05-01T12:01:00Z');
		const mock = makeMockClient([
			{
				match: 'SELECT status, created_at',
				rows: [
					{
						status: 'live',
						created_at: createdAt,
						side: 'buy',
						asset: 'BLURT',
						fiat_currency: 'USD',
						fee_method: 'waived_first_buy'
					}
				]
			}
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					permlink: 'first-buy-blurt-2026-05',
					side: 'buy',
					asset: 'BLURT',
					fiat_currency: 'USD',
					amount_min: 1, // ← below 500-BLURT floor
					amount_max: 500,
					price_model: { kind: 'fixed', price: 0.002 },
					payment_methods: ['sepa']
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'replace_below_waiver_floor' });
		// No UPDATE attempted.
		expect(mock.queries).toHaveLength(1);
	});

	it('B1: allows replace at exactly the waiver floor for waived orders', async () => {
		const createdAt = new Date('2026-05-01T12:00:00Z');
		const blockTime = new Date('2026-05-01T12:01:00Z');
		const mock = makeMockClient([
			{
				match: 'SELECT status, created_at',
				rows: [
					{
						status: 'live',
						created_at: createdAt,
						side: 'buy',
						asset: 'BLURT',
						fiat_currency: 'USD',
						fee_method: 'waived_first_buy'
					}
				]
			},
			{ match: 'UPDATE orders', rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					permlink: 'first-buy-blurt-2026-05',
					side: 'buy',
					asset: 'BLURT',
					fiat_currency: 'USD',
					amount_min: 500, // ← at the floor
					amount_max: 1000,
					price_model: { kind: 'fixed', price: 0.002 },
					payment_methods: ['sepa']
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('B1: rejects replace with amount_min=null when target is waived', async () => {
		// null amount_min would bypass the floor entirely if not caught.
		const createdAt = new Date('2026-05-01T12:00:00Z');
		const blockTime = new Date('2026-05-01T12:01:00Z');
		const mock = makeMockClient([
			{
				match: 'SELECT status, created_at',
				rows: [
					{
						status: 'live',
						created_at: createdAt,
						side: 'buy',
						asset: 'BLURT',
						fiat_currency: 'USD',
						fee_method: 'waived_first_buy'
					}
				]
			}
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					permlink: 'first-buy-blurt-2026-05',
					side: 'buy',
					asset: 'BLURT',
					fiat_currency: 'USD',
					amount_min: null,
					amount_max: 1000,
					price_model: { kind: 'fixed', price: 0.002 },
					payment_methods: ['sepa']
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'replace_below_waiver_floor' });
	});

	it('B1: BLURT-paid orders can replace with any positive amount_min', async () => {
		// Sanity check: the floor check ONLY applies to waived orders.
		// A normal BLURT-paid order can still dial amount_min wherever.
		const createdAt = new Date('2026-05-01T12:00:00Z');
		const blockTime = new Date('2026-05-01T12:01:00Z');
		const mock = makeMockClient([
			{
				match: 'SELECT status, created_at',
				rows: [
					{
						status: 'live',
						created_at: createdAt,
						side: 'sell',
						asset: 'BTC',
						fiat_currency: 'EUR',
						fee_method: 'blurt'
					}
				]
			},
			{ match: 'UPDATE orders', rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					...validPayload(),
					amount_min: 1 // would fail if waiver-floor logic mis-fired
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});
});
