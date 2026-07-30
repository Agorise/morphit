import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/orderReplace';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

function validPayload() {
	return {
		permlink: 'sell-btc-eur-2026-04',
		side: 'sell',
		asset: 'BTC',
		asset_network: null,
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
						asset_network: null,
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

	// ─── cp425/cp440: barter accepted_assets on replace ─────────────
	// cp440 — accepted_assets is now LOCKED on replace (bait-and-switch
	// guard), like side/asset/fiat/network. An unchanged set passes; a
	// changed set is rejected. The validation still mirrors the order handler.
	function validBarterReplacePayload() {
		return {
			permlink: 'sell-barter-mxn-2026-07',
			side: 'sell',
			asset: 'BARTER',
			asset_network: null,
			fiat_currency: 'MXN',
			amount_min: 100,
			amount_max: 500,
			price_model: { kind: 'fixed', price: 250 },
			payment_methods: ['in-person'],
			accepted_assets: ['XMR', 'BTC']
		};
	}

	it('updates a barter order when the accepted set is unchanged (order-independent)', async () => {
		const createdAt = new Date('2026-07-05T12:00:00Z');
		const blockTime = new Date('2026-07-05T12:02:00Z');
		const mock = makeMockClient([
			{
				match: 'SELECT status, created_at',
				rows: [
					{
						status: 'live',
						created_at: createdAt,
						side: 'sell',
						asset: 'BARTER',
						asset_network: null,
						fiat_currency: 'MXN',
						fee_method: 'blurt',
						// stored sorted; payload sends ['XMR','BTC'] — same set,
						// different order — must still be treated as unchanged.
						accepted_assets: ['BTC', 'XMR']
					}
				]
			},
			{ match: 'UPDATE orders', rowCount: 1 }
		]);
		const r = await handler(
			makeCtx({ signer: 'alice', blockTime, payload: validBarterReplacePayload() }),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(2);
	});

	it('rejects a barter replace that changes the accepted set (cp440 bait-and-switch lock)', async () => {
		const createdAt = new Date('2026-07-05T12:00:00Z');
		const blockTime = new Date('2026-07-05T12:02:00Z');
		const mock = makeMockClient([
			{
				match: 'SELECT status, created_at',
				rows: [
					{
						status: 'live',
						created_at: createdAt,
						side: 'sell',
						asset: 'BARTER',
						asset_network: null,
						fiat_currency: 'MXN',
						fee_method: 'blurt',
						accepted_assets: ['BTC', 'XMR']
					}
				]
			},
			{ match: 'UPDATE orders', rowCount: 1 }
		]);
		// payload drops BTC, keeping only XMR — a substance change.
		const payload = { ...validBarterReplacePayload(), accepted_assets: ['XMR'] };
		const r = await handler(makeCtx({ signer: 'alice', blockTime, payload }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'replace_accepted_assets_change_forbidden' });
		// rejected after the probe, before the UPDATE.
		expect(mock.queries).toHaveLength(1);
	});

	it('rejects a barter replace with no accepted_assets (before any query)', async () => {
		const mock = makeMockClient();
		const p: Record<string, unknown> = { ...validBarterReplacePayload() };
		delete p.accepted_assets;
		const r = await handler(makeCtx({ payload: p }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'accepted_assets_required_for_barter' });
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects a crypto replace that carries accepted_assets', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({ payload: { ...validPayload(), accepted_assets: ['XMR'] } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'accepted_assets_not_permitted_for_asset' });
		expect(mock.queries).toHaveLength(0);
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
						asset_network: null,
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
						asset_network: null,
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
		// Part 122 cp49 deep-deep A-2: synthetic non-ticker
		// '__UNKNOWN__' (formerly 'ETH').  See order.test.ts for
		// rationale on why we don't hard-code a real ticker as
		// the unknown stand-in.
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { ...validPayload(), asset: '__UNKNOWN__' }
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

	it('cp422: accepts multi-line markdown terms on replace (TAB/LF/CR permitted)', async () => {
		// Mirror of the create-handler regression: the replace handler
		// shared the same C0-swallowing regex, so editing an order to add
		// multi-line terms was silently rejected on-chain too.
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
						asset_network: null,
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
					terms: '# Updated terms\n\nCash only.\n\n> Meet in public.\ntabs ok'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	// ─── B1 regression: waiver substance protection ────────────────

	it('B1: rejects replace below waiver floor when target is waived_first_buy', async () => {
		// User created a $1+ waived first-buy order (passes the waiver
		// floor in order.ts handler), now tries to replace with
		// amount_min=$0.50 to dial back the commitment below the
		// $1 USD-equivalent floor (cp369: fiat floor, not 500 BLURT).
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
						asset_network: null,
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
					asset_network: null,
					fiat_currency: 'USD',
					amount_min: 0.5, // ← below the $1 USD-equivalent floor
					amount_max: 50,
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
						asset_network: null,
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
					asset_network: null,
					fiat_currency: 'USD',
					amount_min: 1, // ← at the $1 USD-equivalent floor
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
						asset_network: null,
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
					asset_network: null,
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
						asset_network: null,
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
					amount_min: 0.5 // below the $1 floor; allowed since target isn't waived
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});
});

// ─────────────────────────────────────────────────────────────────
// cp30-DD-DD CODE-3 — asset_network gate test coverage.
//
// orderReplace handler treats asset_network as a frozen substance
// field, parallel to side/asset/fiat: USDT and USDC orders REQUIRE
// it, single-network assets must omit it, and replace cannot
// change the value within the 15-minute window.
//
// These tests were filed as REVISIT in cp30-DD-DD and added now
// to close that follow-up.  Gate logic was correct on first ship;
// these tests prevent future regression.
// ─────────────────────────────────────────────────────────────────

function validUsdtPayload(): Record<string, unknown> {
	return {
		permlink: 'sell-usdt-eur-2026-04',
		side: 'sell',
		asset: 'USDT',
		fiat_currency: 'EUR',
		amount_min: 50,
		amount_max: 5000,
		price_model: { kind: 'spread', percent: 1 },
		payment_methods: ['sepa'],
		asset_network: 'erc20'
	};
}

function validUsdcPayload(): Record<string, unknown> {
	return {
		permlink: 'sell-usdc-eur-2026-04',
		side: 'sell',
		asset: 'USDC',
		fiat_currency: 'EUR',
		amount_min: 50,
		amount_max: 5000,
		price_model: { kind: 'spread', percent: 1 },
		payment_methods: ['sepa'],
		asset_network: 'base'
	};
}

describe('orderReplace asset_network gate (cp30-DD-DD CODE-3)', () => {
	it('rejects USDT replace missing asset_network', async () => {
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([]);
		const payload = validUsdtPayload();
		delete payload.asset_network;

		const r = await handler(
			makeCtx({ signer: 'alice', blockTime, payload }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'asset_network_required_for_usdt' });
	});

	it('rejects USDC replace missing asset_network', async () => {
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([]);
		const payload = validUsdcPayload();
		delete payload.asset_network;

		const r = await handler(
			makeCtx({ signer: 'alice', blockTime, payload }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'asset_network_required_for_usdc' });
	});

	it('rejects USDT replace with unknown asset_network', async () => {
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([]);

		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					...validUsdtPayload(),
					asset_network: 'polygon' // USDC network, not USDT
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'asset_network_unknown' });
	});

	it('rejects USDC replace with unknown asset_network', async () => {
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([]);

		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					...validUsdcPayload(),
					asset_network: 'trc20' // USDT network, not USDC
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'asset_network_unknown' });
	});

	it('rejects single-network asset (BTC) carrying asset_network', async () => {
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([]);

		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					...validPayload(),
					asset_network: 'erc20' // BTC doesn't have networks
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'asset_network_not_permitted_for_asset' });
	});

	it('rejects USDT replace that changes asset_network from target', async () => {
		// CRITICAL — this is the bait-and-switch we guard against:
		// counterparty saw "USDT on Ethereum" listing, sender flips to
		// Tron within the 15-minute window after DM, buyer's funds go
		// to the wrong chain.
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
						asset: 'USDT',
						fiat_currency: 'EUR',
						fee_method: 'blurt',
						asset_network: 'erc20'
					}
				]
			}
		]);

		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					...validUsdtPayload(),
					asset_network: 'trc20' // CHANGED from target's 'erc20'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'replace_asset_network_change_forbidden' });
	});

	it('rejects USDC replace that changes asset_network from target', async () => {
		// Same bait-and-switch on USDC.  The risk is amplified here
		// because three of USDC's four networks (ERC-20/Base/Polygon)
		// share the same EVM 0x[40 hex] address format — a buyer who
		// saw "USDC on Base" can't visually distinguish the seller's
		// address from a USDC-on-Polygon address.
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
						asset: 'USDC',
						fiat_currency: 'EUR',
						fee_method: 'blurt',
						asset_network: 'base'
					}
				]
			}
		]);

		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					...validUsdcPayload(),
					asset_network: 'polygon' // CHANGED from target's 'base'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'replace_asset_network_change_forbidden' });
	});

	it('allows USDT replace that preserves asset_network', async () => {
		// Honest path: replace within 15 minutes, keeping substance
		// fields (side/asset/fiat/asset_network) the same, only
		// tweaking detail fields (amount, terms, etc.).
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
						asset: 'USDT',
						fiat_currency: 'EUR',
						fee_method: 'blurt',
						asset_network: 'erc20'
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
					...validUsdtPayload(),
					asset_network: 'erc20', // unchanged
					amount_max: 7500 // detail-field tweak
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('allows USDC replace that preserves asset_network', async () => {
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
						asset: 'USDC',
						fiat_currency: 'EUR',
						fee_method: 'blurt',
						asset_network: 'base'
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
					...validUsdcPayload(),
					asset_network: 'base', // unchanged
					amount_max: 7500 // detail-field tweak
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('cp30-DD-DD I-1: rejects USDT asset_network exceeding length cap', async () => {
		// Defense-in-depth: indexer bounds input length BEFORE
		// allocating a lowercased copy.  Pathological input gets the
		// standard required-for-usdt reason (not a distinct
		// "too long" code) so attackers can't distinguish length-
		// rejected from type-rejected paths.
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([]);

		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					...validUsdtPayload(),
					asset_network: 'erc20-but-pathologically-extended-beyond-MAX_NETWORK_LEN'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'asset_network_required_for_usdt' });
	});
});

