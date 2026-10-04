#!/usr/bin/env tsx
/**
 * order-edit-window-countdown-smoke — the order-detail Edit button carries a
 * live countdown and removes itself when the 15-minute edit window closes.
 * The window rule and its formatter live in ONE module (orders/editWindow.ts)
 * that the detail page and /my/orders both use.
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
const orderDetail = readFileSync(
	join(
		WEB,
		'src',
		'routes',
		'[lang]',
		'[x+40][account=account]',
		'[permlink=permlink]',
		'+page.svelte'
	),
	'utf8'
);
const myOrders = readFileSync(
	join(WEB, 'src', 'routes', '[lang]', 'my', 'orders', '+page.svelte'),
	'utf8'
);
const editWindow = readFileSync(join(WEB, 'src', 'lib', 'orders', 'editWindow.ts'), 'utf8');

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

/** Source with comments removed: a fix's own docblock may quote the old code. */
const stripComments = (src: string): string =>
	src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
		.join('\n');

check(
	'the edit-window rule lives in ONE pure module',
	/export const EDIT_WINDOW_MS = 15 \* 60 \* 1000;/.test(editWindow) &&
		/export function editWindowRemainingSeconds/.test(editWindow)
);
check(
	'the formatter renders "4m 20s" (unpadded, matching /my/orders)',
	/return `\$\{minutes\}m \$\{seconds\}s`;/.test(editWindow)
);
check(
	'order detail shows the countdown in the Edit label',
	/order_detail\.action_edit_countdown/.test(orderDetail)
);
check(
	'the countdown reads the ticking clock (not an inline Date.now())',
	/withinEditWindowFor\(o\.created_at, nowMs\)/.test(orderDetail) &&
		/editWindowRemainingSeconds\(o\.created_at, nowMs\)/.test(orderDetail)
);
check(
	'order detail has NO hardcoded 15-minute literal left (both call sites)',
	!/15 \* 60 \* 1000/.test(stripComments(orderDetail))
);
check(
	'the "editing closed" note also derives from EDIT_WINDOW_MS',
	/age >= EDIT_WINDOW_MS/.test(orderDetail)
);
check(
	'/my/orders consumes the same module (no second formatter)',
	/editWindowRemainingSecondsFor\(o\.created_at, nowMs\)/.test(myOrders) &&
		!/function formatRemainingMmSs/.test(myOrders)
);
check(
	'all 10 locales have the countdown label with {remaining}',
	LOCALES.every((c) => String(loc(c).order_detail.action_edit_countdown).includes('{remaining}'))
);

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} order-edit-window-countdown checks passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} order-edit-window-countdown checks FAILED`);
	process.exit(1);
}
