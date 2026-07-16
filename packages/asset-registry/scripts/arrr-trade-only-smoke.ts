#!/usr/bin/env tsx
/**
 * arrr-trade-only-smoke.
 *
 * Part 122 cp41 sentinel: ARRR (Pirate Chain) must be
 * `canPayListingFee: false` AND `canBeTraded: true` in BOTH the
 * canonical and frontend asset registries.  If a future contributor
 * toggles either value the wrong way, this smoke fails loudly.
 *
 * Memory #23 invariant pinned from two directions:
 *  - Canonical registry's `canPayListingFee: true → ticker ∈
 *    {BLURT, BTC, XMR}` rule means a future contributor
 *    flipping ARRR's flag to true would fail the
 *    asset-registry-smoke first (good defence-in-depth).
 *  - This smoke is the ARRR-specific sentinel: ARRR must
 *    be trade-only.  If the frontend's canBeUsedForListingFee
 *    drifts from the canonical's canPayListingFee, the user-
 *    facing form would offer ARRR as a fee option while the
 *    indexer would reject it — confusing UX.
 *  - Also: `'arrr'` is in FORBIDDEN_TICKERS in
 *    fee-method-enum-frozen-smoke, so an accidental ARRR
 *    fee-method addition triggers a third independent failure.
 *    Three-axis defence-in-depth.
 *
 * Also asserts ARRR ships single-network (mainnet only),
 * defaultNetwork: 'mainnet' (no picker shown), and
 * privacyWarningKey: null (Pirate Chain is decentralized and
 * every transaction is shielded by construction — no public
 * sender/recipient/amount to warn about).  optInPrivacyTech
 * includes 'shielded-pools' to reflect the underlying Sapling
 * zk-SNARK protocol (same tech family as Zcash, different chain).
 *
 * Address-validator coverage: single zs1 Sapling shielded format
 * (bech32, 78 chars total = `zs1` prefix + 75 bech32 data chars).
 * Visually identical to Zcash Sapling addresses — context (asset
 * field, instance config) disambiguates which chain.
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

console.log('\n── arrr-trade-only smoke ─────────────────────────────\n');

// ── Scenario 1 — canonical registry has ARRR with correct flags ──
const canonArrr = CANONICAL.find((a) => a.ticker === 'ARRR');
if (!canonArrr) {
	fail('canonical registry contains ARRR entry', 'no ASSETS entry with ticker===\'ARRR\'');
} else {
	pass('canonical registry contains ARRR entry');
	if (canonArrr.canBeTraded === true) pass('canonical ARRR.canBeTraded === true');
	else fail('canonical ARRR.canBeTraded === true', `actual: ${canonArrr.canBeTraded}`);
	if (canonArrr.canPayListingFee === false) pass('canonical ARRR.canPayListingFee === false (memory #23)');
	else fail('canonical ARRR.canPayListingFee === false (memory #23)', `actual: ${canonArrr.canPayListingFee}`);
	if (canonArrr.decimals === 8) pass('canonical ARRR.decimals === 8');
	else fail('canonical ARRR.decimals === 8', `actual: ${canonArrr.decimals}`);
	if (Array.isArray(canonArrr.supportedNetworks) && canonArrr.supportedNetworks.length === 1 && canonArrr.supportedNetworks[0] === 'mainnet') {
		pass('canonical ARRR.supportedNetworks === [mainnet]');
	} else {
		fail('canonical ARRR.supportedNetworks === [mainnet]', `actual: ${JSON.stringify(canonArrr.supportedNetworks)}`);
	}
	if (canonArrr.defaultNetwork === 'mainnet') pass('canonical ARRR.defaultNetwork === mainnet');
	else fail('canonical ARRR.defaultNetwork === mainnet', `actual: ${canonArrr.defaultNetwork}`);
	if (canonArrr.privacyWarningKey === null) pass('canonical ARRR.privacyWarningKey === null (decentralized + shielded)');
	else fail('canonical ARRR.privacyWarningKey === null', `actual: ${canonArrr.privacyWarningKey}`);
	// Privacy features
	const pf = canonArrr.privacyFeatures;
	if (pf && pf.freshAddressAdvice === 'hd-derived') pass('canonical ARRR.privacyFeatures.freshAddressAdvice === hd-derived');
	else fail('canonical ARRR.privacyFeatures.freshAddressAdvice === hd-derived', `actual: ${JSON.stringify(pf)}`);
	if (pf && Array.isArray(pf.optInPrivacyTech) && pf.optInPrivacyTech.includes('shielded-pools')) {
		pass('canonical ARRR.optInPrivacyTech includes shielded-pools');
	} else {
		fail('canonical ARRR.optInPrivacyTech includes shielded-pools', `actual: ${JSON.stringify(pf?.optInPrivacyTech)}`);
	}
	if (pf && pf.privacyGuideKey === 'arrr') pass('canonical ARRR.privacyGuideKey === arrr');
	else fail('canonical ARRR.privacyGuideKey === arrr', `actual: ${pf?.privacyGuideKey}`);
}

// ── Scenario 2 — frontend registry parity ──
const feArrr = FRONTEND.find((a) => a.ticker === 'arrr');
if (!feArrr) {
	fail('frontend registry contains arrr entry', "no ASSETS entry with ticker==='arrr'");
} else {
	pass('frontend registry contains arrr entry');
	if (feArrr.canBeTraded === true) pass('frontend arrr.canBeTraded === true');
	else fail('frontend arrr.canBeTraded === true', `actual: ${feArrr.canBeTraded}`);
	if (feArrr.canBeUsedForListingFee === false) pass('frontend arrr.canBeUsedForListingFee === false (memory #23)');
	else fail('frontend arrr.canBeUsedForListingFee === false', `actual: ${feArrr.canBeUsedForListingFee}`);
	if (feArrr.decimals === 8) pass('frontend arrr.decimals === 8');
	else fail('frontend arrr.decimals === 8', `actual: ${feArrr.decimals}`);
}

// ── Scenario 3 — address validator accepts canonical zs1 + rejects everything else ──
if (canonArrr) {
	const ZS1_VALID = 'zs1' + 'q'.repeat(75);
	if (canonArrr.addressShape.test(ZS1_VALID)) pass('addressShape ACCEPTS valid zs1');
	else fail('addressShape ACCEPTS valid zs1', `regex: ${canonArrr.addressShape}`);

	// Adversarial — should all REJECT
	const REJECTS: Array<[string, string]> = [
		['empty', ''],
		['zs1 too short (74 data chars)', 'zs1' + 'q'.repeat(74)],
		['zs1 too long (76 data chars)', 'zs1' + 'q'.repeat(76)],
		['zs2 invalid prefix', 'zs2' + 'q'.repeat(75)],
		['zs1 with 1 in data', 'zs11' + 'q'.repeat(74)],
		['zs1 with b in data', 'zs1b' + 'q'.repeat(74)],
		['BTC P2PKH address', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
		['DASH X-address', 'XwnLY8qaFu8aGM9XRdcaQ9XgnnQ8AbnXkc'],
		['LTC L-address', 'LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL'],
		['DOGE D-address', 'DPHwLrG5Cm5R8KCNNfMcXSEoVbCRBkXxhf'],
		['ZEC t1 transparent (not ARRR)', 't1RKFygRTZxfP7Z3uW4kBJjGNB6cqxQyEmA'],
		['ZEC u1 Unified (not ARRR)', 'u1' + 'q'.repeat(80)],
		['SQL injection', "zs1'; DROP TABLE--" + 'a'.repeat(60)],
		['XSS', '<script>alert(1)</script>'],
		['null byte', 'zs1' + '\u0000' + 'q'.repeat(74)],
		['leading whitespace', ' zs1' + 'q'.repeat(75)],
		['trailing whitespace', 'zs1' + 'q'.repeat(75) + ' '],
		['100K-char DoS', 'q'.repeat(100000)]
	];
	let rejectAllPassed = true;
	for (const [name, input] of REJECTS) {
		if (canonArrr.addressShape.test(input)) {
			fail(`addressShape REJECTS ${name}`, `accepted input: ${input.slice(0, 60)}`);
			rejectAllPassed = false;
		}
	}
	if (rejectAllPassed) pass(`addressShape REJECTS all ${REJECTS.length} adversarial inputs`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\narrr-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} arrr-trade-only scenarios passed`);
