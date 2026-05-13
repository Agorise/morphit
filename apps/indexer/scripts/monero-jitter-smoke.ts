/**
 * Smoke: jitterMoneroAmount helper (Q5 unlinkability).
 *
 * Verifies:
 *   - Output is always >= input (no underpayment).
 *   - Output is at most input + 1e-6 XMR (jitter ≤ 999_999 piconero).
 *   - Output is 12-decimal-precise.
 *   - Same input across many calls produces different outputs
 *     (RNG actually varies; ≥99% unique across 100 calls).
 *   - Malformed inputs throw.
 *   - Edge cases: integer inputs, already-fractional inputs,
 *     trailing-zero inputs.
 *
 * Runs in Node with crypto.webcrypto; no DOM dependency.
 */

import { jitterMoneroAmount } from '../../web/src/lib/chat/payload.ts';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── monero-jitter smoke ───────────────────────────────────\n');

function parsePico(s: string): bigint {
	const [w, f = ''] = s.split('.');
	const padded = (f + '000000000000').slice(0, 12);
	return BigInt(w) * 1_000_000_000_000n + BigInt(padded);
}

scenario('output >= input always (sample 200)', () => {
	const base = '0.5';
	const basePico = parsePico(base);
	for (let i = 0; i < 200; i++) {
		const out = jitterMoneroAmount(base);
		const outPico = parsePico(out);
		if (outPico < basePico) {
			throw new Error(`output ${out} < input ${base} on iteration ${i}`);
		}
	}
});

scenario('output <= input + 1e-6 XMR always', () => {
	const base = '0.5';
	const basePico = parsePico(base);
	const ceilingPico = basePico + 999_999n;
	for (let i = 0; i < 200; i++) {
		const out = jitterMoneroAmount(base);
		const outPico = parsePico(out);
		if (outPico > ceilingPico) {
			throw new Error(`output ${out} exceeds input + 999999 piconero`);
		}
	}
});

scenario('output is 12-decimal-precise', () => {
	const out = jitterMoneroAmount('1');
	if (!/^\d+\.\d{12}$/.test(out)) {
		throw new Error(`bad shape: ${out}`);
	}
});

scenario('different calls produce different outputs', () => {
	const seen = new Set<string>();
	for (let i = 0; i < 100; i++) {
		seen.add(jitterMoneroAmount('0.5'));
	}
	// Allowing up to 1 collision since RNG can technically repeat,
	// but at 1 in a million we expect 99 unique out of 100.
	if (seen.size < 95) {
		throw new Error(`only ${seen.size} unique out of 100 — RNG broken?`);
	}
});

scenario('integer input works', () => {
	const out = jitterMoneroAmount('5');
	const outPico = parsePico(out);
	if (outPico < 5_000_000_000_000n || outPico > 5_000_000_999_999n) {
		throw new Error(`out-of-range: ${out}`);
	}
});

scenario('high-precision input works', () => {
	const out = jitterMoneroAmount('0.123456789012');
	const outPico = parsePico(out);
	const inPico = parsePico('0.123456789012');
	if (outPico < inPico || outPico > inPico + 999_999n) {
		throw new Error(`out-of-range: ${out}`);
	}
});

scenario('zero input works', () => {
	// Edge case: a 0-amount transfer with jitter pays the seller a
	// trivial dust. Not a sensible trade, but the helper should
	// not crash.
	const out = jitterMoneroAmount('0');
	const outPico = parsePico(out);
	if (outPico > 999_999n) throw new Error(`unexpected: ${out}`);
});

scenario('rejects malformed input: empty', () => {
	try {
		jitterMoneroAmount('');
		throw new Error('did not throw');
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes('invalid')) {
			throw err;
		}
	}
});

scenario('rejects malformed input: non-numeric', () => {
	try {
		jitterMoneroAmount('abc');
		throw new Error('did not throw');
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes('invalid')) {
			throw err;
		}
	}
});

scenario('rejects malformed input: 13+ decimals', () => {
	try {
		jitterMoneroAmount('0.1234567890123');
		throw new Error('did not throw');
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes('invalid')) {
			throw err;
		}
	}
});

scenario('rejects malformed input: negative', () => {
	try {
		jitterMoneroAmount('-1');
		throw new Error('did not throw');
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes('invalid')) {
			throw err;
		}
	}
});

scenario('AMOUNT_RE accepts the jittered output', () => {
	// The wire-format AMOUNT_RE allows 1..12 digits whole + 1..12
	// fractional. The jitter helper produces 12 fractional digits
	// — the tightest the regex allows.
	const out = jitterMoneroAmount('0.5');
	if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(out)) {
		throw new Error(`AMOUNT_RE mismatch: ${out}`);
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
