/**
 * currency-api FX fetcher — jsDelivr `@latest` redirect handling.
 *
 * currency-api is addressed via jsDelivr's `@latest` path, which
 * 302-redirects to the concrete dated version. fxGetJson never lets fetch
 * follow a redirect on its own (redirect:'manual' always): it follows ONE
 * hop by hand, and only when the target stays on the same host and scheme.
 * A redirect to any other host is refused before a request is sent to it.
 */

import { describe, expect, it } from 'vitest';

import { createCurrencyApiFetcher } from '$indexer/fx/currencyApiFetcher';

const BASE = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1';
const EXPECTED_URL = `${BASE}/currencies/usd.json`;
const DATED_URL =
	'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2026.6.29/v1/currencies/usd.json';
const USD_BODY = JSON.stringify({
	date: '2026-06-29',
	usd: { eur: 0.92, gbp: 0.79, mxn: 18.5, jpy: 161.2 }
});

const json = (body: string): Response =>
	new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const redirect = (location: string): Response =>
	new Response(null, { status: 302, headers: { location } });

describe('createCurrencyApiFetcher (jsDelivr @latest redirect handling)', () => {
	it('follows the same-host @latest redirect by hand and parses the table', async () => {
		const seen: { url: string; redirect: RequestInit['redirect'] }[] = [];
		const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			seen.push({ url: String(url), redirect: init?.redirect });
			return String(url) === EXPECTED_URL ? redirect(DATED_URL) : json(USD_BODY);
		}) as unknown as typeof globalThis.fetch;

		const fetch = createCurrencyApiFetcher({ baseUrl: BASE, timeoutMs: 2000, fetchImpl });
		const table = await fetch();

		expect(seen.map((s) => s.url)).toEqual([EXPECTED_URL, DATED_URL]);
		expect(seen.every((s) => s.redirect === 'manual')).toBe(true);
		expect(table).not.toBeNull();
		expect(table!.base).toBe('USD');
		expect(table!.rates.EUR).toBeCloseTo(0.92);
		expect(table!.rates.MXN).toBeCloseTo(18.5);
	});

	it('a redirect to a DIFFERENT host is refused and never requested', async () => {
		const seen: string[] = [];
		const fetchImpl = (async (url: string | URL) => {
			seen.push(String(url));
			return String(url) === EXPECTED_URL
				? redirect('https://evil.example.com/v1/currencies/usd.json')
				: json(USD_BODY);
		}) as unknown as typeof globalThis.fetch;

		const fetch = createCurrencyApiFetcher({ baseUrl: BASE, timeoutMs: 2000, fetchImpl });
		expect(await fetch()).toBeNull();
		expect(seen).toEqual([EXPECTED_URL]);
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
			return json(USD_BODY);
		}) as unknown as typeof globalThis.fetch;

		const fetch = createCurrencyApiFetcher({ baseUrl: `${BASE}/`, timeoutMs: 2000, fetchImpl });
		await fetch();
		expect(seenUrl).toBe(EXPECTED_URL);
	});
});
