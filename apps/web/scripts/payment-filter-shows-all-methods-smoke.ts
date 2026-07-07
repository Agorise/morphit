/**
 * payment-filter-shows-all-methods-smoke — the orderbook payment-methods
 * filter must surface EVERY registry method, not a truncated head of the
 * alphabet.
 *
 * REGRESSION: PaymentFilterSelect once capped its browse list at
 * `.slice(0, 50)`.  The registry grew past 50 methods, so the tail of the
 * alphabet (Unionpay … Zelle) silently vanished from the dropdown — Ken:
 * "the select options only go as far as S."  searchPaymentMethods returns
 * ALL entries on an empty query (see payments/search.ts), so the only thing
 * that can hide methods in the filter is a too-small cap in the component.
 *
 * This smoke pins:
 *   1. the registry still contains the late-alphabet methods the old cap
 *      dropped, and
 *   2. PaymentFilterSelect applies NO slice cap below the registry size.
 *
 * Usage (from apps/web):
 *   tsx scripts/payment-filter-shows-all-methods-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registrySrc = readFileSync(
	join(__dirname, '..', 'src', 'lib', 'payments', 'registry.ts'),
	'utf-8'
);
const componentSrc = readFileSync(
	join(__dirname, '..', 'src', 'lib', 'components', 'PaymentFilterSelect.svelte'),
	'utf-8'
);
const searchSrc = readFileSync(
	join(__dirname, '..', 'src', 'lib', 'payments', 'search.ts'),
	'utf-8'
);

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = ''): void {
	checks++;
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
	}
}

console.log('\n── Payment filter shows every method ──────────────────');

// 1. Registry size (count of `key: '...'` lines).
const registryCount = (registrySrc.match(/^\s*key:\s*'/gm) ?? []).length;
check('registry has a plausible number of methods', registryCount >= 50, `count=${registryCount}`);

// 2. Late-alphabet methods the old 50-cap dropped must still be defined —
//    these are exactly the ones that disappeared past "S".
for (const k of ['unionpay', 'venmo', 'wechat_pay', 'wise', 'zelle']) {
	check(`registry still defines '${k}'`, new RegExp(`key:\\s*'${k}'`).test(registrySrc));
}

// 3. Empty query must return all entries (so an empty-focus browse offers
//    every method; the component is then the only place a cap could hide
//    them).  Pinned against the documented search semantics.
check(
	'searchPaymentMethods returns all entries on empty query',
	/empty query returns all entries/i.test(searchSrc)
);

// 4. The component must not cap the browse list below the registry size.
//    Any `.slice(0, N)` with N < registryCount silently hides methods.
const caps = [...componentSrc.matchAll(/\.slice\(\s*0\s*,\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
if (caps.length === 0) {
	check('PaymentFilterSelect applies no truncating slice cap', true);
} else {
	for (const cap of caps) {
		check(
			`slice(0, ${cap}) in PaymentFilterSelect must be >= registry size (${registryCount})`,
			cap >= registryCount
		);
	}
}

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} payment-filter-shows-all-methods scenarios passed (registry: ${registryCount} methods, no truncating cap)`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
