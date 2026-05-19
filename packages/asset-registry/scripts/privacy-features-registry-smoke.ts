#!/usr/bin/env tsx
/**
 * privacy-features-registry-smoke.
 *
 * Part 122 cp26 sentinel: every asset in the canonical registry
 * must have a non-null, well-formed `privacyFeatures` field.
 * Catches future asset additions that forget to populate it.
 *
 * Asserted:
 *  - Every asset has `privacyFeatures` (not undefined)
 *  - `freshAddressAdvice` is one of the 3 valid values
 *  - `optInPrivacyTech` is null OR a non-empty array of valid
 *    protocol names
 *  - `privacyGuideKey` is a non-empty lowercase string
 *  - Per-ticker invariants: XMR uses 'subaddress', BLURT uses
 *    'account-reuse', BTC/BCH/LTC/DASH/DOGE/USDT/USDC/DAI/ZEC use
 *    'hd-derived'
 *  - XMR has no opt-in tech (already private at chain level)
 *  - USDT/USDC/DAI have no opt-in tech (centralization is the
 *    real issue, not chain-level linkability)
 *  - BLURT has no opt-in tech; DOGE has no opt-in tech (no
 *    native privacy upgrade)
 *  - LTC has 'mweb'; BCH has 'cashfusion'; DASH has
 *    'privatesend'; BTC has both 'coinjoin' and 'payjoin'
 */

import { ASSETS } from '../src/index';

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

console.log('\n── privacy-features-registry smoke ───────────────────\n');

const VALID_ADVICE = new Set(['subaddress', 'hd-derived', 'account-reuse']);
const VALID_TECH = new Set(['mweb', 'cashfusion', 'coinjoin', 'payjoin', 'privatesend', 'shielded-pools', 'csppmix']);

// ── Scenario 1 — every asset has privacyFeatures populated ────
for (const a of ASSETS) {
	if (a.privacyFeatures === undefined || a.privacyFeatures === null) {
		fail(`${a.ticker} has privacyFeatures`, 'undefined or null');
	} else {
		pass(`${a.ticker} has privacyFeatures`);
	}
}

// ── Scenario 2 — freshAddressAdvice is one of 3 valid values ──
for (const a of ASSETS) {
	const advice = a.privacyFeatures?.freshAddressAdvice;
	if (advice === undefined || !VALID_ADVICE.has(advice)) {
		fail(
			`${a.ticker} freshAddressAdvice is valid`,
			`got "${advice}", expected one of ${[...VALID_ADVICE].join('|')}`
		);
	} else {
		pass(`${a.ticker} freshAddressAdvice="${advice}"`);
	}
}

// ── Scenario 3 — optInPrivacyTech is null OR non-empty array ──
for (const a of ASSETS) {
	const tech = a.privacyFeatures?.optInPrivacyTech;
	if (tech === null) {
		pass(`${a.ticker} optInPrivacyTech is null (no opt-in tech)`);
	} else if (!Array.isArray(tech)) {
		fail(`${a.ticker} optInPrivacyTech is array or null`, `got ${typeof tech}`);
	} else if (tech.length === 0) {
		fail(
			`${a.ticker} optInPrivacyTech is non-empty when array`,
			'use null instead of empty array'
		);
	} else {
		const bad = tech.filter((t) => !VALID_TECH.has(t));
		if (bad.length > 0) {
			fail(
				`${a.ticker} optInPrivacyTech values valid`,
				`unknown techs: ${bad.join(', ')}`
			);
		} else {
			pass(`${a.ticker} optInPrivacyTech=[${tech.join(', ')}]`);
		}
	}
}

// ── Scenario 4 — privacyGuideKey is non-empty lowercase ───────
for (const a of ASSETS) {
	const key = a.privacyFeatures?.privacyGuideKey;
	if (typeof key !== 'string' || key.length === 0) {
		fail(`${a.ticker} privacyGuideKey is non-empty string`, `got "${key}"`);
	} else if (key !== key.toLowerCase()) {
		fail(`${a.ticker} privacyGuideKey is lowercase`, `got "${key}"`);
	} else {
		pass(`${a.ticker} privacyGuideKey="${key}"`);
	}
}

