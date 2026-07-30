import { describe, it, expect } from 'vitest';
import {
	fxRate,
	usdToFiat,
	fiatToUsd,
	firstOrderMinInFiat,
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
	it('rounds UP to a clean step and stays ≥ the true $1-equivalent', () => {
		// EUR: $1 = 0.92 → ≥1? no (<1) → two decimals rounded up → 0.92
		expect(firstOrderMinInFiat(TABLE, 'EUR')).toBe(0.92);
		// AUD: $1 = 1.52 → ≥1 → nearest 0.5 up → 2
		const aud = firstOrderMinInFiat(TABLE, 'AUD')!;
		expect(aud).toBe(2);
		expect(aud).toBeGreaterThanOrEqual(1.52);
		// MXN: $1 = 17.1 → ≥10 → nearest whole up → 18
		const mxn = firstOrderMinInFiat(TABLE, 'MXN')!;
		expect(mxn).toBe(18);
		expect(mxn).toBeGreaterThanOrEqual(17.1);
		// JPY: $1 = 156 → ≥100 → nearest 10 up → 160
		const jpy = firstOrderMinInFiat(TABLE, 'JPY')!;
		expect(jpy).toBe(160);
		expect(jpy).toBeGreaterThanOrEqual(156);
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

describe('FxFetchResult type', () => {
	it('discriminates ok/error', () => {
		const ok: FxFetchResult = { kind: 'ok', table: TABLE };
		const err: FxFetchResult = { kind: 'error', message: 'x' };
		expect(ok.kind).toBe('ok');
		expect(err.kind).toBe('error');
	});
});
