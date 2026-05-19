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

const enRaw = readFileSync(LOCALE_PATH, 'utf-8');
const en = JSON.parse(enRaw);

const entries = en.faq?.entries ?? {};
const lines = [];

lines.push('# Morphit — complete FAQ (English)');
lines.push('');
lines.push('> Non-custodial peer-to-peer fiat↔BTC/XMR/BLURT/USDT/USDC/DAI/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/SOL/ETH marketplace.');
lines.push('> No KYC. No custody. No arbitration. Federated, open-source.');
lines.push('> Translations available at https://morphit.io/faq?lang=<code>');
lines.push('> where <code> ∈ {en, es, de, pl, fr, it, ru, fa, zh-CN, zh-HK}.');
lines.push('');
lines.push('---');
lines.push('');

let count = 0;
for (const [key, entry] of Object.entries(entries)) {
	count++;
	const q = entry.q ?? '';
	const a = entry.a ?? '';
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

writeFileSync(OUT_PATH, lines.join('\n'), 'utf-8');

// eslint-disable-next-line no-console
console.log(`[llms-full] wrote ${OUT_PATH} (${count} entries, ${lines.join('\n').length} chars)`);
