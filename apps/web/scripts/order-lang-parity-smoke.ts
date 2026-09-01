#!/usr/bin/env tsx
/**
 * order-lang-parity-smoke.ts (v1.15.0)
 *
 * The order-language codes (operator-config ORDER_LANG_CODES — used by the
 * indexer to validate/filter, and by the web order + profile ops) MUST stay in
 * lockstep with the web SUPPORTED_LOCALES (the switcher / the "This post is in"
 * options). If they drift, a user could post in a language the orderbook filter
 * can't offer, or the filter could offer a language no order can be tagged with.
 * This locks the set + the isOrderLang guard.
 */
import { ORDER_LANG_CODES, ORDER_LANG_SET, isOrderLang } from '@morphit/operator-config';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales.ts';

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  ✗ ${desc}`);
	}
}

console.log('\n── order-lang parity smoke (v1.15.0) ──────────────────\n');

const localeCodes = SUPPORTED_LOCALES.map((l) => l.code);

check('there are exactly 10 order-language codes', ORDER_LANG_CODES.length === 10);
check(
	'ORDER_LANG_CODES equals SUPPORTED_LOCALES codes, SAME ORDER',
	JSON.stringify([...ORDER_LANG_CODES]) === JSON.stringify(localeCodes)
);
check(
	'ORDER_LANG_SET has exactly the SUPPORTED_LOCALES codes (set equality)',
	ORDER_LANG_SET.size === localeCodes.length && localeCodes.every((c) => ORDER_LANG_SET.has(c))
);

// isOrderLang accepts every supported code
for (const c of localeCodes) {
	check(`isOrderLang accepts "${c}"`, isOrderLang(c));
}

// …and rejects everything else
check('isOrderLang rejects an unsupported code', !isOrderLang('jp'));
check('isOrderLang rejects a bare language of a supported region (e.g. "zh")', !isOrderLang('zh'));
check('isOrderLang rejects empty string', !isOrderLang(''));
check('isOrderLang rejects non-strings', !isOrderLang(null) && !isOrderLang(42) && !isOrderLang(['en']));
check('isOrderLang rejects an uppercase variant', !isOrderLang('EN'));

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} order-lang-parity checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} order-lang-parity scenarios passed`);
