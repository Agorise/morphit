#!/usr/bin/env tsx
/**
 * fastpath-order-scope — v1.7.0, ADR-0051.
 *
 * THE BOUNDARY THIS PINS, AND WHY IT IS NOT A SCOPE DECISION.
 *
 * The head tailer emits order status transitions it sees at the chain head,
 * ~45-63s before the durable poller applies them. It watches EXACTLY TWO op ids,
 * and the two it does NOT watch are excluded for safety reasons that are easy to
 * lose to a well-meaning "why not orders too?" patch:
 *
 *   morphit_order_v1 (new order) — the public orderbook gates on
 *     `fee_status IN ('verified','verified_by_attestation')`. A head-block order
 *     has NOT had its fee verified, and verification is money, which ADR-0051
 *     keeps durable-only. Emitting one provisionally would put UNPAID orders in
 *     front of every user for ~60s at a time, repeatably: a fee bypass with extra
 *     steps. The person who posted an order already sees it instantly via the
 *     client-side `pendingOrders` echo, which is what was actually wanted and
 *     costs no such hole.
 *
 *   morphit_order_replace_v1 (edit) — carries the order's free text. A rejected
 *     edit would flash arbitrary content into every open orderbook.
 *
 * What remains carries no free text (cancel is `{permlink}`; complete is
 * `{permlink, counterparty}`), acts on an order already fee-verified and public,
 * and is owner-signed. Both transitions REMOVE the order from live views, so the
 * provisional path can only ever remove — never add. That is the property that
 * makes it unusable for spam, and it is structural rather than promised.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Add morphit_order_v1 to the tailer → fails.
 *   - Add morphit_order_replace_v1 → fails.
 *   - Make the stream's provisional listener emit `order_upserted` → fails.
 *   - Drop the `tracked.has()` gate → fails.
 *   - Let the tailer write to the database → fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
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

console.log('\n── fastpath-order-scope (v1.7.0 / ADR-0051) ───────────\n');

const tailer = read('apps/indexer/src/indexer/headTailer.ts');
const stream = read('apps/indexer/src/api/orderbookStream.ts');
const bus = read('apps/indexer/src/indexer/orderbookEventBus.ts');
const orderbook = read('apps/indexer/src/api/orderbook.ts');

// ─── exactly two op ids, and only those ──────────────────────────
// Match DECLARATIONS (`const X_OP_ID = '...'`), not mentions — the files explain
// at length WHY the others are excluded, and a guard that punishes documentation
// is a guard someone deletes.
const declaredOpIds = [...tailer.matchAll(/const \w*OP_ID\s*=\s*'(morphit_[a-z_0-9]+)'/g)].map(
	(m) => m[1]
);
check(
	'the tailer declares order cancel + complete',
	declaredOpIds.includes('morphit_order_cancel_v1') &&
		declaredOpIds.includes('morphit_order_complete_v1')
);
check(
	'the tailer does NOT watch morphit_order_v1 (fee bypass)',
	!declaredOpIds.includes('morphit_order_v1'),
	'a head-block order has no verified fee — this would publish unpaid orders for ~60s'
);
check(
	'the tailer does NOT watch morphit_order_replace_v1 (free-text spam)',
	!declaredOpIds.includes('morphit_order_replace_v1'),
	'an edit carries the order text; a rejected one would flash into every orderbook'
);
check(
	'no other order-ish op crept in',
	declaredOpIds.filter((id) => id.startsWith('morphit_order')).length === 2,
	`found: ${declaredOpIds.filter((id) => id.startsWith('morphit_order')).join(', ')}`
);

// ─── the premise the fee-bypass argument rests on ────────────────
// If the orderbook ever stopped gating on fee_status, the reason for excluding
// morphit_order_v1 evaporates — and so does this file's reasoning. Pin it.
check(
	'the public orderbook still gates on verified fees (premise of the exclusion)',
	/fee_status IN \('verified', 'verified_by_attestation'\)/.test(orderbook),
	'if this gate is gone, the whole fee-bypass argument needs re-opening, not patching'
);

// ─── provisional can only REMOVE ─────────────────────────────────
check(
	'the provisional event type admits only removing transitions',
	/kind: 'cancelled' \| 'completed'/.test(bus),
	"anything that could ADD an order to a live view reopens the fee bypass"
);
const provListener = /onProvisional\(\(ev\) => \{[\s\S]*?\}\);/.exec(stream)?.[0] ?? '';
check('the stream subscribes to the provisional channel', provListener.length > 0);
check(
	'the provisional listener only ever removes',
	provListener.includes('emitRemoval(ev.orderId)') && !provListener.includes('order_upserted'),
	'emitting an upsert here would send the row STALE — the table still holds the old status'
);
check(
	'the provisional listener removes ONLY what it already sent this subscriber',
	provListener.includes('if (!tracked.has(ev.orderId)) return;'),
	'the tracked gate is what makes a bogus event a no-op rather than a weapon'
);
check(
	'the provisional listener never re-queries the row',
	!/fetchOrderIfMatchesFilter/.test(provListener),
	'the durable table still holds the OLD status; a query returns the pre-change state'
);

// ─── ADR-0051 invariant #1, the load-bearing premise of all of it ─
check(
	'the tailer still NEVER writes the database',
	!/\bINSERT\b|\bUPDATE\b|\bDELETE\b|withTx\(/i.test(tailer),
	'if the fast path can write, a reorg can corrupt state and ADR-0051 collapses'
);

// ─── no listener leak ────────────────────────────────────────────
check(
	'the provisional subscription is torn down when the connection closes',
	/unsubscribeProvisional\(\);/.test(stream),
	'a leaked listener holds the closed connection forever'
);

console.log(`\n${'─'.repeat(54)}`);
if (failed === 0) {
	console.log(`✓ all ${passed} fastpath-order-scope checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed}/${passed + failed} fastpath-order-scope checks failed`);
	process.exit(1);
}
