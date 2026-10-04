#!/usr/bin/env tsx
/**
 * price-provider-coverage-parity-smoke.
 *
 * Every priced ticker (every ASSET_TICKER except goods assets) has an
 * initial-state slot in the price store (apps/web/src/lib/prices/index.ts).
 * A missing slot means the store has no key for that asset, so UI that
 * reads `priceStore[symbol]` sees `undefined` instead of "unknown" (null).
 *
 * Catches: an asset added to the registry without a price-store slot, and a
 * stale slot left behind after an asset is removed.
 */

import { ASSET_TICKERS, isGoodsAsset, type AssetTicker } from '../src/index';

let failed = 0;
let passed = 0;

console.log('\n── price-provider coverage parity smoke ──────────────\n');

// Parse the source textually: importing the module from packages/asset-registry
// would need the SvelteKit + svelte deps resolved.
// Adjust paths relative to the smoke location.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const SMOKE_DIR = dirname(fileURLToPath(import.meta.url));
const APP_WEB_LIB = join(SMOKE_DIR, '../../../apps/web/src/lib/prices');

const idxSrc = readFileSync(join(APP_WEB_LIB, 'index.ts'), 'utf8');

// Extract the tickers of a `TICKER: <value>` map
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

// Goods assets (BARTER) have NO crypto price: a barter listing is valued
// directly in the seller's fiat, so it has no price-state entry. Exempt them.
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('\nprice-provider coverage parity smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} price-provider-coverage-parity scenarios passed`);
