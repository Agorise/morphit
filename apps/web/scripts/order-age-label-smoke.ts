#!/usr/bin/env tsx
/**
 * Smoke: how old an order is, and when it expired, read right (v1.21.17).
 *
 * The maintainer saw two of his orders under My Orders → Expired reading "Posted
 * 2mo ago" on the day they expired after 90 days, with "Expires on: Expired" and
 * no way to see the day they were posted. Now:
 *   - one ladder (relativeAge) builds every "3d" / "3mo" / "1y" — RelativeTime,
 *     the orderbook expiry chip's tooltip and the chat inbox tooltip — and it
 *     rounds months and years to the nearest one (unit-tested in
 *     relativeAge.test.ts, mounted in RelativeTime.test.ts);
 *   - the "Posted … ago" line on My Orders carries "Posted on 28 July, 2026" as
 *     its tooltip (whole line) and for a screen reader;
 *   - an expired order says "Expired on <date>".
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(WEB, rel), 'utf8');
const strip = (s: string): string =>
	s
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
};

console.log('\n── order age labels ───────────────────────────────────\n');

const LADDER_USERS = [
	'src/lib/components/RelativeTime.svelte',
	'src/lib/components/OrderExpiryChip.svelte',
	'src/routes/[lang]/chat/+page.svelte'
];
for (const f of LADDER_USERS) {
	const code = strip(read(f));
	check(`${f} builds its age from relativeAge()`, /relativeAge\(/.test(code));
	check(
		`${f} keeps no ladder of its own (no 30-day months, no 2592000 s)`,
		!/\/\s*30\)|2592000|31104000/.test(code)
	);
}

const orders = strip(read('src/routes/[lang]/my/orders/+page.svelte'));
const postedLine =
	/<span class="text-ink-500" title=\{postedOn\(o\)\}>[\s\S]*?<\/span>\s*<span class="sr-only">\{postedOn\(o\)\}<\/span>\s*<\/span>/.exec(
		orders
	)?.[0] ?? '';
check('the whole "Posted … ago" line has the "Posted on <date>" tooltip', postedLine.length > 0);
check(
	'…the relative time inside it carries the same tooltip (no second, different one)',
	/<RelativeTime iso=\{o\.created_at\} format="terse" ago title=\{postedOn\(o\)\} \/>/.test(
		postedLine
	)
);
check(
	'…and a screen reader hears the date, not "2mo ago"',
	/<span aria-hidden="true">/.test(postedLine) &&
		/class="sr-only">\{postedOn\(o\)\}/.test(postedLine)
);
check(
	'postedOn() fills my_orders.order.posted_on with the posting day',
	/function postedOn\(o: OrderRecord\): string \{\s*return \$_\('my_orders\.order\.posted_on', \{\s*values: \{ date: formatDayMonth\(o\.created_at\) \}/.test(
		orders
	)
);
check(
	'an expired order says "Expired on <date>" (not "Expires on: Expired")',
	/expiredNow \? \$_\('order_detail\.expired_on'\) : \$_\('order_detail\.expires_on'\)/.test(
		orders
	) &&
		/: formatDayMonth\(o\.expires_at\)\}/.test(orders) &&
		!/\$_\('my_orders\.order\.state_expired'\)\s*:\s*formatDayMonth\(o\.expires_at\)/.test(orders)
);

for (const loc of SUPPORTED_LOCALES.map((l) => l.code)) {
	const j = JSON.parse(read(`src/lib/i18n/locales/${loc}.json`)) as {
		my_orders: { order: Record<string, string> };
		order_detail: Record<string, string>;
	};
	check(
		`${loc}: posted_on has {date}, expired_on is set`,
		(j.my_orders.order.posted_on ?? '').includes('{date}') &&
			(j.order_detail.expired_on ?? '').length > 0
	);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log(`✗ ${fail} of ${pass + fail} order-age-label checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${pass} order-age-label scenarios passed`);
