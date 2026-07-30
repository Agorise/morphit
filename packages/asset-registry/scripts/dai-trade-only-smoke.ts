#!/usr/bin/env tsx
/**
 * dai-trade-only-smoke.
 *
 * Part 122 cp31 sentinel: DAI must be `canPayListingFee: false`
 * AND `canBeTraded: true` in BOTH the canonical and frontend
 * asset registries.  If a future contributor toggles either
 * value the wrong way, this smoke fails loudly.
 *
 * Memory #23 invariant pinned from two directions (same as
 * usdt-trade-only-smoke + usdc-trade-only-smoke):
 *  - Canonical registry's `canPayListingFee: true → ticker ∈
 *    {BLURT, BTC, XMR}` rule means a future contributor
 *    flipping DAI's flag to true would fail the
 *    asset-registry-smoke first (good defence-in-depth).
 *  - This smoke is the DAI-specific sentinel: DAI must be
 *    trade-only.  If the frontend's canBeUsedForListingFee
 *    drifts from the canonical's canPayListingFee, the user-
 *    facing form would offer DAI as a fee option while the
 *    indexer would reject it — confusing UX.
 *
 * Also asserts DAI carries the four supported networks
 * (ERC-20, Polygon, Base, Arbitrum), defaultNetwork: null
 * (forcing explicit choice every trade), and
 * privacyWarningKey: 'dai_partly_centralized' (distinct
 * from USDT/USDC's `*_centralized` class — see ADR-0029 §2
 * for the rationale on the more-nuanced warning).
 *
 * DAI-specific scenarios (not in USDT/USDC smokes):
 *   - SPL is INTENTIONALLY NOT in supportedNetworks (ADR-0029
 *     §1: no canonical Maker-issued DAI on Solana)
 *   - TRC-20 similarly excluded
 *   - BEP-20 similarly excluded (Binance-Peg DAI is wrapped,
 *     not Maker-native, same rationale as USDC's BEP-20
 *     exclusion under ADR-0028)
 *   - decimals === 18 (EVM-standard, different from USDT/USDC's
 *     6 — a future contributor adding any non-EVM DAI would
 *     need to confront the precision divergence first)
 *   - privacyWarningKey is the distinct `dai_partly_centralized`
 *     class, NOT lumped with `*_centralized` — gives DAI credit
 *     for the design choice (no admin freeze power) while being
 *     honest about the PSM/USDC backing dependency.
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

console.log('\n── dai-trade-only smoke ──────────────────────────────\n');

// ── Scenario 1 — DAI is in the canonical registry ────────────────
const canonDai = CANONICAL.find((a) => a.ticker === 'DAI');
if (canonDai) {
	pass('DAI is in canonical registry');
} else {
	fail('DAI is in canonical registry', 'no DAI entry found in @morphit/asset-registry ASSETS');
}

// ── Scenario 2 — canonical DAI.canPayListingFee === false ────────
if (canonDai && canonDai.canPayListingFee === false) {
	pass('canonical DAI.canPayListingFee === false (memory #23)');
} else {
	fail(
		'canonical DAI.canPayListingFee === false (memory #23)',
		`DAI must be trade-only.  fee_method enum is frozen at BLURT/BTC/XMR; DAI must not pay listing fees.  Got canPayListingFee=${canonDai?.canPayListingFee}`
	);
}

// ── Scenario 3 — canonical DAI.canBeTraded === true ──────────────
if (canonDai && canonDai.canBeTraded === true) {
	pass('canonical DAI.canBeTraded === true');
} else {
	fail(
		'canonical DAI.canBeTraded === true',
		`DAI must be tradable.  Got canBeTraded=${canonDai?.canBeTraded}`
	);
}

// ── Scenario 4 — canonical DAI supports 4 networks ───────────────
if (canonDai) {
	const networks = [...canonDai.supportedNetworks].sort();
	const expected = ['arbitrum', 'base', 'erc20', 'polygon'];
	if (JSON.stringify(networks) === JSON.stringify(expected)) {
		pass('canonical DAI.supportedNetworks = [erc20, polygon, base, arbitrum]');
	} else {
		fail(
			'canonical DAI.supportedNetworks = [erc20, polygon, base, arbitrum]',
			`got ${JSON.stringify(networks)}, expected ${JSON.stringify(expected)}`
		);
	}
}

// ── Scenario 5 — SPL is NOT in supportedNetworks (ADR-0029 §1) ───
// Sentinel against a future contributor adding wrapped/bridged DAI
// on Solana.  No canonical Maker-issued native DAI on Solana
// exists; existing Solana DAI variants (Wormhole DAI, etc.) are
// wrapper-custodian dependencies that defeat DAI's
// decentralization rationale.  If you're here adding SPL DAI,
// first read ADR-0029 §1; the rationale for the exclusion is the
// SAME rationale that distinguishes DAI from USDT/USDC.
if (canonDai && !canonDai.supportedNetworks.includes('spl')) {
	pass('canonical DAI excludes spl (ADR-0029 §1 — no canonical Maker DAI on Solana)');
} else {
	fail(
		'canonical DAI excludes spl (ADR-0029 §1 — no canonical Maker DAI on Solana)',
		'SPL DAI variants are wrapper-bridged (Wormhole, Allbridge), not Maker-native — would defeat DAI decentralization rationale.  Read ADR-0029 §1 before adding.'
	);
}

// ── Scenario 6 — TRC-20 is NOT in supportedNetworks ──────────────
if (canonDai && !canonDai.supportedNetworks.includes('trc20')) {
	pass('canonical DAI excludes trc20 (no native Maker issuance on Tron)');
} else {
	fail(
		'canonical DAI excludes trc20 (no native Maker issuance on Tron)',
		'TRC-20 DAI is wrapped, not Maker-native'
	);
}

// ── Scenario 7 — BEP-20 is NOT in supportedNetworks ──────────────
// Binance-Peg DAI is wrapped, not Maker-native; same exclusion
// rationale as USDC's BEP-20 exclusion under ADR-0028 §1.
if (canonDai && !canonDai.supportedNetworks.includes('bep20')) {
	pass('canonical DAI excludes bep20 (Binance-Peg wrapped, not Maker-native)');
} else {
	fail(
		'canonical DAI excludes bep20 (Binance-Peg wrapped, not Maker-native)',
		'BEP-20 DAI is Binance-Peg.  Wrapper-custodian dependency; same exclusion rationale as USDC BEP-20.'
	);
}

// ── Scenario 8 — defaultNetwork is null (forces explicit choice) ─
// CRITICAL FOR DAI: all 4 supported networks share the EVM 0x[40
// hex] address format — visually identical.  This is the highest
// cross-network address-confusion surface of any asset on Morphit.
if (canonDai && canonDai.defaultNetwork === null) {
	pass('canonical DAI.defaultNetwork === null (no default — forces explicit choice)');
} else {
	fail(
		'canonical DAI.defaultNetwork === null',
		`Cross-network sends lose funds.  CRITICAL HERE: all 4 DAI networks share EVM 0x[40 hex] shape — picker is the ONLY disambiguator.  Got ${canonDai?.defaultNetwork}`
	);
}

// ── Scenario 9 — privacyWarningKey is DAI-specific class ─────────
// Sentinel for the design decision in ADR-0029 §2: DAI gets the
// distinct `dai_partly_centralized` warning class, NOT lumped
// with USDT/USDC's `*_centralized`.  This reflects the real
// difference (no admin freeze power at the token contract) while
// being honest about the PSM/USDC backing dependency.  If a
// future contributor "simplifies" by lumping DAI into the
// `*_centralized` class, this smoke fires.
if (canonDai && canonDai.privacyWarningKey === 'dai_partly_centralized') {
	pass('canonical DAI.privacyWarningKey === "dai_partly_centralized" (distinct from *_centralized)');
} else {
	fail(
		'canonical DAI.privacyWarningKey === "dai_partly_centralized"',
		`DAI is not freeze-power-equivalent to USDT/USDC.  ADR-0029 §2 requires a distinct warning class that gives DAI credit for the design choice while being honest about PSM/USDC backing.  Got ${canonDai?.privacyWarningKey}`
	);
}

// ── Scenario 10 — decimals === 18 (EVM standard) ─────────────────
// DAI uses 18-decimal precision on every supported network
// (EVM-standard), different from USDT/USDC's 6.  Affects the
// underlying token math but not the user-visible amount-jitter
// resolution (jitter clamps to 6-decimal display precision).
if (canonDai && canonDai.decimals === 18) {
	pass('canonical DAI.decimals === 18 (EVM standard across all 4 networks)');
} else {
	fail(
		'canonical DAI.decimals === 18 (EVM standard across all 4 networks)',
		`Got decimals=${canonDai?.decimals}.  All 4 supported DAI networks are EVM-family with 18-decimal precision.`
	);
}

// ── Scenario 11 — frontend DAI entry mirrors canonical ───────────
const feDai = FRONTEND.find((a) => a.ticker === 'dai');
if (feDai) {
	pass('frontend DAI entry exists');
} else {
	fail('frontend DAI entry exists', 'no dai entry in apps/web/src/lib/assets/registry.ts');
}

// ── Scenario 12 — frontend canBeUsedForListingFee === false ──────
if (feDai && feDai.canBeUsedForListingFee === false) {
	pass('frontend DAI.canBeUsedForListingFee === false (mirrors canonical)');
} else {
	fail(
		'frontend DAI.canBeUsedForListingFee === false',
		`Frontend must mirror canonical.  Drift = user-facing form offers DAI as a fee option while indexer rejects it.  Got canBeUsedForListingFee=${feDai?.canBeUsedForListingFee}`
	);
}

// ── Scenario 13 — frontend DAI.canBeTraded === true ──────────────
if (feDai && feDai.canBeTraded === true) {
	pass('frontend DAI.canBeTraded === true');
} else {
	fail(
		'frontend DAI.canBeTraded === true',
		`Frontend DAI must be tradable.  Got canBeTraded=${feDai?.canBeTraded}`
	);
}

// ── Scenario 14 — frontend DAI.defaultNetwork === null ───────────
if (feDai && feDai.defaultNetwork === null) {
	pass('frontend DAI.defaultNetwork === null');
} else {
	fail(
		'frontend DAI.defaultNetwork === null',
		`Got ${feDai?.defaultNetwork}`
	);
}

// ── Scenario 15 — frontend DAI.privacyWarningKey set ─────────────
if (feDai && feDai.privacyWarningKey === 'dai_partly_centralized') {
	pass('frontend DAI.privacyWarningKey === "dai_partly_centralized"');
} else {
	fail(
		'frontend DAI.privacyWarningKey === "dai_partly_centralized"',
		`Got ${feDai?.privacyWarningKey}`
	);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\ndai-trade-only smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} dai-trade-only scenarios passed`);
