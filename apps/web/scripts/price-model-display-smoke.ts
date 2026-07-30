/**
 * priceModelDisplay smoke.
 *
 * Validates the formatOrderPriceModel / formatPriceModel
 * helpers used by the orderbook + (Item 2 / Q10) post-form
 * input UI.  The on-chain price_model field is opaque to the
 * indexer, so any contract drift between what the post form
 * SUBMITS and what the orderbook DISPLAYS would cause every
 * order's price to render as "Custom price" (the safe
 * fallback) — a silent correctness regression.  This smoke
 * catches that.
 *
 * Coverage:
 *   - 'spread' / 0 (the post-form default) → "Market price"
 *   - 'spread' / +N (positive) → "Market +N%"
 *   - 'spread' / -N (negative) → "Market -N%"
 *   - 'spread' with non-integer percent → 2-decimal, trimmed
 *   - 'fixed' / N → "<price> <fiat> flat"
 *   - 'fixed' / large round number → no decimals
 *   - 'fixed' / sub-100 fractional → 2 decimals trimmed
 *   - empty {} (legacy pre-picker orders) → null
 *   - missing / null → null
 *   - unknown shape → "Custom price" (defensive fallback)
 *   - hostile shape (kind='spread' + missing percent) →
 *     "Custom price" (graceful)
 *
 * Usage:
 *   tsx apps/web/scripts/price-model-display-smoke.ts
 */

