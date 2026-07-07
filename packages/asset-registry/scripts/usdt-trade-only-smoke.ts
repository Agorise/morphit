#!/usr/bin/env tsx
/**
 * usdt-trade-only-smoke.
 *
 * Part 121 sentinel: USDT must be `canPayListingFee: false`
 * AND `canBeTraded: true` in BOTH the canonical and frontend
 * asset registries.  If a future contributor toggles either
 * value the wrong way, this smoke fails loudly.
 *
 * Memory #23 invariant pinned from two directions:
 *  - Canonical registry's `canPayListingFee: true → ticker ∈
 *    {BLURT, BTC, XMR}` rule means a future contributor
 *    flipping USDT's flag to true would fail the
 *    asset-registry-smoke first (good defence-in-depth).
 *  - This smoke is the USDT-specific sentinel: USDT must
 *    be trade-only.  If the frontend's canBeUsedForListingFee
 *    drifts from the canonical's canPayListingFee, the user-
 *    facing form would offer USDT as a fee option while the
 *    indexer would reject it — confusing UX.
 *
 * Also asserts USDT carries the four supported networks
 * (ERC-20, TRC-20, SPL, BEP-20), defaultNetwork: null (forcing
 * explicit choice every trade), and privacyWarningKey:
 * 'usdt_centralized'.
 */

import { ASSETS as CANONICAL, getAsset as canonGetAsset } from '../src/index';
import { ASSETS as FRONTEND, getAsset as feGetAsset } from '../../../apps/web/src/lib/assets/registry';

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

console.log('\n── usdt-trade-only smoke ─────────────────────────────\n');

// ── Scenario 1 — USDT is in the canonical registry ───────────────
const canonUsdt = CANONICAL.find((a) => a.ticker === 'USDT');
if (canonUsdt) {
	pass('USDT is in canonical registry');
} else {
	fail('USDT is in canonical registry', 'no USDT entry found in @morphit/asset-registry ASSETS');
}

// ── Scenario 2 — canonical USDT.canPayListingFee === false ───────
if (canonUsdt && canonUsdt.canPayListingFee === false) {
	pass('canonical USDT.canPayListingFee === false (memory #23)');
} else {
	fail(
		'canonical USDT.canPayListingFee === false (memory #23)',
		`USDT must be trade-only.  Got canPayListingFee=${canonUsdt?.canPayListingFee}`
	);
}

// ── Scenario 3 — canonical USDT.canBeTraded === true ─────────────
if (canonUsdt && canonUsdt.canBeTraded === true) {
	pass('canonical USDT.canBeTraded === true');
} else {
	fail(
		'canonical USDT.canBeTraded === true',
		`USDT must be tradable.  Got canBeTraded=${canonUsdt?.canBeTraded}`
	);
}

// ── Scenario 4 — canonical USDT supports 4 networks ──────────────
if (canonUsdt) {
	const networks = [...canonUsdt.supportedNetworks].sort();
	const expected = ['bep20', 'erc20', 'spl', 'trc20'];
	if (JSON.stringify(networks) === JSON.stringify(expected)) {
		pass('canonical USDT.supportedNetworks = [erc20, trc20, spl, bep20]');
	} else {
		fail(
			'canonical USDT.supportedNetworks = [erc20, trc20, spl, bep20]',
			`got ${JSON.stringify(networks)}, expected ${JSON.stringify(expected)}`
		);
	}
}

// ── Scenario 5 — defaultNetwork is null (forces explicit choice) ─
if (canonUsdt && canonUsdt.defaultNetwork === null) {
	pass('canonical USDT.defaultNetwork === null (no default — forces explicit choice)');
} else {
	fail(
		'canonical USDT.defaultNetwork === null',
		`Cross-network sends lose funds.  defaultNetwork MUST be null so the form requires explicit user choice.  Got ${canonUsdt?.defaultNetwork}`
	);
}

// ── Scenario 6 — privacyWarningKey set ───────────────────────────
if (canonUsdt && canonUsdt.privacyWarningKey === 'usdt_centralized') {
	pass('canonical USDT.privacyWarningKey === "usdt_centralized"');
} else {
	fail(
		'canonical USDT.privacyWarningKey === "usdt_centralized"',
		`USDT must surface a privacy warning (Memory #19 priority #1).  Got ${canonUsdt?.privacyWarningKey}`
	);
}

// ── Scenario 7 — frontend USDT entry mirrors canonical ───────────
const feUsdt = FRONTEND.find((a) => a.ticker === 'usdt');
if (feUsdt) {
	pass('frontend USDT entry exists');
} else {
	fail('frontend USDT entry exists', 'no usdt entry in apps/web/src/lib/assets/registry.ts');
}

// ── Scenario 8 — frontend canBeUsedForListingFee === false ───────
if (feUsdt && feUsdt.canBeUsedForListingFee === false) {
	pass('frontend USDT.canBeUsedForListingFee === false (mirrors canonical)');
} else {
	fail(
		'frontend USDT.canBeUsedForListingFee === false',
		`Frontend must mirror canonical.  Drift = user-facing form offers USDT as a fee option while indexer rejects it.  Got canBeUsedForListingFee=${feUsdt?.canBeUsedForListingFee}`
	);
}

// ── Scenario 9 — frontend USDT.canBeTraded === true ──────────────
if (feUsdt && feUsdt.canBeTraded === true) {
	pass('frontend USDT.canBeTraded === true');
} else {
	fail(
		'frontend USDT.canBeTraded === true',
		`Frontend USDT must be tradable.  Got canBeTraded=${feUsdt?.canBeTraded}`
	);
}

// ── Scenario 10 — frontend USDT.defaultNetwork === null ──────────
if (feUsdt && feUsdt.defaultNetwork === null) {
	pass('frontend USDT.defaultNetwork === null');
} else {
	fail(
		'frontend USDT.defaultNetwork === null',
		`Got ${feUsdt?.defaultNetwork}`
	);
}

// ── Scenario 11 — frontend USDT.privacyWarningKey set ────────────
if (feUsdt && feUsdt.privacyWarningKey === 'usdt_centralized') {
	pass('frontend USDT.privacyWarningKey === "usdt_centralized"');
} else {
	fail(
		'frontend USDT.privacyWarningKey === "usdt_centralized"',
		`Got ${feUsdt?.privacyWarningKey}`
	);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nusdt-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} usdt-trade-only scenarios passed`);
