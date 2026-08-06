#!/usr/bin/env tsx
/**
 * Smoke: the orderbook wire response carries `status`, so the client-side
 * expiry filter doesn't blank the whole book. Anchor cp510 [11d].
 *
 * THE BUG THIS GUARDS. cp508 added a client-side expiry guard on the orderbook:
 * `visibleItems` filters each row through `isOrderLive(o, now)`, which is
 * `o.status === 'live' && !isOrderExpired(o, now)`. But the orderbook query's
 * row → wire mapping (`rowToWire` in apps/indexer/src/api/orderbook.ts) OMITTED
 * `status`, even though the SQL WHERE clause guarantees `o.status = 'live'`. So
 * every wire order arrived with `status === undefined`, `isOrderLive` returned
 * false for ALL of them, and the orderbook rendered a BLANK orders section the
 * moment it contained any order (the "no orders match your filters" empty-state
 * card was also missing — see the catch-all branch). It only looked fine while
 * the book was empty, which is why it slipped through.
 *
 * THE CONTRACT. If the orderbook filters on `o.status` client-side, the wire
 * must send `o.status`. This smoke fails if either half regresses:
 *
 *   1. `rowToWire` emits a `status` field (the query only returns live rows, so
 *      it's the constant 'live').
 *   2. `isOrderLive` still gates on `o.status === 'live'` — i.e. the wire field
 *      is load-bearing (documents WHY #1 must stay).
 *   3. The orderbook page still runs rows through `isOrderLive` for visibility.
 *   4. The orderbook page has a `visibleItems.length === 0` catch-all so an
 *      all-filtered book shows the empty-state card, never a blank <ul>.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Delete `status:` from rowToWire → fails (#1).
 *   - Make isOrderLive stop checking o.status → fails (#2).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

let pass = 0;
let fail = 0;
const ok = (m: string): void => {
	console.log(`  ✓ ${m}`);
	pass++;
};
const bad = (m: string): void => {
	console.error(`  ✗ ${m}`);
	fail++;
};
const read = (rel: string): string => {
	const p = join(REPO, rel);
	return existsSync(p) ? readFileSync(p, 'utf-8') : '';
};

// ── 1. rowToWire emits status ──
const orderbookApi = read('apps/indexer/src/api/orderbook.ts');
const rowToWireIdx = orderbookApi.indexOf('function rowToWire');
const rowToWireBody = rowToWireIdx >= 0 ? orderbookApi.slice(rowToWireIdx, rowToWireIdx + 1600) : '';
if (/\bstatus:\s*'live'/.test(rowToWireBody)) {
	ok("orderbook rowToWire emits status: 'live'");
} else {
	bad(
		"orderbook rowToWire does NOT emit `status: 'live'` — the client isOrderLive filter will " +
			'drop every order and blank the book (cp510 [11d]).'
	);
}

// ── 2. the SQL only returns live rows (so the constant is honest) ──
if (/o\.status\s*=\s*'live'/.test(orderbookApi)) {
	ok("orderbook query still filters WHERE o.status = 'live' (constant is honest)");
} else {
	bad("orderbook query no longer pins o.status = 'live' — the hard-coded wire 'live' may be wrong.");
}

// ── 3. isOrderLive gates on o.status === 'live' (the field is load-bearing) ──
const expiry = read('apps/web/src/lib/orders/orderExpiry.ts');
if (/isOrderLive/.test(expiry) && /o\.status\s*===\s*'live'/.test(expiry)) {
	ok("isOrderLive still gates on o.status === 'live' (wire status is load-bearing)");
} else {
	bad('isOrderLive no longer checks o.status === live — the wire-status contract has drifted.');
}

// ── 4. the orderbook page filters visibleItems through isOrderLive ──
const orderbookPage = read('apps/web/src/routes/[lang]/orderbook/+page.svelte');
if (/visibleItems\b/.test(orderbookPage) && /isOrderLive\(/.test(orderbookPage)) {
	ok('orderbook page runs rows through isOrderLive for visibility');
} else {
	bad('orderbook page no longer uses isOrderLive for visibleItems — contract untested here.');
}

// ── 5. catch-all empty-state so an all-filtered book is never a blank <ul> ──
if (/\{:else if visibleItems\.length === 0\}/.test(orderbookPage)) {
	ok('orderbook has a visibleItems.length === 0 catch-all empty-state branch');
} else {
	bad(
		'orderbook lacks a `{:else if visibleItems.length === 0}` catch-all — an all-filtered book ' +
			'can render a blank <ul> with no empty-state card (cp510 [11d]).'
	);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log(`✓ all ${pass} orderbook-live-status-wired scenarios passed`);
