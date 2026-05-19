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
 *    'account-reuse', BTC/BCH/LTC/DASH/DOGE/USDT/USDC/DAI use
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
const VALID_TECH = new Set(['mweb', 'cashfusion', 'coinjoin', 'payjoin', 'privatesend']);

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
	DOGE: 'hd-derived'
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
	DOGE: null
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

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nprivacy-features-registry smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} privacy-features-registry scenarios passed`);
