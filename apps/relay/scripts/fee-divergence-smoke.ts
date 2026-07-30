#!/usr/bin/env tsx
/**
 * Smoke for analyzeFeeDivergence helper.
 *
 * The relay polls Blurt's chain properties to learn the
 * current account_creation_fee.  When the chain value drifts
 * from the operator's configured MORPHIT_INDEXER_ACCOUNT_
 * CREATION_FEE_BLURT by more than 10%, the operator's
 * fallback is stale and they should update their env.  When
 * the chain value is unparseable, the relay falls back to the
 * configured value and logs loudly.
 *
 * This smoke exercises the pure analysis function without
 * the dblurt rotator, so it runs offline at CI time.
 *
 * Coverage:
 *   - In-range: exact match, ±5%, ±9.99%
 *   - Divergent: ±10.01%, ±50%, ±99% (tests up-and-down)
 *   - Fallback (unparseable): undefined, null, number, empty
 *     string, missing ticker, wrong ticker, NaN
 *   - Edge: chain fee is exactly threshold (10.00%) — should
 *     stay in_range (strict > comparison)
 *   - Defensive: configured fallback ≤ 0 → fallback (no
 *     division-by-zero or absurd divergence pct)
 *   - Realistic: 100 BLURT (current real Blurt fee) ↔ various
 *     observed values
 *
 * Usage:
 *   tsx apps/relay/scripts/fee-divergence-smoke.ts
 */

import { analyzeFeeDivergence, FEE_DIVERGENCE_WARN_THRESHOLD } from '../src/blurt/client.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function expectKind(actual: unknown, expectedKind: string, label = ''): void {
	const a = (actual as { kind?: string })?.kind;
	if (a !== expectedKind) {
		throw new Error(
			`${label ? label + ': ' : ''}expected kind=${expectedKind}, got kind=${a} (full: ${JSON.stringify(actual)})`
		);
	}
}

console.log('analyzeFeeDivergence smoke:\n');

// ─── Sanity: threshold is what we expect ──────────────────

scenario('FEE_DIVERGENCE_WARN_THRESHOLD is exported as 0.10', () => {
	if (FEE_DIVERGENCE_WARN_THRESHOLD !== 0.1) {
		throw new Error(`expected 0.10, got ${FEE_DIVERGENCE_WARN_THRESHOLD}`);
	}
});

// ─── In-range ─────────────────────────────────────────────

scenario('exact match → in_range', () => {
	const r = analyzeFeeDivergence('100.000 BLURT', 100);
	expectKind(r, 'in_range');
});

scenario('+5% → in_range', () => {
	const r = analyzeFeeDivergence('105.000 BLURT', 100);
	expectKind(r, 'in_range');
});

scenario('-5% → in_range', () => {
	const r = analyzeFeeDivergence('95.000 BLURT', 100);
	expectKind(r, 'in_range');
});

scenario('+9.99% → in_range (strictly under threshold)', () => {
	const r = analyzeFeeDivergence('109.990 BLURT', 100);
	expectKind(r, 'in_range');
});

scenario('exactly +10.00% → in_range (strict > comparison)', () => {
	// Boundary: divergence === threshold.  We use strict >, so
	// 0.10 === 0.10 stays in_range.  This is the safer side —
	// no warning at the exact boundary value.
	const r = analyzeFeeDivergence('110.000 BLURT', 100);
	expectKind(r, 'in_range');
});

// ─── Divergent ────────────────────────────────────────────

scenario('+10.01% → divergent', () => {
	const r = analyzeFeeDivergence('110.010 BLURT', 100);
	expectKind(r, 'divergent');
});

scenario('+50% → divergent', () => {
	const r = analyzeFeeDivergence('150.000 BLURT', 100);
	expectKind(r, 'divergent');
	const a = r as { observedBlurt: number; divergencePct: number };
	if (a.observedBlurt !== 150) {
		throw new Error(`expected observedBlurt=150, got ${a.observedBlurt}`);
	}
	if (a.divergencePct !== 50) {
		throw new Error(`expected divergencePct=50, got ${a.divergencePct}`);
	}
});

