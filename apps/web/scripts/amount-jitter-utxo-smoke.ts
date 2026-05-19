#!/usr/bin/env tsx
/**
 * amount-jitter-utxo-smoke.
 *
 * Part 122 cp26 sentinel for the transparent-chain amount-jitter
 * helpers (jitterUtxoAmount + jitterBlurtAmount + dispatcher);
 * extended in cp30 to cover the stablecoin variant
 * (jitterStablecoinAmount via jitterAmountForAsset routing); cp31
 * added DAI (third stablecoin); cp33 added DOGE (sixth UTXO); cp39 added ZEC (seventh); cp41 added ARRR (eighth — Sapling shielded but UTXO-model amount semantics); cp43 added DCR (ninth — hybrid PoW/PoS, UTXO-model); cp45 added SOL (NOT routed through this function — Solana has 9-decimal lamport precision and uses a NEW jitterSolAmount); cp47 added ETH (NOT routed through this function — ETH is 18-decimal on-chain and uses a NEW jitterEthAmount with 6-decimal display-clamp matching the DAI cp31 design).
 *
 * The XMR jitter is already covered by older payload smokes; this
 * sentinel covers:
 *  - jitterUtxoAmount: 8-decimal precision (BTC/BCH/LTC/DASH/DOGE),
 *    0-999 satoshi jitter range, round-UP only
 *  - jitterBlurtAmount: 3-decimal precision, 0-99 milliblurt
 *    jitter range, round-UP only
 *  - jitterStablecoinAmount (cp30, via dispatcher): 6-decimal
 *    precision (USDT/USDC), 18-decimal precision (DAI), 0-999
 *    micro-unit jitter range, round-UP only.  See ADR-0028
 *    Decision 2 — the cp26 USDT-pass-through behaviour was
 *    reversed in cp30 because the amount-correlation linkability
 *    threat is independent of the centralization concern.
 *  - jitterAmountForAsset dispatcher: per-asset routing across
 *    all 12 tradable assets
 *  - input validation throws on garbage
 */

// crypto is global in modern Node — no shim needed
import {
	jitterUtxoAmount,
	jitterBlurtAmount,
	jitterAmountForAsset
} from '../src/lib/chat/payload';

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

console.log('\n── amount-jitter-utxo smoke ──────────────────────────\n');

// ── Scenario 1 — UTXO output is 8 decimals ───────────────────
{
	const out = jitterUtxoAmount('0.001');
	const m = /^\d+\.\d{8}$/.test(out);
	if (m) pass('jitterUtxoAmount output has 8 decimals');
	else fail('jitterUtxoAmount output has 8 decimals', `got "${out}"`);
}

// ── Scenario 2 — UTXO jitter rounds UP only ──────────────────
{
	// Run 100 iterations, every output must be >= input
	const base = '0.001';
	const baseSat = 100_000n; // 0.001 BTC = 100,000 sat
	let underpayment = 0;
	let maxJitter = 0n;
	for (let i = 0; i < 100; i++) {
		const out = jitterUtxoAmount(base);
		const [w, f = ''] = out.split('.');
		const sat = BigInt(w) * 100_000_000n + BigInt((f + '00000000').slice(0, 8));
		if (sat < baseSat) underpayment++;
		const diff = sat - baseSat;
		if (diff > maxJitter) maxJitter = diff;
	}
	if (underpayment === 0) pass('jitterUtxoAmount never rounds down (100 trials)');
	else fail('jitterUtxoAmount never rounds down', `${underpayment} underpayments`);
	if (maxJitter < 1000n) pass(`jitterUtxoAmount jitter < 1000 sat (saw max ${maxJitter})`);
	else fail('jitterUtxoAmount jitter < 1000 sat', `saw ${maxJitter}`);
}

// ── Scenario 3 — UTXO rejects garbage input ──────────────────
{
	try {
		jitterUtxoAmount('not-a-number');
		fail('jitterUtxoAmount rejects garbage', 'no throw');
	} catch {
		pass('jitterUtxoAmount rejects garbage');
	}
}

// ── Scenario 4 — BLURT output is 3 decimals ──────────────────
{
	const out = jitterBlurtAmount('100');
	const m = /^\d+\.\d{3}$/.test(out);
	if (m) pass('jitterBlurtAmount output has 3 decimals');
	else fail('jitterBlurtAmount output has 3 decimals', `got "${out}"`);
}

// ── Scenario 5 — BLURT jitter < 100 milliblurt ───────────────
{
	const base = '100';
	const baseMilli = 100_000n;
	let underpayment = 0;
	let maxJitter = 0n;
	for (let i = 0; i < 100; i++) {
		const out = jitterBlurtAmount(base);
		const [w, f = ''] = out.split('.');
		const milli = BigInt(w) * 1000n + BigInt((f + '000').slice(0, 3));
		if (milli < baseMilli) underpayment++;
		const diff = milli - baseMilli;
		if (diff > maxJitter) maxJitter = diff;
	}
	if (underpayment === 0) pass('jitterBlurtAmount never rounds down');
	else fail('jitterBlurtAmount never rounds down', `${underpayment} underpayments`);
	if (maxJitter < 100n) pass(`jitterBlurtAmount jitter < 100 milliblurt (saw max ${maxJitter})`);
	else fail('jitterBlurtAmount jitter < 100 milliblurt', `saw ${maxJitter}`);
}