import { formatPriceModel, formatOrderPriceModel } from '../src/lib/orders/priceModelDisplay.ts';
import type { OrderRecord } from '@morphit/indexer-client';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.error(`  ✗ ${name}`);
		console.error(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function expect(actual: unknown, expected: unknown, label = ''): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label ? label + ': ' : ''}expected ${e}, got ${a}`);
	}
}

// Stub translator — returns the key + interpolated values so
// we can verify which i18n key the formatter chose.
function t(key: string, opts?: { values?: Record<string, unknown> }): string {
	if (!opts?.values) return key;
	const vals = Object.entries(opts.values)
		.map(([k, v]) => `${k}=${v}`)
		.join(',');
	return `${key}|${vals}`;
}

console.log('priceModelDisplay smoke:\n');

// ─── Spread variants ──────────────────────────────────────

scenario('spread/0 → market price label (no signed pct)', () => {
	const r = formatPriceModel({ kind: 'spread', percent: 0 }, t, 'USD');
	expect(r, 'orderbook.price_model.spread_market');
});

scenario('spread/+5 → "Market +5%"', () => {
	const r = formatPriceModel({ kind: 'spread', percent: 5 }, t, 'USD');
	expect(r, 'orderbook.price_model.spread_pct|sign=+,pct=5');
});

scenario('spread/-3 → "Market -3%" (sign empty, pct negative)', () => {
	const r = formatPriceModel({ kind: 'spread', percent: -3 }, t, 'USD');
	expect(r, 'orderbook.price_model.spread_pct|sign=,pct=-3');
});

scenario('spread/+2.5 → "Market +2.5%" (one decimal preserved)', () => {
	const r = formatPriceModel({ kind: 'spread', percent: 2.5 }, t, 'USD');
	expect(r, 'orderbook.price_model.spread_pct|sign=+,pct=2.5');
});

scenario('spread/+0.05 → trailing zeros trimmed', () => {
	const r = formatPriceModel({ kind: 'spread', percent: 0.05 }, t, 'USD');
	expect(r, 'orderbook.price_model.spread_pct|sign=+,pct=0.05');
});

// ─── Fixed-price variants ─────────────────────────────────

scenario('fixed/100000 → "100000 USD flat" (no decimals on round large)', () => {
	const r = formatPriceModel({ kind: 'fixed', price: 100000 }, t, 'USD');
	expect(r, 'orderbook.price_model.fixed|price=100000,fiat=USD');
});

scenario('fixed/99.99 → "99.99 EUR flat" (sub-100 keeps 2 decimals)', () => {
	const r = formatPriceModel({ kind: 'fixed', price: 99.99 }, t, 'EUR');
	expect(r, 'orderbook.price_model.fixed|price=99.99,fiat=EUR');
});

scenario('fixed/50 → "50 USD flat" (integer trimmed to whole)', () => {
	const r = formatPriceModel({ kind: 'fixed', price: 50 }, t, 'USD');
	expect(r, 'orderbook.price_model.fixed|price=50,fiat=USD');
});

scenario('fixed/0.5 → "0.5 USD flat" (small fractional preserved)', () => {
	const r = formatPriceModel({ kind: 'fixed', price: 0.5 }, t, 'USD');
	expect(r, 'orderbook.price_model.fixed|price=0.5,fiat=USD');
});

// ─── Empty / legacy ───────────────────────────────────────

scenario('empty object {} → null (pre-picker legacy order)', () => {
	const r = formatPriceModel({}, t, 'USD');
	expect(r, null);
});

scenario('null → null', () => {
	const r = formatPriceModel(null, t, 'USD');
	expect(r, null);
});

scenario('undefined → null', () => {
	const r = formatPriceModel(undefined, t, 'USD');
	expect(r, null);
});

// ─── Unknown / hostile shapes ─────────────────────────────

scenario('unknown kind → "Custom price" fallback', () => {
	const r = formatPriceModel({ kind: 'tiered', tiers: [] }, t, 'USD');
	expect(r, 'orderbook.price_model.custom');
});

scenario('spread missing percent → "Custom price" (defensive)', () => {
	const r = formatPriceModel({ kind: 'spread' }, t, 'USD');
	expect(r, 'orderbook.price_model.custom');
});

scenario('fixed missing price → "Custom price" (defensive)', () => {
	const r = formatPriceModel({ kind: 'fixed' }, t, 'USD');
	expect(r, 'orderbook.price_model.custom');
});

scenario('spread with non-numeric percent → "Custom price"', () => {
	const r = formatPriceModel({ kind: 'spread', percent: 'huge' }, t, 'USD');
	expect(r, 'orderbook.price_model.custom');
});

scenario('fixed with negative price → still rendered (caller validates)', () => {
	// formatFixedPrice doesn't guard, but the typeof-number check
	// passes and we'd get a negative.  Acceptable: orderbook will
	// show "-50 USD flat" which is at least visibly wrong rather
	// than silently presenting as market price.  Document the
	// behavior here.  The post-form's priceModelError validator
	// rejects this client-side; an indexer-side check could be
	// added if needed but is out of scope for the display helper.
	const r = formatPriceModel({ kind: 'fixed', price: -50 }, t, 'USD');
	expect(r, 'orderbook.price_model.fixed|price=-50,fiat=USD');
});

// ─── formatOrderPriceModel adapter ────────────────────────

scenario('formatOrderPriceModel routes through correctly', () => {
	// cp474 — `asset` is REQUIRED by the Pick<> this takes and was absent, so
	// `isGoodsAsset(o.asset)` read `undefined` in every scenario here.
	const order: Pick<OrderRecord, 'asset' | 'price_model' | 'fiat_currency'> = {
		asset: 'BTC',
		price_model: { kind: 'spread', percent: 0 },
		fiat_currency: 'EUR'
	};
	const r = formatOrderPriceModel(order, t);
	expect(r, 'orderbook.price_model.spread_market');
});

scenario('formatOrderPriceModel passes fiat through to fixed', () => {
	const order: Pick<OrderRecord, 'asset' | 'price_model' | 'fiat_currency'> = {
		asset: 'BTC',
		price_model: { kind: 'fixed', price: 100 },
		fiat_currency: 'JPY'
	};
	const r = formatOrderPriceModel(order, t);
	expect(r, 'orderbook.price_model.fixed|price=100,fiat=JPY');
});

// cp474 — suppressing the price line for BARTER (cp425) is the ONLY thing
// `formatOrderPriceModel` does that `formatPriceModel` doesn't, and it had no
// coverage: both scenarios above omitted `asset`, so `isGoodsAsset(undefined)`
// took the non-goods path every time. A goods order ships an inert price_model
// that would otherwise render as "Market rate" on the card.
scenario('formatOrderPriceModel suppresses the price line for BARTER (cp425)', () => {
	const order: Pick<OrderRecord, 'asset' | 'price_model' | 'fiat_currency'> = {
		asset: 'BARTER',
		price_model: { kind: 'spread', percent: 0 },
		fiat_currency: 'EUR'
	};
	const r = formatOrderPriceModel(order, t);
	if (r !== null) {
		throw new Error(`goods order must render no price line, got ${JSON.stringify(r)}`);
	}
});

// ─── Contract: post form ↔ display ─────────────────────────
// These mirror EXACTLY what the post form submits in
// apps/web/src/routes/post/+page.svelte:
//
//   spread → { kind: 'spread', percent: Number(spreadPercent) || 0 }
//   fixed  → { kind: 'fixed',  price:   Number(fixedPrice) }
//
// Drift between submission shape and display shape would
// silently route every order to "Custom price".  These
// contract-tests catch that.

scenario('CONTRACT: post-form spread/0 default → recognized', () => {
	// spreadPercent is '' or '0' → Number('') || 0 → 0
	const submitted = { kind: 'spread', percent: 0 };
	const r = formatPriceModel(submitted, t, 'USD');
	expect(r, 'orderbook.price_model.spread_market');
});

scenario('CONTRACT: post-form fixed/100000 → recognized', () => {
	// User typed 100000 in the fixed price input
	const submitted = { kind: 'fixed', price: 100000 };
	const r = formatPriceModel(submitted, t, 'USD');
	expect(r, 'orderbook.price_model.fixed|price=100000,fiat=USD');
});

console.log(
	`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} scenarios passed`
);
process.exit(failures === 0 ? 0 : 1);
