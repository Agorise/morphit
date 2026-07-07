#!/usr/bin/env tsx
/**
 * payment-rail-coverage-parity-smoke.
 *
 * CP42 deep-deep I-62 closure: pins LL #36 invariant structurally
 * — every tradable asset in the canonical registry MUST have a
 * corresponding `pay_<ticker>` entry in the frontend's payments
 * registry.  If a future asset addition lands tradable status
 * but forgets the payment-rail row, this smoke fails loudly.
 *
 * Twin smoke to wiring-completeness-smoke's cp41-arrr-payment-rail-wired
 * CHECK row (which pins ARRR specifically); this smoke pins the
 * INVARIANT across all 12 assets in one shot.
 */

import { ASSETS as CANONICAL, isGoodsAsset, type AssetTicker } from '../src/index';
import { ASSETS as FRONTEND } from '../../../apps/web/src/lib/assets/registry';
import { PAYMENT_METHODS } from '../../../apps/web/src/lib/payments/registry';

let failed = 0;
let passed = 0;

console.log('\n── payment-rail coverage parity smoke ────────────────\n');

const tradableTickers = new Set(
	CANONICAL.filter((a) => a.canBeTraded).map((a) => a.ticker.toLowerCase())
);
const payRailKeys = new Set(
	PAYMENT_METHODS.filter((m) => m.key.startsWith('pay_')).map((m) => m.key.slice('pay_'.length))
);

// cp425 — goods assets (BARTER) settle in one of the buyer's accepted
// cryptos (the order's `accepted_assets`), not a fiat rail, so there's no
// `pay_barter` payment method. Exempt them from the pay-rail requirement.
const missing = [...tradableTickers].filter(
	(t) => !payRailKeys.has(t) && !isGoodsAsset(t.toUpperCase() as AssetTicker)
);
const extra = [...payRailKeys].filter((k) => !tradableTickers.has(k));

if (missing.length === 0 && extra.length === 0) {
	console.log(`  ✓ All ${tradableTickers.size} tradable assets have a payment-rail entry (LL #36)`);
	passed++;
} else {
	if (missing.length) {
		console.error(`  ✗ MISSING payment-rail entries: ${missing.join(', ')}`);
		failed++;
	}
	if (extra.length) {
		console.error(`  ✗ EXTRA payment-rail entries (no tradable asset): ${extra.join(', ')}`);
		failed++;
	}
}

// Also assert tradable-vs-frontend parity
const frontTickers = new Set(FRONTEND.filter((a) => a.canBeTraded).map((a) => a.ticker));
const canonLower = new Set([...tradableTickers]);
const drift = [...canonLower].filter((t) => !frontTickers.has(t)).concat([...frontTickers].filter((t) => !canonLower.has(t)));
if (drift.length === 0) {
	console.log(`  ✓ Canonical canBeTraded set == Frontend canBeTraded set`);
	passed++;
} else {
	console.error(`  ✗ Canonical↔Frontend canBeTraded drift: ${drift.join(', ')}`);
	failed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('\npayment-rail-coverage-parity smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} payment-rail-coverage-parity scenarios passed`);