// ── Scenario 5 — per-ticker advice expectations ───────────────
const EXPECTED_ADVICE: Readonly<Record<string, string>> = {
	XMR: 'subaddress',
	BTC: 'hd-derived',
	BLURT: 'account-reuse',
	USDT: 'hd-derived',
	USDC: 'hd-derived',
	DAI: 'hd-derived',
	BCH: 'hd-derived',
	LTC: 'hd-derived',
	DASH: 'hd-derived',
	DOGE: 'hd-derived',
	ZEC: 'hd-derived',
	ARRR: 'hd-derived',
	DCR: 'hd-derived'
};
for (const [ticker, expected] of Object.entries(EXPECTED_ADVICE)) {
	const a = ASSETS.find((x) => x.ticker === ticker);
	if (a === undefined) {
		fail(`${ticker} present for advice check`, 'asset not in registry');
		continue;
	}
	const actual = a.privacyFeatures.freshAddressAdvice;
	if (actual !== expected) {
		fail(
			`${ticker}.freshAddressAdvice === "${expected}"`,
			`got "${actual}"`
		);
	} else {
		pass(`${ticker}.freshAddressAdvice === "${expected}"`);
	}
}

// ── Scenario 6 — per-ticker opt-in tech expectations ──────────
const EXPECTED_TECH: Readonly<Record<string, readonly string[] | null>> = {
	XMR: null,
	BTC: ['coinjoin', 'payjoin'],
	BLURT: null,
	USDT: null,
	USDC: null,
	DAI: null,
	BCH: ['cashfusion'],
	LTC: ['mweb'],
	DASH: ['privatesend'],
	DOGE: null,
	ZEC: ['shielded-pools'],
	ARRR: ['shielded-pools'],
	DCR: ['csppmix']
};
for (const [ticker, expected] of Object.entries(EXPECTED_TECH)) {
	const a = ASSETS.find((x) => x.ticker === ticker);
	if (a === undefined) continue;
	const actual = a.privacyFeatures.optInPrivacyTech;
	if (expected === null) {
		if (actual !== null) {
			fail(`${ticker}.optInPrivacyTech === null`, `got ${JSON.stringify(actual)}`);
		} else {
			pass(`${ticker}.optInPrivacyTech === null`);
		}
	} else {
		if (actual === null) {
			fail(
				`${ticker}.optInPrivacyTech === [${expected.join(', ')}]`,
				'got null'
			);
		} else if (
			actual.length !== expected.length ||
			!expected.every((t) => actual.includes(t))
		) {
			fail(
				`${ticker}.optInPrivacyTech === [${expected.join(', ')}]`,
				`got [${actual.join(', ')}]`
			);
		} else {
			pass(`${ticker}.optInPrivacyTech === [${expected.join(', ')}]`);
		}
	}
}

// ── Scenario 4 — every registered tech tag has its i18n keys (cp40-I2) ─
// CP39 shipped 'shielded-pools' tech tag for ZEC but forgot to add the
// corresponding `privacy.opt_in_tech.shielded-pools.{name,explain}` i18n
// keys. The /privacy/zec route reads these dynamically via
// `$_(\`privacy.opt_in_tech.${tech}.name\`)`, so a missing key surfaces
// as literal-key text to the user. Cp40 closed the bug and added this
// defensive smoke so any future tech addition that forgets the i18n
// pairs fires loud.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const enPath = resolve(__dirname, '../../../apps/web/src/lib/i18n/locales/en.json');
let en: Record<string, unknown>;
try {
	en = JSON.parse(readFileSync(enPath, 'utf8')) as Record<string, unknown>;
} catch (e) {
	fail('en.json loadable for tech-i18n parity check', String(e));
	en = {};
}

const i18nTechs = (en.privacy as Record<string, unknown> | undefined)?.opt_in_tech as
	| Record<string, { name?: string; explain?: string }>
	| undefined;

// Collect every tech that appears in the canonical registry
const techsInRegistry = new Set<string>();
for (const a of ASSETS) {
	const t = a.privacyFeatures?.optInPrivacyTech;
	if (t) for (const tag of t) techsInRegistry.add(tag);
}

for (const tag of techsInRegistry) {
	const entry = i18nTechs?.[tag];
	const hasName = typeof entry?.name === 'string' && entry.name.length > 0;
	const hasExplain = typeof entry?.explain === 'string' && entry.explain.length > 0;
	if (hasName && hasExplain) {
		pass(`i18n: privacy.opt_in_tech.${tag}.{name,explain} both present in en.json`);
	} else {
		fail(
			`i18n: privacy.opt_in_tech.${tag}.{name,explain} both present in en.json`,
			`name=${hasName ? 'OK' : 'MISSING'} explain=${hasExplain ? 'OK' : 'MISSING'}`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nprivacy-features-registry smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} privacy-features-registry scenarios passed`);
