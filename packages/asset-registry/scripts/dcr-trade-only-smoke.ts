#!/usr/bin/env tsx
/**
 * dcr-trade-only-smoke.
 *
 * Part 122 cp43 sentinel: DCR (Decred) must be
 * `canPayListingFee: false` AND `canBeTraded: true` in BOTH the
 * canonical and frontend asset registries.  If a future contributor
 * toggles either value the wrong way, this smoke fails loudly.
 *
 * Memory #23 invariant pinned from two directions:
 *  - Canonical registry's `canPayListingFee: true → ticker ∈
 *    {BLURT, BTC, XMR}` rule means a future contributor flipping
 *    DCR's flag to true would fail the asset-registry-smoke first.
 *  - This smoke is the DCR-specific sentinel: DCR must be
 *    trade-only.  If the frontend's canBeUsedForListingFee drifts
 *    from the canonical's canPayListingFee, the user-facing form
 *    would offer DCR as a fee option while the indexer would
 *    reject it — confusing UX.
 *
 * Also asserts DCR ships single-network (mainnet only),
 * defaultNetwork: 'mainnet' (no picker shown), and
 * privacyWarningKey: null (Decred is decentralized via hybrid
 * PoW+PoS consensus and offers opt-in wallet-side CSPP mixing for
 * users who want transaction-level privacy).  optInPrivacyTech
 * includes 'csppmix' to reflect the CoinShuffle++ wallet-side
 * mixing protocol integrated into dcrwallet — NEW tech tag
 * introduced at cp43.
 *
 * Address-validator coverage: Ds P2PKH-Secp256k1 (35 chars, most
 * common), Dc P2SH (35 chars, multisig/escrow).  Rejects Dp/Dr/De
 * (extended pubkey/privkey/Edwards-curve — NOT used for receive).
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

console.log('\n── dcr-trade-only smoke ──────────────────────────────\n');

// ── Scenario 1 — canonical registry has DCR with correct flags ──
const canonDcr = CANONICAL.find((a) => a.ticker === 'DCR');
if (!canonDcr) {
	fail('canonical registry contains DCR entry', "no ASSETS entry with ticker==='DCR'");
} else {
	pass('canonical registry contains DCR entry');
	if (canonDcr.canBeTraded === true) pass('canonical DCR.canBeTraded === true');
	else fail('canonical DCR.canBeTraded === true', `actual: ${canonDcr.canBeTraded}`);
	if (canonDcr.canPayListingFee === false) pass('canonical DCR.canPayListingFee === false (memory #23)');
	else fail('canonical DCR.canPayListingFee === false (memory #23)', `actual: ${canonDcr.canPayListingFee}`);
	if (canonDcr.decimals === 8) pass('canonical DCR.decimals === 8');
	else fail('canonical DCR.decimals === 8', `actual: ${canonDcr.decimals}`);
	if (Array.isArray(canonDcr.supportedNetworks) && canonDcr.supportedNetworks.length === 1 && canonDcr.supportedNetworks[0] === 'mainnet') {
		pass('canonical DCR.supportedNetworks === [mainnet]');
	} else {
		fail('canonical DCR.supportedNetworks === [mainnet]', `actual: ${JSON.stringify(canonDcr.supportedNetworks)}`);
	}
	if (canonDcr.defaultNetwork === 'mainnet') pass('canonical DCR.defaultNetwork === mainnet');
	else fail('canonical DCR.defaultNetwork === mainnet', `actual: ${canonDcr.defaultNetwork}`);
	if (canonDcr.privacyWarningKey === null) pass('canonical DCR.privacyWarningKey === null (decentralized hybrid PoW/PoS)');
	else fail('canonical DCR.privacyWarningKey === null', `actual: ${canonDcr.privacyWarningKey}`);
	const pf = canonDcr.privacyFeatures;
	if (pf && pf.freshAddressAdvice === 'hd-derived') pass('canonical DCR.privacyFeatures.freshAddressAdvice === hd-derived');
	else fail('canonical DCR.privacyFeatures.freshAddressAdvice === hd-derived', `actual: ${JSON.stringify(pf)}`);
	if (pf && Array.isArray(pf.optInPrivacyTech) && pf.optInPrivacyTech.includes('csppmix')) {
		pass('canonical DCR.optInPrivacyTech includes csppmix (CoinShuffle++ wallet mixing)');
	} else {
		fail('canonical DCR.optInPrivacyTech includes csppmix', `actual: ${JSON.stringify(pf?.optInPrivacyTech)}`);
	}
	if (pf && pf.privacyGuideKey === 'dcr') pass('canonical DCR.privacyGuideKey === dcr');
	else fail('canonical DCR.privacyGuideKey === dcr', `actual: ${pf?.privacyGuideKey}`);
}

// ── Scenario 2 — frontend registry parity ──
const feDcr = FRONTEND.find((a) => a.ticker === 'dcr');
if (!feDcr) {
	fail('frontend registry contains dcr entry', "no ASSETS entry with ticker==='dcr'");
} else {
	pass('frontend registry contains dcr entry');
	if (feDcr.canBeTraded === true) pass('frontend dcr.canBeTraded === true');
	else fail('frontend dcr.canBeTraded === true', `actual: ${feDcr.canBeTraded}`);
	// @ts-expect-error
	if (feDcr.canBeUsedForListingFee === false) pass('frontend dcr.canBeUsedForListingFee === false (memory #23)');
	// @ts-expect-error
	else fail('frontend dcr.canBeUsedForListingFee === false', `actual: ${feDcr.canBeUsedForListingFee}`);
	if (feDcr.decimals === 8) pass('frontend dcr.decimals === 8');
	else fail('frontend dcr.decimals === 8', `actual: ${feDcr.decimals}`);
}

// ── Scenario 3 — address validator coverage ──
if (canonDcr) {
	// Specimens — valid Ds + Dc
	const DS_VALID = 'Ds' + '1'.repeat(33); // 35 chars total
	const DC_VALID = 'Dc' + '1'.repeat(33);
	if (canonDcr.addressShape.test(DS_VALID)) pass('addressShape ACCEPTS valid Ds');
	else fail('addressShape ACCEPTS valid Ds', `regex: ${canonDcr.addressShape}`);
	if (canonDcr.addressShape.test(DC_VALID)) pass('addressShape ACCEPTS valid Dc');
	else fail('addressShape ACCEPTS valid Dc', `regex: ${canonDcr.addressShape}`);

	// Adversarial — should all REJECT
	const REJECTS: Array<[string, string]> = [
		['empty', ''],
		['too short (34 chars)', 'Ds' + '1'.repeat(32)],
		['too long (36 chars)', 'Ds' + '1'.repeat(34)],
		['Dp extended pubkey (reject — not for receive)', 'Dp' + '1'.repeat(33)],
		['Dr extended privkey (reject — SENSITIVE; never share)', 'Dr' + '1'.repeat(33)],
		['De Edwards-curve (reject — not for regular receive)', 'De' + '1'.repeat(33)],
		['Da invalid prefix', 'Da' + '1'.repeat(33)],
		['ds lowercase d', 'ds' + '1'.repeat(33)],
		['DS uppercase second char', 'DS' + '1'.repeat(33)],
		['contains 0 (excluded from base58)', 'Ds0' + '1'.repeat(32)],
		['contains O (excluded from base58)', 'DsO' + '1'.repeat(32)],
		['contains I (excluded from base58)', 'DsI' + '1'.repeat(32)],
		['contains l (excluded from base58)', 'Dsl' + '1'.repeat(32)],
		['BTC P2PKH (1-prefix)', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
		['DASH X-address', 'XwnLY8qaFu8aGM9XRdcaQ9XgnnQ8AbnXkc'],
		['DOGE D-address (DPHwLrG5... — DP not Ds/Dc)', 'DPHwLrG5Cm5R8KCNNfMcXSEoVbCRBkXxhf'],
		['SQL injection', "Ds'; DROP TABLE--" + '1'.repeat(15)],
		['XSS', '<script>alert(1)</script>'],
		['null byte', 'Ds\u0000' + '1'.repeat(32)],
		['leading whitespace', ' Ds' + '1'.repeat(33)],
		['trailing whitespace', 'Ds' + '1'.repeat(33) + ' '],
		['100K-char DoS', '1'.repeat(100000)]
	];
	let rejectAllPassed = true;
	for (const [name, input] of REJECTS) {
		if (canonDcr.addressShape.test(input)) {
			fail(`addressShape REJECTS ${name}`, `accepted input: ${input.slice(0, 60)}`);
			rejectAllPassed = false;
		}
	}
	if (rejectAllPassed) pass(`addressShape REJECTS all ${REJECTS.length} adversarial inputs`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\ndcr-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} dcr-trade-only scenarios passed`);
