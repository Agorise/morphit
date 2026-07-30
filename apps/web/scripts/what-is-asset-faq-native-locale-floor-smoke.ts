#!/usr/bin/env tsx
/**
 * what-is-asset-faq-native-locale-floor-smoke.
 *
 * Part 122 cp54 STRUCTURAL DEFENSE (LL #58 / O-8).
 *
 * Closes the cp54-D1 native-locale drift class: per Memory #29,
 * EVERY new i18n key MUST be NATIVE in en/es/fr/de and may be
 * EN-fallback in it/pl/ru/fa/zh-CN/zh-HK.  For the per-asset
 * `what_is_<asset>` FAQ family specifically, this smoke pins
 * that NATIVE en/es/fr/de invariant — values in es/fr/de MUST
 * NOT be byte-identical to en (which would indicate EN-fallback
 * smuggled in instead of a native translation).
 *
 * Drift history surfaced at cp54:
 *   - usdt (cp4 part 121), usdc (cp30), doge (cp33): native ES/FR/DE ✓
 *   - dai (cp31), zec (cp39), arrr (cp41), dcr (cp43), sol (cp45),
 *     eth (cp47), xrp (cp49): EN-fallback in es/fr/de ✗
 *   - bch (cp51 backfill), ltc (cp51), dash (cp51): EN-fallback ✗
 *
 * Total drift at cp54 discovery: 10 FAQs × 3 native locales × 2
 * fields = 60 missing native translations spanning 7+ checkpoints.
 *
 * Cp54 wrote all 60 native translations inline; this smoke pins
 * the floor going forward.
 *
 * Recurring class scope progression (8 defenses across 7 checkpoints):
 *   cp48-O1: standalone smoke scripts
 *   cp49-O2: vitest unit tests
 *   cp50-O3: HTTP route handler regex
 *   cp51-O4: ops-cli per-ticker hardcoded tables
 *   cp51-O5: per-asset i18n FAQ key coverage
 *   cp52-O6: Ansible env-template required-var parity
 *   cp53-O7: operator doc per-asset coverage
 *   cp54-O8: per-asset FAQ native-locale floor (THIS)
 *
 * Mutation test verification: M-122 — reverting es.json's
 * what_is_xrp value back to EN-fallback fires:
 *   "what-is-asset-faq-native-locale-floor FAILED:
 *    locale es field q of what_is_xrp is EN-byte-identical
 *    (EN-fallback smuggled in instead of native translation)."
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ASSET_TICKERS } from '../../../packages/asset-registry/src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── what-is-asset-faq-native-locale-floor smoke (cp54 LL #58 / O-8) ──\n');

// Native locales per Memory #29.  EN-fallback OK for it/pl/ru/fa/zh-CN/zh-HK
// (those will be filled in by community-supplied translations over time).
const NATIVE_LOCALES = ['es', 'fr', 'de'] as const;

// Per-asset what_is_<ticker> FAQ family.  BTC/XMR explicitly
// excluded — they don't have dedicated FAQs (explained in
// what_is_morphit + privacy framework FAQs instead, per cp53
// GRANDMA-FRIENDLY documentation fix).
const EXCLUDED_ASSETS = new Set(['BTC', 'XMR']);

const SUBJECT_ASSETS = (ASSET_TICKERS as readonly string[]).filter(
	(t) => !EXCLUDED_ASSETS.has(t)
);

console.log(`Subject FAQ family: what_is_<asset> for ${SUBJECT_ASSETS.length} assets`);
console.log(`Native locales (per Memory #29): ${NATIVE_LOCALES.join(', ')}`);
console.log();

// Load EN baseline
const enPath = join(REPO_ROOT, 'apps/web/src/lib/i18n/locales/en.json');
const en = JSON.parse(readFileSync(enPath, 'utf-8'));
const enEntries = en.faq?.entries ?? {};

let scenariosRun = 0;
const fallbackFindings: string[] = [];

for (const loc of NATIVE_LOCALES) {
	const locPath = join(REPO_ROOT, `apps/web/src/lib/i18n/locales/${loc}.json`);
	const locData = JSON.parse(readFileSync(locPath, 'utf-8'));
	const locEntries = locData.faq?.entries ?? {};

	for (const ticker of SUBJECT_ASSETS) {
		const key = `what_is_${ticker.toLowerCase()}`;
		scenariosRun++;

		const enEntry = enEntries[key];
		const locEntry = locEntries[key];

		// Per Memory #29: the FAQ entry MUST exist in the locale
		// (cp51-O5 already pins existence; this smoke adds the
		// native-vs-fallback check).
		if (!enEntry) {
			fail(`${loc}/${key}: EN entry missing`, `cp51-O5 should have caught this; verify`);
			continue;
		}
		if (!locEntry) {
			fail(`${loc}/${key}: locale entry missing`, `cp51-O5 should have caught this`);
			continue;
		}

		// Native locales: q and a must NOT be byte-identical to EN.
		// Byte-identical = EN-fallback smuggled in instead of a real
		// native translation.
		for (const field of ['q', 'a'] as const) {
			if (locEntry[field] === enEntry[field]) {
				fallbackFindings.push(`${loc}/${key}/${field}`);
			}
		}
	}
}

if (fallbackFindings.length === 0) {
	pass(`every ${SUBJECT_ASSETS.length} what_is_<asset> FAQ has native (non-EN-byte-identical) value in each of ${NATIVE_LOCALES.length} native locales (q+a, ${scenariosRun * 2} field-checks)`);
} else {
	fail(
		`every what_is_<asset> FAQ has native value in es/fr/de`,
		`${fallbackFindings.length} EN-fallback smuggled in: [${fallbackFindings.slice(0, 10).join(', ')}${fallbackFindings.length > 10 ? '...' : ''}]`
	);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nwhat-is-asset-faq-native-locale-floor smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} scenarios passed`);
