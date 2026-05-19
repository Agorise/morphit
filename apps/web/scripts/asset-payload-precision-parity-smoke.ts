#!/usr/bin/env tsx
/**
 * asset-payload-precision-parity-smoke (cp46 — O-1 closure).
 *
 * RUN-LOCATION REQUIREMENT: must be invoked with apps/web/tsconfig.json
 * as the resolved tsconfig because the imports below traverse into
 * payload.ts which uses `$lib` path aliases.  The smoke either runs
 * with cwd=apps/web (default tsconfig discovery) or with
 * TSX_TSCONFIG_PATH=apps/web/tsconfig.json set explicitly.
 *
 * run-smokes.sh sets TSX_TSCONFIG_PATH for this entry.
 *
 * Pins THREE invariants per asset that no other smoke catches:
 *
 *   1. **Decimals ↔ jitter precision parity.**  Each canonical
 *      asset declares `decimals: N`.  The jitter function for
 *      that asset's amount-class operates at N-decimal
 *      precision.  Mismatch (e.g. jitterSolAmount running at
 *      1e8 instead of 1e9) silently produces wrong on-chain
 *      amounts.  Cp45 SOL addition surfaced this gap: a
 *      mutation M-98 changing `1_000_000_000n` to `100_000_000n`
 *      was invisible to all 35 existing smokes.  This smoke
 *      pins the invariant by exercising `jitterAmountForAsset`
 *      at runtime and counting fractional digits.
 *
 *   2. **URI scheme parity.**  Each asset has a documented URI
 *      scheme in its payment-URI builder branch (`bitcoin:`,
 *      `monero:`, `litecoin:`, `bitcoincash:`, `dash:`,
 *      `dogecoin:`, `zcash:`, `arrr:`, `decred:`, `solana:`,
 *      EVM-style for stablecoins, in-app for BLURT).  Cp46
 *      mutation M-99 changing `solana:` → `bitcoin:` would
 *      silently emit wrong URIs and confuse wallets.  This
 *      smoke pins each asset's expected scheme.
 *
 *   3. **Txid shape parity.**  Each asset has a documented
 *      txid regex.  Cp46 mutation M-97 widening
 *      `/^[1-9A-HJ-NP-Za-km-z]{87,88}$/` to `{1,200}` would
 *      silently accept malformed txids (BTC 64-hex shape would
 *      then test true for SOL).  This smoke pins each asset's
 *      txid by testing shape-correct input ACCEPTED and
 *      shape-wrong input REJECTED.
 *
 * Discipline: this smoke is REQUIRED to PASS at every
 * checkpoint.  It runs in ~50ms because it only does string
 * arithmetic, no I/O.
 */

import { ASSETS as CANONICAL } from '@morphit/asset-registry';
import {
	jitterAmountForAsset,
	buildPaymentUri,
	isValidTxid,
	type ChatAssetTicker
} from '../src/lib/chat/payload';

// Per-asset expected URI scheme + txid shape.  Source-of-truth
// is the cp1-cp45 wiring across the registry; this smoke is the
// load-bearing cross-check.
type AssetExpectation = {
	ticker: string;
	chatTicker: ChatAssetTicker;
	expectedJitterDecimals: number; // may differ from canonical.decimals (DAI uses 6-decimal jitter on 18-decimal on-chain by cp31 design)
	expectedUriScheme: string | null; // null = no URI (BLURT) or per-network (USDT/USDC/DAI)
	txidShapeAcceptable: string;
	txidShapeUnacceptable: string;
};

