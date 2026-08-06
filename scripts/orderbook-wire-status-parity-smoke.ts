#!/usr/bin/env tsx
/**
 * orderbook-wire-status-parity — cp513 (t.txt O8, v1.8.6).
 *
 * THE BUG THIS EXISTS TO CATCH.
 *
 * The orderbook is served over TWO channels with SEPARATE wire mappings:
 *   - REST   /v1/orderbook        → rowToWire in api/orderbook.ts
 *   - SSE    /v1/orderbook/stream  → rowToWire in api/orderbookStreamHelpers.ts
 *
 * Both query `WHERE o.status = 'live'`, so `status` is always 'live' — and BOTH
 * mappings must emit it, because the FRONTEND filters every rendered order
 * through `isOrderLive(o) = (o.status === 'live' && !isOrderExpired(o))`
 * (orderExpiry.ts), used by the orderbook page's `visibleItems` derived. An
 * order whose wire shape lacks `status` arrives as `status: undefined`,
 * `undefined === 'live'` is false, and it is silently filtered OUT of the
 * rendered list — the page shows "No orders match your filters" even though the
 * row is present in `items`.
 *
 * cp510 [11d] added `status: 'live' as const` to the REST mapping. Its SSE twin
 * was MISSED, so every streamed snapshot/upsert row was filtered out. Because a
 * later refactor made the SSE snapshot authoritative, the status-less snapshot
 * won and the live orderbook rendered permanently empty (and before that, the
 * REST rows showed then the snapshot replaced them → "flash then vanish"). This
 * cost a multi-session debug. This smoke pins the contract so the two mappings
 * can never drift on `status` again.
 *
 * Tamper tests (each must turn this red):
 *   - Drop `status: 'live'` from EITHER rowToWire            → parity check fails.
 *   - Change isOrderLive to stop gating on status            → dependency check fails.
 *   - Stop filtering the orderbook page through isOrderLive  → usage check fails.
 *
 * Output contract: emits `✓ all N ... checks passed` on the last line.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── orderbook-wire-status-parity (cp513 / t.txt O8) ───\n');

const rest = read('apps/indexer/src/api/orderbook.ts');
const sse = read('apps/indexer/src/api/orderbookStreamHelpers.ts');
const expiry = read('apps/web/src/lib/orders/orderExpiry.ts');
const page = read('apps/web/src/routes/[lang]/orderbook/+page.svelte');

// A wire mapping emits a literal live status. Match the exact `status: 'live'`
// literal both mappings use (guaranteed by their `WHERE o.status = 'live'`).
const emitsLiveStatus = (src: string): boolean =>
	/\bstatus:\s*'live'\s+as\s+const\b/.test(src);

check(
	'REST orderbook rowToWire emits status: \u2018live\u2019',
	emitsLiveStatus(rest),
	'api/orderbook.ts — cp510 [11d]'
);
check(
	'SSE orderbook rowToWire emits status: \u2018live\u2019 (the twin cp510 missed)',
	emitsLiveStatus(sse),
	'api/orderbookStreamHelpers.ts — without this every streamed row is filtered out client-side'
);
check(
	'both channels agree — neither can ship an order without status',
	emitsLiveStatus(rest) && emitsLiveStatus(sse)
);

// The frontend contract that MAKES status load-bearing: isOrderLive gates on it,
// and the orderbook page filters its rendered list through isOrderLive.
check(
	'isOrderLive gates on status === \u2018live\u2019 (why status is mandatory on the wire)',
	/isOrderLive[\s\S]{0,120}?o\.status === 'live'/.test(expiry),
	'orderExpiry.ts'
);
check(
	'the orderbook page filters visibleItems through isOrderLive',
	/visibleItems[\s\S]*?isOrderLive\(o[\s,]/.test(page),
	'a status-less row would be dropped from visibleItems and the book would look empty'
);

console.log(`\n${'─'.repeat(54)}`);
if (failed === 0) {
	console.log(`✓ all ${passed} orderbook-wire-status-parity checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed}/${passed + failed} orderbook-wire-status-parity checks failed`);
	process.exit(1);
}
