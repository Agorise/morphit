#!/usr/bin/env tsx
/**
 * doge-trade-only-smoke.
 *
 * Part 122 cp33 sentinel: DOGE must be `canPayListingFee: false`
 * AND `canBeTraded: true` in BOTH the canonical and frontend
 * asset registries.  If a future contributor toggles either
 * value the wrong way, this smoke fails loudly.
 *
 * Memory #23 invariant pinned from two directions:
 *  - Canonical registry's `canPayListingFee: true → ticker ∈
 *    {BLURT, BTC, XMR}` rule means a future contributor
 *    flipping DOGE's flag to true would fail the
 *    asset-registry-smoke first (good defence-in-depth).
 *  - This smoke is the DOGE-specific sentinel: DOGE must
 *    be trade-only.  If the frontend's canBeUsedForListingFee
 *    drifts from the canonical's canPayListingFee, the user-
 *    facing form would offer DOGE as a fee option while the
 *    indexer would reject it — confusing UX.
 *
 * Also asserts DOGE ships single-network (mainnet only),
 * defaultNetwork: 'mainnet' (no picker shown), and
 * privacyWarningKey: null (DOGE is transparent at the base
 * layer like BTC but decentralized — no issuer-freeze risk.
 * Unlike DASH it has no opt-in privacy upgrade — no PrivateSend
 * equivalent, no confidential transactions, no segwit-enabled
 * mixing.  For Morphit's strongest privacy posture, users
 * should use XMR instead.).
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

console.log('\n── doge-trade-only smoke ─────────────────────────────\n');

// ── Scenario 1 — DOGE is in the canonical registry ───────────────
const canonDogecoin = CANONICAL.find((a) => a.ticker === 'DOGE');
if (canonDogecoin) {
	pass('DOGE is in canonical registry');
} else {
	fail('DOGE is in canonical registry', 'no DOGE entry found in @morphit/asset-registry ASSETS');
}

// ── Scenario 2 — canonical DOGE.canPayListingFee === false ───────
if (canonDogecoin && canonDogecoin.canPayListingFee === false) {
	pass('canonical DOGE.canPayListingFee === false (memory #23)');
} else {
	fail(
		'canonical DOGE.canPayListingFee === false (memory #23)',
		`DOGE must be trade-only.  Got canPayListingFee=${canonDogecoin?.canPayListingFee}`
	);
}

// ── Scenario 3 — canonical DOGE.canBeTraded === true ─────────────
if (canonDogecoin && canonDogecoin.canBeTraded === true) {
	pass('canonical DOGE.canBeTraded === true');
} else {
	fail(
		'canonical DOGE.canBeTraded === true',
		`DOGE must be tradable.  Got canBeTraded=${canonDogecoin?.canBeTraded}`
	);
}

// ── Scenario 4 — canonical DOGE single-network (mainnet) ─────────
if (canonDogecoin) {
	const networks = [...canonDogecoin.supportedNetworks];
	if (networks.length === 1 && networks[0] === 'mainnet') {
		pass('canonical DOGE.supportedNetworks = [mainnet] (single-network)');
	} else {
		fail(
			'canonical DOGE.supportedNetworks = [mainnet]',
			`DOGE is single-network.  Got ${JSON.stringify(networks)}`
		);
	}
}

// ── Scenario 5 — defaultNetwork is 'mainnet' (no picker needed) ──
if (canonDogecoin && canonDogecoin.defaultNetwork === 'mainnet') {
	pass('canonical DOGE.defaultNetwork === "mainnet" (no network picker)');
} else {
	fail(
		'canonical DOGE.defaultNetwork === "mainnet"',
		`Single-network asset must set defaultNetwork to its only network.  Got ${canonDogecoin?.defaultNetwork}`
	);
}

// ── Scenario 6 — privacyWarningKey is null ───────────────────────
if (canonDogecoin && canonDogecoin.privacyWarningKey === null) {
	pass('canonical DOGE.privacyWarningKey === null (transparent + decentralized, same posture as BTC)');
} else {
	fail(
		'canonical DOGE.privacyWarningKey === null',
		`DOGE is transparent (like BTC) but decentralized — no issuer can freeze addresses, so no warning needed.  PrivateSend is wallet-side opt-in, not a chain-level property.  Got ${canonDogecoin?.privacyWarningKey}`
	);
}

// ── Scenario 7 — decimals === 8 (matches BTC's satoshi unit) ─────
if (canonDogecoin && canonDogecoin.decimals === 8) {
	pass('canonical DOGE.decimals === 8 (duff == satoshi, same as BTC)');
} else {
	fail(
		'canonical DOGE.decimals === 8',
		`DOGE preserved BTC's 8-decimal smallest-unit semantics (duff == satoshi).  Got decimals=${canonDogecoin?.decimals}`
	);
}

// ── Scenario 8 — privacyFeatures struct present with empty optInPrivacyTech ─
// DOGE has no native privacy upgrade — no PrivateSend equivalent, no
// confidential transactions, no segwit-enabled mixing.  optInPrivacyTech
// must be empty; privacyGuideKey is 'doge'.
if (canonDogecoin && canonDogecoin.privacyFeatures !== undefined) {
	const pf = canonDogecoin.privacyFeatures;
	const techList = pf.optInPrivacyTech ?? [];
	const techEmpty = Array.isArray(techList) && techList.length === 0;
	if (techEmpty && pf.privacyGuideKey === 'doge' && pf.freshAddressAdvice === 'hd-derived') {
		pass('canonical DOGE.privacyFeatures = { hd-derived, [], doge }');
	} else {
		fail(
			'canonical DOGE.privacyFeatures correct',
			`Expected freshAddressAdvice=hd-derived, optInPrivacyTech=[], privacyGuideKey=doge.  Got ${JSON.stringify(pf)}`
		);
	}
} else {
	fail(
		'canonical DOGE.privacyFeatures present',
		`privacyFeatures struct missing — every Morphit asset must have one`
	);
}

// ── Scenario 9 — frontend DOGE entry mirrors canonical ───────────
const feDogecoin = FRONTEND.find((a) => a.ticker === 'doge');
if (feDogecoin) {
	pass('frontend DOGE entry exists');
} else {
	fail('frontend DOGE entry exists', 'no doge entry in apps/web/src/lib/assets/registry.ts');
}

// ── Scenario 10 — frontend canBeUsedForListingFee === false ──────
if (feDogecoin && feDogecoin.canBeUsedForListingFee === false) {
	pass('frontend DOGE.canBeUsedForListingFee === false (mirrors canonical)');
} else {
	fail(
		'frontend DOGE.canBeUsedForListingFee === false',
		`Frontend must mirror canonical.  Drift = user-facing form offers DOGE as a fee option while indexer rejects it.  Got canBeUsedForListingFee=${feDogecoin?.canBeUsedForListingFee}`
	);
}

// ── Scenario 11 — frontend DOGE.canBeTraded === true ─────────────
if (feDogecoin && feDogecoin.canBeTraded === true) {
	pass('frontend DOGE.canBeTraded === true');
} else {
	fail(
		'frontend DOGE.canBeTraded === true',
		`Frontend DOGE must be tradable.  Got canBeTraded=${feDogecoin?.canBeTraded}`
	);
}

// ── Scenario 12 — frontend DOGE.privacyWarningKey is null ────────
if (feDogecoin && feDogecoin.privacyWarningKey === null) {
	pass('frontend DOGE.privacyWarningKey === null');
} else {
	fail(
		'frontend DOGE.privacyWarningKey === null',
		`Got ${feDogecoin?.privacyWarningKey}`
	);
}

// ── Scenario 13 — address validator accepts DOGE address forms ───
if (feDogecoin) {
	// Test addresses (verified-shape — not real funds):
	//  - P2PKH (D-prefix, 34 chars, base58) — overwhelmingly most common
	//  - P2SH (9 or A prefix, 34 chars, base58) — multisig, rare on DOGE
	// No bech32 — Dogecoin Core has not activated segwit.
	const validP2PKH = 'DPHwLrG5Cm5R8KCNNfMcXSEoVbCRBkXxhf';
	const validP2SH_9 = '9sLa1AsjPBxLqDpFnyKHcW8GScXm9LhT5h';
	const validP2SH_A = 'AALa1AsjPBxLqDpFnyKHcW8GScXm9LhT5h';
	const invalidBtc = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
	const invalidDash = 'XwnLY8qaFu8aGM9XRdcaQ9XgnnQ8AbnXkc';
	const invalidTooShort = 'DPHwLrG5Cm5R8KCNNfMcXSEoVbCRBkXxh';
	const invalidGarbage = 'definitely-not-a-doge-address';
	const checks: [string, boolean][] = [
		['P2PKH (D-prefix) accepted', feDogecoin.addressValidator(validP2PKH)],
		['P2SH (9-prefix) accepted', feDogecoin.addressValidator(validP2SH_9)],
		['P2SH (A-prefix) accepted', feDogecoin.addressValidator(validP2SH_A)],
		['BTC P2PKH (1-prefix) rejected', !feDogecoin.addressValidator(invalidBtc)],
		['DASH (X-prefix) rejected', !feDogecoin.addressValidator(invalidDash)],
		['too-short address rejected', !feDogecoin.addressValidator(invalidTooShort)],
		['garbage rejected', !feDogecoin.addressValidator(invalidGarbage)]
	];
	const allPassed = checks.every(([, ok]) => ok);
	if (allPassed) {
		pass('frontend DOGE addressValidator accepts D/9/A prefixes, rejects BTC/DASH/garbage');
	} else {
		const failedSub = checks.filter(([, ok]) => !ok).map(([n]) => n);
		fail(
			'frontend DOGE addressValidator accepts D/9/A prefixes, rejects BTC/DASH/garbage',
			`failed sub-checks: ${failedSub.join(', ')}`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\ndoge-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} doge-trade-only scenarios passed`);
