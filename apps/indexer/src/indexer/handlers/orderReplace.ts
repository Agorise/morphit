/**
 * Handler: morphit_order_replace_v1
 *
 * Same payload shape as morphit_order_v1. Replaces an existing
 * live order in place. Preserves created_at; bumps updated_at.
 *
 * Rejections:
 *   - target order doesn't exist → target_not_found
 *   - target status isn't 'live'  → target_not_live
 *   - payload invalid (any reason from the create validator) → same code
 *
 * Note on ownership: orders have PRIMARY KEY (account, permlink).
 * The handler only looks up (ctx.signer, permlink) — there's no way
 * to replace another account's order because the key space is
 * per-account.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { checkJsonbSize } from '$indexer/payloadSize';
import { validateOrderPermlink } from '$indexer/permlink';
import { ASSET_TICKERS_SET, type AssetTicker } from '@morphit/asset-registry';

const SIDES = new Set(['buy', 'sell']);

/** Sanity caps for chain-direct payloads.  Mirror of order.ts.
 *  See that file for full rationale. */
const MAX_AMOUNT = 1e12;
const MAX_EXPIRES_AT_DAYS = 365;

/** O3.4 — forbidden character class for user-text fields.
 *  Mirror of order.ts.  See that file for full rationale. */
const FORBIDDEN_TEXT_CHARS =
	/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumOrNull(v: unknown): v is number | null | undefined {
	return v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));
}

// Same validator as order.ts — duplicated deliberately because if
// the two op schemas ever diverge we want them to fail independently.
// Keeps this handler completely self-contained.
interface Validated {
	readonly permlink: string;
	readonly side: 'buy' | 'sell';
	readonly asset: AssetTicker;
	readonly fiat_currency: string;
	readonly amount_min: number | null;
	readonly amount_max: number | null;
	readonly price_model: Record<string, unknown>;
	/** Pre-serialized per Finding L; passed directly to
	 *  client.query() instead of re-stringifying. */
	readonly price_model_serialized: string;
	readonly location_region: string | null;
	readonly payment_methods: readonly string[];
	readonly terms: string | null;
	readonly expires_at: Date | null;
}

