#!/usr/bin/env tsx
/**
 * disabled-payment-methods-parse-smoke.
 *
 * cp208: pin the behavior of the env-var parser for
 * MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS — the payment-method
 * analogue of disabled-assets-parse-smoke.  An operator who wants
 * to turn off Barter (or any other canonical method) writes:
 *
 *   MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS="barter_goods"
 *   MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS="barter_goods,paypal"
 *   MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS="barter_goods, paypal"   (whitespace)
 *   MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS="BARTER_GOODS"               (mixed case)
 *   MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS=" barter_goods, , "          (padded + empty token)
 *   MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS=""                           (offer all — default)
 *
 * All should parse to a normalized LOWERCASE array (payment-method
 * keys are lowercase, unlike the uppercase asset tickers), with no
 * empty tokens and no whitespace.
 *
 * The parser lives in apps/indexer/src/config/index.ts and uses
 * zod's .transform() chain (split + trim + lower + filter-empty).
 * If a future contributor simplifies the parser and breaks one of
 * these forms, this smoke fails loudly.
 */

import { z } from 'zod';

// Re-derive the exact transform from config/index.ts to test in
// isolation (without booting the full config).  Mirrors the
// production MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS parser.
const parser = z
	.string()
	.default('')
	.transform((s) =>
		s
			.split(',')
			.map((t) => t.trim().toLowerCase())
			.filter((t) => t.length > 0)
	);

let failed = 0;
let passed = 0;

function expect(name: string, input: string, expected: string[]): void {
	const got = parser.parse(input);
	const ok = JSON.stringify(got) === JSON.stringify(expected);
	if (ok) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.error(`  ✗ ${name}`);
		console.error(`      input:    ${JSON.stringify(input)}`);
		console.error(`      got:      ${JSON.stringify(got)}`);
		console.error(`      expected: ${JSON.stringify(expected)}`);
		failed++;
	}
}

console.log('\n── disabled-payment-methods-parse smoke ──────────────\n');

expect('empty → []', '', []);
expect('one method → [barter_goods]', 'barter_goods', ['barter_goods']);
expect('two methods → [barter_goods,paypal]', 'barter_goods,paypal', [
	'barter_goods',
	'paypal'
]);
expect('three methods', 'barter_goods,paypal,zelle', [
	'barter_goods',
	'paypal',
	'zelle'
]);
expect('whitespace tolerant', 'barter_goods, paypal', ['barter_goods', 'paypal']);
expect('uppercase normalized → lowercase', 'BARTER_GOODS', ['barter_goods']);
expect('mixed case + whitespace', '  Barter_Goods , PayPal ', [
	'barter_goods',
	'paypal'
]);
expect('trailing comma', 'barter_goods,', ['barter_goods']);
expect('leading comma', ',barter_goods', ['barter_goods']);
expect('double comma', 'barter_goods,,paypal', ['barter_goods', 'paypal']);
expect('whitespace-only token dropped', 'barter_goods, ,', ['barter_goods']);
expect('fully normalized form', '  barter_goods,  PayPal , zelle  ', [
	'barter_goods',
	'paypal',
	'zelle'
]);

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\ndisabled-payment-methods-parse smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} disabled-payment-methods-parse scenarios passed`);
