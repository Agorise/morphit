#!/usr/bin/env node
/**
 * Morphit — llms-full.txt builder.
 *
 * Emits a consolidated, plain-text flat-file of the FAQ in English
 * at `/llms-full.txt`. Convention from llmstxt.org: llms.txt is an
 * index + policy, llms-full.txt is the full ingestible content.
 *
 * AI retrieval tools that prefer a single-file ingestion (vs
 * crawling /faq and parsing Svelte-rendered HTML) hit this URL.
 * Source-of-truth is still the per-locale JSON; this is a
 * derived artifact.
 *
 * Regenerated on every `npm run build` via a prebuild step.
 * Dependency-free for the same reason build-sitemap.mjs is.
 *
 * The render is factored into a pure `renderLlmsFull(en)` export so
 * the freshness smoke (apps/web/scripts/llms-full-freshness-smoke.ts)
 * can re-derive the expected bytes from the current en.json and
 * diff them against the committed artifact. This is the single
 * source of truth for the file format — the CLI writer below and
 * the smoke both go through it, so they can never disagree on
 * format. (the committed artifact had silently drifted ~2
 * weeks from en.json because no guard existed; this closes that.)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOCALE_PATH = resolve(
	__dirname,
	'../apps/web/src/lib/i18n/locales/en.json'
);
const OUT_PATH = resolve(__dirname, '../apps/web/static/llms-full.txt');

/**
 * Per-instance brand placeholders (docs/BRANDING.md): SITE-brand mentions in
 * the locale JSON are `{brand}` / `{brand|<default form>}`. llms-full.txt is the
 * canonical project FAQ (it links morphit.io throughout), so every placeholder
 * resolves to its DEFAULT form — the text is exactly what it was before the
 * placeholders existed. Mirrors applyBrandToString in src/lib/brand/brandName.ts.
 */
const BRAND_PLACEHOLDER_RE = /\{brand(?:\|([^{}|]*))?\}/g;
export function resolveBrandDefault(s) {
	return typeof s === 'string'
		? s.replace(BRAND_PLACEHOLDER_RE, (_m, alt) => (alt ? alt : 'Morphit'))
		: s;
}

/**
 * Coin tokens (v1.21.5; apps/web/src/lib/assets/coinTokens.ts): copy that names
 * the coins traded here carries `{coins[:filter][|and|or|list]}` / `{coin_count}`,
 * which the app fills in with the coins THIS instance accepts. llms-full.txt is
 * the canonical FAQ, so every token resolves to the full list — every tradable
 * coin, registry order, English list words (Intl.ListFormat 'en' style).
 * COIN_TICKERS must equal the registry's tradable coins; coinTokens.test.ts
 * holds the two together.
 */
export const COIN_TICKERS = [
	'XMR', 'BTC', 'BLURT', 'USDT', 'USDC', 'DAI', 'BCH', 'LTC',
	'DASH', 'DOGE', 'ZEC', 'ARRR', 'DCR', 'SOL', 'ETH', 'XRP'
];
const COIN_TOKEN_RE = /\{coins(?::([a-z0-9,-]+))?(?:\|(and|or|list))?\}|\{coin_count\}/g;
function joinEn(items, mode) {
	if (mode === 'list' || items.length < 2) return items.join(', ');
	const word = mode === 'or' ? 'or' : 'and';
	if (items.length === 2) return `${items[0]} ${word} ${items[1]}`;
	return `${items.slice(0, -1).join(', ')}, ${word} ${items[items.length - 1]}`;
}
export function resolveCoinTokensFull(s) {
	if (typeof s !== 'string' || !s.includes('{coin')) return s;
	return s.replace(COIN_TOKEN_RE, (whole, spec, mode) => {
		if (whole === '{coin_count}') return String(COIN_TICKERS.length);
		const names = (spec ?? '').split(',').filter((x) => x.length > 0);
		const drop = new Set(names.filter((n) => n.startsWith('-')).map((n) => n.slice(1).toUpperCase()));
		const keep = new Set(names.filter((n) => !n.startsWith('-')).map((n) => n.toUpperCase()));
		const list = COIN_TICKERS.filter((t) => !drop.has(t) && (keep.size === 0 || keep.has(t)));
		return joinEn(list, mode ?? 'and');
	});
}

/**
 * Pure renderer: parsed en.json object → exact llms-full.txt body.
 * No file I/O, no side effects — safe to import from the smoke.
 */
export function renderLlmsFull(en) {
	const entries = en.faq?.entries ?? {};
	const lines = [];

	lines.push('# Morphit — complete FAQ (English)');
	lines.push('');
	lines.push('> Non-custodial peer-to-peer fiat↔BTC/XMR/BLURT/USDT/USDC/DAI/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/SOL/ETH/XRP marketplace.');
	lines.push('> No KYC. No custody. No arbitration. Federated, open-source.');
	lines.push('> Translations available at https://morphit.io/faq?lang=<code>');
	lines.push('> where <code> ∈ {en, es, de, pl, fr, it, ru, fa, zh-CN, zh-HK}.');
	lines.push('');
	lines.push('---');
	lines.push('');

	let count = 0;
	for (const [key, entry] of Object.entries(entries)) {
		count++;
		const q = resolveCoinTokensFull(resolveBrandDefault(entry.q ?? ''));
		const a = resolveCoinTokensFull(resolveBrandDefault(entry.a ?? ''));
		lines.push(`## ${q}`);
		lines.push('');
		lines.push(`**FAQ key:** \`${key}\``);
		lines.push('');
		lines.push(a);
		lines.push('');
		lines.push('---');
		lines.push('');
	}

	lines.push(`## Metadata`);
	lines.push('');
	lines.push(`Total FAQ entries: ${count}`);
	lines.push(`Canonical URL: https://morphit.io/faq`);
	lines.push(`License: AGPL-3.0 (content may be quoted/redistributed)`);
	lines.push(`Source of truth: https://git.agorise.net/agorise/morphit`);
	lines.push('');

	return lines.join('\n');
}

// Run-as-main guard: read/write files only when invoked directly
// (`node scripts/build-llms-full.mjs`, including the web prebuild
// step `npm run build:llms-full`), never when imported by the smoke.
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
	const en = JSON.parse(readFileSync(LOCALE_PATH, 'utf-8'));
	const out = renderLlmsFull(en);
	writeFileSync(OUT_PATH, out, 'utf-8');
	const n = Object.keys(en.faq?.entries ?? {}).length;
	// eslint-disable-next-line no-console
	console.log(`[llms-full] wrote ${OUT_PATH} (${n} entries, ${out.length} chars)`);
}