function validate(payload: unknown): Validated | { reason: string } {
	if (!isPlainObject(payload)) return { reason: 'payload_not_object' };

	const permlinkFail = validateOrderPermlink(payload.permlink);
	if (permlinkFail) return { reason: permlinkFail };
	const permlink = payload.permlink as string;

	const side = payload.side;
	if (typeof side !== 'string' || !SIDES.has(side)) return { reason: 'side_invalid' };

	const asset = payload.asset;
	if (typeof asset !== 'string' || !ASSET_TICKERS_SET.has(asset))
		return { reason: 'asset_invalid' };

	const fiat = payload.fiat_currency;
	if (typeof fiat !== 'string' || fiat.length < 1 || fiat.length > 8) {
		return { reason: 'fiat_currency_invalid' };
	}
	if (!/^[A-Z]+$/.test(fiat)) {
		return { reason: 'fiat_currency_invalid' };
	}

	if (!isFiniteNumOrNull(payload.amount_min)) return { reason: 'amount_min_invalid' };
	if (!isFiniteNumOrNull(payload.amount_max)) return { reason: 'amount_max_invalid' };
	const amount_min = (payload.amount_min as number | null | undefined) ?? null;
	const amount_max = (payload.amount_max as number | null | undefined) ?? null;
	if (amount_min !== null && amount_min < 0) return { reason: 'amount_min_negative' };
	if (amount_max !== null && amount_max < 0) return { reason: 'amount_max_negative' };
	// Sanity-cap.  Mirror of order.ts.
	if (amount_min !== null && amount_min > MAX_AMOUNT) {
		return { reason: 'amount_min_too_large' };
	}
	if (amount_max !== null && amount_max > MAX_AMOUNT) {
		return { reason: 'amount_max_too_large' };
	}
	if (amount_min !== null && amount_max !== null && amount_min > amount_max) {
		return { reason: 'amount_min_exceeds_max' };
	}

	// price_model — opaque object, size-bounded.  Same shape
	// validation as order.ts for known kinds; unknown kinds pass
	// through.  Defense-in-depth.
	if (!isPlainObject(payload.price_model)) return { reason: 'price_model_not_object' };
	const priceModelSize = checkJsonbSize(payload.price_model);
	if (!priceModelSize.ok) return { reason: 'price_model_too_large' };
	const priceModelObj = payload.price_model;
	if (priceModelObj.kind === 'spread') {
		if (typeof priceModelObj.percent !== 'number' || !Number.isFinite(priceModelObj.percent)) {
			return { reason: 'price_model_spread_percent_not_finite' };
		}
		if (priceModelObj.percent < -500 || priceModelObj.percent > 500) {
			return { reason: 'price_model_spread_percent_out_of_range' };
		}
	} else if (priceModelObj.kind === 'fixed') {
		if (typeof priceModelObj.price !== 'number' || !Number.isFinite(priceModelObj.price)) {
			return { reason: 'price_model_fixed_price_not_finite' };
		}
		if (priceModelObj.price <= 0) {
			return { reason: 'price_model_fixed_price_not_positive' };
		}
		if (priceModelObj.price > MAX_AMOUNT) {
			return { reason: 'price_model_fixed_price_too_large' };
		}
	}

	let location_region: string | null = null;
	if (payload.location_region !== undefined && payload.location_region !== null) {
		if (typeof payload.location_region !== 'string')
			return { reason: 'location_region_not_string' };
		// O3.4 — NFC + forbidden-char filter, mirror of order.ts.
		const normalized = payload.location_region.normalize('NFC');
		if (normalized.length > 128) return { reason: 'location_region_too_long' };
		if (FORBIDDEN_TEXT_CHARS.test(normalized)) {
			return { reason: 'location_region_forbidden_char' };
		}
		location_region = normalized;
	}

	const pm = payload.payment_methods;
	if (!Array.isArray(pm)) return { reason: 'payment_methods_not_array' };
	if (pm.length < 1 || pm.length > 12) return { reason: 'payment_methods_bad_count' };
	const normalizedPm: string[] = [];
	const seenPm = new Set<string>();
	for (const item of pm) {
		if (typeof item !== 'string' || item.length < 1 || item.length > 32) {
			return { reason: 'payment_method_item_invalid' };
		}
		// O3.4 — NFC + forbidden-char filter.
		const normItem = item.normalize('NFC');
		if (normItem.length > 32) {
			return { reason: 'payment_method_item_invalid' };
		}
		if (FORBIDDEN_TEXT_CHARS.test(normItem)) {
			return { reason: 'payment_method_item_forbidden_char' };
		}
		// Match order.ts: reject duplicate payment-method entries.
		if (seenPm.has(normItem)) {
			return { reason: 'payment_method_item_duplicate' };
		}
		seenPm.add(normItem);
		normalizedPm.push(normItem);
	}

	let terms: string | null = null;
	if (payload.terms !== undefined && payload.terms !== null) {
		if (typeof payload.terms !== 'string') return { reason: 'terms_not_string' };
		// O3.4 — NFC + forbidden-char filter.
		const normalized = payload.terms.normalize('NFC');
		if (normalized.length > 2048) return { reason: 'terms_too_long' };
		if (FORBIDDEN_TEXT_CHARS.test(normalized)) {
			return { reason: 'terms_forbidden_char' };
		}
		terms = normalized;
	}

	// expires_at — optional ISO-8601 timestamp.  Same strict shape
	// the create handler enforces (see handlers/order.ts comment);
	// keep the two paths in sync.
	const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
	let expires_at: Date | null = null;
	if (payload.expires_at !== undefined && payload.expires_at !== null) {
		if (typeof payload.expires_at !== 'string') return { reason: 'expires_at_not_string' };
		if (!ISO_8601_RE.test(payload.expires_at)) return { reason: 'expires_at_unparseable' };
		const d = new Date(payload.expires_at);
		if (Number.isNaN(d.getTime())) return { reason: 'expires_at_unparseable' };
		// Sanity-cap.  Mirror of order.ts.
		const maxFutureMs = MAX_EXPIRES_AT_DAYS * 86_400_000;
		if (d.getTime() - Date.now() > maxFutureMs) {
			return { reason: 'expires_at_too_far_future' };
		}
		expires_at = d;
	}

	return {
		permlink,
		side: side as 'buy' | 'sell',
		asset: asset as AssetTicker,
		fiat_currency: fiat,
		amount_min,
		amount_max,
		price_model: payload.price_model,
		price_model_serialized: priceModelSize.serialized,
		location_region,
		payment_methods: normalizedPm,
		terms,
		expires_at
	};
}

