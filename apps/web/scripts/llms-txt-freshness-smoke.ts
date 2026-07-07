#!/usr/bin/env tsx
/**
 * apps/web/scripts/llms-txt-freshness-smoke.ts
 *
 * Structural Defense — llms.txt freshness (cp429).
 *
 * `apps/web/static/llms.txt` is the short, curated llms.txt-standard
 * index (llmstxt.org convention) served for AI crawlers — DISTINCT
 * from `llms-full.txt` (the full FAQ corpus, which has its own
 * `llms-full-freshness-smoke.ts` guard). Unlike llms-full.txt, llms.txt
 * is HAND-MAINTAINED editorial content: there is no generator, and it
 * is NOT in the `build:llms-full` prebuild. That is exactly why it
 * drifted — in cp429 it still advertised the marketplace as a plain
 * fiat↔crypto venue and listed the 16 crypto tickers but never
 * mentioned BARTER (goods/services), which shipped as a first-class
 * registry asset in cp425. Nobody updates a static file when the asset
 * registry changes, and nothing caught it.
 *
 * This smoke is the guard. It does NOT try to regenerate the file
 * (the prose is editorial); instead it asserts the DRIFT-PRONE facts
 * in llms.txt still match the canonical `@morphit/asset-registry`:
 *
 *   LT-1: apps/web/static/llms.txt exists (committed)
 *   LT-2: every non-goods (tradable-coin) ticker in ASSET_TICKERS
 *         appears in llms.txt — add a new asset and this fails until
 *         the index is updated. THE drift guard.
 *   LT-3: goods/services (barter) is mentioned, because the registry
 *         contains at least one goods asset (isGoodsAsset). Keeps the
 *         "one side can be goods & services" property from being
 *         paraphrased away the way it was before cp429.
 *   LT-4: llms.txt is actually wired to be served (referenced in the
 *         i18n bootstrap comment / lives under static/), so this file
 *         doesn't quietly become dead weight nobody serves.
 *
 * Robust to git checkout: no mtime — it re-reads the current registry
 * and the committed file and compares their content directly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_TICKERS, isGoodsAsset } from '@morphit/asset-registry';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const LLMS_TXT = join(REPO, 'apps/web/static/llms.txt');
const I18N_INDEX = join(REPO, 'apps/web/src/lib/i18n/index.ts');

let passed = 0;
let failed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

// LT-1: file exists
const exists = existsSync(LLMS_TXT);
if (exists) {
	pass('apps/web/static/llms.txt exists (committed)');
} else {
	fail('apps/web/static/llms.txt exists', 'the curated llms.txt index is missing');
}

const body = exists ? readFileSync(LLMS_TXT, 'utf8') : '';

// LT-2: every tradable-coin ticker appears (drift guard)
if (exists) {
	const coinTickers = ASSET_TICKERS.filter((t) => !isGoodsAsset(t));
	// Match tickers as whole tokens so e.g. "DAI" doesn't spuriously
	// match inside another word.
	const missing = coinTickers.filter((t) => !new RegExp(`\\b${t}\\b`).test(body));
	if (missing.length === 0) {
		pass(`all ${coinTickers.length} tradable-coin tickers present in llms.txt`);
	} else {
		fail(
			'all tradable-coin tickers present in llms.txt',
			`missing from llms.txt: ${missing.join(', ')} — the asset registry lists them but the ` +
				`curated index does not. Update apps/web/static/llms.txt (this is not auto-generated).`
		);
	}
}

// LT-3: goods/services (barter) mentioned when the registry has a goods asset
if (exists) {
	const hasGoodsAsset = ASSET_TICKERS.some((t) => isGoodsAsset(t));
	if (!hasGoodsAsset) {
		pass('no goods asset in registry — barter mention not required');
	} else {
		const mentionsBarter = /\bbarter\b/i.test(body) || /goods\s*(?:&|and|\/)\s*services/i.test(body);
		if (mentionsBarter) {
			pass('llms.txt mentions goods & services (barter)');
		} else {
			fail(
				'llms.txt mentions goods & services (barter)',
				'the registry contains a goods asset (barter) but llms.txt never mentions goods/services — ' +
					'AI summaries will describe Morphit as fiat↔crypto only. Add a barter mention.'
			);
		}
	}
}

// LT-4: llms.txt is wired to be served (not dead weight)
if (existsSync(I18N_INDEX)) {
	const idx = readFileSync(I18N_INDEX, 'utf8');
	// The i18n bootstrap references llms.txt in the SERP/hreflang comment
	// block; static/ files are served verbatim. Assert the reference is
	// still present so a future refactor doesn't orphan the file.
	if (/llms\.txt/.test(idx)) {
		pass('llms.txt still referenced by the i18n bootstrap (served, not orphaned)');
	} else {
		fail(
			'llms.txt still referenced by the i18n bootstrap',
			'no reference to llms.txt in i18n/index.ts — confirm it is still served for AI crawlers'
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nllms-txt-freshness smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} llms-txt-freshness checks pass`);
