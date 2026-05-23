#!/usr/bin/env tsx
/**
 * apps/web/scripts/privacy-headline-length-smoke.ts
 *
 * Structural Defense (cp119 A8) — `privacy.guide_heading` × asset ×
 * locale must render to ≤110 chars (Google's recommended `headline`
 * length limit for Article schema).
 *
 * cp118 flipped `/privacy/[asset]` to indexable: true.  Each rendered
 * page emits an Article JSON-LD node with `headline` set to
 * t('privacy.guide_heading', { asset: TICKER }).  Per Google's spec,
 * Article `headline` should be ≤110 chars; values exceeding that
 * may be truncated in SERP rich-results.
 *
 * This smoke pre-renders every (locale × tradable ticker) combo and
 * verifies length ≤110.  The {asset} interpolation expands to the
 * literal ticker symbol; longest ticker today is 'USDT' (4 chars) or
 * 'BLURT' (5 chars), so the actual headline length is roughly
 * `template_chars - 7 + ticker_length`.
 *
 * Scenario count: 16 tickers × 10 locales = 160 length checks.
 * Pass/fail is reported at the per-locale level (one scenario per
 * locale × worst-case ticker), with detail showing the longest
 * rendered headline for each locale.
 *
 * If a locale fails, the fix is to shorten that locale's
 * `privacy.guide_heading` translation to fit within 110 chars
 * for all tradable tickers.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_TICKERS } from '@morphit/asset-registry';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const LOCALES = ['en', 'es', 'de', 'pl', 'fr', 'it', 'ru', 'fa', 'zh-CN', 'zh-HK'];

/** Google's recommended maximum for Article `headline` field. */
const HEADLINE_LIMIT = 110;

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

console.log('\n── privacy-headline-length smoke (cp119 A8) ──────\n');

const tradable = [...ASSET_TICKERS];
let totalChecked = 0;

for (const loc of LOCALES) {
	const path = join(REPO, 'apps/web/src/lib/i18n/locales', `${loc}.json`);
	const json = JSON.parse(readFileSync(path, 'utf8')) as {
		privacy?: { guide_heading?: string };
	};
	const template = json.privacy?.guide_heading;
	if (!template) {
		fail(
			`${loc}: privacy.guide_heading exists`,
			`Key missing from ${loc}.json — locale parity drift; run i18n smokes`
		);
		continue;
	}

	let worstLen = 0;
	let worstTicker = '';
	let worstRendered = '';
	const overLimit: Array<{ ticker: string; len: number; rendered: string }> = [];

	for (const ticker of tradable) {
		// Mirror svelte-i18n's interpolation: {asset} → ticker symbol
		const rendered = template.replace(/\{asset\}/g, ticker);
		totalChecked++;
		if (rendered.length > worstLen) {
			worstLen = rendered.length;
			worstTicker = ticker;
			worstRendered = rendered;
		}
		if (rendered.length > HEADLINE_LIMIT) {
			overLimit.push({ ticker, len: rendered.length, rendered });
		}
	}

	if (overLimit.length === 0) {
		pass(
			`${loc}: all ${tradable.length} ticker renderings ≤${HEADLINE_LIMIT} chars (worst: ${worstTicker} at ${worstLen} chars — "${worstRendered}")`
		);
	} else {
		const lines = overLimit
			.slice(0, 3)
			.map((o) => `${o.ticker}: ${o.len} chars — "${o.rendered}"`)
			.join('\n      ');
		fail(
			`${loc}: all ticker renderings ≤${HEADLINE_LIMIT} chars`,
			`${overLimit.length} ticker(s) exceed Google's recommended Article headline limit:\n      ${lines}${overLimit.length > 3 ? `\n      ...and ${overLimit.length - 3} more` : ''}\n      Shorten the ${loc} translation of privacy.guide_heading.`
		);
	}
}

const total = passed + failed;
console.log(
	`\n${passed} passed, ${failed} failed (${total} total; ${totalChecked} ticker × locale combos checked)`
);
if (failed > 0) {
	console.error(`\nprivacy-headline-length smoke FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} privacy-headline-length scenarios passed`);
