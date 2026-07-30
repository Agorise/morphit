#!/usr/bin/env tsx
/**
 * dash-trade-only-smoke.
 *
 * Part 122 cp27 sentinel: DASH must be `canPayListingFee: false`
 * AND `canBeTraded: true` in BOTH the canonical and frontend
 * asset registries.  If a future contributor toggles either
 * value the wrong way, this smoke fails loudly.
 *
 * Memory #23 invariant pinned from two directions:
 *  - Canonical registry's `canPayListingFee: true → ticker ∈
 *    {BLURT, BTC, XMR}` rule means a future contributor
 *    flipping DASH's flag to true would fail the
 *    asset-registry-smoke first (good defence-in-depth).
 *  - This smoke is the DASH-specific sentinel: DASH must
 *    be trade-only.  If the frontend's canBeUsedForListingFee
 *    drifts from the canonical's canPayListingFee, the user-
 *    facing form would offer DASH as a fee option while the
 *    indexer would reject it — confusing UX.
 *
 * Also asserts DASH ships single-network (mainnet only),
 * defaultNetwork: 'mainnet' (no picker shown), and
 * privacyWarningKey: null (DASH is transparent at the base
 * layer like BTC but decentralized — no issuer-freeze risk;
 * opt-in PrivateSend mixing is wallet-side, not a chain
 * property worth warning about).
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

console.log('\n── dash-trade-only smoke ─────────────────────────────\n');

// ── Scenario 1 — DASH is in the canonical registry ───────────────
const canonDash = CANONICAL.find((a) => a.ticker === 'DASH');
if (canonDash) {
	pass('DASH is in canonical registry');
} else {
	fail('DASH is in canonical registry', 'no DASH entry found in @morphit/asset-registry ASSETS');
}

// ── Scenario 2 — canonical DASH.canPayListingFee === false ───────
if (canonDash && canonDash.canPayListingFee === false) {
	pass('canonical DASH.canPayListingFee === false (memory #23)');
} else {
	fail(
		'canonical DASH.canPayListingFee === false (memory #23)',
		`DASH must be trade-only.  Got canPayListingFee=${canonDash?.canPayListingFee}`
	);
}

// ── Scenario 3 — canonical DASH.canBeTraded === true ─────────────
if (canonDash && canonDash.canBeTraded === true) {
	pass('canonical DASH.canBeTraded === true');
} else {
	fail(
		'canonical DASH.canBeTraded === true',
		`DASH must be tradable.  Got canBeTraded=${canonDash?.canBeTraded}`
	);
}

// ── Scenario 4 — canonical DASH single-network (mainnet) ─────────
if (canonDash) {
	const networks = [...canonDash.supportedNetworks];
	if (networks.length === 1 && networks[0] === 'mainnet') {
		pass('canonical DASH.supportedNetworks = [mainnet] (single-network)');
	} else {
		fail(
			'canonical DASH.supportedNetworks = [mainnet]',
			`DASH is single-network.  Got ${JSON.stringify(networks)}`
		);
	}
}

// ── Scenario 5 — defaultNetwork is 'mainnet' (no picker needed) ──
if (canonDash && canonDash.defaultNetwork === 'mainnet') {
	pass('canonical DASH.defaultNetwork === "mainnet" (no network picker)');
} else {
	fail(
		'canonical DASH.defaultNetwork === "mainnet"',
		`Single-network asset must set defaultNetwork to its only network.  Got ${canonDash?.defaultNetwork}`
	);
}

// ── Scenario 6 — privacyWarningKey is null ───────────────────────
if (canonDash && canonDash.privacyWarningKey === null) {
	pass('canonical DASH.privacyWarningKey === null (transparent + decentralized, same posture as BTC)');
} else {
	fail(
		'canonical DASH.privacyWarningKey === null',
		`DASH is transparent (like BTC) but decentralized — no issuer can freeze addresses, so no warning needed.  PrivateSend is wallet-side opt-in, not a chain-level property.  Got ${canonDash?.privacyWarningKey}`
	);
}

// ── Scenario 7 — decimals === 8 (matches BTC's satoshi unit) ─────
if (canonDash && canonDash.decimals === 8) {
	pass('canonical DASH.decimals === 8 (duff == satoshi, same as BTC)');
} else {
	fail(
		'canonical DASH.decimals === 8',
		`DASH preserved BTC's 8-decimal smallest-unit semantics (duff == satoshi).  Got decimals=${canonDash?.decimals}`
	);
}

// ── Scenario 8 — privacyFeatures struct present with privatesend ─
if (canonDash && canonDash.privacyFeatures !== undefined) {
	const pf = canonDash.privacyFeatures;
	const techList = pf.optInPrivacyTech ?? [];
	const hasPrivatesend = Array.isArray(techList) && techList.includes('privatesend');
	if (hasPrivatesend && pf.privacyGuideKey === 'dash' && pf.freshAddressAdvice === 'hd-derived') {
		pass('canonical DASH.privacyFeatures = { hd-derived, [privatesend], dash }');
	} else {
		fail(
			'canonical DASH.privacyFeatures correct',
			`Expected freshAddressAdvice=hd-derived, optInPrivacyTech=[privatesend], privacyGuideKey=dash.  Got ${JSON.stringify(pf)}`
		);
	}
} else {
	fail(
		'canonical DASH.privacyFeatures present',
		`privacyFeatures struct missing — every Morphit asset must have one`
	);
}

// ── Scenario 9 — frontend DASH entry mirrors canonical ───────────
const feDash = FRONTEND.find((a) => a.ticker === 'dash');
if (feDash) {
	pass('frontend DASH entry exists');
} else {
	fail('frontend DASH entry exists', 'no dash entry in apps/web/src/lib/assets/registry.ts');
}

// ── Scenario 10 — frontend canBeUsedForListingFee === false ──────
if (feDash && feDash.canBeUsedForListingFee === false) {
	pass('frontend DASH.canBeUsedForListingFee === false (mirrors canonical)');
} else {
	fail(
		'frontend DASH.canBeUsedForListingFee === false',
		`Frontend must mirror canonical.  Drift = user-facing form offers DASH as a fee option while indexer rejects it.  Got canBeUsedForListingFee=${feDash?.canBeUsedForListingFee}`
	);
}

// ── Scenario 11 — frontend DASH.canBeTraded === true ─────────────
if (feDash && feDash.canBeTraded === true) {
	pass('frontend DASH.canBeTraded === true');
} else {
	fail(
		'frontend DASH.canBeTraded === true',
		`Frontend DASH must be tradable.  Got canBeTraded=${feDash?.canBeTraded}`
	);
}

// ── Scenario 12 — frontend DASH.privacyWarningKey is null ────────
if (feDash && feDash.privacyWarningKey === null) {
	pass('frontend DASH.privacyWarningKey === null');
} else {
	fail(
		'frontend DASH.privacyWarningKey === null',
		`Got ${feDash?.privacyWarningKey}`
	);
}

// ── Scenario 13 — address validator accepts DASH address forms ───
if (feDash) {
	// Test addresses (verified-shape — not real funds):
	//  - P2PKH (X-prefix, 34 chars, base58) — most common
	//  - P2SH (7-prefix, 34 chars, base58) — multisig, less common
	const validP2PKH = 'Xt1bUkULFn7tXY6Hno1FmHFszbxFB9SREr';
	const validP2SH = '7XKqZjPFcCRqM4LfRZdQQfXKbWQGiRGHQu';
	const invalidBtc = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
	const invalidTooShort = 'Xt1bUkULFn7tXY6Hno1FmHFszbxFB9SRE';
	const invalidGarbage = 'definitely-not-a-dash-address';
	const checks: [string, boolean][] = [
		['P2PKH (X-prefix) accepted', feDash.addressValidator(validP2PKH)],
		['P2SH (7-prefix) accepted', feDash.addressValidator(validP2SH)],
		['BTC P2PKH (1-prefix) rejected', !feDash.addressValidator(invalidBtc)],
		['too-short address rejected', !feDash.addressValidator(invalidTooShort)],
		['garbage rejected', !feDash.addressValidator(invalidGarbage)]
	];
	const allPassed = checks.every(([, ok]) => ok);
	if (allPassed) {
		pass('frontend DASH addressValidator accepts X+7 prefixes, rejects BTC/garbage');
	} else {
		const failedSub = checks.filter(([, ok]) => !ok).map(([n]) => n);
		fail(
			'frontend DASH addressValidator accepts X+7 prefixes, rejects BTC/garbage',
			`failed sub-checks: ${failedSub.join(', ')}`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\ndash-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} dash-trade-only scenarios passed`);
