/**
 * postPrefill — read the one-shot /post prefill another page left in
 * sessionStorage (profile "Top up BLURT", the welcome CTA, "Re-list this
 * order").
 *
 * The writer (e.g. `buildRelistPrefill` in ./relist) and this reader are the
 * two halves of one hand-off; /post applies only what this returns. Kept pure
 * (no storage, no DOM) so the whole hand-off unit-tests end to end.
 *
 * Every field is checked: the slot is browser storage, so a tampered or
 * older-build value must never reach the form with the wrong type or out of
 * range. A field that fails its check is left out, and the form keeps what
 * it had for it.
 */
import { isAssetTicker, isGoodsAsset, type AssetTicker } from '@morphit/asset-registry';

import {
	isDaiNetwork,
	isUsdcNetwork,
	isUsdtNetwork,
	type DaiNetwork,
	type UsdcNetwork,
	type UsdtNetwork
} from '$lib/assets/networks';
import { sanitizeBarterTitle } from '$lib/orders/payload';
import { isOrderLang, type LocaleCode } from '$i18n/locales';

/** The fields /post takes from a prefill. Absent = leave that field alone. */
export interface PostPrefill {
	side?: 'buy' | 'sell';
	asset?: AssetTicker;
	usdtNetwork?: UsdtNetwork;
	usdcNetwork?: UsdcNetwork;
	daiNetwork?: DaiNetwork;
	amountMin?: string;
	amountMax?: string;
	topupUsdMin?: number;
	fiat?: string;
	priceModelKind?: 'spread' | 'fixed';
	spreadPercent?: string;
	fixedPrice?: string;
	paymentMethods?: string[];
	/** A barter listing's accepted cryptos — step 3's selection. */
	acceptedAssets?: AssetTicker[];
	region?: string;
	terms?: string;
	specificBarterTitle?: string;
	expiresDays?: number;
	/** The language the post is written in. */
	postLang?: LocaleCode;
}

/**
 * Parse the raw prefill string. Returns null when it is not a JSON object
 * (the caller drops the slot either way).
 */
export function parsePostPrefill(raw: string): PostPrefill | null {
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
	const p = v as Record<string, unknown>;
	const out: PostPrefill = {};

	if (p.side === 'buy' || p.side === 'sell') out.side = p.side;
	if (isAssetTicker(p.asset)) out.asset = p.asset;
	// The multi-network picker matching the asset. An unknown value is left
	// out, so the picker stays empty and the form makes the user pick rather
	// than post a stale network.
	const net = p.assetNetwork;
	if (out.asset === 'USDT' && isUsdtNetwork(net)) out.usdtNetwork = net;
	else if (out.asset === 'USDC' && isUsdcNetwork(net)) out.usdcNetwork = net;
	else if (out.asset === 'DAI' && isDaiNetwork(net)) out.daiNetwork = net;

	if (typeof p.amountMin === 'string') out.amountMin = p.amountMin;
	if (typeof p.amountMax === 'string') out.amountMax = p.amountMax;
	if (typeof p.topupUsdMin === 'number' && Number.isFinite(p.topupUsdMin)) {
		out.topupUsdMin = p.topupUsdMin;
	}
	if (typeof p.fiat === 'string') out.fiat = p.fiat;
	if (p.priceModelKind === 'spread' || p.priceModelKind === 'fixed') {
		out.priceModelKind = p.priceModelKind;
	}
	if (typeof p.spreadPercent === 'string') out.spreadPercent = p.spreadPercent;
	if (typeof p.fixedPrice === 'string') out.fixedPrice = p.fixedPrice;
	if (Array.isArray(p.paymentMethods)) {
		out.paymentMethods = p.paymentMethods.filter((m): m is string => typeof m === 'string');
	}
	if (Array.isArray(p.acceptedAssets)) {
		// Only cryptos a barter listing can accept (no goods), each once — the
		// same set step 3 offers.
		const seen = new Set<AssetTicker>();
		for (const t of p.acceptedAssets) if (isAssetTicker(t) && !isGoodsAsset(t)) seen.add(t);
		out.acceptedAssets = [...seen];
	}
	if (typeof p.region === 'string') out.region = p.region;
	if (typeof p.terms === 'string') out.terms = p.terms;
	if (typeof p.specificBarterTitle === 'string') {
		out.specificBarterTitle = sanitizeBarterTitle(p.specificBarterTitle);
	}
	if (typeof p.expiresDays === 'number' && Number.isFinite(p.expiresDays)) {
		// The schema-allowed range; the form validates on submit anyway.
		out.expiresDays = Math.max(1, Math.min(90, Math.floor(p.expiresDays)));
	}
	if (isOrderLang(p.postLang)) out.postLang = p.postLang;
	return out;
}
