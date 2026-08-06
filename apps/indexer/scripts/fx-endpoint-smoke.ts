/**
 * Smoke — /v1/fx endpoint (cp372).
 *
 * Verifies the public USD→fiat endpoint serves the whole cached
 * table (privacy: client picks its own currency, no per-currency
 * query), echoes source/stale/updated_at, and 404s when the FX feed
 * is disabled on the instance.
 *
 * Run: npx tsx --tsconfig ../../tsconfig.smoke.json scripts/fx-endpoint-smoke.ts
 */

import { fxRoute } from '../src/api/fx.ts';
import type { FxRateSource } from '../src/indexer/fx/source.ts';

let passed = 0;
let failed = 0;
function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passed++;
			console.log(`  ✓ ${name}`);
		})
		.catch((err) => {
			failed++;
			console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
		});
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

function stubSource(over: Partial<ReturnType<FxRateSource['currentDetailed']>> = {}): FxRateSource {
	return {
		rate: () => 1,
		usdToFiat: () => 1,
		fiatToUsd: () => 1,
		currentDetailed: () => ({
			rates: { EUR: 0.92, AUD: 1.52, MXN: 17.1, USD: 1 },
			source: 'frankfurter',
			updated_at: new Date('2026-06-27T00:00:00Z'),
			stale: false,
			live_currency_count: 4,
			contributing_sources: ['frankfurter'],
			outlier_rejected: false,
			...over
		}),
		start: () => {},
		stop: () => {}
	};
}

await scenario('serves the whole rate table with base=USD + metadata', async () => {
	const app = fxRoute(stubSource());
	const res = await app.request('/');
	assert(res.status === 200, `status ${res.status}`);
	const body = (await res.json()) as Record<string, unknown>;
	assert(body.base === 'USD', 'base USD');
	const rates = body.rates as Record<string, number>;
	assert(rates.EUR === 0.92 && rates.MXN === 17.1, 'rates passed through');
	assert(body.source === 'frankfurter', 'source echoed');
	assert(body.stale === false, 'stale echoed');
	assert(typeof body.updated_at === 'string', 'updated_at ISO string');
	assert(body.currency_count === 4, 'currency_count');
});

await scenario('privacy: no per-currency lookup route (whole table only)', async () => {
	const app = fxRoute(stubSource());
	const res = await app.request('/EUR');
	// A per-currency path must NOT resolve to a rate — only '/' serves.
	assert(res.status === 404, `per-currency path should 404, got ${res.status}`);
});

await scenario('stale table is surfaced honestly', async () => {
	const app = fxRoute(stubSource({ stale: true, source: 'static_table' }));
	const res = await app.request('/');
	const body = (await res.json()) as Record<string, unknown>;
	assert(body.stale === true && body.source === 'static_table', 'stale + static surfaced');
});

await scenario('404 when the FX feed is disabled (null source)', async () => {
	const app = fxRoute(null);
	const res = await app.request('/');
	assert(res.status === 404, `disabled should 404, got ${res.status}`);
	const body = (await res.json()) as { status?: string; code?: string };
	assert(body.status === 'error' && body.code === 'not_found', 'flat error body with code not_found');
});

console.log(`\n${failed === 0 ? '✓ all' : '✗'} ${passed} fx-endpoint scenarios ${failed === 0 ? 'passed' : `passed, ${failed} failed`}`);
if (failed > 0) process.exit(1);