const EXPECTATIONS: AssetExpectation[] = [
	{
		ticker: 'BTC',
		chatTicker: 'btc',
		expectedJitterDecimals: 8,
		expectedUriScheme: 'bitcoin:',
		txidShapeAcceptable: 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'XMR',
		chatTicker: 'xmr',
		expectedJitterDecimals: 12,
		expectedUriScheme: 'monero:',
		txidShapeAcceptable: 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'BLURT',
		chatTicker: 'blurt',
		expectedJitterDecimals: 3,
		expectedUriScheme: null,
		txidShapeAcceptable: 'a'.repeat(40),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'USDT',
		chatTicker: 'usdt',
		expectedJitterDecimals: 6,
		expectedUriScheme: null,
		txidShapeAcceptable: '0x' + 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'USDC',
		chatTicker: 'usdc',
		expectedJitterDecimals: 6,
		expectedUriScheme: null,
		txidShapeAcceptable: '0x' + 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'DAI',
		chatTicker: 'dai',
		// DAI is 18-decimal on-chain but jitter clamps to 6-decimal
		// display precision per cp31 ADR-0029 design: consistent
		// $0.001-magnitude jitter UX across all stablecoins.  Comment
		// in packages/asset-registry/src/index.ts DAI entry documents
		// this; the smoke captures the design choice as a fixed
		// invariant.
		expectedJitterDecimals: 6,
		expectedUriScheme: null,
		txidShapeAcceptable: '0x' + 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'BCH',
		chatTicker: 'bch',
		expectedJitterDecimals: 8,
		expectedUriScheme: 'bitcoincash:',
		txidShapeAcceptable: 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'LTC',
		chatTicker: 'ltc',
		expectedJitterDecimals: 8,
		expectedUriScheme: 'litecoin:',
		txidShapeAcceptable: 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'DASH',
		chatTicker: 'dash',
		expectedJitterDecimals: 8,
		expectedUriScheme: 'dash:',
		txidShapeAcceptable: 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'DOGE',
		chatTicker: 'doge',
		expectedJitterDecimals: 8,
		expectedUriScheme: 'dogecoin:',
		txidShapeAcceptable: 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'ZEC',
		chatTicker: 'zec',
		expectedJitterDecimals: 8,
		expectedUriScheme: 'zcash:',
		txidShapeAcceptable: 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'ARRR',
		chatTicker: 'arrr',
		expectedJitterDecimals: 8,
		expectedUriScheme: 'arrr:',
		txidShapeAcceptable: 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'DCR',
		chatTicker: 'dcr',
		expectedJitterDecimals: 8,
		expectedUriScheme: 'decred:',
		txidShapeAcceptable: 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	},
	{
		ticker: 'SOL',
		chatTicker: 'sol',
		// SOL is the first 9-decimal asset in Morphit.  Cp45 added
		// jitterSolAmount for 9-decimal lamport arithmetic.  cp46
		// M-98 mutation showed that changing 1_000_000_000n to
		// 100_000_000n (BTC-family precision) was silently invisible
		// to all 35 existing smokes — this smoke is the structural
		// closure.
		expectedJitterDecimals: 9,
		expectedUriScheme: 'solana:',
		txidShapeAcceptable: '1'.repeat(87),
		txidShapeUnacceptable: '1'.repeat(86)
	},
	{
		ticker: 'ETH',
		chatTicker: 'eth',
		// ETH is 18-decimal on-chain (wei) but jitter clamps to
		// 6-decimal display precision per cp47 design (matching
		// DAI's cp31 ADR-0029 rationale).  At $2500/ETH a 0-999
		// microether jitter range is ~$0.0025 max — the same
		// $0.001-magnitude jitter UX the stablecoins use.
		expectedJitterDecimals: 6,
		expectedUriScheme: 'ethereum:',
		txidShapeAcceptable: '0x' + 'a'.repeat(64),
		txidShapeUnacceptable: 'a'.repeat(63)
	}
];

let passed = 0;
let failed = 0;

function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── asset-payload-precision-parity smoke (cp46) ──────\n');

// ── 1. canonical asset count matches expectations array ──
if (CANONICAL.length === EXPECTATIONS.length) {
	pass(`canonical asset count (${CANONICAL.length}) matches expectations`);
} else {
	fail(
		`canonical asset count matches expectations`,
		`canonical ${CANONICAL.length} != expectations ${EXPECTATIONS.length} — add a row for the new asset`
	);
}

