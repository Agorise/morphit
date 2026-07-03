#!/usr/bin/env tsx
/**
 * order-pay-amount-smoke (cp406).
 *
 * Locks the money math that seeds the "Pay now" amount: order fiat minimum →
 * crypto units, across every price model + every "can't compute → null" path.
 * A wrong number here means a user could send the wrong amount, so this covers
 * fixed (exact), market/spread (signed, live-price), and all the null cases.
 *
 * Usage:
 *   cd apps/web && npx tsx --tsconfig ../../tsconfig.smoke.json scripts/order-pay-amount-smoke.ts
 */

import { computeOrderPayAmount } from '../src/lib/orders/payAmount.ts';
import { chatAssetFromTicker } from '../src/lib/assets/registry.ts';
import type { FxResponse } from '@morphit/indexer-client';

const FX: FxResponse = {
	base: 'USD',
	rates: { MXN: 17, EUR: 0.92, USD: 1 }, // units of fiat per 1 USD
	source: 'test',
	stale: false,
	updated_at: '2026-07-02T00:00:00Z',
	currency_count: 3
};

let failures = 0;
let count = 0;
function check(name: string, cond: boolean, detail = ''): void {
	count++;
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

// order() — minimal shape the helper reads.
function order(price_model: unknown, fiat_currency: string, amount_min: number | null) {
	return { price_model, fiat_currency, amount_min } as Parameters<typeof computeOrderPayAmount>[0];
}

// ── Fixed price (exact, no live data) ──
{
	// 500 MXN at 0.85 MXN/BLURT → 588.2352941 BLURT
	const r = computeOrderPayAmount(order({ kind: 'fixed', price: 0.85 }, 'MXN', 500), null, null);
	check('1 — fixed: 500 MXN / 0.85 ≈ 588.2353', r !== null && near(r.amount, 500 / 0.85), `got ${r?.amount}`);
	check('2 — fixed is NOT approximate', r?.approximate === false);
}
{
	// Fixed works with NO fx table + NO live price (deterministic).
	const r = computeOrderPayAmount(order({ kind: 'fixed', price: 50000 }, 'USD', 100), null, null);
	check('3 — fixed USD/BTC: 100 / 50000 = 0.002', r !== null && near(r.amount, 0.002));
}

// ── Market / spread (live price) ──
{
	// 500 MXN → 29.41176 USD; at $0.05/BLURT market → 588.2353 BLURT
	const r = computeOrderPayAmount(order({ kind: 'spread', percent: 0 }, 'MXN', 500), FX, 0.05);
	check('4 — market(0%): 500 MXN → USD / 0.05 ≈ 588.2353', r !== null && near(r.amount, 500 / 17 / 0.05), `got ${r?.amount}`);
	check('5 — market IS approximate', r?.approximate === true);
}
{
	// +5% → higher price → FEWER coins than market.
	const mkt = computeOrderPayAmount(order({ kind: 'spread', percent: 0 }, 'MXN', 500), FX, 0.05)!;
	const up = computeOrderPayAmount(order({ kind: 'spread', percent: 5 }, 'MXN', 500), FX, 0.05)!;
	check('6 — +5%: coins = market / 1.05', near(up.amount, 500 / 17 / (0.05 * 1.05)));
	check('7 — +5% yields FEWER coins than market', up.amount < mkt.amount);
}
{
	// -10% → lower price → MORE coins.
	const mkt = computeOrderPayAmount(order({ kind: 'spread', percent: 0 }, 'MXN', 500), FX, 0.05)!;
	const down = computeOrderPayAmount(order({ kind: 'spread', percent: -10 }, 'MXN', 500), FX, 0.05)!;
	check('8 — -10%: coins = market / 0.90', near(down.amount, 500 / 17 / (0.05 * 0.9)));
	check('9 — -10% yields MORE coins than market', down.amount > mkt.amount);
}

// ── Cannot compute → null (leave the field blank) ──
check('10 — custom price model → null', computeOrderPayAmount(order({ kind: 'custom' }, 'MXN', 500), FX, 0.05) === null);
check('11 — empty price model → null', computeOrderPayAmount(order({}, 'MXN', 500), FX, 0.05) === null);
check('12 — price_model null → null', computeOrderPayAmount(order(null, 'MXN', 500), FX, 0.05) === null);
check('13 — amount_min null → null', computeOrderPayAmount(order({ kind: 'fixed', price: 0.85 }, 'MXN', null), FX, 0.05) === null);
check('14 — amount_min 0 → null', computeOrderPayAmount(order({ kind: 'fixed', price: 0.85 }, 'MXN', 0), FX, 0.05) === null);
check('15 — amount_min negative → null', computeOrderPayAmount(order({ kind: 'fixed', price: 0.85 }, 'MXN', -5), FX, 0.05) === null);
check('16 — fixed price 0 → null', computeOrderPayAmount(order({ kind: 'fixed', price: 0 }, 'MXN', 500), FX, 0.05) === null);
check('17 — fixed price negative → null', computeOrderPayAmount(order({ kind: 'fixed', price: -1 }, 'MXN', 500), FX, 0.05) === null);
check('18 — market, FX table null → null (no fiat→USD)', computeOrderPayAmount(order({ kind: 'spread', percent: 0 }, 'MXN', 500), null, 0.05) === null);
check('19 — market, live price null → null', computeOrderPayAmount(order({ kind: 'spread', percent: 0 }, 'MXN', 500), FX, null) === null);
check('20 — market, live price 0 → null', computeOrderPayAmount(order({ kind: 'spread', percent: 0 }, 'MXN', 500), FX, 0) === null);
check('21 — market, unknown fiat (no rate) → null', computeOrderPayAmount(order({ kind: 'spread', percent: 0 }, 'XYZ', 500), FX, 0.05) === null);
// A USD market order needs no rate lookup beyond the identity — still needs a live price.
check('22 — market USD (rate=1): 100 USD / 0.05 = 2000', (() => {
	const r = computeOrderPayAmount(order({ kind: 'spread', percent: 0 }, 'USD', 100), FX, 0.05);
	return r !== null && near(r.amount, 2000);
})());

// ── Pay-now asset resolution (cp406 case-fold fix) ──
// OrderRecord.asset is UPPERCASE ('BLURT'); the chat modals need the lowercase
// ChatAssetTicker. Before the fix the compare failed and the modal fell back to
// the free 16-coin picker — the root cause of the "Pay now modal messed up".
check("23 — 'BLURT' (order case) → 'blurt'", chatAssetFromTicker('BLURT') === 'blurt');
check("24 — 'blurt' → 'blurt' (already lower)", chatAssetFromTicker('blurt') === 'blurt');
check("25 — 'BTC' → 'btc'", chatAssetFromTicker('BTC') === 'btc');
check("26 — 'XmR' (mixed) → 'xmr'", chatAssetFromTicker('XmR') === 'xmr');
check('27 — unknown ticker → null', chatAssetFromTicker('XYZ') === null);
check('28 — empty string → null', chatAssetFromTicker('') === null);

console.log(`\n${count} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('order-pay-amount-smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${count} order-pay-amount scenarios passed`);
