#!/usr/bin/env tsx
/**
 * ltc-trade-only-smoke.
 *
 * Part 122 cp24 sentinel: LTC must be `canPayListingFee: false`
 * AND `canBeTraded: true` in BOTH the canonical and frontend
 * asset registries.  If a future contributor toggles either
 * value the wrong way, this smoke fails loudly.
 *
 * Memory #23 invariant pinned from two directions:
 *  - Canonical registry's `canPayListingFee: true → ticker ∈
 *    {BLURT, BTC, XMR}` rule means a future contributor
 *    flipping LTC's flag to true would fail the
 *    asset-registry-smoke first (good defence-in-depth).
 *  - This smoke is the LTC-specific sentinel: LTC must
 *    be trade-only.  If the frontend's canBeUsedForListingFee
 *    drifts from the canonical's canPayListingFee, the user-
 *    facing form would offer LTC as a fee option while the
 *    indexer would reject it — confusing UX.
 *
 * Also asserts LTC ships single-network (mainnet only),
 * defaultNetwork: 'mainnet' (no picker shown), and
 * privacyWarningKey: null (LTC is transparent like BTC but
 * decentralized — no issuer-freeze risk, same posture as BTC).
 */

import { ASSETS as CANONICAL } from '../src/index';
import { ASSETS as FRONTEND } from '../../../apps/web/src/lib/assets/registry';

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

console.log('\n── ltc-trade-only smoke ──────────────────────────────\n');

// ── Scenario 1 — LTC is in the canonical registry ────────────────
const canonLtc = CANONICAL.find((a) => a.ticker === 'LTC');
if (canonLtc) {
	pass('LTC is in canonical registry');
} else {
	fail('LTC is in canonical registry', 'no LTC entry found in @morphit/asset-registry ASSETS');
}

// ── Scenario 2 — canonical LTC.canPayListingFee === false ────────
if (canonLtc && canonLtc.canPayListingFee === false) {
	pass('canonical LTC.canPayListingFee === false (memory #23)');
} else {
	fail(
		'canonical LTC.canPayListingFee === false (memory #23)',
		`LTC must be trade-only.  Got canPayListingFee=${canonLtc?.canPayListingFee}`
	);
}

// ── Scenario 3 — canonical LTC.canBeTraded === true ──────────────
if (canonLtc && canonLtc.canBeTraded === true) {
	pass('canonical LTC.canBeTraded === true');
} else {
	fail(
		'canonical LTC.canBeTraded === true',
		`LTC must be tradable.  Got canBeTraded=${canonLtc?.canBeTraded}`
	);
}

// ── Scenario 4 — canonical LTC single-network (mainnet) ──────────
if (canonLtc) {
	const networks = [...canonLtc.supportedNetworks];
	if (networks.length === 1 && networks[0] === 'mainnet') {
		pass('canonical LTC.supportedNetworks = [mainnet] (single-network)');
	} else {
		fail(
			'canonical LTC.supportedNetworks = [mainnet]',
			`LTC is single-network.  Got ${JSON.stringify(networks)}`
		);
	}
}

// ── Scenario 5 — defaultNetwork is 'mainnet' (no picker needed) ──
if (canonLtc && canonLtc.defaultNetwork === 'mainnet') {
	pass('canonical LTC.defaultNetwork === "mainnet" (no network picker)');
} else {
	fail(
		'canonical LTC.defaultNetwork === "mainnet"',
		`Single-network asset must set defaultNetwork to its only network.  Got ${canonLtc?.defaultNetwork}`
	);
}

// ── Scenario 6 — privacyWarningKey is null ───────────────────────
if (canonLtc && canonLtc.privacyWarningKey === null) {
	pass('canonical LTC.privacyWarningKey === null (transparent + decentralized, same posture as BTC)');
} else {
	fail(
		'canonical LTC.privacyWarningKey === null',
		`LTC is transparent (like BTC) but decentralized — no issuer can freeze addresses, so no warning needed.  Got ${canonLtc?.privacyWarningKey}`
	);
}

// ── Scenario 7 — decimals === 8 (matches BTC's satoshi unit) ─────
if (canonLtc && canonLtc.decimals === 8) {
	pass('canonical LTC.decimals === 8 (sat-denominated, same as BTC)');
} else {
	fail(
		'canonical LTC.decimals === 8',
		`LTC preserved BTC's 8-decimal smallest-unit semantics across the 2017 fork.  Got decimals=${canonLtc?.decimals}`
	);
}

