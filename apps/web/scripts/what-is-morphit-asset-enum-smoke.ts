#!/usr/bin/env tsx
/**
 * what-is-morphit-asset-enum-smoke.
 *
 * cp131 DEEP-001 STRUCTURAL DEFENSE.
 *
 * The FAQ entry `what_is_morphit` is the FIRST answer a new user
 * reads.  Its body contains a parenthetical enumeration of every
 * asset tradable on Morphit ("(Bitcoin, Monero, BLURT, USDT,
 * USD Coin (USDC), Dai, Bitcoin Cash, Litecoin, Dash, Dogecoin,
 * Zcash, Pirate Chain, Decred, Solana, Ethereum, and XRP)").
 *
 * Drift class caught at cp131: the enumeration stopped at
 * Dogecoin while the registry kept growing through cp124+.  The
 * canonical "Morphit supports these N assets" pitch was
 * underclaiming capability on the headline FAQ for a dozen
 * checkpoints.
 *
 * This smoke pins the enumeration to a per-asset name list
 * derived from packages/asset-registry — every tradable ticker
 * MUST have its display name (or a known alias) appear in the
 * what_is_morphit answer in every locale.
 *
 * Why we accept aliases (e.g. "USD Coin" for USDC, "Dogecoin"
 * for DOGE): the FAQ is human-facing prose; "Dogecoin" reads
 * better than "DOGE" in a sentence-style enumeration.  The
 * smoke accepts either the ticker OR the canonical English
 * display name.
 *
 * Per-locale tolerance: each locale renders names in its own
 * script (zh uses 比特币, fa uses Latin script).  The smoke
 * accepts EITHER the English display name OR the locale's
 * native rendering (sourced from `cheat_sheet.section_assets.*`
 * if present, else falling back to the English form).
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ASSET_TICKERS } from '../../../packages/asset-registry/src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let failed = 0;
let passed = 0;
const failures: string[] = [];

/** English display names + accepted aliases for each ticker.
 *  When extending ASSET_TICKERS, ADD A ROW HERE too — otherwise
 *  this smoke will refuse to recognize the new asset. */
const ENGLISH_NAMES: Record<string, readonly string[]> = {
	BTC: ['Bitcoin', 'BTC'],
	XMR: ['Monero', 'XMR'],
	BLURT: ['BLURT', 'Blurt'],
	USDT: ['USDT', 'Tether'],
	USDC: ['USD Coin', 'USDC'],
	DAI: ['Dai', 'DAI'],
	BCH: ['Bitcoin Cash', 'BCH'],
	LTC: ['Litecoin', 'LTC'],
	DASH: ['Dash', 'DASH'],
	DOGE: ['Dogecoin', 'DOGE'],
	ZEC: ['Zcash', 'ZEC'],
	ARRR: ['Pirate Chain', 'ARRR'],
	DCR: ['Decred', 'DCR'],
	SOL: ['Solana', 'SOL'],
	ETH: ['Ethereum', 'ETH'],
	XRP: ['XRP', 'Ripple']
};

/** Per-locale alternate renderings.  When a locale uses a
 *  native-script name, list it here in addition to the English
 *  alias.  Locales not listed fall through to ENGLISH_NAMES. */
const LOCALE_ALIASES: Record<string, Record<string, readonly string[]>> = {
	'zh-CN': {
		BTC: ['比特币', 'Bitcoin', 'BTC'],
		XMR: ['门罗币', 'Monero', 'XMR'],
		USDC: ['美元币', 'USD Coin', 'USDC'],
		BCH: ['比特币现金', 'Bitcoin Cash', 'BCH'],
		LTC: ['莱特币', 'Litecoin', 'LTC'],
		DASH: ['达世币', 'Dash', 'DASH'],
		DOGE: ['狗狗币', 'Dogecoin', 'DOGE'],
		ETH: ['以太坊', 'Ethereum', 'ETH']
	},
	'zh-HK': {
		BTC: ['比特幣', 'Bitcoin', 'BTC'],
		XMR: ['門羅幣', 'Monero', 'XMR'],
		USDC: ['美元幣', 'USD Coin', 'USDC'],
		BCH: ['比特幣現金', 'Bitcoin Cash', 'BCH'],
		LTC: ['萊特幣', 'Litecoin', 'LTC'],
		DASH: ['達世幣', 'Dash', 'DASH'],
		DOGE: ['狗狗幣', 'Dogecoin', 'DOGE'],
		ETH: ['以太坊', 'Ethereum', 'ETH']
	}
};

function acceptedNames(locale: string, ticker: string): readonly string[] {
	const localeMap = LOCALE_ALIASES[locale];
	if (localeMap && localeMap[ticker]) return localeMap[ticker];
	return ENGLISH_NAMES[ticker] ?? [ticker];
}

const localeDir = join(__dirname, '..', 'src', 'lib', 'i18n', 'locales');
const locales = readdirSync(localeDir)
	.filter((f) => f.endsWith('.json'))
	.map((f) => f.replace('.json', ''))
	.sort();

console.log('── what-is-morphit asset-enum smoke (cp131 DEEP-001) ──\n');
console.log(`  canonical: ${ASSET_TICKERS.length} tradable assets · ${locales.length} locales\n`);

for (const locale of locales) {
	const path = join(localeDir, `${locale}.json`);
	const data = JSON.parse(readFileSync(path, 'utf-8'));
	const answer = data?.faq?.entries?.what_is_morphit?.a;
	if (typeof answer !== 'string' || answer.length === 0) {
		failures.push(`${locale}: faq.entries.what_is_morphit.a missing or not a string`);
		failed++;
		continue;
	}

	for (const ticker of ASSET_TICKERS) {
		const accepted = acceptedNames(locale, ticker);
		const present = accepted.some((name) => answer.includes(name));
		if (present) {
			passed++;
			continue;
		}
		failures.push(
			`${locale}: what_is_morphit answer does NOT enumerate ${ticker} (accepted spellings: ${accepted.join(', ')})`
		);
		failed++;
	}
}

if (failed === 0) {
	console.log(`  ✓ all ${passed} (locale × ticker) presence checks hold`);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
} else {
	for (const f of failures) console.log(`  ✗ ${f}`);
	console.log('\n──────────────────────────────────────────────────────');
	console.error(`✗ ${failed} drift(s) caught: an asset was added without updating what_is_morphit FAQ`);
	process.exit(1);
}
