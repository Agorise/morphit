/**
 * currency-api FX fetcher — jsDelivr `@latest` redirect handling.
 *
 * Regression guard for the "FX feed: currency_api down (last ok:
 * never)" bug: the shared FX fetch stack defaults to
 * redirect:'manual' (a price-stack SSRF protection), but currency-api
 * is addressed via jsDelivr's `@latest` path, which 302-redirects to
 * the concrete dated version. Under redirect:'manual' that hop is an
 * opaque non-OK response, so the source could never succeed.
 *
 * The fix: this fetcher opts into following the redirect, while
 * fxGetJson still rejects any redirect that crosses to a DIFFERENT
 * host — preserving the "no 30x to unexpected origins" intent.
 */

import { describe, expect, it } from 'vitest';

import { createCurrencyApiFetcher } from '$indexer/fx/currencyApiFetcher';

const BASE = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1';
const EXPECTED_URL = `${BASE}/currencies/usd.json`;
const USD_BODY = JSON.stringify({
	date: '2026-06-29',
	usd: { eur: 0.92, gbp: 0.79, mxn: 18.5, jpy: 161.2 }
});

/** Build a Response with a controllable final `.url` (the getter on
 *  the prototype returns '' for constructed Responses; shadow it with
 *  an own property so we can simulate where a redirect landed). */
function mockResponse(body: string, finalUrl: string, status = 200): Response {
	const res = new Response(body, {
		status,
		headers: { 'content-type': 'application/json' }
	});
	Object.defineProperty(res, 'url', { value: finalUrl, configurable: true });
	return res;
}

describe('createCurrencyApiFetcher (jsDelivr @latest redirect handling)', () => {
	it('requests with redirect:"follow" and parses the table when @latest resolves on the same host', async () => {
		let seenInit: RequestInit | undefined;
		let seenUrl = '';
		const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			seenUrl = String(url);
			seenInit = init;
			// jsDelivr resolves @latest → concrete dated version, SAME host.
			return mockResponse(
				USD_BODY,
				'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2026.6.29/v1/currencies/usd.json'
			);
		}) as unknown as typeof globalThis.fetch;

		const fetch = createCurrencyApiFetcher({ baseUrl: BASE, timeoutMs: 2000, fetchImpl });
		const table = await fetch();

		expect(seenUrl).toBe(EXPECTED_URL);
		expect(seenInit?.redirect).toBe('follow');
		expect(table).not.toBeNull();
		expect(table!.base).toBe('USD');
		expect(table!.rates.EUR).toBeCloseTo(0.92);
		expect(table!.rates.MXN).toBeCloseTo(18.5);
	});

	it('rejects (returns null) when a redirect lands on a DIFFERENT host — SSRF guard preserved', async () => {
		const fetchImpl = (async () =>
			mockResponse(USD_BODY, 'https://evil.example.com/v1/currencies/usd.json')
		) as unknown as typeof globalThis.fetch;

		const fetch = createCurrencyApiFetcher({ baseUrl: BASE, timeoutMs: 2000, fetchImpl });
		expect(await fetch()).toBeNull();
	});

	it('returns null on a non-OK upstream (never throws)', async () => {
		const fetchImpl = (async () =>
			new Response('upstream boom', { status: 500 })
		) as unknown as typeof globalThis.fetch;

		const fetch = createCurrencyApiFetcher({ baseUrl: BASE, timeoutMs: 2000, fetchImpl });
		expect(await fetch()).toBeNull();
	});

	it('trims a trailing slash on the base URL when building the request URL', async () => {
		let seenUrl = '';
		const fetchImpl = (async (url: string | URL) => {
			seenUrl = String(url);
			return mockResponse(USD_BODY, String(url));
		}) as unknown as typeof globalThis.fetch;

		const fetch = createCurrencyApiFetcher({ baseUrl: `${BASE}/`, timeoutMs: 2000, fetchImpl });
		await fetch();
		expect(seenUrl).toBe(EXPECTED_URL);
	});
});
