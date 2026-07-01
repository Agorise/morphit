/**
 * Morphit indexer — feeAmountCalc tests.
 *
 * Covers both pure-math (`computeFeeAmounts`) and the
 * Coingecko fetch wrapper (`fetchBtcXmrPricesFromCoingecko`)
 * with a stubbed `fetch`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	computeFeeAmounts,
	fetchBtcXmrPricesFromCoingecko
} from '../../src/lib/feeAmountCalc';

describe('computeFeeAmounts — pure math', () => {
	it('canonical defaults: $0.25 target at $60K BTC / $320 XMR', () => {
		const result = computeFeeAmounts(0.25, { btcUsd: 60_000, xmrUsd: 320 });
		// 0.25 / 60_000 * 1e8 = 416.666... → 417 (Math.round)
		expect(result.btcSatoshis).toBe(417);
		// 0.25 / 320 * 1e12 = 781_250_000
		expect(result.xmrPiconero).toBe(781_250_000);
	});

	it('zero target → zero amounts', () => {
		const result = computeFeeAmounts(0, { btcUsd: 60_000, xmrUsd: 320 });
		expect(result.btcSatoshis).toBe(0);
		expect(result.xmrPiconero).toBe(0);
	});

	it('high target ($1.00) scales linearly', () => {
		const result = computeFeeAmounts(1.0, { btcUsd: 60_000, xmrUsd: 320 });
		// 1.0 / 60_000 * 1e8 = 1666.666... → 1667
		expect(result.btcSatoshis).toBe(1667);
		// 1.0 / 320 * 1e12 = 3_125_000_000
		expect(result.xmrPiconero).toBe(3_125_000_000);
	});

	it('higher BTC price → fewer sats for same USD target', () => {
		const lo = computeFeeAmounts(0.25, { btcUsd: 30_000, xmrUsd: 320 });
		const hi = computeFeeAmounts(0.25, { btcUsd: 120_000, xmrUsd: 320 });
		expect(hi.btcSatoshis).toBeLessThan(lo.btcSatoshis);
		// XMR side unaffected when only BTC price changes
		expect(lo.xmrPiconero).toBe(hi.xmrPiconero);
	});
});

describe('fetchBtcXmrPricesFromCoingecko', () => {
	function mockFetch(opts: {
		body?: unknown;
		ok?: boolean;
		status?: number;
		throwsBeforeFetch?: Error;
	}): typeof fetch {
		return vi.fn(async () => {
			if (opts.throwsBeforeFetch) throw opts.throwsBeforeFetch;
			return {
				ok: opts.ok ?? true,
				status: opts.status ?? 200,
				json: async () => opts.body
			} as Response;
		}) as unknown as typeof fetch;
	}

	it('happy path: valid response → prices returned', async () => {
		const fetchImpl = mockFetch({
			body: {
				bitcoin: { usd: 60_123.45 },
				monero: { usd: 320.67 }
			}
		});
		const prices = await fetchBtcXmrPricesFromCoingecko(fetchImpl);
		expect(prices.btcUsd).toBe(60_123.45);
		expect(prices.xmrUsd).toBe(320.67);
	});

	it('non-2xx HTTP → throws with status', async () => {
		const fetchImpl = mockFetch({ ok: false, status: 503 });
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/HTTP 503/
		);
	});

	it('network failure → throws with "coingecko unreachable"', async () => {
		const fetchImpl = mockFetch({
			throwsBeforeFetch: new Error('ENOTFOUND api.coingecko.com')
		});
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/coingecko unreachable/
		);
	});

	it('missing bitcoin field → throws', async () => {
		const fetchImpl = mockFetch({
			body: { monero: { usd: 320 } }
		});
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/BTC\/USD not a number or numeric string/
		);
	});

	it('zero BTC price → throws (avoids divide-by-zero downstream)', async () => {
		const fetchImpl = mockFetch({
			body: { bitcoin: { usd: 0 }, monero: { usd: 320 } }
		});
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/BTC\/USD missing or invalid/
		);
	});

	it('negative XMR price → throws', async () => {
		const fetchImpl = mockFetch({
			body: { bitcoin: { usd: 60_000 }, monero: { usd: -1 } }
		});
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/XMR\/USD missing or invalid/
		);
	});

	it('string price → coerced and accepted (Coingecko sometimes returns strings)', async () => {
		const fetchImpl = mockFetch({
			body: { bitcoin: { usd: '60000' }, monero: { usd: '320' } }
		});
		const prices = await fetchBtcXmrPricesFromCoingecko(fetchImpl);
		expect(prices.btcUsd).toBe(60_000);
		expect(prices.xmrUsd).toBe(320);
	});

	it('garbage string price → throws (Part 112 hardening)', async () => {
		const fetchImpl = mockFetch({
			body: { bitcoin: { usd: 'not-a-number' }, monero: { usd: 320 } }
		});
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/BTC\/USD not a numeric string/
		);
	});

	// Part 112 hardening — pre-tightening, these would have
	// coerced through `Number()` to surprising values
	// (`Number(null) === 0`, `Number(true) === 1`,
	// `Number([42]) === 42`, etc) and only `0` would have been
	// caught by the downstream `<= 0` gate.  Post-tightening,
	// all are rejected with a type-explicit error.
	it('null price → throws (Part 112 hardening)', async () => {
		const fetchImpl = mockFetch({
			body: { bitcoin: { usd: null }, monero: { usd: 320 } }
		});
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/BTC\/USD not a number or numeric string/
		);
	});

	it('boolean price → throws (Part 112 hardening)', async () => {
		const fetchImpl = mockFetch({
			body: { bitcoin: { usd: true }, monero: { usd: 320 } }
		});
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/BTC\/USD not a number or numeric string/
		);
	});

	it('array price → throws (Part 112 hardening)', async () => {
		const fetchImpl = mockFetch({
			body: { bitcoin: { usd: [60_000] }, monero: { usd: 320 } }
		});
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/BTC\/USD not a number or numeric string/
		);
	});

	it('object price → throws (Part 112 hardening)', async () => {
		const fetchImpl = mockFetch({
			body: { bitcoin: { usd: { value: 60_000 } }, monero: { usd: 320 } }
		});
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/BTC\/USD not a number or numeric string/
		);
	});

	it('empty string price → throws (Part 112 hardening, would have coerced to 0)', async () => {
		const fetchImpl = mockFetch({
			body: { bitcoin: { usd: '' }, monero: { usd: 320 } }
		});
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/BTC\/USD not a numeric string/
		);
	});

	it('whitespace-padded numeric string → throws (Part 112 hardening, was tolerated by Number())', async () => {
		const fetchImpl = mockFetch({
			body: { bitcoin: { usd: ' 60000 ' }, monero: { usd: 320 } }
		});
		await expect(fetchBtcXmrPricesFromCoingecko(fetchImpl)).rejects.toThrow(
			/BTC\/USD not a numeric string/
		);
	});

	it('exponential notation accepted (scientific JSON numbers are legal)', async () => {
		const fetchImpl = mockFetch({
			body: { bitcoin: { usd: '6e4' }, monero: { usd: 320 } }
		});
		const prices = await fetchBtcXmrPricesFromCoingecko(fetchImpl);
		expect(prices.btcUsd).toBe(60_000);
	});
});
