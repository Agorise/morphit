#!/usr/bin/env tsx
/**
 * xrp-trade-only-smoke.
 *
 * Part 122 cp49 sentinel: XRP (Ripple) must be
 * `canPayListingFee: false` AND `canBeTraded: true` in BOTH the
 * canonical and frontend asset registries.
 *
 * Memory #23 invariant pinned from two directions: canonical
 * registry's `canPayListingFee: true → ticker ∈ {BLURT, BTC,
 * XMR}` rule means a future contributor flipping XRP's flag to
 * true would fail asset-registry-smoke first.  This smoke is the
 * XRP-specific sentinel.
 *
 * Also asserts XRP ships single-network (XRPL mainnet only),
 * privacyWarningKey: null (native XRP cannot be frozen — freeze
 * flag applies only to issued tokens/IOUs not native XRP),
 * optInPrivacyTech: null (XRPL has no native protocol-level
 * mixing), 6 decimals (drops — 1 XRP = 10^6 drops), and
 * addressShape accepts r-prefixed 24-34 base58 strings.
 *
 * Address-validator coverage: 25-35 chars total (r + 24-34 base58).
 * Rejects non-base58 chars, wrong length, missing 'r' prefix.
 *
 * LL #50 NOTE: XRP addresses use the 'r' prefix which is unique
 * among Morphit assets.  No cross-asset overlap expected — but
 * the address-shape-overlap-smoke at cp42 captures any unexpected
 * collisions.
 *
 * XRPL-SPECIFIC UX NOTES (documented in privacy.guides.xrp):
 * - Destination tags (32-bit integers) ride in the URI query
 *   string `?dt=N`, not in the address regex.  Sending to an
 *   exchange-hosted address without the required tag practically
 *   loses funds (recoverable via exchange support only).
 * - Reserve requirement: XRPL accounts need ≥1 XRP base reserve
 *   to exist.  Sending <1 XRP to a never-funded address fails.
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

console.log('\n── xrp-trade-only smoke ──────────────────────────────\n');

// ── Scenario 1 — canonical registry has XRP with correct flags ──
const canonXrp = CANONICAL.find((a) => a.ticker === 'XRP');
if (!canonXrp) {
	fail('canonical registry contains XRP entry', "no ASSETS entry with ticker==='XRP'");
} else {
	pass('canonical registry contains XRP entry');
	if (canonXrp.canBeTraded === true) pass('canonical XRP.canBeTraded === true');
	else fail('canonical XRP.canBeTraded === true', `actual: ${canonXrp.canBeTraded}`);
	if (canonXrp.canPayListingFee === false) pass('canonical XRP.canPayListingFee === false (memory #23)');
	else fail('canonical XRP.canPayListingFee === false (memory #23)', `actual: ${canonXrp.canPayListingFee}`);
	if (canonXrp.decimals === 6) pass('canonical XRP.decimals === 6 (drops)');
	else fail('canonical XRP.decimals === 6 (drops)', `actual: ${canonXrp.decimals}`);
	if (Array.isArray(canonXrp.supportedNetworks) && canonXrp.supportedNetworks.length === 1 && canonXrp.supportedNetworks[0] === 'mainnet') {
		pass('canonical XRP.supportedNetworks === [mainnet]');
	} else {
		fail('canonical XRP.supportedNetworks === [mainnet]', `actual: ${JSON.stringify(canonXrp.supportedNetworks)}`);
	}
	if (canonXrp.defaultNetwork === 'mainnet') pass('canonical XRP.defaultNetwork === mainnet');
	else fail('canonical XRP.defaultNetwork === mainnet', `actual: ${canonXrp.defaultNetwork}`);
	if (canonXrp.privacyWarningKey === null) {
		pass('canonical XRP.privacyWarningKey === null (native XRP cannot be frozen — freeze applies only to IOUs)');
	} else {
		fail('canonical XRP.privacyWarningKey === null', `actual: ${canonXrp.privacyWarningKey}`);
	}
	const pf = canonXrp.privacyFeatures;
	if (pf && pf.freshAddressAdvice === 'hd-derived') pass('canonical XRP.freshAddressAdvice === hd-derived');
	else fail('canonical XRP.freshAddressAdvice === hd-derived', `actual: ${JSON.stringify(pf)}`);
	if (pf && pf.optInPrivacyTech === null) {
		pass('canonical XRP.optInPrivacyTech === null (no native mixing protocol; matches XMR/SOL/ETH convention)');
	} else {
		fail('canonical XRP.optInPrivacyTech === null', `actual: ${JSON.stringify(pf?.optInPrivacyTech)}`);
	}
	if (pf && pf.privacyGuideKey === 'xrp') pass('canonical XRP.privacyGuideKey === xrp');
	else fail('canonical XRP.privacyGuideKey === xrp', `actual: ${pf?.privacyGuideKey}`);
}

// ── Scenario 2 — frontend registry parity ──
const feXrp = FRONTEND.find((a) => a.ticker === 'xrp');
if (!feXrp) {
	fail('frontend registry contains xrp entry', "no ASSETS entry with ticker==='xrp'");
} else {
	pass('frontend registry contains xrp entry');
	if (feXrp.canBeTraded === true) pass('frontend xrp.canBeTraded === true');
	else fail('frontend xrp.canBeTraded === true', `actual: ${feXrp.canBeTraded}`);
	if (feXrp.canBeUsedForListingFee === false) pass('frontend xrp.canBeUsedForListingFee === false (memory #23)');
	else fail('frontend xrp.canBeUsedForListingFee === false', `actual: ${feXrp.canBeUsedForListingFee}`);
	if (feXrp.decimals === 6) pass('frontend xrp.decimals === 6');
	else fail('frontend xrp.decimals === 6', `actual: ${feXrp.decimals}`);
}

// ── Scenario 3 — address validator coverage ──
if (canonXrp) {
	// Real-world XRPL addresses for shape testing
	const VALID_BITSTAMP = 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv'; // Bitstamp hot wallet (publicly known)
	const VALID_BINANCE = 'rEy8TFcrAPvhpKrwyrscNYyqBGUkE9hKaJ'; // Binance hot wallet (publicly known)
	const VALID_RIPPLE = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'; // Ripple's known address
	if (canonXrp.addressShape.test(VALID_BITSTAMP)) pass('addressShape ACCEPTS real-shape Bitstamp address');
	else fail('addressShape ACCEPTS real-shape Bitstamp address', `regex: ${canonXrp.addressShape}`);
	if (canonXrp.addressShape.test(VALID_BINANCE)) pass('addressShape ACCEPTS real-shape Binance address');
	else fail('addressShape ACCEPTS real-shape Binance address', `regex: ${canonXrp.addressShape}`);
	if (canonXrp.addressShape.test(VALID_RIPPLE)) pass('addressShape ACCEPTS real-shape Ripple address');
	else fail('addressShape ACCEPTS real-shape Ripple address', `regex: ${canonXrp.addressShape}`);

	const REJECTS: Array<[string, string]> = [
		['empty', ''],
		['no r prefix', 'Hb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
		['uppercase R prefix', 'RHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
		['1-prefix (BTC P2PKH-shape)', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
		['too short (r + 23)', 'r' + '1'.repeat(23)],
		['too long (r + 35)', 'r' + '1'.repeat(35)],
		['contains 0 (excluded base58)', 'r0' + '1'.repeat(30)],
		['contains O (excluded base58)', 'rO' + '1'.repeat(30)],
		['contains I (excluded base58)', 'rI' + '1'.repeat(30)],
		['contains l (excluded base58)', 'rl' + '1'.repeat(30)],
		['contains spaces', 'r ' + '1'.repeat(30)],
		['has destination tag suffix', 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv?dt=12345'],
		['has destination tag colon', 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv:12345'],
		['SQL injection', "'; DROP TABLE--"],
		['XSS', '<script>alert(1)</script>'],
		['null byte', '\u0000rHb9CJAWyB4rj91VRWn96Dku'],
		['leading whitespace', ' rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
		['trailing whitespace', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh '],
		['newline', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh\n'],
		['100K-char DoS', 'r' + '1'.repeat(100000)],
		// Cross-chain rejection
		['BTC P2PKH', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
		['SOL address', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'],
		['ETH address', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'],
		['XMR address (95-char)', '4' + 'A'.repeat(94)],
	];
	let rejectAllPassed = true;
	let rejectCount = 0;
	for (const [name, input] of REJECTS) {
		if (canonXrp.addressShape.test(input)) {
			fail(`addressShape REJECTS ${name}`, `accepted input: ${input.slice(0, 60)}`);
			rejectAllPassed = false;
		}
		rejectCount++;
	}
	if (rejectAllPassed) pass(`addressShape REJECTS all ${rejectCount} adversarial inputs`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nxrp-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} xrp-trade-only scenarios passed`);
