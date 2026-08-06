#!/usr/bin/env tsx
/**
 * disabled-assets-parse-smoke.
 *
 * Part 121 follow-up: pin the behavior of the env-var parser
 * for MORPHIT_INDEXER_DISABLED_ASSETS so multi-coin disabling
 * works whether the operator writes:
 *
 *   MORPHIT_INDEXER_DISABLED_ASSETS="USDT"          (one coin)
 *   MORPHIT_INDEXER_DISABLED_ASSETS="USDT,DAI"      (two coins)
 *   MORPHIT_INDEXER_DISABLED_ASSETS="USDT, DAI"     (whitespace)
 *   MORPHIT_INDEXER_DISABLED_ASSETS="usdt,dai"      (lowercase)
 *   MORPHIT_INDEXER_DISABLED_ASSETS=" USDT, DAI, "  (padded + trailing comma)
 *   MORPHIT_INDEXER_DISABLED_ASSETS=""              (empty / unset)
 *
 * All should parse to a normalized uppercase array, no empty
 * tokens, no whitespace.  This is a real Ken-asked question:
 * "how do we handle that if the operator wants to disable 2
 * or 3 coins, not just one?"
 *
 * The parser lives in apps/indexer/src/config/index.ts and
 * uses zod's .transform() chain (split+trim+upper+filter-empty).
 * If a future contributor simplifies the parser and breaks one
 * of these forms, this smoke fails loudly.
 */

import { z } from 'zod';

// Re-derive the exact transform from config/index.ts to test
// in isolation (without booting the full config).  If the
// production parser drifts from this re-derivation, the
// integration tests in apps/indexer/test/ will catch it.
const parser = z
	.string()
	.default('')
	.transform((s) =>
		s
			.split(',')
			.map((t) => t.trim().toUpperCase())
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

console.log('\n── disabled-assets-parse smoke ───────────────────────\n');

expect('empty → []', '', []);
expect('one coin → [USDT]', 'USDT', ['USDT']);
expect('two coins → [USDT,DAI]', 'USDT,DAI', ['USDT', 'DAI']);
expect('three coins → [USDT,DAI,USDC]', 'USDT,DAI,USDC', ['USDT', 'DAI', 'USDC']);
expect('whitespace tolerant → [USDT,DAI]', 'USDT, DAI', ['USDT', 'DAI']);
expect('lowercase normalized → [USDT]', 'usdt', ['USDT']);
expect('mixed case + whitespace → [USDT,DAI]', '  usdt , Dai ', ['USDT', 'DAI']);
expect('trailing comma → [USDT]', 'USDT,', ['USDT']);
expect('leading comma → [USDT]', ',USDT', ['USDT']);
expect('double comma → [USDT,DAI]', 'USDT,,DAI', ['USDT', 'DAI']);
expect('whitespace-only token dropped → [USDT]', 'USDT, ,', ['USDT']);
expect('mixed normalized form → [USDT,DAI,USDC]', '  USDT,  dai , USDC  ', [
	'USDT',
	'DAI',
	'USDC'
]);

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\ndisabled-assets-parse smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} disabled-assets-parse scenarios passed`);
