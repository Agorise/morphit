#!/usr/bin/env tsx
/**
 * sol-trade-only-smoke.
 *
 * Part 122 cp45 sentinel: SOL (Solana) must be
 * `canPayListingFee: false` AND `canBeTraded: true` in BOTH the
 * canonical and frontend asset registries.
 *
 * Memory #23 invariant pinned from two directions: canonical
 * registry's `canPayListingFee: true → ticker ∈ {BLURT, BTC,
 * XMR}` rule means a future contributor flipping SOL's flag to
 * true would fail asset-registry-smoke first.  This smoke is the
 * SOL-specific sentinel.
 *
 * Also asserts SOL ships single-network (mainnet only),
 * privacyWarningKey: null (decentralized PoS), optInPrivacyTech
 * is empty (Solana has no native protocol-level mixing), 9
 * decimals (lamports — unique smallest-unit precision among
 * Morphit's 14 assets), and addressShape accepts 32-44 base58
 * character strings.
 *
 * Address-validator coverage: 32-char minimum, 44-char maximum
 * (most addresses are exactly 44).  Rejects out-of-range lengths
 * and non-base58 characters.
 *
 * LL #50 NOTE: SOL addresses share their shape with USDT-Solana
 * and USDC-Solana SPL token-account addresses.  This is by
 * design — Solana addresses ARE base58 32-byte public keys
 * regardless of whether they hold native SOL or an SPL token.
 * The asset field on the order disambiguates at the order
 * layer; cp42 address-shape-overlap-smoke documents the
 * intentional cross-asset overlaps.
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

console.log('\n── sol-trade-only smoke ──────────────────────────────\n');

// ── Scenario 1 — canonical registry has SOL with correct flags ──
const canonSol = CANONICAL.find((a) => a.ticker === 'SOL');
if (!canonSol) {
	fail('canonical registry contains SOL entry', "no ASSETS entry with ticker==='SOL'");
} else {
	pass('canonical registry contains SOL entry');
	if (canonSol.canBeTraded === true) pass('canonical SOL.canBeTraded === true');
	else fail('canonical SOL.canBeTraded === true', `actual: ${canonSol.canBeTraded}`);
	if (canonSol.canPayListingFee === false) pass('canonical SOL.canPayListingFee === false (memory #23)');
	else fail('canonical SOL.canPayListingFee === false (memory #23)', `actual: ${canonSol.canPayListingFee}`);
	if (canonSol.decimals === 9) pass('canonical SOL.decimals === 9 (lamports)');
	else fail('canonical SOL.decimals === 9 (lamports)', `actual: ${canonSol.decimals}`);
	if (Array.isArray(canonSol.supportedNetworks) && canonSol.supportedNetworks.length === 1 && canonSol.supportedNetworks[0] === 'mainnet') {
		pass('canonical SOL.supportedNetworks === [mainnet]');
	} else {
		fail('canonical SOL.supportedNetworks === [mainnet]', `actual: ${JSON.stringify(canonSol.supportedNetworks)}`);
	}
	if (canonSol.defaultNetwork === 'mainnet') pass('canonical SOL.defaultNetwork === mainnet');
	else fail('canonical SOL.defaultNetwork === mainnet', `actual: ${canonSol.defaultNetwork}`);
	if (canonSol.privacyWarningKey === null) pass('canonical SOL.privacyWarningKey === null (decentralized PoS)');
	else fail('canonical SOL.privacyWarningKey === null', `actual: ${canonSol.privacyWarningKey}`);
	const pf = canonSol.privacyFeatures;
	if (pf && pf.freshAddressAdvice === 'hd-derived') pass('canonical SOL.freshAddressAdvice === hd-derived');
	else fail('canonical SOL.freshAddressAdvice === hd-derived', `actual: ${JSON.stringify(pf)}`);
	if (pf && pf.optInPrivacyTech === null) {
		pass('canonical SOL.optInPrivacyTech === null (no native mixing protocol; matches XMR convention)');
	} else {
		fail('canonical SOL.optInPrivacyTech === null', `actual: ${JSON.stringify(pf?.optInPrivacyTech)}`);
	}
	if (pf && pf.privacyGuideKey === 'sol') pass('canonical SOL.privacyGuideKey === sol');
	else fail('canonical SOL.privacyGuideKey === sol', `actual: ${pf?.privacyGuideKey}`);
}

// ── Scenario 2 — frontend registry parity ──
const feSol = FRONTEND.find((a) => a.ticker === 'sol');
if (!feSol) {
	fail('frontend registry contains sol entry', "no ASSETS entry with ticker==='sol'");
} else {
	pass('frontend registry contains sol entry');
	if (feSol.canBeTraded === true) pass('frontend sol.canBeTraded === true');
	else fail('frontend sol.canBeTraded === true', `actual: ${feSol.canBeTraded}`);
	// @ts-expect-error
	if (feSol.canBeUsedForListingFee === false) pass('frontend sol.canBeUsedForListingFee === false (memory #23)');
	// @ts-expect-error
	else fail('frontend sol.canBeUsedForListingFee === false', `actual: ${feSol.canBeUsedForListingFee}`);
	if (feSol.decimals === 9) pass('frontend sol.decimals === 9');
	else fail('frontend sol.decimals === 9', `actual: ${feSol.decimals}`);
}

// ── Scenario 3 — address validator coverage ──
if (canonSol) {
	// Specimens — valid 44-char address (most common) + 32-char minimum
	const VALID_44 = '1'.repeat(44); // synthetic 44-char base58
	const VALID_32 = '1'.repeat(32); // synthetic 32-char base58 (length minimum)
	const VALID_REAL = 'So11111111111111111111111111111111111111112'; // 43-char wSOL mint
	if (canonSol.addressShape.test(VALID_44)) pass('addressShape ACCEPTS 44-char address');
	else fail('addressShape ACCEPTS 44-char address', `regex: ${canonSol.addressShape}`);
	if (canonSol.addressShape.test(VALID_32)) pass('addressShape ACCEPTS 32-char address (minimum)');
	else fail('addressShape ACCEPTS 32-char address (minimum)', `regex: ${canonSol.addressShape}`);
	if (canonSol.addressShape.test(VALID_REAL)) pass('addressShape ACCEPTS real wSOL-mint-shaped 43-char');
	else fail('addressShape ACCEPTS real-shaped 43-char', `regex: ${canonSol.addressShape}`);

	// Adversarial — should all REJECT
	const REJECTS: Array<[string, string]> = [
		['empty', ''],
		['1 char short (31)', '1'.repeat(31)],
		['1 char long (45)', '1'.repeat(45)],
		['100 char (massive overrun)', '1'.repeat(100)],
		['contains 0 (excluded from base58)', '0' + '1'.repeat(43)],
		['contains O (excluded)', 'O' + '1'.repeat(43)],
		['contains I (excluded)', 'I' + '1'.repeat(43)],
		['contains l (excluded)', 'l' + '1'.repeat(43)],
		['SQL injection', "'; DROP TABLE--AAAAAAAAAAAAAAAAAAAAAAAA"],
		['XSS', '<script>alert(1)</script>'],
		['null byte', '\u0000' + '1'.repeat(43)],
		['leading whitespace', ' ' + '1'.repeat(44)],
		['trailing whitespace', '1'.repeat(44) + ' '],
		['newline', '1'.repeat(44) + '\n'],
		['100K-char DoS', '1'.repeat(100000)],
		// Cross-chain rejection — these are NOT Solana shapes (length/charset mismatch)
		['BTC P2PKH (1A1zP1...)', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'], // 34 chars but starts with valid base58 — this IS within {32,44} so will match. Document as intentional overlap.
		['ETH 0x-address (42-char hex, no 0x)', '0' + 'a'.repeat(41)], // contains 0, rejected
	];
	let rejectAllPassed = true;
	let rejectCount = 0;
	for (const [name, input] of REJECTS) {
		// Note: BTC P2PKH at 34 chars within {32,44} is an EXPECTED overlap.
		// Skip that one from the reject test — it's documented in
		// cp42 address-shape-overlap-smoke EXPECTED_OVERLAPS.
		if (name.includes('BTC P2PKH')) continue;
		if (canonSol.addressShape.test(input)) {
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
	console.error('\nsol-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} sol-trade-only scenarios passed`);