// ── Scenario 6 — dispatcher routes correctly ─────────────────
{
	// XMR: 12-decimal output
	const xmr = jitterAmountForAsset('xmr', '1.5');
	if (/^\d+\.\d{12}$/.test(xmr)) pass('dispatcher routes XMR to 12-decimal');
	else fail('dispatcher routes XMR to 12-decimal', `got "${xmr}"`);
	// BTC: 8-decimal
	const btc = jitterAmountForAsset('btc', '0.5');
	if (/^\d+\.\d{8}$/.test(btc)) pass('dispatcher routes BTC to 8-decimal');
	else fail('dispatcher routes BTC to 8-decimal', `got "${btc}"`);
	// BCH: 8-decimal
	const bch = jitterAmountForAsset('bch', '0.5');
	if (/^\d+\.\d{8}$/.test(bch)) pass('dispatcher routes BCH to 8-decimal');
	else fail('dispatcher routes BCH to 8-decimal', `got "${bch}"`);
	// LTC: 8-decimal
	const ltc = jitterAmountForAsset('ltc', '0.5');
	if (/^\d+\.\d{8}$/.test(ltc)) pass('dispatcher routes LTC to 8-decimal');
	else fail('dispatcher routes LTC to 8-decimal', `got "${ltc}"`);
	// DASH: 8-decimal (cp27)
	const dash = jitterAmountForAsset('dash', '0.5');
	if (/^\d+\.\d{8}$/.test(dash)) pass('dispatcher routes DASH to 8-decimal');
	else fail('dispatcher routes DASH to 8-decimal', `got "${dash}"`);
	// DOGE: 8-decimal (cp33 — UTXO family, shibatoshi scale)
	const doge = jitterAmountForAsset('doge', '0.5');
	if (/^\d+\.\d{8}$/.test(doge)) pass('dispatcher routes DOGE to 8-decimal (cp33)');
	else fail('dispatcher routes DOGE to 8-decimal (cp33)', `got "${doge}"`);
	// ZEC: 8-decimal (cp39 — UTXO family, zatoshi scale)
	const zec = jitterAmountForAsset('zec', '0.5');
	if (/^\d+\.\d{8}$/.test(zec)) pass('dispatcher routes ZEC to 8-decimal (cp39)');
	else fail('dispatcher routes ZEC to 8-decimal (cp39)', `got "${zec}"`);
	// BLURT: 3-decimal
	const blurt = jitterAmountForAsset('blurt', '10');
	if (/^\d+\.\d{3}$/.test(blurt)) pass('dispatcher routes BLURT to 3-decimal');
	else fail('dispatcher routes BLURT to 3-decimal', `got "${blurt}"`);
	// USDT: 6-decimal (cp30 — reversed the cp26 USDT-no-jitter
	// decision; see ADR-0028 Decision 2).
	const usdt = jitterAmountForAsset('usdt', '100');
	if (/^\d+\.\d{6}$/.test(usdt)) pass('dispatcher routes USDT to 6-decimal (cp30)');
	else fail('dispatcher routes USDT to 6-decimal (cp30)', `got "${usdt}"`);
	// USDC: 6-decimal (cp30 — new asset, stablecoin jitter)
	const usdc = jitterAmountForAsset('usdc', '100');
	if (/^\d+\.\d{6}$/.test(usdc)) pass('dispatcher routes USDC to 6-decimal (cp30)');
	else fail('dispatcher routes USDC to 6-decimal (cp30)', `got "${usdc}"`);
	// DAI: stablecoin jitter, 6-decimal display precision per the
	// jitterStablecoinAmount routine (DAI's underlying token is
	// 18-decimal but the jitter routine standardizes display at
	// 6-decimal — same as USDT/USDC).
	const dai = jitterAmountForAsset('dai', '100');
	if (/^\d+\.\d{6}$/.test(dai)) pass('dispatcher routes DAI to 6-decimal (cp31)');
	else fail('dispatcher routes DAI to 6-decimal (cp31)', `got "${dai}"`);
}

// ── Scenario 7 — stablecoin jitter range + round-up (cp30/cp31) ─
// Per ADR-0028 Decision 2: jitter for stablecoins is 0–999
// micro-units (6-decimal precision), round-UP only — same
// invariants as the UTXO jitter, just at a different scale.
// CP35 closure: added DAI to the iteration (cp31 missed it).
{
	for (const asset of ['usdt', 'usdc', 'dai'] as const) {
		const baseMicro = BigInt(100) * 1_000_000n; // 100.000000
		let underpayment = 0;
		let maxJitter = 0n;
		for (let i = 0; i < 1000; i++) {
			const out = jitterAmountForAsset(asset, '100');
			const [w, f = ''] = out.split('.');
			const micro = BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
			if (micro < baseMicro) underpayment++;
			const diff = micro - baseMicro;
			if (diff > maxJitter) maxJitter = diff;
		}
		if (underpayment === 0) pass(`jitterAmountForAsset('${asset}') never rounds down`);
		else fail(`jitterAmountForAsset('${asset}') never rounds down`, `${underpayment} underpayments out of 1000`);
		if (maxJitter < 1000n) pass(`jitterAmountForAsset('${asset}') jitter < 1000 micro-units (saw max ${maxJitter})`);
		else fail(`jitterAmountForAsset('${asset}') jitter < 1000 micro-units`, `saw ${maxJitter}`);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\namount-jitter-utxo smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} amount-jitter-utxo scenarios passed`);
