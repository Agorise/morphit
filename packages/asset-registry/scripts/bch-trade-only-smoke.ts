#!/usr/bin/env tsx
/**
 * bch-trade-only-smoke.
 *
 * Part 122 cp21 sentinel: BCH must be `canPayListingFee: false`
 * AND `canBeTraded: true` in BOTH the canonical and frontend
 * asset registries.  If a future contributor toggles either
 * value the wrong way, this smoke fails loudly.
 *
 * Memory #23 invariant pinned from two directions:
 *  - Canonical registry's `canPayListingFee: true → ticker ∈
 *    {BLURT, BTC, XMR}` rule means a future contributor
 *    flipping BCH's flag to true would fail the
 *    asset-registry-smoke first (good defence-in-depth).
 *  - This smoke is the BCH-specific sentinel: BCH must
 *    be trade-only.  If the frontend's canBeUsedForListingFee
 *    drifts from the canonical's canPayListingFee, the user-
 *    facing form would offer BCH as a fee option while the
 *    indexer would reject it — confusing UX.
 *
 * Also asserts BCH ships single-network (mainnet only),
 * defaultNetwork: 'mainnet' (no picker shown), and
 * privacyWarningKey: null (BCH is transparent like BTC but
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

console.log('\n── bch-trade-only smoke ──────────────────────────────\n');

// ── Scenario 1 — BCH is in the canonical registry ────────────────
const canonBch = CANONICAL.find((a) => a.ticker === 'BCH');
if (canonBch) {
	pass('BCH is in canonical registry');
} else {
	fail('BCH is in canonical registry', 'no BCH entry found in @morphit/asset-registry ASSETS');
}

// ── Scenario 2 — canonical BCH.canPayListingFee === false ────────
if (canonBch && canonBch.canPayListingFee === false) {
	pass('canonical BCH.canPayListingFee === false (memory #23)');
} else {
	fail(
		'canonical BCH.canPayListingFee === false (memory #23)',
		`BCH must be trade-only.  Got canPayListingFee=${canonBch?.canPayListingFee}`
	);
}

// ── Scenario 3 — canonical BCH.canBeTraded === true ──────────────
if (canonBch && canonBch.canBeTraded === true) {
	pass('canonical BCH.canBeTraded === true');
} else {
	fail(
		'canonical BCH.canBeTraded === true',
		`BCH must be tradable.  Got canBeTraded=${canonBch?.canBeTraded}`
	);
}

// ── Scenario 4 — canonical BCH single-network (mainnet) ──────────
if (canonBch) {
	const networks = [...canonBch.supportedNetworks];
	if (networks.length === 1 && networks[0] === 'mainnet') {
		pass('canonical BCH.supportedNetworks = [mainnet] (single-network)');
	} else {
		fail(
			'canonical BCH.supportedNetworks = [mainnet]',
			`BCH is single-network.  Got ${JSON.stringify(networks)}`
		);
	}
}

// ── Scenario 5 — defaultNetwork is 'mainnet' (no picker needed) ──
if (canonBch && canonBch.defaultNetwork === 'mainnet') {
	pass('canonical BCH.defaultNetwork === "mainnet" (no network picker)');
} else {
	fail(
		'canonical BCH.defaultNetwork === "mainnet"',
		`Single-network asset must set defaultNetwork to its only network.  Got ${canonBch?.defaultNetwork}`
	);
}

// ── Scenario 6 — privacyWarningKey is null ───────────────────────
if (canonBch && canonBch.privacyWarningKey === null) {
	pass('canonical BCH.privacyWarningKey === null (transparent + decentralized, same posture as BTC)');
} else {
	fail(
		'canonical BCH.privacyWarningKey === null',
		`BCH is transparent (like BTC) but decentralized — no issuer can freeze addresses, so no warning needed.  Got ${canonBch?.privacyWarningKey}`
	);
}

// ── Scenario 7 — decimals === 8 (matches BTC's satoshi unit) ─────
if (canonBch && canonBch.decimals === 8) {
	pass('canonical BCH.decimals === 8 (sat-denominated, same as BTC)');
} else {
	fail(
		'canonical BCH.decimals === 8',
		`BCH preserved BTC's 8-decimal smallest-unit semantics across the 2017 fork.  Got decimals=${canonBch?.decimals}`
	);
}

// ── Scenario 8 — frontend BCH entry mirrors canonical ────────────
const feBch = FRONTEND.find((a) => a.ticker === 'bch');
if (feBch) {
	pass('frontend BCH entry exists');
} else {
	fail('frontend BCH entry exists', 'no bch entry in apps/web/src/lib/assets/registry.ts');
}

// ── Scenario 9 — frontend canBeUsedForListingFee === false ───────
if (feBch && feBch.canBeUsedForListingFee === false) {
	pass('frontend BCH.canBeUsedForListingFee === false (mirrors canonical)');
} else {
	fail(
		'frontend BCH.canBeUsedForListingFee === false',
		`Frontend must mirror canonical.  Drift = user-facing form offers BCH as a fee option while indexer rejects it.  Got canBeUsedForListingFee=${feBch?.canBeUsedForListingFee}`
	);
}

// ── Scenario 10 — frontend BCH.canBeTraded === true ──────────────
if (feBch && feBch.canBeTraded === true) {
	pass('frontend BCH.canBeTraded === true');
} else {
	fail(
		'frontend BCH.canBeTraded === true',
		`Frontend BCH must be tradable.  Got canBeTraded=${feBch?.canBeTraded}`
	);
}

// ── Scenario 11 — frontend BCH.defaultNetwork === 'mainnet' ──────
if (feBch && feBch.defaultNetwork === 'mainnet') {
	pass('frontend BCH.defaultNetwork === "mainnet"');
} else {
	fail(
		'frontend BCH.defaultNetwork === "mainnet"',
		`Got ${feBch?.defaultNetwork}`
	);
}

// ── Scenario 12 — frontend BCH.privacyWarningKey is null ─────────
if (feBch && feBch.privacyWarningKey === null) {
	pass('frontend BCH.privacyWarningKey === null');
} else {
	fail(
		'frontend BCH.privacyWarningKey === null',
		`Got ${feBch?.privacyWarningKey}`
	);
}

// ── Scenario 13 — address validator accepts CashAddr forms ───────
if (feBch) {
	// Test addresses (verified-shape — not real funds):
	//  - Bare CashAddr P2PKH
	//  - Prefixed CashAddr P2PKH (`bitcoincash:q...`)
	//  - Prefixed CashAddr P2SH (`bitcoincash:p...`)
	//  - Legacy P2PKH (BTC-style 1...)
	//  - Legacy P2SH (BTC-style 3...)
	const validBareCashAddr = 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
	const validPrefixedCashAddr = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
	const validPrefixedP2SH = 'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
	const validLegacyP2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
	const validLegacyP2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
	const invalidGarbage = 'definitely-not-a-bch-address';
	const checks: [string, boolean][] = [
		['bare-CashAddr P2PKH accepted', feBch.addressValidator(validBareCashAddr)],
		['prefixed CashAddr P2PKH accepted', feBch.addressValidator(validPrefixedCashAddr)],
		['prefixed CashAddr P2SH accepted', feBch.addressValidator(validPrefixedP2SH)],
		['legacy P2PKH accepted', feBch.addressValidator(validLegacyP2PKH)],
		['legacy P2SH accepted', feBch.addressValidator(validLegacyP2SH)],
		['garbage rejected', !feBch.addressValidator(invalidGarbage)]
	];
	const allPassed = checks.every(([, ok]) => ok);
	if (allPassed) {
		pass('frontend BCH addressValidator accepts CashAddr + legacy, rejects garbage');
	} else {
		const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
		fail(
			'frontend BCH addressValidator accepts CashAddr + legacy, rejects garbage',
			`failed sub-checks: ${failed.join(', ')}`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nbch-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} bch-trade-only scenarios passed`);
