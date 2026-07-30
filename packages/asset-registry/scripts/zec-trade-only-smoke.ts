#!/usr/bin/env tsx
/**
 * zec-trade-only-smoke.
 *
 * Part 122 cp39 sentinel: ZEC must be `canPayListingFee: false`
 * AND `canBeTraded: true` in BOTH the canonical and frontend
 * asset registries.  If a future contributor toggles either
 * value the wrong way, this smoke fails loudly.
 *
 * Memory #23 invariant pinned from two directions:
 *  - Canonical registry's `canPayListingFee: true → ticker ∈
 *    {BLURT, BTC, XMR}` rule means a future contributor
 *    flipping ZEC's flag to true would fail the
 *    asset-registry-smoke first (good defence-in-depth).
 *  - This smoke is the ZEC-specific sentinel: ZEC must
 *    be trade-only.  If the frontend's canBeUsedForListingFee
 *    drifts from the canonical's canPayListingFee, the user-
 *    facing form would offer ZEC as a fee option while the
 *    indexer would reject it — confusing UX.
 *
 * Also asserts ZEC ships single-network (mainnet only),
 * defaultNetwork: 'mainnet' (no picker shown), and
 * privacyWarningKey: null (Zcash is decentralized and the
 * privacy choice is the user's per address — transparent
 * t1/t3 or shielded zs1/u1).  optInPrivacyTech includes
 * 'shielded-pools' to reflect that Zcash supports zero-
 * knowledge shielded transactions (Sapling + Orchard pools).
 *
 * Address-validator coverage: t1 transparent (P2PKH), t3
 * transparent (P2SH), zs1 Sapling shielded (bech32, 78 chars),
 * u1 Unified Address (bech32m, variable).
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

console.log('\n── zec-trade-only smoke ──────────────────────────────\n');

// ── Scenario 1 — ZEC is in the canonical registry ────────────────
const canonZec = CANONICAL.find((a) => a.ticker === 'ZEC');
if (canonZec) {
	pass('ZEC is in canonical registry');
} else {
	fail('ZEC is in canonical registry', 'no ZEC entry found in @morphit/asset-registry ASSETS');
}

// ── Scenario 2 — canonical ZEC.canPayListingFee === false ────────
if (canonZec && canonZec.canPayListingFee === false) {
	pass('canonical ZEC.canPayListingFee === false (memory #23)');
} else {
	fail(
		'canonical ZEC.canPayListingFee === false (memory #23)',
		`ZEC must be trade-only.  Got canPayListingFee=${canonZec?.canPayListingFee}`
	);
}

// ── Scenario 3 — canonical ZEC.canBeTraded === true ──────────────
if (canonZec && canonZec.canBeTraded === true) {
	pass('canonical ZEC.canBeTraded === true');
} else {
	fail(
		'canonical ZEC.canBeTraded === true',
		`ZEC must be tradable.  Got canBeTraded=${canonZec?.canBeTraded}`
	);
}

// ── Scenario 4 — canonical ZEC single-network (mainnet) ──────────
if (canonZec) {
	const networks = [...canonZec.supportedNetworks];
	if (networks.length === 1 && networks[0] === 'mainnet') {
		pass('canonical ZEC.supportedNetworks = [mainnet] (single-network)');
	} else {
		fail(
			'canonical ZEC.supportedNetworks = [mainnet]',
			`ZEC is single-network.  Got ${JSON.stringify(networks)}`
		);
	}
}

// ── Scenario 5 — defaultNetwork is 'mainnet' (no picker needed) ──
if (canonZec && canonZec.defaultNetwork === 'mainnet') {
	pass('canonical ZEC.defaultNetwork === "mainnet" (no network picker)');
} else {
	fail(
		'canonical ZEC.defaultNetwork === "mainnet"',
		`Single-network asset must set defaultNetwork to its only network.  Got ${canonZec?.defaultNetwork}`
	);
}

// ── Scenario 6 — privacyWarningKey is null ───────────────────────
if (canonZec && canonZec.privacyWarningKey === null) {
	pass('canonical ZEC.privacyWarningKey === null (decentralized; per-address privacy choice)');
} else {
	fail(
		'canonical ZEC.privacyWarningKey === null',
		`Zcash is decentralized — no issuer can freeze addresses, so no warning needed.  The privacy choice (transparent vs shielded) is the user's per address.  Got ${canonZec?.privacyWarningKey}`
	);
}

// ── Scenario 7 — decimals === 8 (matches BTC's satoshi unit) ─────
if (canonZec && canonZec.decimals === 8) {
	pass('canonical ZEC.decimals === 8 (zatoshi == satoshi, same as BTC)');
} else {
	fail(
		'canonical ZEC.decimals === 8',
		`ZEC preserved BTC's 8-decimal smallest-unit semantics (zatoshi == satoshi).  Got decimals=${canonZec?.decimals}`
	);
}

// ── Scenario 8 — privacyFeatures struct present with shielded-pools tech ─
// Zcash supports zero-knowledge shielded transactions (Sapling +
// Orchard pools).  optInPrivacyTech must include 'shielded-pools';
// privacyGuideKey is 'zec'.
if (canonZec && canonZec.privacyFeatures !== undefined) {
	const pf = canonZec.privacyFeatures;
	const techList = pf.optInPrivacyTech ?? [];
	const hasShielded = Array.isArray(techList) && techList.includes('shielded-pools');
	if (hasShielded && pf.privacyGuideKey === 'zec' && pf.freshAddressAdvice === 'hd-derived') {
		pass('canonical ZEC.privacyFeatures = { hd-derived, [shielded-pools], zec }');
	} else {
		fail(
			'canonical ZEC.privacyFeatures correct',
			`Expected freshAddressAdvice=hd-derived, optInPrivacyTech includes shielded-pools, privacyGuideKey=zec.  Got ${JSON.stringify(pf)}`
		);
	}
} else {
	fail(
		'canonical ZEC.privacyFeatures present',
		`privacyFeatures struct missing — every Morphit asset must have one`
	);
}

// ── Scenario 9 — frontend ZEC entry mirrors canonical ────────────
const feZec = FRONTEND.find((a) => a.ticker === 'zec');
if (feZec) {
	pass('frontend ZEC entry exists');
} else {
	fail('frontend ZEC entry exists', 'no zec entry in apps/web/src/lib/assets/registry.ts');
}

// ── Scenario 10 — frontend canBeUsedForListingFee === false ──────
if (feZec && feZec.canBeUsedForListingFee === false) {
	pass('frontend ZEC.canBeUsedForListingFee === false (mirrors canonical)');
} else {
	fail(
		'frontend ZEC.canBeUsedForListingFee === false',
		`Frontend must mirror canonical.  Drift = user-facing form offers ZEC as a fee option while indexer rejects it.  Got canBeUsedForListingFee=${feZec?.canBeUsedForListingFee}`
	);
}

// ── Scenario 11 — frontend ZEC.canBeTraded === true ──────────────
if (feZec && feZec.canBeTraded === true) {
	pass('frontend ZEC.canBeTraded === true');
} else {
	fail(
		'frontend ZEC.canBeTraded === true',
		`Frontend ZEC must be tradable.  Got canBeTraded=${feZec?.canBeTraded}`
	);
}

// ── Scenario 12 — frontend ZEC.privacyWarningKey is null ─────────
if (feZec && feZec.privacyWarningKey === null) {
	pass('frontend ZEC.privacyWarningKey === null');
} else {
	fail(
		'frontend ZEC.privacyWarningKey === null',
		`Got ${feZec?.privacyWarningKey}`
	);
}

// ── Scenario 13 — address validator accepts all 4 ZEC address forms ───
if (feZec) {
	// Test addresses (verified-shape — not real funds):
	//  - t1 (transparent P2PKH): base58, 35 chars
	//  - t3 (transparent P2SH, multi-sig): base58, 35 chars
	//  - zs1 (Sapling shielded): bech32, 78 chars
	//  - u1 (Unified Address with Orchard receivers): bech32m, variable
	const validT1 = 't1RKFygRTZxfP7Z3uW4kBJjGNB6cqxQyEmA';
	const validT3 = 't3RKFygRTZxfP7Z3uW4kBJjGNB6cqxQyEmA';
	// 78 chars total = "zs1" + 75 bech32 data chars
	const validZs1 = 'zs1' + 'q'.repeat(75);
	// u1 + at least 30 bech32m chars
	const validU1 = 'u1' + 'q'.repeat(50);
	const invalidBtc = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
	const invalidDash = 'XwnLY8qaFu8aGM9XRdcaQ9XgnnQ8AbnXkc';
	const invalidDoge = 'DPHwLrG5Cm5R8KCNNfMcXSEoVbCRBkXxhf';
	const invalidT2 = 't2RKFygRTZxfP7Z3uW4kBJjGNB6cqxQyEmA'; // t2 not used in ZEC
	const invalidZs2 = 'zs2' + 'q'.repeat(75); // zs2 not used
	const invalidGarbage = 'definitely-not-a-zec-address';
	const checks: [string, boolean][] = [
		['t1 (transparent P2PKH) accepted', feZec.addressValidator(validT1)],
		['t3 (transparent P2SH) accepted', feZec.addressValidator(validT3)],
		['zs1 (Sapling shielded) accepted', feZec.addressValidator(validZs1)],
		['u1 (Unified Address) accepted', feZec.addressValidator(validU1)],
		['BTC P2PKH (1-prefix) rejected', !feZec.addressValidator(invalidBtc)],
		['DASH (X-prefix) rejected', !feZec.addressValidator(invalidDash)],
		['DOGE (D-prefix) rejected', !feZec.addressValidator(invalidDoge)],
		['t2-prefix (invalid for ZEC) rejected', !feZec.addressValidator(invalidT2)],
		['zs2-prefix (invalid for ZEC) rejected', !feZec.addressValidator(invalidZs2)],
		['garbage rejected', !feZec.addressValidator(invalidGarbage)]
	];
	const allPassed = checks.every(([, ok]) => ok);
	if (allPassed) {
		pass('frontend ZEC addressValidator accepts t1/t3/zs1/u1, rejects BTC/DASH/DOGE/garbage');
	} else {
		const failedSub = checks.filter(([, ok]) => !ok).map(([n]) => n);
		fail(
			'frontend ZEC addressValidator accepts t1/t3/zs1/u1, rejects BTC/DASH/DOGE/garbage',
			`failed sub-checks: ${failedSub.join(', ')}`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nzec-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} zec-trade-only scenarios passed`);
