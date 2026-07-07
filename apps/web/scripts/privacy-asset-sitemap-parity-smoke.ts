#!/usr/bin/env tsx
/**
 * apps/web/scripts/privacy-asset-sitemap-parity-smoke.ts
 *
 * Structural Defense (cp117 A7) — asset-registry × sitemap parity
 * for the `/privacy/[asset]` dynamic route.
 *
 * cp117 flipped `privacy_asset` from `indexable: false` to `true`.  The
 * sitemap builder expands the `[asset]` dynamic segment to one URL per
 * tradable ticker.  This smoke catches drift between the asset registry
 * and the rendered sitemap:
 *
 *   - Every tradable ticker has a `/privacy/<ticker>` entry per locale
 *   - No /privacy/<ticker> entries exist for tickers NOT in the registry
 *     (catches a stale ticker someone deleted from the registry but
 *     forgot to remove from the sitemap)
 *   - The count is exact: 16 tickers × 10 locales = 160 privacy-asset
 *     URLs in the rendered sitemap.xml (today; auto-scales with registry)
 *
 * The smoke READS the rendered sitemap.xml, so it catches both
 * (a) sitemap-builder-script bugs (forgot to expand a route), AND
 * (b) "I added a ticker but forgot to rebuild the sitemap" drift.
 *
 * Scenarios:
 *   P-1: sitemap.xml file exists at apps/web/static/sitemap.xml
 *   P-2: every tradable ASSET_TICKER has exactly 10 /privacy/<ticker>
 *        entries (one per locale) in the rendered sitemap
 *   P-3: no /privacy/<ticker> entries exist for tickers absent from
 *        the asset registry (catches stale-ticker drift)
 *   P-4: exact count: tickers × locales = total /privacy/<ticker> URLs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_TICKERS, isGoodsAsset, type AssetTicker } from '@morphit/asset-registry';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const SITEMAP = join(REPO, 'apps/web/static/sitemap.xml');

const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── privacy-asset-sitemap-parity smoke (cp117 A7) ──\n');

// P-1: sitemap exists
if (!existsSync(SITEMAP)) {
	fail(
		'sitemap.xml exists',
		`missing at ${SITEMAP} — run 'node scripts/build-sitemap.mjs'`
	);
	console.log(`\n${passed} passed, ${failed} failed`);
	console.error('\nprivacy-asset-sitemap-parity smoke FAILED');
	process.exit(1);
} else {
	pass('sitemap.xml exists');
}

const xml = readFileSync(SITEMAP, 'utf8');

// Extract every /privacy/<token> path from the sitemap.  Match the
// <loc> entries — that's the canonical row; alternates would
// inflate counts.
const locRe = /<loc>https:\/\/morphit\.io\/([a-z-]+(?:-[A-Z]{2})?)\/privacy\/([a-z0-9]+)<\/loc>/g;
const found = new Map<string, Set<string>>(); // ticker → set of locales
let m: RegExpExecArray | null;
while ((m = locRe.exec(xml)) !== null) {
	const [, locale, ticker] = m;
	if (!found.has(ticker)) found.set(ticker, new Set());
	found.get(ticker)!.add(locale);
}

// P-2: every registered ticker present × 10 locales
// cp425 — goods assets (BARTER) have no /privacy/<ticker> page (no on-chain
// privacy guide; wares change hands off-platform), so they're exempt from the
// required set and the exact count.
const privacyTickers = (ASSET_TICKERS as readonly string[]).filter(
	(t) => !isGoodsAsset(t as AssetTicker)
);
const missing: string[] = [];
const partial: string[] = [];
for (const ticker of privacyTickers) {
	const tickerLc = ticker.toLowerCase();
	const seen = found.get(tickerLc);
	if (!seen) {
		missing.push(tickerLc);
		continue;
	}
	const missingLocales = LOCALES.filter((l) => !seen.has(l));
	if (missingLocales.length > 0) {
		partial.push(`${tickerLc} (missing locales: ${missingLocales.join(', ')})`);
	}
}
if (missing.length === 0 && partial.length === 0) {
	pass(
		`every crypto ASSET_TICKER (${privacyTickers.length}) has /privacy/<ticker> in all ${LOCALES.length} locales`
	);
} else {
	const detail: string[] = [];
	if (missing.length > 0) detail.push(`completely missing: ${missing.join(', ')}`);
	if (partial.length > 0) detail.push(`partially missing: ${partial.join('; ')}`);
	fail(
		'every tradable ASSET_TICKER has /privacy/<ticker> in all locales',
		detail.join(' | ') + " — run 'node scripts/build-sitemap.mjs'"
	);
}

// P-3: no /privacy/<ticker> entries for unknown tickers
const registrySet = new Set(ASSET_TICKERS.map((t) => t.toLowerCase()));
const stale: string[] = [];
for (const ticker of found.keys()) {
	if (!registrySet.has(ticker)) {
		stale.push(ticker);
	}
}
if (stale.length === 0) {
	pass(
		`no /privacy/<ticker> entries exist for unknown tickers (registry × sitemap parity)`
	);
} else {
	fail(
		'no /privacy/<ticker> entries exist for unknown tickers',
		`sitemap has /privacy/${stale.join(', /privacy/')} which is not in ASSET_TICKERS — registry was likely shrunk without rebuilding sitemap`
	);
}

// P-4: exact count
const expectedCount = privacyTickers.length * LOCALES.length;
let actualCount = 0;
locRe.lastIndex = 0;
while (locRe.exec(xml) !== null) actualCount++;
if (actualCount === expectedCount) {
	pass(
		`exact count: ${ASSET_TICKERS.length} tickers × ${LOCALES.length} locales = ${expectedCount} /privacy/<ticker> URLs`
	);
} else {
	fail(
		`exact count: ${ASSET_TICKERS.length} tickers × ${LOCALES.length} locales = ${expectedCount} /privacy/<ticker> URLs`,
		`sitemap has ${actualCount} — expected ${expectedCount}; difference of ${actualCount - expectedCount} indicates drift`
	);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error(`\nprivacy-asset-sitemap-parity smoke FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} privacy-asset-sitemap-parity scenarios passed`);
