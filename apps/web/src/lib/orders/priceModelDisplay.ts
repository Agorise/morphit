/**
 * Morphit — price-model display formatter.
 *
 * The on-chain `price_model` field is opaque to the indexer
 * (`Record<string, unknown>`).  By convention the UI uses two
 * known shapes:
 *   - { kind: 'spread', percent: number }  — "market ± N%"
 *   - { kind: 'fixed',  price:   number }  — flat price in fiat
 *
 * Any other shape (future-compat or older client we don't know
 * yet) falls through to a neutral "Custom price" label so the
 * orderbook stays readable without making up details we can't
 * verify.  Counterparties can still open the order detail page
 * to inspect the full record; this helper just owns the
 * one-line summary string for inline display.
 *
 * The function returns null when the price model is empty (i.e.,
 * the legacy "no price model specified" case from before the
 * post-form picker was added).  Callers display nothing in that
 * case rather than rendering a placeholder.
 *
 * Why a shared module: 5 sites previously each had their own
 * (or no) inline price-model rendering.  Centralizing here
 * keeps copy consistent and makes adding new kinds (e.g.,
 * `{kind:'tiered'}`) a one-place change.
 *
 * Pure module — no Svelte imports, no i18n side effects.  The
 * caller passes in the i18n `$_` function so this stays unit-
 * testable from tsx without spinning up the i18n runtime.
 */

import type { OrderRecord } from '@morphit/indexer-client';
import { isGoodsAsset } from '@morphit/asset-registry';

type Translator = (key: string, opts?: { values?: Record<string, unknown> }) => string;

/** Format `o.price_model` as a short human-readable label.
 *  Returns null when the price model is empty / not specified;
 *  callers should render nothing in that case. */
export function formatPriceModel(
	priceModel: unknown,
	t: Translator,
	fiatCurrency: string
): string | null {
	if (!priceModel || typeof priceModel !== 'object') return null;
	const pm = priceModel as Record<string, unknown>;

	// Empty object — pre-picker legacy orders.  Render nothing
	// rather than "Custom price" because the user genuinely
	// didn't specify anything.
	if (Object.keys(pm).length === 0) return null;

	if (pm.kind === 'spread' && typeof pm.percent === 'number') {
		// Spread of 0 means "market rate."  Render that special-
		// cased — "market +0%" reads weirdly to humans.
		if (pm.percent === 0) {
			return t('orderbook.price_model.spread_market');
		}
		// Show signed percent: +5%, -3%, etc.
		const sign = pm.percent > 0 ? '+' : '';
		return t('orderbook.price_model.spread_pct', {
			values: { sign, pct: formatPercent(pm.percent) }
		});
	}

	if (pm.kind === 'fixed' && typeof pm.price === 'number') {
		return t('orderbook.price_model.fixed', {
			values: {
				price: formatFixedPrice(pm.price),
				fiat: fiatCurrency
			}
		});
	}

	// Unknown shape — possibly a future kind we haven't taught
	// this formatter about, or possibly a hostile client posting
	// a malformed object.  Either way, "Custom price" is a safe
	// neutral label that doesn't lie about details we don't know.
	return t('orderbook.price_model.custom');
}

/** Convenience that takes an `OrderRecord` instead of a raw
 *  price_model — most call sites have the whole order in scope. */
export function formatOrderPriceModel(
	o: Pick<OrderRecord, 'price_model' | 'fiat_currency' | 'asset'>,
	t: Translator
): string | null {
	// cp425 — a BARTER (goods/services) order has no crypto-vs-fiat rate; it
	// ships an inert price_model that would otherwise render as "Market rate".
	// Suppress the price line entirely for goods — the card shows the value
	// range + accepted cryptos instead.
	if (isGoodsAsset(o.asset)) return null;
	return formatPriceModel(o.price_model, t, o.fiat_currency);
}

function formatPercent(pct: number): string {
	// Trim trailing zeroes for whole numbers; keep up to 2
	// decimals otherwise.
	if (Number.isInteger(pct)) return String(pct);
	return pct.toFixed(2).replace(/\.?0+$/, '');
}

function formatFixedPrice(price: number): string {
	// Two decimal places for sub-100 prices (USD-style); whole
	// numbers above that.  Keeps the orderbook line tidy without
	// printing $50,000.00 for a flat USD/BTC quote.
	if (price >= 100 && Number.isInteger(price)) return String(price);
	if (price >= 100) return price.toFixed(0);
	return price.toFixed(2).replace(/\.?0+$/, '');
}
