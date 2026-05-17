#!/usr/bin/env tsx
/**
 * amount-jitter-utxo-smoke.
 *
 * Part 122 cp26 sentinel for the transparent-chain amount-jitter
 * helpers (jitterUtxoAmount + jitterBlurtAmount + dispatcher).
 *
 * The XMR jitter is already covered by older payload smokes; this
 * sentinel covers the cp26 additions:
 *  - jitterUtxoAmount: 8-decimal precision (BTC/BCH/LTC), 0-999
 *    satoshi jitter range, round-UP only
 *  - jitterBlurtAmount: 3-decimal precision, 0-99 milliblurt
 *    jitter range, round-UP only
 *  - jitterAmountForAsset dispatcher: per-asset routing
 *  - USDT pass-through (no jitter)
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
	// BLURT: 3-decimal
	const blurt = jitterAmountForAsset('blurt', '10');
	if (/^\d+\.\d{3}$/.test(blurt)) pass('dispatcher routes BLURT to 3-decimal');
	else fail('dispatcher routes BLURT to 3-decimal', `got "${blurt}"`);
}

// ── Scenario 7 — USDT passes through unchanged (no jitter) ───
{
	const out = jitterAmountForAsset('usdt', '100');
	if (out === '100') pass('USDT pass-through (no jitter)');
	else fail('USDT pass-through (no jitter)', `got "${out}"`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\namount-jitter-utxo smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} amount-jitter-utxo scenarios passed`);