scenario('-50% → divergent (drop below)', () => {
	const r = analyzeFeeDivergence('50.000 BLURT', 100);
	expectKind(r, 'divergent');
	const a = r as { divergencePct: number };
	if (a.divergencePct !== 50) {
		throw new Error(`expected divergencePct=50, got ${a.divergencePct}`);
	}
});

scenario('+99% (near doubling) → divergent', () => {
	const r = analyzeFeeDivergence('199.000 BLURT', 100);
	expectKind(r, 'divergent');
});

// ─── Fallback (unparseable observed) ──────────────────────

scenario('undefined → fallback', () => {
	const r = analyzeFeeDivergence(undefined, 100);
	expectKind(r, 'fallback');
});

scenario('null → fallback', () => {
	const r = analyzeFeeDivergence(null, 100);
	expectKind(r, 'fallback');
});

scenario('number 100 (not a string) → fallback', () => {
	const r = analyzeFeeDivergence(100, 100);
	expectKind(r, 'fallback');
});

scenario('empty string → fallback', () => {
	const r = analyzeFeeDivergence('', 100);
	expectKind(r, 'fallback');
});

scenario('missing ticker ("100.000") → fallback', () => {
	const r = analyzeFeeDivergence('100.000', 100);
	expectKind(r, 'fallback');
});

scenario('wrong ticker ("100.000 STEEM") → fallback', () => {
	const r = analyzeFeeDivergence('100.000 STEEM', 100);
	expectKind(r, 'fallback');
});

scenario('garbled string ("not a fee") → fallback', () => {
	const r = analyzeFeeDivergence('not a fee', 100);
	expectKind(r, 'fallback');
});

scenario('object value → fallback', () => {
	const r = analyzeFeeDivergence({ amount: 100 }, 100);
	expectKind(r, 'fallback');
});

// ─── Edge cases on the parsed observed value ──────────────

scenario('zero observed ("0.000 BLURT") → fallback (not a real fee)', () => {
	const r = analyzeFeeDivergence('0.000 BLURT', 100);
	expectKind(r, 'fallback');
});

scenario('negative observed not parseable by regex → fallback', () => {
	// regex is /^([\d.]+)\s+BLURT$/ which doesn't match '-' prefix
	const r = analyzeFeeDivergence('-100.000 BLURT', 100);
	expectKind(r, 'fallback');
});

// ─── Defensive: bad operator config ───────────────────────

scenario('configured fallback = 0 → fallback (avoid div-by-zero)', () => {
	const r = analyzeFeeDivergence('100.000 BLURT', 0);
	expectKind(r, 'fallback');
});

scenario('configured fallback = NaN → fallback', () => {
	const r = analyzeFeeDivergence('100.000 BLURT', Number.NaN);
	expectKind(r, 'fallback');
});

scenario('configured fallback = -50 → fallback', () => {
	const r = analyzeFeeDivergence('100.000 BLURT', -50);
	expectKind(r, 'fallback');
});

// ─── Realistic Blurt fee scenarios ────────────────────────

scenario('REALISTIC: 100 BLURT chain ↔ 100 BLURT config (current state)', () => {
	const r = analyzeFeeDivergence('100.000 BLURT', 100);
	expectKind(r, 'in_range');
});

scenario('REALISTIC: witnesses raise to 200 ↔ 100 config (operator stale)', () => {
	const r = analyzeFeeDivergence('200.000 BLURT', 100);
	expectKind(r, 'divergent');
	const a = r as { divergencePct: number };
	if (a.divergencePct !== 100) {
		throw new Error(`expected divergencePct=100, got ${a.divergencePct}`);
	}
});

scenario('REALISTIC: witnesses drop to 50 ↔ 100 config', () => {
	const r = analyzeFeeDivergence('50.000 BLURT', 100);
	expectKind(r, 'divergent');
});

scenario('REALISTIC: chain RPC returns garbage during outage', () => {
	const r = analyzeFeeDivergence('NETWORK_ERROR', 100);
	expectKind(r, 'fallback');
});

console.log(
	`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} scenarios passed`
);
process.exit(failures === 0 ? 0 : 1);