// Part 70 closure of REVISIT-LIST item: bumped from 3 minutes
// to 15 minutes per ADR-0001 (updated) / ADR-0009 (updated).
// Rationale: 3 min was so short Sally would lock herself out
// after stepping away from the keyboard for ~4 min — costing
// her another listing fee just to re-post a typo'd order.
// Trade-off: a bait-and-switch attacker who's actively
// watching incoming DMs has 5x the window for a manual race.
// Mitigations against that attack class: (a) the buyer's
// trade-side commitment requires a separate broadcast and
// the receiver-side chat client renders the order-version
// hash so a switched listing is visible at commitment, (b)
// every edit leaves a full on-chain audit trail (ADR-0001
// item 1), so a switch-after-DM is forensically detectable
// after the fact, (c) feedback-system reputational cost
// post-trade. The bait-and-switch threat was never fully
// blocked at any window size; 15 min is the right balance
// for the realistic-typo case without meaningfully changing
// the attacker's calculus.
const REPLACE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes per ADR-0001/0009

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	const v = validate(ctx.payload);
	if ('reason' in v) return { ok: false, reason: v.reason };

	// Look up the target first so we can distinguish the three
	// rejection reasons (not_found / not_live / window_expired)
	// before we touch anything.
	const probe = await client.query<{
		status: string;
		created_at: Date;
		side: string;
		asset: string;
		fiat_currency: string;
		fee_method: string;
	}>(
		`SELECT status, created_at, side, asset, fiat_currency, fee_method
		 FROM orders WHERE account = $1 AND permlink = $2`,
		[ctx.signer, v.permlink]
	);
	if (probe.rowCount === 0) {
		return { ok: false, reason: 'target_not_found' };
	}
	const target = probe.rows[0]!;
	if (target.status !== 'live') {
		return { ok: false, reason: 'target_not_live' };
	}

	// 15-minute replace-window enforcement per ADR-0001 §
	// "3 → 15 minute amendment" + ADR-0009 §3.  Use block time,
	// not wall-clock time, so the window is deterministic across
	// indexer replays.
	const age = ctx.blockTime.getTime() - target.created_at.getTime();
	if (age > REPLACE_WINDOW_MS) {
		return { ok: false, reason: 'replace_window_expired' };
	}

	// Substance fields (side, asset, fiat_currency) cannot change
	// in a replace.  The 15-minute window is for fixing details —
	// typos in terms, refining the price model, updating payment
	// methods — not for fundamentally changing what's being
	// traded.  A counterparty who clicked through on the original
	// listing should see substantively the same trade if they
	// arrive a few minutes later.
	//
	// This also closes a waiver-bypass attack: under
	// `fee_method='waived_first_buy'` the create handler requires
	// `side='buy'`, but if replace allowed flipping to 'sell' the
	// user could redeem the waiver as a free sell listing instead.
	if (v.side !== target.side) {
		return { ok: false, reason: 'replace_side_change_forbidden' };
	}
	if (v.asset !== target.asset) {
		return { ok: false, reason: 'replace_asset_change_forbidden' };
	}
	if (v.fiat_currency !== target.fiat_currency) {
		return { ok: false, reason: 'replace_fiat_change_forbidden' };
	}

	// B1 audit fix — waiver substance protection.
	// If the original order was created under fee_method='waived_first_buy',
	// the replace must not let the user dial back the substance that
	// earned the waiver.  The waiver floor (500 BLURT amount_min) is
	// only enforced at create-time in order.ts; without this check,
	// a user could create an order at amount_min=500 to claim the
	// waiver, then replace within the 15-minute window with
	// amount_min=1, leaving a tiny "waived first buy" order on the
	// orderbook that defeats the floor policy.
	//
	// side/asset/fiat are already locked above.  We only re-verify
	// the amount-floor here; the rest of the waiver shape (side='buy',
	// asset='BLURT') is implied by the substance-equals checks
	// because the original passed them at create-time.
	const WAIVER_MIN_BLURT = 500;
	if (target.fee_method === 'waived_first_buy') {
		if (v.amount_min === null || v.amount_min < WAIVER_MIN_BLURT) {
			return { ok: false, reason: 'replace_below_waiver_floor' };
		}
	}

	// Apply the update. Note we re-check status = 'live' in the
	// WHERE clause as belt-and-suspenders; the probe already
	// confirmed this, but the UPDATE running inside a savepoint
	// can't see anything the probe didn't.
	const replaceRes = await client.query(
		`UPDATE orders SET
			side = $3,
			asset = $4,
			fiat_currency = $5,
			amount_min = $6,
			amount_max = $7,
			price_model = $8::jsonb,
			location_region = $9,
			payment_methods = $10,
			terms = $11,
			updated_at = $12,
			expires_at = $13
		 WHERE account = $1 AND permlink = $2 AND status = 'live'`,
		[
			ctx.signer,
			v.permlink,
			v.side,
			v.asset,
			v.fiat_currency,
			v.amount_min,
			v.amount_max,
			v.price_model_serialized,
			v.location_region,
			v.payment_methods,
			v.terms,
			ctx.blockTime,
			v.expires_at
		]
	);

	// Only emit if the UPDATE actually changed a row.  In the
	// rare case the savepoint sees a different state than the
	// probe earlier in this handler (e.g., a concurrent
	// orderCancel landed in the same trx), the UPDATE returns
	// rowCount=0 and there's nothing for subscribers to learn
	// about.  (F-9 audit fix.)
	if ((replaceRes.rowCount ?? 0) > 0) {
		ctx.recordOrderbookChange(`${ctx.signer}/${v.permlink}`);
	}
	return { ok: true };
};

export default handle;