// ─────────────────────────────────────────────────────────────────
// cp31-DD DD-6 — DAI asset_network gate test coverage.
//
// Mirror of the cp30-DD-DD CODE-3 USDC tests above, targeting DAI's
// 4-EVM-network allowlist and the same replace-substance lock.
// DAI carries the most-amplified version of the cross-network mis-
// send risk on Morphit because ALL FOUR DAI networks (ERC-20,
// Polygon, Base, Arbitrum) share the EVM 0x[40 hex] address shape.
// The orderReplace handler's substance-field lock parallels USDC
// (via the structurally-identical Mirror-of-order.ts pattern), but
// the regression layer needs DAI-targeted scenarios so a future
// breakage in the DAI branch fires loudly instead of silently
// being covered only by mirror-equivalence.
// ─────────────────────────────────────────────────────────────────

function validDaiPayload(): Record<string, unknown> {
	return {
		permlink: 'sell-dai-eur-2026-04',
		side: 'sell',
		asset: 'DAI',
		fiat_currency: 'EUR',
		amount_min: 50,
		amount_max: 5000,
		price_model: { kind: 'spread', percent: 1 },
		payment_methods: ['sepa'],
		asset_network: 'arbitrum'
	};
}

describe('orderReplace asset_network gate — DAI (cp31-DD DD-6)', () => {
	it('rejects DAI replace missing asset_network', async () => {
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([]);
		const payload = validDaiPayload();
		delete payload.asset_network;

		const r = await handler(
			makeCtx({ signer: 'alice', blockTime, payload }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'asset_network_required_for_dai' });
	});

	it('rejects DAI replace with unknown asset_network', async () => {
		// 'spl' is a valid USDC network but DAI is exclusively EVM
		// (no canonical Maker DAI on Solana per ADR-0029 §1).  Catch
		// the wrong-network class explicitly.
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([]);

		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					...validDaiPayload(),
					asset_network: 'spl'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'asset_network_unknown' });
	});

	it('rejects DAI replace with USDT-only network (trc20)', async () => {
		// trc20 is valid for USDT, invalid for DAI.  Each asset's
		// allowlist is independent; a cross-asset network value
		// must be rejected.
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([]);

		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					...validDaiPayload(),
					asset_network: 'trc20'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'asset_network_unknown' });
	});

	it('rejects DAI replace that changes asset_network from target', async () => {
		// CRITICAL DAI case — bait-and-switch amplified by the
		// 4-way EVM-identity property.  Original was DAI/arbitrum;
		// replace tries to flip to DAI/polygon.  Counterparty who
		// saw "DAI on Arbitrum One" listing can't visually
		// distinguish that the seller flipped to Polygon — same
		// 0x address shape.  This is THE attack surface DAI's
		// strongest cross-network warning was written for, and it
		// reaches into the orderReplace flow too.
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
						asset: 'DAI',
						fiat_currency: 'EUR',
						fee_method: 'blurt',
						asset_network: 'arbitrum'
					}
				]
			}
		]);

		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					...validDaiPayload(),
					asset_network: 'polygon' // CHANGED from target's 'arbitrum'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'replace_asset_network_change_forbidden' });
	});

	it('allows DAI replace that preserves asset_network', async () => {
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
						asset: 'DAI',
						fiat_currency: 'EUR',
						fee_method: 'blurt',
						asset_network: 'arbitrum'
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
					...validDaiPayload(),
					asset_network: 'arbitrum', // unchanged
					amount_max: 7500 // detail-field tweak
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('cp30-DD-DD I-1: rejects DAI asset_network exceeding length cap', async () => {
		// I-1 defense-in-depth inherited by the DAI branch:
		// bound input length BEFORE allocating a lowercased copy.
		// Pathological input gets the standard
		// required-for-dai reason (not a distinct "too long"
		// code).
		const blockTime = new Date('2026-04-19T12:02:00Z');
		const mock = makeMockClient([]);

		const r = await handler(
			makeCtx({
				signer: 'alice',
				blockTime,
				payload: {
					...validDaiPayload(),
					asset_network: 'arbitrum-pathologically-extended-beyond-MAX_NETWORK_LEN'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'asset_network_required_for_dai' });
	});
});