// ── Scenario 8 — frontend LTC entry mirrors canonical ────────────
const feLtc = FRONTEND.find((a) => a.ticker === 'ltc');
if (feLtc) {
	pass('frontend LTC entry exists');
} else {
	fail('frontend LTC entry exists', 'no ltc entry in apps/web/src/lib/assets/registry.ts');
}

// ── Scenario 9 — frontend canBeUsedForListingFee === false ───────
if (feLtc && feLtc.canBeUsedForListingFee === false) {
	pass('frontend LTC.canBeUsedForListingFee === false (mirrors canonical)');
} else {
	fail(
		'frontend LTC.canBeUsedForListingFee === false',
		`Frontend must mirror canonical.  Drift = user-facing form offers LTC as a fee option while indexer rejects it.  Got canBeUsedForListingFee=${feLtc?.canBeUsedForListingFee}`
	);
}

// ── Scenario 10 — frontend LTC.canBeTraded === true ──────────────
if (feLtc && feLtc.canBeTraded === true) {
	pass('frontend LTC.canBeTraded === true');
} else {
	fail(
		'frontend LTC.canBeTraded === true',
		`Frontend LTC must be tradable.  Got canBeTraded=${feLtc?.canBeTraded}`
	);
}

// ── Scenario 11 — frontend LTC.defaultNetwork === 'mainnet' ──────
if (feLtc && feLtc.defaultNetwork === 'mainnet') {
	pass('frontend LTC.defaultNetwork === "mainnet"');
} else {
	fail(
		'frontend LTC.defaultNetwork === "mainnet"',
		`Got ${feLtc?.defaultNetwork}`
	);
}

// ── Scenario 12 — frontend LTC.privacyWarningKey is null ─────────
if (feLtc && feLtc.privacyWarningKey === null) {
	pass('frontend LTC.privacyWarningKey === null');
} else {
	fail(
		'frontend LTC.privacyWarningKey === null',
		`Got ${feLtc?.privacyWarningKey}`
	);
}

// ── Scenario 13 — address validator accepts LTC address forms ───────
if (feLtc) {
	// Test addresses (verified-shape — not real funds):
	//  - Legacy P2PKH (L-prefix, unambiguous with BTC)
	//  - Modern P2SH (M-prefix, introduced 2017 to disambiguate)
	//  - Deprecated P2SH (3-prefix, BTC-shape ambiguous per ADR-0025 §4)
	//  - Bech32 segwit (ltc1q...)
	//  - Bech32m taproot (ltc1p...)
	const validLegacyP2PKH = 'LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL';
	const validModernP2SH = 'MGV5n4ZdyhqEPdfFsy7XPYZeMfQqmnK1qz';
	const validDeprecatedP2SH = '3P14159f73E4gFr7JterCCQh9QjiTjiZrG';
	const validBech32Segwit = 'ltc1qhvkypg3aqe8xkwyjyzcf6c7d0ck9pevjk2yuva';
	const validBech32mTaproot = 'ltc1pxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
	const invalidGarbage = 'definitely-not-a-ltc-address';
	const invalidPrefix = '4P14159f73E4gFr7JterCCQh9QjiTjiZrG';
	const checks: [string, boolean][] = [
		['legacy P2PKH (L-prefix) accepted', feLtc.addressValidator(validLegacyP2PKH)],
		['modern P2SH (M-prefix) accepted', feLtc.addressValidator(validModernP2SH)],
		['deprecated P2SH (3-prefix) accepted', feLtc.addressValidator(validDeprecatedP2SH)],
		['bech32 segwit (ltc1q) accepted', feLtc.addressValidator(validBech32Segwit)],
		['bech32m taproot (ltc1p) accepted', feLtc.addressValidator(validBech32mTaproot)],
		['garbage rejected', !feLtc.addressValidator(invalidGarbage)],
		['invalid prefix (4...) rejected', !feLtc.addressValidator(invalidPrefix)]
	];
	const allPassed = checks.every(([, ok]) => ok);
	if (allPassed) {
		pass('frontend LTC addressValidator accepts all 4 LTC formats, rejects garbage');
	} else {
		const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
		fail(
			'frontend LTC addressValidator accepts all 4 LTC formats, rejects garbage',
			`failed sub-checks: ${failed.join(', ')}`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nltc-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} ltc-trade-only scenarios passed`);
