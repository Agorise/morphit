#!/usr/bin/env tsx
/**
 * faq-per-tradable-asset-parity-smoke.
 *
 * Part 122 cp51 STRUCTURAL DEFENSE (LL #55 / O-5).
 *
 * Closes the cp51-N1 pre-pattern-drift class: every tradable
 * asset on Morphit (except the three coordination/founder assets
 * BTC/XMR/BLURT which have their own FAQ shape — `what_is_blurt`
 * exists as the coordination-chain FAQ) must have a
 * `what_is_<ticker>` FAQ entry in EVERY locale.
 *
 * Bug history that motivated this defense:
 *   - cp21 BCH addition: no `what_is_bch` FAQ shipped.
 *   - cp24 LTC addition: no `what_is_ltc` FAQ shipped.
 *   - cp27 DASH addition: no `what_is_dash` FAQ shipped.
 *   - cp30 USDT addition: pattern established — `what_is_usdt`
 *     FAQ DID ship.  Every subsequent asset (USDC/DAI/DOGE/ZEC/
 *     ARRR/DCR/SOL/ETH/XRP) followed the pattern.
 *   - cp51 deep-deep N-1: surfaced the gap.  3 missing FAQs
 *     added × 10 locales (30 strings); this smoke pins the
 *     pattern forever.
 *
 * Recurring class scope progression:
 *   cp48-O1: standalone smoke scripts
 *   cp49-O2: vitest unit tests
 *   cp50-O3: HTTP route handler regex
 *   cp51-O4: ops-cli per-ticker hardcoded tables (CATEGORY_B_DESCRIPTIONS)
 *   cp51-O5: per-asset i18n FAQ key coverage (THIS smoke)
 *
 * Mutation test verification: M-119 — deleting the FAQ entry
 * for any one asset (e.g. removing `what_is_xrp` from en.json)
 * fires:
 *   "faq-per-tradable-asset-parity FAILED:
 *    locale 'en' missing what_is_xrp FAQ for tradable asset XRP."
 *
 * NOTE: this smoke checks PRESENCE in faq.entries; it does NOT
 * check whether the FAQ is locale-native vs EN-fallback.  That
 * concern is the `native-translations-floor-smoke` job.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ASSET_TICKERS } from '../../../packages/asset-registry/src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── faq-per-tradable-asset-parity smoke (cp51 LL #55 / O-5) ──\n');

const localesDir = join(__dirname, '..', 'src', 'lib', 'i18n', 'locales');
const localeFiles = readdirSync(localesDir).filter((f) => f.endsWith('.json'));
console.log(`Scanning ${localeFiles.length} locale files\n`);

// BTC has no `what_is_btc` FAQ (Morphit's coordination-chain
// framing puts the explanation under `what_is_morphit` +
// `what_is_blurt`).  XMR likewise has no `what_is_xmr` (its
// privacy-by-default is documented in the `privacy_practices`
// FAQ).  BLURT has `what_is_blurt` which is the
// coordination-chain explainer.
//
// Every OTHER asset (trade-only category) must have its FAQ.
const REQUIRED_FAQ_TICKERS = (ASSET_TICKERS as readonly string[])
	.filter((t) => t !== 'BTC' && t !== 'XMR')
	.map((t) => t.toLowerCase());

console.log(`Required FAQ tickers (${REQUIRED_FAQ_TICKERS.length}): ${REQUIRED_FAQ_TICKERS.join(', ')}\n`);

let allPass = true;
for (const file of localeFiles) {
	const loc = file.replace('.json', '');
	const data = JSON.parse(readFileSync(join(localesDir, file), 'utf-8'));
	const entries = data?.faq?.entries ?? {};

	const missing: string[] = [];
	for (const ticker of REQUIRED_FAQ_TICKERS) {
		const key = `what_is_${ticker}`;
		if (!(key in entries)) {
			missing.push(key);
		} else {
			// Verify entry has q and a
			const entry = entries[key];
			if (!entry || typeof entry !== 'object' || !entry.q || !entry.a) {
				missing.push(`${key} (malformed)`);
			}
		}
	}
	if (missing.length === 0) {
		// Pass message is too verbose for the happy path; collapse below
	} else {
		fail(
			`locale '${loc}' has all required asset FAQs`,
			`missing keys: ${missing.join(', ')}.  Add to faq.entries with {q, a} fields.`
		);
		allPass = false;
	}
}

if (allPass) {
	pass(`every locale (${localeFiles.length}) has all ${REQUIRED_FAQ_TICKERS.length} required asset FAQs`);
}

// Also check FAQ_KEYS + FAQ_RELATED in faqIndex.ts
const faqIndexPath = join(__dirname, '..', 'src', 'lib', 'utils', 'faqIndex.ts');
const faqIndexSrc = readFileSync(faqIndexPath, 'utf-8');

const faqKeysMissing: string[] = [];
const faqRelatedMissing: string[] = [];
for (const ticker of REQUIRED_FAQ_TICKERS) {
	const key = `what_is_${ticker}`;
	if (!faqIndexSrc.includes(`'${key}'`)) {
		faqKeysMissing.push(key);
	}
	// FAQ_RELATED entry: `what_is_<ticker>:` on a line
	const relRe = new RegExp(`^\\s*${key}:\\s*\\[`, 'm');
	if (!relRe.test(faqIndexSrc)) {
		faqRelatedMissing.push(key);
	}
}

if (faqKeysMissing.length === 0) {
	pass(`faqIndex.ts FAQ_KEYS contains all ${REQUIRED_FAQ_TICKERS.length} asset FAQ keys`);
} else {
	fail(
		'faqIndex.ts FAQ_KEYS missing entries',
		`missing: ${faqKeysMissing.join(', ')}.  Add to the FAQ_KEYS readonly array.`
	);
}

if (faqRelatedMissing.length === 0) {
	pass(`faqIndex.ts FAQ_RELATED contains all ${REQUIRED_FAQ_TICKERS.length} asset FAQ entries`);
} else {
	fail(
		'faqIndex.ts FAQ_RELATED missing entries',
		`missing: ${faqRelatedMissing.join(', ')}.  Add to FAQ_RELATED record.`
	);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nfaq-per-tradable-asset-parity smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} scenarios passed`);
