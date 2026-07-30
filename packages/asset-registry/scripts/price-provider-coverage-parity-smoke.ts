#!/usr/bin/env tsx
/**
 * price-provider-coverage-parity-smoke.
 *
 * CP42 O-93 coverage gap closure: every ASSET_TICKER must have a
 * matching entry in (a) the writable internal store's initialState,
 * (b) the Coingecko provider's COIN_ID map, (c) the fallback
 * provider's FALLBACK_USD map.  A typo or missing entry in any one
 * of these means the price for that asset silently returns null in
 * production — orders display correctly but volume/USD-estimate
 * calculations break for the affected asset.
 *
 * Catches: future asset additions that forget to register with one
 * of the three providers; typos in Coingecko slug; stale fallback
 * map after asset removal.
 */

import { ASSET_TICKERS, isGoodsAsset, type AssetTicker } from '../src/index';

let failed = 0;
let passed = 0;

console.log('\n── price-provider coverage parity smoke ──────────────\n');

// Parse the three sources textually because we can't easily import .ts files
// from packages/asset-registry without resolving the SvelteKit + svelte deps.
// Adjust paths relative to the smoke location.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const SMOKE_DIR = dirname(fileURLToPath(import.meta.url));
const APP_WEB_LIB = join(SMOKE_DIR, '../../../apps/web/src/lib/prices');

const idxSrc = readFileSync(join(APP_WEB_LIB, 'index.ts'), 'utf8');
const cgSrc = readFileSync(join(APP_WEB_LIB, 'providers/coingecko.ts'), 'utf8');
const fbSrc = readFileSync(join(APP_WEB_LIB, 'providers/fallback.ts'), 'utf8');

// Extract tickers from each map
function extractTickers(source: string, valueShape: RegExp): Set<string> {
	const re = new RegExp(`(${ASSET_TICKERS.join('|')}):\\s*${valueShape.source}`, 'g');
	const out = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		out.add(m[1]);
	}
	return out;
}

const initialEntries = extractTickers(idxSrc, /null/);
const cgEntries = extractTickers(cgSrc, /'[^']+'/);
const fbEntries = extractTickers(fbSrc, /[0-9.]+/);

// cp425 — goods assets (BARTER) have NO crypto price: a barter listing is
// valued directly in the seller's fiat, so it has no Coingecko slug / fallback
// USD / initial price-state entry. Exempt them from the coverage requirement.
const expected = new Set(
	(ASSET_TICKERS as readonly string[]).filter((t) => !isGoodsAsset(t as AssetTicker))
);

function check(name: string, observed: Set<string>): void {
	const missing = [...expected].filter((t) => !observed.has(t));
	const extra = [...observed].filter((t) => !expected.has(t));
	if (missing.length === 0 && extra.length === 0) {
		console.log(`  ✓ ${name}: all ${observed.size} tickers covered`);
		passed++;
	} else {
		if (missing.length) {
			console.error(`  ✗ ${name}: MISSING ${missing.join(', ')}`);
			failed++;
		}
		if (extra.length) {
			console.error(`  ✗ ${name}: EXTRA ${extra.join(', ')}`);
			failed++;
		}
	}
}

check('initialState (prices/index.ts)', initialEntries);
check('Coingecko COIN_ID map (providers/coingecko.ts)', cgEntries);
check('Fallback FALLBACK_USD map (providers/fallback.ts)', fbEntries);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('\nprice-provider coverage parity smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} price-provider-coverage-parity scenarios passed`);