// ── 2. Decimals ↔ jitter precision parity ──
for (const exp of EXPECTATIONS) {
	const canonAsset = CANONICAL.find((a) => a.ticker === exp.ticker);
	if (!canonAsset) {
		fail(`${exp.ticker} canonical lookup`, 'not found in registry');
		continue;
	}
	// jitterAmountForAsset on '0' input yields '0.<frac>' where frac
	// has exactly `expectedJitterDecimals` characters (zero-padded).
	// NOTE: expectedJitterDecimals may differ from canonAsset.decimals
	// for DAI (18-decimal on-chain, 6-decimal jitter clamp by cp31
	// design).  The smoke author maintains EXPECTATIONS to reflect
	// the documented design choice; mutations to jitter arithmetic
	// surface as mismatches against EXPECTATIONS.
	let jittered: string;
	try {
		jittered = jitterAmountForAsset(exp.chatTicker, '0');
	} catch (e) {
		fail(`${exp.ticker} jitter callable on '0'`, String(e));
		continue;
	}
	const [_, frac = ''] = jittered.split('.');
	if (frac.length === exp.expectedJitterDecimals) {
		pass(`${exp.ticker} jitter precision === ${exp.expectedJitterDecimals} decimals`);
	} else {
		fail(
			`${exp.ticker} jitter precision === ${exp.expectedJitterDecimals} decimals`,
			`expected ${exp.expectedJitterDecimals}-char fraction, got ${frac.length} chars ("${frac}") in "${jittered}"`
		);
	}
}

// ── 3. URI scheme parity ──
for (const exp of EXPECTATIONS) {
	if (exp.expectedUriScheme === null) {
		// Skip URI test for assets with no single scheme (BLURT account
		// names; USDT/USDC/DAI multi-network); covered by per-network
		// smokes elsewhere.
		continue;
	}
	let uri: string;
	try {
		// Synthesize a payload — use a shape-correct address for the
		// asset.  We use the canonical addressShape regex to pick a
		// valid example.
		const sampleAddrs: Record<string, string> = {
			BTC: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
			XMR: '4'.repeat(95),
			BCH: 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
			LTC: 'LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL',
			DASH: 'XwnLY8qaFu8aGM9XRdcaQ9XgnnQ8AbnXkc',
			DOGE: 'DPHwLrG5Cm5R8KCNNfMcXSEoVbCRBkXxhf',
			ZEC: 't1RKFygRTZxfP7Z3uW4kBJjGNB6cqxQyEmA',
			ARRR: 'zs1' + 'q'.repeat(75),
			DCR: 'Dsmcfb6dGoZBaBdF8u1QFcKsuyaPgxR8N7d',
			SOL: 'So11111111111111111111111111111111111111112',
			ETH: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
		};
		const addr = sampleAddrs[exp.ticker];
		if (!addr) {
			fail(`${exp.ticker} URI test sample address`, 'no sample defined');
			continue;
		}
		uri = buildPaymentUri({ method: exp.chatTicker, address: addr } as any);
	} catch (e) {
		fail(`${exp.ticker} URI callable`, String(e));
		continue;
	}
	if (uri.startsWith(exp.expectedUriScheme)) {
		pass(`${exp.ticker} URI scheme === ${exp.expectedUriScheme}`);
	} else {
		fail(
			`${exp.ticker} URI scheme === ${exp.expectedUriScheme}`,
			`got "${uri.slice(0, 40)}..."`
		);
	}
}

// ── 4. Txid shape parity ──
for (const exp of EXPECTATIONS) {
	const ok = isValidTxid(exp.chatTicker, exp.txidShapeAcceptable);
	if (ok) {
		pass(`${exp.ticker} txid ACCEPTS shape-correct (${exp.txidShapeAcceptable.length} chars)`);
	} else {
		fail(
			`${exp.ticker} txid ACCEPTS shape-correct`,
			`rejected ${exp.txidShapeAcceptable.length}-char synthetic input "${exp.txidShapeAcceptable.slice(0, 20)}..."`
		);
	}
	const bad = isValidTxid(exp.chatTicker, exp.txidShapeUnacceptable);
	if (!bad) {
		pass(`${exp.ticker} txid REJECTS shape-wrong (${exp.txidShapeUnacceptable.length} chars)`);
	} else {
		fail(
			`${exp.ticker} txid REJECTS shape-wrong`,
			`accepted ${exp.txidShapeUnacceptable.length}-char input "${exp.txidShapeUnacceptable.slice(0, 20)}..."`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nasset-payload-precision-parity smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} asset-payload-precision-parity scenarios passed`);
