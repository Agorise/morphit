#!/usr/bin/env tsx
/**
 * orderbook-freshness-contract — cp512 (t.txt O8).
 *
 * THE BUG THIS EXISTS TO CATCH.
 *
 * Ken posted two orders and paid for both. On the orderbook page each order
 * flashed for a split second and then VANISHED; a manual refresh showed them
 * on desktop but NOT on his phone, while my/orders showed them Live the whole
 * time. Two independent defects conspired, and fixing only one leaves the bug:
 *
 *   1. STALE CACHE. /v1/orderbook set no Cache-Control of its own, so the
 *      security middleware's default — `public, max-age=3` — governed it. A
 *      live, per-request orderbook is not cacheable: a browser (or any shared /
 *      edge cache) could serve an order-less list for seconds after a new order
 *      went live — exactly what the phone reload kept showing.
 *
 *   2. REST CLOBBERS SSE. The page fires fetchFirstPage() (REST) AND opens the
 *      SSE stream on mount. The stream's snapshot is a live DB read and is
 *      authoritative; a live upsert prepends a just-verified order. But
 *      fetchFirstPage() unconditionally did `items = [...result.data.items]`
 *      on resolve. A REST call that queried a moment BEFORE the order went
 *      live, but resolved AFTER the upsert painted it, overwrote items and
 *      blanked the order → flash-then-vanish.
 *
 * THE FIX (both halves, or the bug returns):
 *   A. orderbook.ts sets `cache-control: no-store` on the success response.
 *   B. the page tracks `currentStreamHadSnapshot`, reset per stream build and
 *      set on snapshot; fetchFirstPage() assigns items ONLY when it is false,
 *      so a late REST prefetch can never clobber the authoritative stream.
 *
 * Tamper tests (each must turn this red):
 *   - Drop the `cache-control: no-store` header in orderbook.ts        → A fails.
 *   - Move it onto a bad-request branch instead of the data response   → A fails.
 *   - Remove the `if (!currentStreamHadSnapshot)` items guard          → B fails.
 *   - Stop resetting the flag in buildStream, or setting it on snapshot→ B fails.
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

console.log('\n── orderbook-freshness-contract (cp512 / t.txt O8) ───\n');

const orderbook = read('apps/indexer/src/api/orderbook.ts');
const security = read('apps/indexer/src/api/middleware/security.ts');
const featured = read('apps/indexer/src/api/featuredOrderbook.ts');
const page = read('apps/web/src/routes/[lang]/orderbook/+page.svelte');

// ─── A. the live orderbook is never cached ───────────────────────
const noStoreRe = /c\.header\(\s*['"]cache-control['"]\s*,\s*['"]no-store['"]\s*\)/i;
check(
	'orderbook.ts sets cache-control: no-store',
	noStoreRe.test(orderbook),
	'without it the security-middleware default (public, max-age=3) makes the live orderbook cacheable'
);
const noStoreIdx = orderbook.search(noStoreRe);
const successJsonIdx = orderbook.search(/return c\.json\(\{[\s\S]*?items:\s*rows\.map\(rowToWire\)/);
check(
	'the no-store header sits on the success path, before the items c.json',
	noStoreIdx >= 0 && successJsonIdx >= 0 && noStoreIdx < successJsonIdx,
	'it must guard the DATA response, not a bad-request branch'
);
check(
	'the security-middleware default it overrides is still a cacheable value',
	/cache-control['"]\s*,\s*c\.res\.headers\.get\(['"]cache-control['"]\)\s*\?\?\s*['"]public, max-age=\d+['"]/i.test(
		security
	),
	'documents WHY the orderbook needs an explicit override'
);
check(
	'featuredOrderbook keeps its own max-age (the override is orderbook-scoped)',
	/c\.header\(\s*['"]cache-control['"]\s*,\s*['"]max-age=\d+, public['"]/i.test(featured)
);

// ─── B. a late REST prefetch never clobbers the SSE snapshot ──────
check('the page tracks currentStreamHadSnapshot', /let currentStreamHadSnapshot = false;/.test(page));
check(
	'buildStream() resets the flag (a fresh stream has no snapshot yet)',
	/function buildStream\(\)[\s\S]*?currentStreamHadSnapshot = false;/.test(page),
	'without the reset a filter change would inherit the previous stream\u2019s flag'
);
check(
	'onSnapshot sets the flag true',
	/onSnapshot:[\s\S]*?currentStreamHadSnapshot = true;/.test(page)
);
check(
	'fetchFirstPage guards the items assignment with !currentStreamHadSnapshot',
	/if \(!currentStreamHadSnapshot\) \{\s*items = \[\.\.\.result\.data\.items\];\s*\}/.test(page),
	'the load-bearing guard against the late-REST clobber'
);
check(
	'a failed REST prefetch does not error-card over an existing snapshot',
	/if \(currentStreamHadSnapshot\) \{\s*phase = 'ready';\s*\} else \{[\s\S]*?phase = 'error';/.test(page)
);

console.log(`\n${'─'.repeat(54)}`);
if (failed === 0) {
	console.log(`✓ all ${passed} orderbook-freshness-contract checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed}/${passed + failed} orderbook-freshness-contract checks failed`);
	process.exit(1);
}
