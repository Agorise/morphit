/**
 * relist — map an expired/cancelled OrderRecord back to a /post prefill.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Re-list" turns an order the user can no longer act on (expired, or one
 * they cancelled) into a fresh /post draft: everything pre-filled, the user
 * reviews + edits on /post, optionally promotes to Featured, and pays a fresh
 * listing fee. It is NOT an edit — it produces a brand-new order with a fresh
 * permlink and expiration; the old order stays as-is. No silent re-sign of an
 * old listing.
 *
 * This builder was extracted from /my/orders (cp438) so the order-detail page
 * (`[permlink]`) re-lists with byte-identical behaviour — the two must not
 * drift. It's pure (no navigation, no storage) so it unit-tests without a DOM;
 * callers do the `safeSession.set(RELIST_PREFILL_KEY, …)` + navigate to /post.
 */
import type { OrderRecord } from '@morphit/indexer-client';

/** sessionStorage key the /post page reads its prefill from (mirrors
 *  `/post`'s own `PREFILL_KEY` and MyBalanceCard's welcome-CTA writer). */
export const RELIST_PREFILL_KEY = 'morphit.post.prefill';

/** The /post prefill shape produced by a re-list. */
export interface RelistPrefill {
	side: OrderRecord['side'];
	asset: string;
	assetNetwork: string | null;
	fiat: string;
	amountMin: string;
	amountMax: string;
	priceModelKind: 'spread' | 'fixed';
	spreadPercent: string;
	fixedPrice: string;
	paymentMethods: string[];
	region: string;
	terms: string;
	expiresDays: number;
	reason: 'relist';
}

/**
 * Translate an OrderRecord into the /post prefill.
 *
 * Defensive about `price_model`: the on-chain field is opaque
 * (`Record<string, unknown>`) because the indexer doesn't validate it. We
 * pattern-match the two known shapes (`{kind:'spread',percent}` /
 * `{kind:'fixed',price}`) and fall back to `spread=0` on anything else so the
 * user can fix it manually rather than losing the draft.
 */
export function buildRelistPrefill(o: OrderRecord): RelistPrefill {
	let priceModelKind: 'spread' | 'fixed' = 'spread';
	let spreadPercent = '0';
	let fixedPrice = '';
	const pm = o.price_model;
	if (pm && typeof pm === 'object') {
		const obj = pm as Record<string, unknown>;
		if (obj.kind === 'spread' && typeof obj.percent === 'number') {
			priceModelKind = 'spread';
			spreadPercent = String(obj.percent);
		} else if (obj.kind === 'fixed' && typeof obj.price === 'number') {
			priceModelKind = 'fixed';
			fixedPrice = String(obj.price);
		}
	}

	return {
		side: o.side,
		asset: o.asset,
		// Carry forward a multi-network asset's asset_network so /post can
		// pre-hydrate its network picker (otherwise a USDT/USDC/DAI re-list
		// lands on /post with an empty picker).
		assetNetwork: o.asset_network ?? null,
		fiat: o.fiat_currency,
		amountMin: o.amount_min !== null ? String(o.amount_min) : '',
		amountMax: o.amount_max !== null ? String(o.amount_max) : '',
		priceModelKind,
		spreadPercent,
		fixedPrice,
		paymentMethods: [...o.payment_methods],
		region: o.location_region ?? '',
		terms: o.terms ?? '',
		// Default new expiry to 30 days — the OLD expiresDays already passed,
		// so make the user pick fresh rather than carrying a stale value.
		expiresDays: 30,
		reason: 'relist'
	};
}
