#!/usr/bin/env tsx
/**
 * fee-status-banner-copy-smoke — the /my/orders fee-status banner.
 *
 * The English banner is the approved copy byte for byte; no locale ends the
 * sentence with a dangling locative ("there", "allí", "dort" …) left over
 * from an older wording; and dismissing the banner is remembered.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
const loc = (c: string) =>
	JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', `${c}.json`), 'utf8'));

const myOrders = readFileSync(
	join(WEB, 'src', 'routes', '[lang]', 'my', 'orders', '+page.svelte'),
	'utf8'
);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

const WANT_BANNER =
	'\u{1F4A1} Each order below shows its listing-fee status. An order appears in the public orderbook only once its fee is verified \u2014 a badge reading \u201Cnot received\u201D, \u201Cunderpaid\u201D or \u201Cnot yet verified\u201D is why an order may appear to be missing.';
check(
	'the EN fee-status banner is the approved copy, byte for byte',
	loc('en').my_orders.fee_status_banner.body === WANT_BANNER
);
check(
	'no locale still ends with a locative ("there"/"allí"/"dort"…)',
	LOCALES.every(
		(c) =>
			!/\b(there|all[íi]|l[àa]-bas|dort|l[ìi]|tam|там)\s*[.。]$/u.test(
				loc(c).my_orders.fee_status_banner.body
			)
	)
);
check(
	'the banner × still dismisses forever (localStorage)',
	/safeLocal\.set\(FEE_BANNER_DISMISS_KEY, '1'\)/.test(myOrders)
);

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} fee-status-banner-copy checks passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} fee-status-banner-copy checks FAILED`);
	process.exit(1);
}
