#!/usr/bin/env tsx
/**
 * usdc-trade-only-smoke.
 *
 * Part 122 cp30 sentinel: USDC must be `canPayListingFee: false`
 * AND `canBeTraded: true` in BOTH the canonical and frontend
 * asset registries.  If a future contributor toggles either
 * value the wrong way, this smoke fails loudly.
 *
 * Memory #23 invariant pinned from two directions (same as
 * usdt-trade-only-smoke):
 *  - Canonical registry's `canPayListingFee: true → ticker ∈
 *    {BLURT, BTC, XMR}` rule means a future contributor
 *    flipping USDC's flag to true would fail the
 *    asset-registry-smoke first (good defence-in-depth).
 *  - This smoke is the USDC-specific sentinel: USDC must
 *    be trade-only.  If the frontend's canBeUsedForListingFee
 *    drifts from the canonical's canPayListingFee, the user-
 *    facing form would offer USDC as a fee option while the
 *    indexer would reject it — confusing UX.
 *
 * Also asserts USDC carries the four supported networks
 * (ERC-20, SPL, Base, Polygon), defaultNetwork: null (forcing
 * explicit choice every trade), and privacyWarningKey:
 * 'usdc_centralized'.
 *
 * Bonus scenarios specific to USDC (not in USDT smoke):
 *   - BEP-20 is INTENTIONALLY NOT in supportedNetworks (ADR-0028
 *     decline rationale: Binance-Peg wrapper + 18-decimal divergence)
 *   - TRC-20 is similarly excluded (Circle doesn't issue on Tron)
 *   - decimals === 6 (Circle's standard on all four supported
 *     networks; a future contributor adding BEP-20 USDC would need
 *     to confront the 18-decimal divergence first)
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

console.log('\n── usdc-trade-only smoke ─────────────────────────────\n');

// ── Scenario 1 — USDC is in the canonical registry ───────────────
const canonUsdc = CANONICAL.find((a) => a.ticker === 'USDC');
if (canonUsdc) {
	pass('USDC is in canonical registry');
} else {
	fail('USDC is in canonical registry', 'no USDC entry found in @morphit/asset-registry ASSETS');
}

// ── Scenario 2 — canonical USDC.canPayListingFee === false ───────
if (canonUsdc && canonUsdc.canPayListingFee === false) {
	pass('canonical USDC.canPayListingFee === false (memory #23)');
} else {
	fail(
		'canonical USDC.canPayListingFee === false (memory #23)',
		`USDC must be trade-only.  fee_method enum is frozen at BLURT/BTC/XMR; USDC must not pay listing fees.  Got canPayListingFee=${canonUsdc?.canPayListingFee}`
	);
}

// ── Scenario 3 — canonical USDC.canBeTraded === true ─────────────
if (canonUsdc && canonUsdc.canBeTraded === true) {
	pass('canonical USDC.canBeTraded === true');
} else {
	fail(
		'canonical USDC.canBeTraded === true',
		`USDC must be tradable.  Got canBeTraded=${canonUsdc?.canBeTraded}`
	);
}

// ── Scenario 4 — canonical USDC supports 4 networks ──────────────
if (canonUsdc) {
	const networks = [...canonUsdc.supportedNetworks].sort();
	const expected = ['base', 'erc20', 'polygon', 'spl'];
	if (JSON.stringify(networks) === JSON.stringify(expected)) {
		pass('canonical USDC.supportedNetworks = [erc20, spl, base, polygon]');
	} else {
		fail(
			'canonical USDC.supportedNetworks = [erc20, spl, base, polygon]',
			`got ${JSON.stringify(networks)}, expected ${JSON.stringify(expected)}`
		);
	}
}

// ── Scenario 5 — BEP-20 is NOT in supportedNetworks (ADR-0028) ───
// Sentinel against a future contributor adding BEP-20 USDC without
// reading ADR-0028's decline rationale (Binance-Peg = 2 custodians
// + 18-decimal divergence).  If you're here adding BEP-20 USDC,
// first read ADR-0028; update the network metadata module
// (decimals must be per-network if BEP-20 is added at 18); then
// update this smoke.
if (canonUsdc && !canonUsdc.supportedNetworks.includes('bep20')) {
	pass('canonical USDC excludes bep20 (ADR-0028 decline)');
} else {
	fail(
		'canonical USDC excludes bep20 (ADR-0028 decline)',
		'BEP-20 USDC is Binance-Peg (2 custodians) and uses 18 decimals — read ADR-0028 before adding'
	);
}

// ── Scenario 6 — TRC-20 is NOT in supportedNetworks ──────────────
// Circle does not natively issue USDC on Tron — any presence
// there is community-bridged.
if (canonUsdc && !canonUsdc.supportedNetworks.includes('trc20')) {
	pass('canonical USDC excludes trc20 (no native Circle issuance on Tron)');
} else {
	fail(
		'canonical USDC excludes trc20 (no native Circle issuance on Tron)',
		'TRC-20 USDC is community-bridged, not Circle-native'
	);
}

// ── Scenario 7 — defaultNetwork is null (forces explicit choice) ─
if (canonUsdc && canonUsdc.defaultNetwork === null) {
	pass('canonical USDC.defaultNetwork === null (no default — forces explicit choice)');
} else {
	fail(
		'canonical USDC.defaultNetwork === null',
		`Cross-network sends lose funds.  Especially important here: ERC-20, Base, Polygon all use the EVM 0x[40 hex] shape — picker is the only disambiguator.  Got ${canonUsdc?.defaultNetwork}`
	);
}

// ── Scenario 8 — privacyWarningKey set ───────────────────────────
if (canonUsdc && canonUsdc.privacyWarningKey === 'usdc_centralized') {
	pass('canonical USDC.privacyWarningKey === "usdc_centralized"');
} else {
	fail(
		'canonical USDC.privacyWarningKey === "usdc_centralized"',
		`USDC must surface a privacy warning (Memory #19 priority #1).  Got ${canonUsdc?.privacyWarningKey}`
	);
}

// ── Scenario 9 — decimals === 6 ──────────────────────────────────
// Circle uses 6-decimal precision for USDC on all four supported
// networks.  A future contributor adding BEP-20 (which uses 18
// decimals as the BSC token-standard default) would have to break
// this invariant.
if (canonUsdc && canonUsdc.decimals === 6) {
	pass('canonical USDC.decimals === 6 (Circle standard across all 4 networks)');
} else {
	fail(
		'canonical USDC.decimals === 6 (Circle standard across all 4 networks)',
		`Got decimals=${canonUsdc?.decimals}.  If you're adding BEP-20 USDC (18 decimals), see ADR-0028 first.`
	);
}

// ── Scenario 10 — frontend USDC entry mirrors canonical ──────────
const feUsdc = FRONTEND.find((a) => a.ticker === 'usdc');
if (feUsdc) {
	pass('frontend USDC entry exists');
} else {
	fail('frontend USDC entry exists', 'no usdc entry in apps/web/src/lib/assets/registry.ts');
}

// ── Scenario 11 — frontend canBeUsedForListingFee === false ──────
if (feUsdc && feUsdc.canBeUsedForListingFee === false) {
	pass('frontend USDC.canBeUsedForListingFee === false (mirrors canonical)');
} else {
	fail(
		'frontend USDC.canBeUsedForListingFee === false',
		`Frontend must mirror canonical.  Drift = user-facing form offers USDC as a fee option while indexer rejects it.  Got canBeUsedForListingFee=${feUsdc?.canBeUsedForListingFee}`
	);
}

// ── Scenario 12 — frontend USDC.canBeTraded === true ─────────────
if (feUsdc && feUsdc.canBeTraded === true) {
	pass('frontend USDC.canBeTraded === true');
} else {
	fail(
		'frontend USDC.canBeTraded === true',
		`Frontend USDC must be tradable.  Got canBeTraded=${feUsdc?.canBeTraded}`
	);
}

// ── Scenario 13 — frontend USDC.defaultNetwork === null ──────────
if (feUsdc && feUsdc.defaultNetwork === null) {
	pass('frontend USDC.defaultNetwork === null');
} else {
	fail(
		'frontend USDC.defaultNetwork === null',
		`Got ${feUsdc?.defaultNetwork}`
	);
}

// ── Scenario 14 — frontend USDC.privacyWarningKey set ────────────
if (feUsdc && feUsdc.privacyWarningKey === 'usdc_centralized') {
	pass('frontend USDC.privacyWarningKey === "usdc_centralized"');
} else {
	fail(
		'frontend USDC.privacyWarningKey === "usdc_centralized"',
		`Got ${feUsdc?.privacyWarningKey}`
	);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nusdc-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} usdc-trade-only scenarios passed`);
