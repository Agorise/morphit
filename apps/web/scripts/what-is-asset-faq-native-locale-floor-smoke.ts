#!/usr/bin/env tsx
/**
 * what-is-asset-faq-native-locale-floor-smoke.
 *
 * STRUCTURAL DEFENSE.
 *
 * Closes the native-locale drift class: per the native-locale policy,
 * EVERY new i18n key MUST be NATIVE in en/es/fr/de and may be
 * EN-fallback in it/pl/ru/fa/zh-CN/zh-HK.  For the per-asset
 * `what_is_<asset>` FAQ family specifically, this smoke pins
 * that NATIVE en/es/fr/de invariant — values in es/fr/de MUST
 * NOT be byte-identical to en (which would indicate EN-fallback
 * smuggled in instead of a native translation).
 *
 * Drift history surfaced:
 *   - usdt (part 121), usdc, doge: native ES/FR/DE ✓
 *   - dai, zec, arrr, dcr, sol,
 *     eth, xrp: EN-fallback in es/fr/de ✗
 *   - bch (backfill), ltc, dash: EN-fallback ✗
 *
 * Total drift discovery: 10 FAQs × 3 native locales × 2
 * fields = 60 missing native translations spanning 7+ checkpoints.
 *
 * wrote all 60 native translations inline; this smoke pins
 * the floor going forward.
 *
 * Recurring class scope progression (8 defenses across 7 checkpoints):
 *   standalone smoke scripts
 *   vitest unit tests
 *   HTTP route handler regex
 *   ops-cli per-ticker hardcoded tables
 *   per-asset i18n FAQ key coverage
 *   Ansible env-template required-var parity
 *   operator doc per-asset coverage
 *   per-asset FAQ native-locale floor (THIS)
 *
 * Mutation test verification: — reverting es.json's
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

// Native locales per the native-locale policy.  EN-fallback OK for it/pl/ru/fa/zh-CN/zh-HK
// (those will be filled in by community-supplied translations over time).
const NATIVE_LOCALES = ['es', 'fr', 'de'] as const;

// Per-asset what_is_<ticker> FAQ family.  BTC/XMR explicitly
// excluded — they don't have dedicated FAQs (explained in
// what_is_morphit + privacy framework FAQs instead, per the
// grandma-UX documentation fix).
const EXCLUDED_ASSETS = new Set(['BTC', 'XMR']);

const SUBJECT_ASSETS = (ASSET_TICKERS as readonly string[]).filter(
	(t) => !EXCLUDED_ASSETS.has(t)
);

console.log(`Subject FAQ family: what_is_<asset> for ${SUBJECT_ASSETS.length} assets`);
console.log(`Native locales (per the native-locale policy): ${NATIVE_LOCALES.join(', ')}`);
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

		// Per the native-locale policy: the FAQ entry MUST exist in the locale
		// (already pins existence; this smoke adds the
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
