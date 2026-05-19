#!/usr/bin/env tsx
/**
 * eth-trade-only-smoke.
 *
 * Part 122 cp47 sentinel: ETH (Ethereum) must be
 * `canPayListingFee: false` AND `canBeTraded: true` in BOTH the
 * canonical and frontend asset registries.
 *
 * Memory #23 invariant pinned from two directions: canonical
 * registry's `canPayListingFee: true → ticker ∈ {BLURT, BTC,
 * XMR}` rule means a future contributor flipping ETH's flag to
 * true would fail asset-registry-smoke first.  This smoke is the
 * ETH-specific sentinel.
 *
 * Also asserts ETH ships single-network (mainnet only),
 * privacyWarningKey: null (decentralized PoS post-Merge),
 * optInPrivacyTech: null (Ethereum has no native protocol-level
 * mixing), 18 decimals (wei — EVM-standard ERC-20 precision),
 * and addressShape accepts 0x-prefixed 40-hex strings.
 *
 * Address-validator coverage: 42 chars total (0x + 40 hex).
 * Rejects non-hex chars, wrong length, missing prefix, etc.
 *
 * LL #50 NOTE: ETH addresses share their shape with USDT-ERC20,
 * USDC-ERC20, DAI-ERC20, USDC-Base, USDC-Polygon, USDC-Arbitrum,
 * DAI-Polygon, DAI-Arbitrum, DAI-Base — every EVM token-account
 * address.  This is by design — Ethereum addresses ARE 20-byte
 * hex regardless of whether they hold native ETH or an ERC-20
 * token on any EVM chain.  The asset field (plus network field
 * for multi-network assets) disambiguates at the order layer;
 * cp42 address-shape-overlap-smoke documents the intentional
 * cross-asset overlaps.
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

console.log('\n── eth-trade-only smoke ──────────────────────────────\n');

// ── Scenario 1 — canonical registry has ETH with correct flags ──
const canonEth = CANONICAL.find((a) => a.ticker === 'ETH');
if (!canonEth) {
	fail('canonical registry contains ETH entry', "no ASSETS entry with ticker==='ETH'");
} else {
	pass('canonical registry contains ETH entry');
	if (canonEth.canBeTraded === true) pass('canonical ETH.canBeTraded === true');
	else fail('canonical ETH.canBeTraded === true', `actual: ${canonEth.canBeTraded}`);
	if (canonEth.canPayListingFee === false) pass('canonical ETH.canPayListingFee === false (memory #23)');
	else fail('canonical ETH.canPayListingFee === false (memory #23)', `actual: ${canonEth.canPayListingFee}`);
	if (canonEth.decimals === 18) pass('canonical ETH.decimals === 18 (wei)');
	else fail('canonical ETH.decimals === 18 (wei)', `actual: ${canonEth.decimals}`);
	if (Array.isArray(canonEth.supportedNetworks) && canonEth.supportedNetworks.length === 1 && canonEth.supportedNetworks[0] === 'mainnet') {
		pass('canonical ETH.supportedNetworks === [mainnet]');
	} else {
		fail('canonical ETH.supportedNetworks === [mainnet]', `actual: ${JSON.stringify(canonEth.supportedNetworks)}`);
	}
	if (canonEth.defaultNetwork === 'mainnet') pass('canonical ETH.defaultNetwork === mainnet');
	else fail('canonical ETH.defaultNetwork === mainnet', `actual: ${canonEth.defaultNetwork}`);
	if (canonEth.privacyWarningKey === null) pass('canonical ETH.privacyWarningKey === null (decentralized PoS)');
	else fail('canonical ETH.privacyWarningKey === null', `actual: ${canonEth.privacyWarningKey}`);
	const pf = canonEth.privacyFeatures;
	if (pf && pf.freshAddressAdvice === 'hd-derived') pass('canonical ETH.freshAddressAdvice === hd-derived');
	else fail('canonical ETH.freshAddressAdvice === hd-derived', `actual: ${JSON.stringify(pf)}`);
	if (pf && pf.optInPrivacyTech === null) {
		pass('canonical ETH.optInPrivacyTech === null (no native mixing protocol; matches XMR/SOL convention)');
	} else {
		fail('canonical ETH.optInPrivacyTech === null', `actual: ${JSON.stringify(pf?.optInPrivacyTech)}`);
	}
	if (pf && pf.privacyGuideKey === 'eth') pass('canonical ETH.privacyGuideKey === eth');
	else fail('canonical ETH.privacyGuideKey === eth', `actual: ${pf?.privacyGuideKey}`);
}

// ── Scenario 2 — frontend registry parity ──
const feEth = FRONTEND.find((a) => a.ticker === 'eth');
if (!feEth) {
	fail('frontend registry contains eth entry', "no ASSETS entry with ticker==='eth'");
} else {
	pass('frontend registry contains eth entry');
	if (feEth.canBeTraded === true) pass('frontend eth.canBeTraded === true');
	else fail('frontend eth.canBeTraded === true', `actual: ${feEth.canBeTraded}`);
	// @ts-expect-error
	if (feEth.canBeUsedForListingFee === false) pass('frontend eth.canBeUsedForListingFee === false (memory #23)');
	// @ts-expect-error
	else fail('frontend eth.canBeUsedForListingFee === false', `actual: ${feEth.canBeUsedForListingFee}`);
	if (feEth.decimals === 18) pass('frontend eth.decimals === 18');
	else fail('frontend eth.decimals === 18', `actual: ${feEth.decimals}`);
}

// ── Scenario 3 — address validator coverage ──
if (canonEth) {
	const VALID_LOWER = '0x' + 'a'.repeat(40);
	const VALID_MIXED = '0xAbCdEf0123456789abcDEF0123456789aBcDeF01'; // EIP-55-shaped (not real checksum)
	const VALID_REAL = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // vitalik.eth's known address
	if (canonEth.addressShape.test(VALID_LOWER)) pass('addressShape ACCEPTS lowercase 0x+40hex');
	else fail('addressShape ACCEPTS lowercase 0x+40hex', `regex: ${canonEth.addressShape}`);
	if (canonEth.addressShape.test(VALID_MIXED)) pass('addressShape ACCEPTS EIP-55 mixed-case');
	else fail('addressShape ACCEPTS EIP-55 mixed-case', `regex: ${canonEth.addressShape}`);
	if (canonEth.addressShape.test(VALID_REAL)) pass('addressShape ACCEPTS real-shape address (vitalik.eth)');
	else fail('addressShape ACCEPTS real-shape address', `regex: ${canonEth.addressShape}`);

	const REJECTS: Array<[string, string]> = [
		['empty', ''],
		['no 0x prefix', 'a'.repeat(40)],
		['0x but 39 hex (1 short)', '0x' + 'a'.repeat(39)],
		['0x but 41 hex (1 long)', '0x' + 'a'.repeat(41)],
		['0X uppercase prefix', '0X' + 'a'.repeat(40)],
		['contains g (not hex)', '0x' + 'g'.repeat(40)],
		['contains z (not hex)', '0x' + 'z'.repeat(40)],
		['contains spaces', '0x ' + 'a'.repeat(39)],
		['ENS name (alice.eth)', 'alice.eth'],
		['ENS name (vitalik.eth)', 'vitalik.eth'],
		['SQL injection', "'; DROP TABLE--abcdef0123456789abcdef01"],
		['XSS', '<script>alert(1)</script>'],
		['null byte', '\u0000' + 'a'.repeat(40)],
		['leading whitespace', ' 0x' + 'a'.repeat(40)],
		['trailing whitespace', '0x' + 'a'.repeat(40) + ' '],
		['newline', '0x' + 'a'.repeat(40) + '\n'],
		['100K-char DoS', '0x' + 'a'.repeat(100000)],
		// Cross-chain rejection
		['BTC P2PKH', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
		['SOL address', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'],
		['XMR address (95-char)', '4' + 'A'.repeat(94)],
	];
	let rejectAllPassed = true;
	let rejectCount = 0;
	for (const [name, input] of REJECTS) {
		if (canonEth.addressShape.test(input)) {
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
	console.error('\neth-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} eth-trade-only scenarios passed`);
