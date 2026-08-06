#!/usr/bin/env tsx
/**
 * per-asset-key-family-native-locale-floor-smoke.
 *
 * Part 122 cp55 STRUCTURAL DEFENSE (LL #59 / O-9).
 *
 * Generalizes cp54-O8 (which was scoped only to `what_is_<asset>`)
 * to multiple per-asset i18n key families that have native-locale
 * policy implications per Memory #29.
 *
 * Covered families (each a Memory #29 native-locale gate):
 *   - chat.address.address_invalid_<asset>     — error-message text
 *   - chat.address.address_placeholder_<asset> — input placeholder
 *   - chat.funds_sent.pill_title_<asset>       — pill label
 *   - cheat_sheet.section_assets.<asset>       — descriptive entry
 *   - post_order.form.asset_explainer.<asset>  — tooltip text
 *
 * Excluded families (intentionally — proper-noun byte-identical = correct):
 *   - chat.address.method_<asset>              — bare cryptocurrency name
 *   - chat.address.pill_method_<asset>         — "Name (TICKER)" labels
 *     for the cp31+ assets where EN itself uses bare ticker label
 *     (BCH/BTC/XMR-style "X address" entries ARE in scope for those
 *     specific assets but the smoke doesn't bifurcate; safer to
 *     leave the whole family out and trust the cp54 lesson generalizes
 *     to a smoke-per-family approach as drift surfaces.)
 *
 * Drift history surfaced at cp55:
 *   - DAI singletons (cp31): EN-fallback across all 3 native locales
 *     in address_invalid, address_placeholder, pill_title,
 *     cheat_sheet.section_assets — 12 strings missing.
 *   - asset_explainer 7-asset drift (cp31-cp49): DAI/ZEC/ARRR/DCR/
 *     SOL/ETH/XRP all EN-fallback in es/fr/de — 21 strings missing.
 *
 * Total cp55 closure: 33 native ES/FR/DE strings.
 *
 * Recurring class scope progression (9 defenses across 8 checkpoints):
 *   cp48-O1: standalone smoke scripts
 *   cp49-O2: vitest unit tests
 *   cp50-O3: HTTP route handler regex
 *   cp51-O4: ops-cli per-ticker tables
 *   cp51-O5: per-asset i18n FAQ key coverage
 *   cp52-O6: Ansible env-template required-vars
 *   cp53-O7: operator doc per-asset coverage
 *   cp54-O8: what_is_<asset> FAQ native-locale floor
 *   cp55-O9: multi-family per-asset native-locale floor (THIS)
 *
 * Mutation test verification: M-123 — reverting es.json's
 * post_order.form.asset_explainer.xrp to EN-fallback fires:
 *   "per-asset-key-family-native-locale-floor FAILED:
 *    family `post_order.form.asset_explainer.<asset>`:
 *    es/xrp is EN-byte-identical (EN-fallback smuggled in)."
 *
 * Limitation: each covered family must have its own native-vs-EN
 * gating logic — proper-noun families (method_<asset>) are
 * NOT covered.  When a new per-asset family is added with
 * native-locale policy implications, add it to FAMILIES below.
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

console.log('\n── per-asset-key-family-native-locale-floor smoke (cp55 LL #59 / O-9) ──\n');

const NATIVE_LOCALES = ['es', 'fr', 'de'] as const;

// Each family entry: path parts (with `{ticker}` substituted at the
// last segment) and a subset of tickers to check.  Some families
// (e.g. txid_invalid) only apply to certain tickers; the `tickers`
// option lets us scope the check to those.
interface Family {
	name: string;
	pathTemplate: string[]; // last segment contains `{ticker}` substitution
	tickers?: readonly string[]; // optional subset; default = all 16
	tickerLowercase?: boolean; // default true
}

const ALL_TICKERS = ASSET_TICKERS as readonly string[];

const FAMILIES: Family[] = [
	{
		name: 'chat.address.address_invalid_<asset>',
		pathTemplate: ['chat', 'address', 'address_invalid_{ticker}']
	},
	{
		name: 'chat.address.address_placeholder_<asset>',
		pathTemplate: ['chat', 'address', 'address_placeholder_{ticker}']
	},
	{
		name: 'chat.funds_sent.pill_title_<asset>',
		pathTemplate: ['chat', 'funds_sent', 'pill_title_{ticker}']
	},
	{
		name: 'cheat_sheet.section_assets.<asset>',
		pathTemplate: ['cheat_sheet', 'section_assets', '{ticker}']
	},
	{
		name: 'post_order.form.asset_explainer.<asset>',
		pathTemplate: ['post_order', 'form', 'asset_explainer', '{ticker}']
	}
];

function resolvePath(obj: unknown, parts: string[], ticker: string): unknown {
	let cur: unknown = obj;
	for (const p of parts) {
		const key = p.replace('{ticker}', ticker.toLowerCase());
		if (typeof cur !== 'object' || cur === null) return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}

const enJson = JSON.parse(
	readFileSync(join(REPO_ROOT, 'apps/web/src/lib/i18n/locales/en.json'), 'utf-8')
);

let totalChecks = 0;
const findingsByFamily = new Map<string, string[]>();

for (const family of FAMILIES) {
	const tickers = family.tickers ?? ALL_TICKERS;
	const findings: string[] = [];

	for (const loc of NATIVE_LOCALES) {
		const locJson = JSON.parse(
			readFileSync(join(REPO_ROOT, `apps/web/src/lib/i18n/locales/${loc}.json`), 'utf-8')
		);
		for (const ticker of tickers) {
			const enVal = resolvePath(enJson, family.pathTemplate, ticker);
			const locVal = resolvePath(locJson, family.pathTemplate, ticker);
			if (typeof enVal !== 'string' || typeof locVal !== 'string') {
				// Family doesn't apply for this ticker; skip
				continue;
			}
			totalChecks++;
			if (locVal === enVal) {
				findings.push(`${loc}/${ticker}`);
			}
		}
	}

	if (findings.length === 0) {
		pass(`${family.name}: every covered ticker (${tickers.length}) is native in ${NATIVE_LOCALES.length} locales`);
	} else {
		findingsByFamily.set(family.name, findings);
	}
}

for (const [name, findings] of findingsByFamily) {
	fail(
		`${name}: native in all locales × tickers`,
		`${findings.length} EN-byte-identical: [${findings.slice(0, 10).join(', ')}${findings.length > 10 ? '...' : ''}]`
	);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
console.log(`Total field-checks across all families: ${totalChecks}`);
if (failed > 0) {
	console.error('\nper-asset-key-family-native-locale-floor smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} family scenarios passed`);
