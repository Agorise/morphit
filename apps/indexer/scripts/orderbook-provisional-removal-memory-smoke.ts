#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/orderbook-provisional-removal-memory-smoke.ts (cp508)
 *
 * Guards the fix for tt.txt #1/#2: "i canceled one of my orders, but it took
 * almost a minute for it to disappear from the orderbook."
 *
 * ROOT CAUSE. `orderbookEventBus.emitProvisional` (the head-block cancel/
 * complete fast path) is fire-and-forget with no memory. An already-open
 * orderbook stream gets the removal in ~2s, but a stream that CONNECTS after
 * the event fired takes its snapshot from the durable table — where the poller
 * is still ~45-63s behind and the row still says 'live' — so the cancelled
 * order reappears for up to a minute.
 *
 * THE FIX. The bus now remembers provisionally-removed order ids for 90s
 * (`isRecentlyRemoved`), and the orderbook stream's snapshot + fallback-poll
 * queries skip those ids. This smoke pins:
 *   1. the memory records what emitProvisional removed,
 *   2. it is id-isolated (removing A doesn't hide B),
 *   3. emitProvisional STILL dispatches to provisional listeners (the fix
 *      didn't break the ~2s path for already-open streams),
 *   4. (static) BOTH fetchSnapshot AND fetchRecentlyChanged filter by
 *      isRecentlyRemoved — the whole point is that a fresh view and the
 *      fallback poll both honour the memory.
 *
 * A regression that deletes the memory (isRecentlyRemoved always false) or
 * drops either query filter re-opens the ~60s bug; this fails loudly if so.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orderbookEventBus } from '../src/indexer/orderbookEventBus';

const HERE = dirname(fileURLToPath(import.meta.url));
const STREAM = resolve(HERE, '..', 'src', 'api', 'orderbookStream.ts');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};

// Unique ids per run so repeated runs against the process singleton don't
// collide (the bus has module-level lifetime).
const uniq = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const idA = `${uniq}-alice/order-aaaa`;
const idB = `${uniq}-bob/order-bbbb`;

// ── 1. Unknown id is not "recently removed" ──────────────────────────
if (!orderbookEventBus.isRecentlyRemoved(idA)) ok('an id never removed reads not-recently-removed');
else bad('a never-removed id wrongly reads recently-removed');

// ── 2. emitProvisional records the removal ───────────────────────────
let dispatched = 0;
const unsub = orderbookEventBus.onProvisional((ev) => {
	if (ev.orderId === idA) dispatched++;
});
orderbookEventBus.emitProvisional({ orderId: idA, kind: 'cancelled' });

if (orderbookEventBus.isRecentlyRemoved(idA)) ok('emitProvisional records the removed order id');
else bad('emitProvisional did NOT record the removed id — fresh snapshots will re-show it');

// ── 3. id isolation ──────────────────────────────────────────────────
if (!orderbookEventBus.isRecentlyRemoved(idB)) ok('a different order id stays visible (id-isolated)');
else bad('recording one removal wrongly hid an unrelated order');

// ── 4. emitProvisional still dispatches to listeners (~2s open-view path) ──
if (dispatched === 1) ok('emitProvisional still dispatches to provisional listeners');
else bad(`emitProvisional dispatched ${dispatched}× (expected 1) — open-view fast removal broken`);
unsub();

// ── 5. Static: both queries filter by isRecentlyRemoved ──────────────
const src = readFileSync(STREAM, 'utf8');
// fetchSnapshot body → its return must gate on isRecentlyRemoved.
const snapBody = src.slice(src.indexOf('async function fetchSnapshot'), src.indexOf('async function fetchOrderIfMatchesFilter'));
const recentStart = src.indexOf('async function fetchRecentlyChanged');
const recentBody = src.slice(recentStart, recentStart + 2000);

if (/isRecentlyRemoved/.test(snapBody)) ok('fetchSnapshot filters by isRecentlyRemoved (fresh view honours the memory)');
else bad('fetchSnapshot does NOT filter by isRecentlyRemoved — fresh orderbook re-shows cancelled orders');

if (/isRecentlyRemoved/.test(recentBody)) ok('fetchRecentlyChanged filters by isRecentlyRemoved (fallback poll honours the memory)');
else bad('fetchRecentlyChanged does NOT filter by isRecentlyRemoved — fallback poll flickers cancelled orders back');

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} orderbook-provisional-removal-memory scenarios passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${fail} of ${pass + fail} orderbook-provisional-removal-memory scenarios FAILED`);
	process.exit(1);
}
