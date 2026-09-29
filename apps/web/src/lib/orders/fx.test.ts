import { describe, it, expect } from 'vitest';
import {
	fxRate,
	usdToFiat,
	fiatToUsd,
	firstOrderMinInFiat,
	waiverFloorStatus,
	type FxFetchResult
} from './fx';
import { FIRST_ORDER_MIN_USD } from '@morphit/asset-registry';
import type { FxResponse } from '@morphit/indexer-client';

const TABLE: FxResponse = {
	base: 'USD',
	rates: { EUR: 0.92, AUD: 1.52, MXN: 17.1, JPY: 156, USD: 1 },
	source: 'frankfurter',
	stale: false,
	updated_at: '2026-06-27T00:00:00Z',
	currency_count: 5
};

describe('fxRate', () => {
	it('returns 1 for USD (any case)', () => {
		expect(fxRate(TABLE, 'USD')).toBe(1);
		expect(fxRate(TABLE, 'usd')).toBe(1);
	});
	it('returns the rate for a known fiat, case-insensitive + trimmed', () => {
		expect(fxRate(TABLE, 'eur')).toBe(0.92);
		expect(fxRate(TABLE, ' MXN ')).toBe(17.1);
	});
	it('null for unknown fiat or null table', () => {
		expect(fxRate(TABLE, 'XYZ')).toBeNull();
		expect(fxRate(null, 'EUR')).toBeNull();
	});
});

describe('usdToFiat / fiatToUsd', () => {
	it('converts both directions', () => {
		expect(usdToFiat(TABLE, 1, 'EUR')).toBeCloseTo(0.92, 6);
		expect(usdToFiat(TABLE, 10, 'MXN')).toBeCloseTo(171, 6);
		expect(fiatToUsd(TABLE, 0.92, 'EUR')).toBeCloseTo(1, 6);
		expect(fiatToUsd(TABLE, 171, 'MXN')).toBeCloseTo(10, 6);
	});
	it('round-trips USD identity', () => {
		expect(usdToFiat(TABLE, 5, 'USD')).toBe(5);
		expect(fiatToUsd(TABLE, 5, 'USD')).toBe(5);
	});
	it('null for unknown fiat or non-finite input', () => {
		expect(usdToFiat(TABLE, 1, 'XYZ')).toBeNull();
		expect(fiatToUsd(TABLE, 1, 'XYZ')).toBeNull();
		expect(usdToFiat(TABLE, Infinity, 'EUR')).toBeNull();
		expect(fiatToUsd(null, 1, 'EUR')).toBeNull();
	});
});

describe('firstOrderMinInFiat — $1-equivalent, rounded UP so it never seeds below the floor', () => {
	it('USD seeds exactly the $1 minimum', () => {
		expect(firstOrderMinInFiat(TABLE, 'USD')).toBe(FIRST_ORDER_MIN_USD);
	});
	it('rounds UP to a clean step and stays ≥ the true $1-equivalent (+ headroom)', () => {
		// EUR: $1 = 0.92, +3% headroom = 0.9476 → two decimals up → 0.95
		expect(firstOrderMinInFiat(TABLE, 'EUR')).toBe(0.95);
		// AUD: 1.52 → 1.5656 → nearest 0.5 up → 2
		expect(firstOrderMinInFiat(TABLE, 'AUD')).toBe(2);
		// MXN: 17.1 → 17.613 → nearest whole up → 18
		expect(firstOrderMinInFiat(TABLE, 'MXN')).toBe(18);
		// JPY: 156 → 160.68 → nearest 10 up → 170
		expect(firstOrderMinInFiat(TABLE, 'JPY')).toBe(170);
	});
	it('null for unknown fiat or null table (caller falls back)', () => {
		expect(firstOrderMinInFiat(TABLE, 'XYZ')).toBeNull();
		expect(firstOrderMinInFiat(null, 'EUR')).toBeNull();
	});
	it('the seeded default always clears the indexer floor (fiatToUsd ≥ $1)', () => {
		for (const fiat of ['EUR', 'AUD', 'MXN', 'JPY', 'USD']) {
			const seeded = firstOrderMinInFiat(TABLE, fiat)!;
			const usd = fiatToUsd(TABLE, seeded, fiat)!;
			expect(usd).toBeGreaterThanOrEqual(FIRST_ORDER_MIN_USD - 1e-9);
		}
	});
});

/**
 * v1.20.0 fix wave, G5. The pre-filled minimum used to sit EXACTLY on the $1
 * floor at the browser's rate (JPY 150 → "150"), so any node whose rate was a
 * hair higher — FX refreshes hourly and every federated node averages its own
 * sources, within FX_OUTLIER_TOLERANCE (2%) of each other — rejected the free
 * first buy. The seed now carries headroom that survives a 2% adverse move.
 */
describe('firstOrderMinInFiat — survives a 2% adverse FX move on the verifying node (G5)', () => {
	for (const [fiat, rate] of [
		['JPY', 150],
		['EUR', 0.92],
		['MXN', 17.999],
		['AUD', 1.4999],
		['GBP', 0.79]
	] as const) {
		it(`${fiat} @ ${rate}`, () => {
			const table: FxResponse = { ...TABLE, rates: { ...TABLE.rates, [fiat]: rate } };
			const seeded = firstOrderMinInFiat(table, fiat)!;
			const nodeTable: FxResponse = { ...TABLE, rates: { ...TABLE.rates, [fiat]: rate * 1.02 } };
			expect(fiatToUsd(nodeTable, seeded, fiat)!).toBeGreaterThanOrEqual(FIRST_ORDER_MIN_USD);
		});
	}
});

/**
 * G5 — the client-side waiver gate must mirror the indexer: an amount in a
 * currency that cannot be converted is NOT treated as already-USD any more.
 */
describe('waiverFloorStatus (G5)', () => {
	it('USD converts 1:1 even with no FX table', () => {
		expect(waiverFloorStatus(null, 1, 'USD')).toBe('ok');
		expect(waiverFloorStatus(null, 0.5, 'usd')).toBe('below');
	});
	it('an unconvertible currency is its own state, never "ok"', () => {
		expect(waiverFloorStatus(TABLE, 1000, 'ZZZ')).toBe('unconvertible');
		expect(waiverFloorStatus(null, 1000, 'EUR')).toBe('unconvertible');
	});
	it('converts via the table otherwise', () => {
		expect(waiverFloorStatus(TABLE, 1.2, 'AUD')).toBe('below');
		expect(waiverFloorStatus(TABLE, 2, 'AUD')).toBe('ok');
		expect(waiverFloorStatus(TABLE, null, 'AUD')).toBe('missing');
	});
});

describe('FxFetchResult type', () => {
	it('discriminates ok/error', () => {
		const ok: FxFetchResult = { kind: 'ok', table: TABLE };
		const err: FxFetchResult = { kind: 'error', message: 'x' };
		expect(ok.kind).toBe('ok');
		expect(err.kind).toBe('error');
	});
});
