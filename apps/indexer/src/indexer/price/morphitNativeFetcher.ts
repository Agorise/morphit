/**
 * Morphit indexer — morphit_native price fetcher (cp127).
 *
 * Self-sovereign price derivation from on-platform trade data.  This
 * is the module that lets us reduce reliance on Coingecko
 * once Morphit has enough internal trading volume.
 *
 * Architectural overview
 * ──────────────────────
 * The fetcher implements a TIERED ANCHOR architecture that survives
 * every adversarial scenario in the cp127 design discussion:
 *
 *   Tier 1 — USD-fiat-direct anchor (PRIMARY, most resilient)
 *     Orders where the asset trades directly against denominationFiat
 *     (typically 'USD').  Payment method is irrelevant — bank transfer,
 *     cash in person, cash by mail, Venmo, etc.  The fiat side is
 *     stated explicitly by the trader.
 *     Survives: all stablecoin shutdowns, single-payment-method
 *     failures, brand-new-fiat replacement of USD (via the
 *     denominationFiat parameter).
 *
 *   Tier 2 — Stablecoin-anchored supplement
 *     Orders where the asset trades against a stablecoin via
 *     payment_methods.  Each stablecoin's contribution is gated by
 *     the cross-stablecoin depeg detector (only "pegged" or
 *     "unknown" stablecoins count).  Useful because stablecoin
 *     trading volume on P2P platforms is often higher than direct
 *     bank-transfer volume.
 *     Survives: 1-stablecoin shutdown (skip Tier 2 entirely; Tier 1
 *     covers).  0 stablecoins remaining (skip Tier 2; Tier 1
 *     covers).
 *
 *   Tier 3 — Hybrid combined pool
 *     When Tier 1 and Tier 2 each independently fail to meet
 *     thresholds, but their combined pool does.  Useful during
 *     bootstrap or post-shutdown degraded operation.
 *
 * Returns null if no tier qualifies; the composite source's fallback
 * chain takes over (next upstream → static floor).
 *
 * Black-hat defenses (per the cp127 conspiracy-theorist review)
 * ─────────────────────────────────────────────────────────────
 *   A. Per-trader contribution cap — each distinct account
 *      contributes its OWN MEDIAN price (not its sum of orders).
 *      Implements proportional 1/(N-1) cap implicitly via the
 *      per-trader median (one trader = one vote).
 *
 *   B. Long-term drift sanity check — handled by the drift monitor
 *      module, not here.  This fetcher publishes its raw derived
 *      value; smoothing + drift checks happen one layer up.
 *
 *   C. Cross-source disagreement detector — handled by the
 *      disagreement monitor, not here.  This fetcher publishes
 *      independently of what external sources say.
 *
 *   D. Order-age grace period — orders must exist for ≥10 minutes
 *      AND be status='live' AT QUERY TIME (the WHERE clause
 *      re-checks status, defeating post-and-cancel races).
 *
 *   E. Hardcoded outer envelope — applied here as null-return for
 *      values outside [PRICE_PLAUSIBLE_MIN, PRICE_PLAUSIBLE_MAX].
 *      Composite source has its own redundant check.
 *
 *   F. Cross-instance peer disagreement — DEFERRED to cp128.  Not
 *      part of this module.
 *
 *   G. Receipt — exposed via /v1/price/morphit-native/receipt;
 *      this module exposes the underlying data structure as part
 *      of its return type.
 *
 *   H. NOT-AN-ORACLE warning — added to the listing-fee payload
 *      surface, not here.
 *
 * Sybil floor
 * ───────────
 * Each contributing account must have ≥1 prior verified-fee-completed
 * order (the existing "is_new_trader" cold-start protection extended
 * to price derivation), AND must NOT appear in any of:
 *   - suspicious_reciprocity
 *   - related_accounts
 *   - one_way_pile_on attacking_reviewers
 *   - review_concentration reviewers
 *   - operator_blocks (accounts THIS operator has blocked — cp209;
 *     mirrors the orderbook's instance-local moderation so a
 *     manually-blocked seller can't influence this instance's price)
 *
 * The first four are the same cp123-cp125 reputation filter tables.
 * Reusing them ensures price manipulation requires the same level of
 * sophistication as reputation manipulation — a high bar by design.
 *
 * Price-model handling
 * ────────────────────
 * Only `kind: 'fixed'` orders count.  `kind: 'spread'` orders price
 * against an external market reference — including them would create
 * a circular dependency where we derive our own price from orders
 * that themselves depend on the price we haven't published yet.
 *
 * Performance
 * ───────────
 * Three SQL queries (one per tier).  Each query is bounded by the
 * 8-hour window + signal-table filters.  Cheap.  Called on the
 * standard 5-minute refresh cadence.
 */

import type { Database } from '$db/pool';
import { logger } from '$log';
import {
	detectStablecoinDepeg,
	type StablecoinDepegReport
} from '$indexer/price/stablecoinDepegDetector';

const log = logger('price/native');

/** Configurable thresholds (operator-tunable later if needed).
 *  Conservative defaults match the cp127 design discussion. */
export const NATIVE_WINDOW_HOURS = 8;
export const NATIVE_MIN_DISTINCT_TRADERS = 3;
export const NATIVE_MIN_STABLECOIN_COUNT_TIER2 = 2;
export const NATIVE_ORDER_AGE_GRACE_MINUTES = 10;

/** Hardcoded outer plausibility envelope.  Operator config can
 *  TIGHTEN these per-asset (e.g., for high-priced assets) but CANNOT
 *  widen them past these absolute bounds.  Defense E in the
 *  black-hat checklist: a captured operator can't set
 *  PRICE_PLAUSIBLE_MAX_USD=10000 to manipulate display.
 *
 *  Per-asset bounds will be supplied by the caller; these are the
 *  outer-bound floor/ceiling. */
export const HARDCODED_OUTER_MIN_USD = 0.00001; // 1 satoshi-equivalent floor
export const HARDCODED_OUTER_MAX_USD = 10_000_000; // BTC-sized ceiling

/** Result type returned to the price-source consumer.  When the
 *  derivation succeeded, `price` is set; otherwise everything except
 *  `tier_attempted` and `reason` is null.  This rich return is
 *  consumed by the price-receipt endpoint for forensic transparency. */
export interface NativeDerivationResult {
	readonly price: number | null;
	readonly tier_used: 'tier1_usd_direct' | 'tier2_stablecoin' | 'tier3_hybrid' | null;
	readonly tier_attempted: ReadonlyArray<{
		readonly name: 'tier1_usd_direct' | 'tier2_stablecoin' | 'tier3_hybrid';
		readonly qualifying_traders: number;
		readonly outcome: 'used' | 'insufficient_traders' | 'skipped';
		readonly reason?: string;
	}>;
	/** Distinct traders whose orders contributed to the final
	 *  median.  Provided for the receipt endpoint. */
	readonly contributing_traders: ReadonlyArray<string>;
	readonly depeg_report: StablecoinDepegReport;
	readonly window_hours: number;
	readonly as_of: string; // ISO-8601 timestamp
	/** Reason string when price is null. */
	readonly null_reason?: string;
}

export interface MorphitNativeFetcherConfig {
	readonly asset: string; // e.g., 'BLURT', 'BTC', 'XMR'
	readonly denominationFiat: string; // e.g., 'USD'
	readonly stablecoinKeys: ReadonlyArray<string>; // e.g., ['usdt', 'usdc', 'dai']
	readonly db: Database;
	/** This instance's OPERATOR account name (the `operator` column
	 *  in operator_blocks — keyed by `operatorAccountName`, NOT
	 *  `officialAccountName`; cp258 fixed this from the latter, which
	 *  silently made the exclusion inert whenever an operator set a
	 *  separate MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME).  Orders from
	 *  accounts this operator has blocked (state='blocked') are excluded
	 *  from every derivation tier AND from the depeg detector, mirroring
	 *  the orderbook's instance-local moderation (cp209).  Pass
	 *  `config.operatorAccountName`; '' makes the exclusion inert. */
	readonly operatorAccountName: string;
	/** Per-asset plausibility envelope.  Will be clamped to
	 *  HARDCODED_OUTER_MIN_USD..HARDCODED_OUTER_MAX_USD before use. */
	readonly minPlausibleUsd: number;
	readonly maxPlausibleUsd: number;
	/** Optional test-mode overrides. */
	readonly windowHours?: number;
	readonly minDistinctTraders?: number;
	readonly orderAgeGraceMinutes?: number;
}

/**
 * Build a fetcher function suitable for the composite source's
 * upstream chain.  The returned function:
 *
 *   - Never throws (catches errors internally, logs them, returns null)
 *   - Returns null when derivation can't run or no tier qualifies
 *   - Returns a positive number within the plausibility envelope on
 *     success
 *
 * The returned function performs ONE complete derivation per call.
 * Callers should cache appropriately — the composite source does
 * this via its background refresher.
 */
export function createMorphitNativeFetcher(
	config: MorphitNativeFetcherConfig
): () => Promise<number | null> {
	return async () => {
		try {
			const result = await deriveMorphitNativePrice(config);
			return result.price;
		} catch (err) {
			log.warn('native_fetcher_unexpected_error', {
				asset: config.asset,
				error: err instanceof Error ? err.message : String(err)
			});
			return null;
		}
	};
}

/**
 * Run a full derivation and return the rich result type.  Used by
 * the receipt endpoint (which needs the full structure) and by the
 * fetcher wrapper above (which only needs the price).
 *
 * Pure function — only reads from DB, never writes.  Safe to call
 * concurrently; expensive only relative to a cache lookup.
 */
export async function deriveMorphitNativePrice(
	config: MorphitNativeFetcherConfig
): Promise<NativeDerivationResult> {
	const windowHours = config.windowHours ?? NATIVE_WINDOW_HOURS;
	const minTraders = config.minDistinctTraders ?? NATIVE_MIN_DISTINCT_TRADERS;
	const graceMinutes = config.orderAgeGraceMinutes ?? NATIVE_ORDER_AGE_GRACE_MINUTES;
	const asOf = new Date().toISOString();

	// Clamp the per-asset envelope to the hardcoded outer bounds
	// before use.  Operator can tighten but cannot widen.
	const minPlausible = Math.max(config.minPlausibleUsd, HARDCODED_OUTER_MIN_USD);
	const maxPlausible = Math.min(config.maxPlausibleUsd, HARDCODED_OUTER_MAX_USD);

	if (minPlausible >= maxPlausible) {
		// Operator config is inconsistent (or attacker tried to wedge
		// the envelope to nothing).  Refuse to derive — fall back.
		log.warn('native_envelope_inconsistent', {
			asset: config.asset,
			min: minPlausible,
			max: maxPlausible
		});
		return nullResult(asOf, 'envelope_inconsistent', config);
	}

	// Run the depeg detector first.  Its result gates which
	// stablecoins are eligible for Tier 2.
	const depegReport = await detectStablecoinDepeg(config.db, {
		stablecoinKeys: config.stablecoinKeys,
		operatorAccountName: config.operatorAccountName,
		windowHours,
		orderAgeGraceMinutes: graceMinutes
	});

	const eligibleStablecoins = config.stablecoinKeys.filter((k) => {
		const status = depegReport.status[k.toLowerCase()];
		// Treat "unknown" as eligible (insufficient cross-ratio data
		// shouldn't kill Tier 2 entirely — we degrade to the standard
		// peg assumption for that coin).  Only "depegged" excludes.
		return status !== 'depegged';
	});

	const tierAttempts: Array<{
		name: 'tier1_usd_direct' | 'tier2_stablecoin' | 'tier3_hybrid';
		qualifying_traders: number;
		outcome: 'used' | 'insufficient_traders' | 'skipped';
		reason?: string;
	}> = [];

	// ─── Tier 1: USD-fiat-direct ───────────────────────────────────
	const tier1Orders = await queryTier1Orders(config, windowHours, graceMinutes);
	const tier1TraderMedians = computePerTraderMedians(tier1Orders);

	if (tier1TraderMedians.size >= minTraders) {
		const finalPrice = medianOfNumbers([...tier1TraderMedians.values()]);
		if (isWithinEnvelope(finalPrice, minPlausible, maxPlausible)) {
			tierAttempts.push({
				name: 'tier1_usd_direct',
				qualifying_traders: tier1TraderMedians.size,
				outcome: 'used'
			});
			return {
				price: finalPrice,
				tier_used: 'tier1_usd_direct',
				tier_attempted: tierAttempts,
				contributing_traders: [...tier1TraderMedians.keys()],
				depeg_report: depegReport,
				window_hours: windowHours,
				as_of: asOf
			};
		}
		tierAttempts.push({
			name: 'tier1_usd_direct',
			qualifying_traders: tier1TraderMedians.size,
			outcome: 'skipped',
			reason: 'price_outside_envelope'
		});
	} else {
		tierAttempts.push({
			name: 'tier1_usd_direct',
			qualifying_traders: tier1TraderMedians.size,
			outcome: 'insufficient_traders'
		});
	}

	// ─── Tier 2: Stablecoin-anchored ────────────────────────────────
	if (eligibleStablecoins.length < NATIVE_MIN_STABLECOIN_COUNT_TIER2) {
		tierAttempts.push({
			name: 'tier2_stablecoin',
			qualifying_traders: 0,
			outcome: 'skipped',
			reason: `only_${eligibleStablecoins.length}_eligible_stablecoins_min_${NATIVE_MIN_STABLECOIN_COUNT_TIER2}`
		});
	} else {
		const tier2Orders = await queryTier2Orders(
			config,
			eligibleStablecoins,
			windowHours,
			graceMinutes
		);
		const tier2TraderMedians = computePerTraderMedians(tier2Orders);
		// ── Black-hat defense (Tier 2): require orders across ≥2 of
		// the eligible stablecoins, not just ≥minTraders generally.
		// A whale dominating only the USDT pool can't single-handedly
		// move Tier 2 — they'd need cross-stablecoin presence. ──
		const distinctStablecoinsUsed = new Set(tier2Orders.map((o) => o.via_stablecoin));

		if (
			tier2TraderMedians.size >= minTraders &&
			distinctStablecoinsUsed.size >= NATIVE_MIN_STABLECOIN_COUNT_TIER2
		) {
			const finalPrice = medianOfNumbers([...tier2TraderMedians.values()]);
			if (isWithinEnvelope(finalPrice, minPlausible, maxPlausible)) {
				tierAttempts.push({
					name: 'tier2_stablecoin',
					qualifying_traders: tier2TraderMedians.size,
					outcome: 'used'
				});
				return {
					price: finalPrice,
					tier_used: 'tier2_stablecoin',
					tier_attempted: tierAttempts,
					contributing_traders: [...tier2TraderMedians.keys()],
					depeg_report: depegReport,
					window_hours: windowHours,
					as_of: asOf
				};
			}
			tierAttempts.push({
				name: 'tier2_stablecoin',
				qualifying_traders: tier2TraderMedians.size,
				outcome: 'skipped',
				reason: 'price_outside_envelope'
			});
		} else {
			tierAttempts.push({
				name: 'tier2_stablecoin',
				qualifying_traders: tier2TraderMedians.size,
				outcome: 'insufficient_traders',
				reason: `traders=${tier2TraderMedians.size}/${minTraders}, stablecoins=${distinctStablecoinsUsed.size}/${NATIVE_MIN_STABLECOIN_COUNT_TIER2}`
			});
		}
	}

	// ─── Tier 3: Hybrid combined pool ───────────────────────────────
	// Combine Tier 1 trader-medians with Tier 2 trader-medians
	// (depeg-filtered).  If a trader appears in BOTH tiers, take the
	// median of their combined contribution — one vote per trader.
	const combinedTraderMedians = new Map<string, number>();
	for (const [trader, price] of tier1TraderMedians) {
		combinedTraderMedians.set(trader, price);
	}
	if (eligibleStablecoins.length >= NATIVE_MIN_STABLECOIN_COUNT_TIER2) {
		const tier2OrdersForHybrid = await queryTier2Orders(
			config,
			eligibleStablecoins,
			windowHours,
			graceMinutes
		);
		const tier2TraderMediansForHybrid = computePerTraderMedians(tier2OrdersForHybrid);
		for (const [trader, price] of tier2TraderMediansForHybrid) {
			const existing = combinedTraderMedians.get(trader);
			if (existing === undefined) {
				combinedTraderMedians.set(trader, price);
			} else {
				// Trader present in both tiers; their final vote is the
				// median of both.  Since we have 2 values, median = mean.
				combinedTraderMedians.set(trader, (existing + price) / 2);
			}
		}
	}

	if (combinedTraderMedians.size >= minTraders) {
		const finalPrice = medianOfNumbers([...combinedTraderMedians.values()]);
		if (isWithinEnvelope(finalPrice, minPlausible, maxPlausible)) {
			tierAttempts.push({
				name: 'tier3_hybrid',
				qualifying_traders: combinedTraderMedians.size,
				outcome: 'used'
			});
			return {
				price: finalPrice,
				tier_used: 'tier3_hybrid',
				tier_attempted: tierAttempts,
				contributing_traders: [...combinedTraderMedians.keys()],
				depeg_report: depegReport,
				window_hours: windowHours,
				as_of: asOf
			};
		}
		tierAttempts.push({
			name: 'tier3_hybrid',
			qualifying_traders: combinedTraderMedians.size,
			outcome: 'skipped',
			reason: 'price_outside_envelope'
		});
	} else {
		tierAttempts.push({
			name: 'tier3_hybrid',
			qualifying_traders: combinedTraderMedians.size,
			outcome: 'insufficient_traders'
		});
	}

	// No tier qualified.  Caller falls through to the next composite
	// upstream (Coingecko) → static floor.
	return {
		price: null,
		tier_used: null,
		tier_attempted: tierAttempts,
		contributing_traders: [],
		depeg_report: depegReport,
		window_hours: windowHours,
		as_of: asOf,
		null_reason: 'no_tier_qualified'
	};
}

// ─── SQL query helpers ──────────────────────────────────────────────

interface RawOrderRow {
	readonly account: string;
	readonly implied_price_in_denomination: number;
	readonly via_stablecoin?: string; // Tier 2 only
	readonly source_permlink: string;
}

/**
 * Tier 1 query: orders where asset trades DIRECTLY against
 * denominationFiat (e.g., asset='BLURT', fiat_currency='USD').
 * Payment method irrelevant — could be bank transfer, cash, etc.
 *
 * The implied price IS the fiat price stated in the order, in the
 * denominationFiat units per 1 unit of asset.  For
 * (asset='BLURT', fiat='USD', price=0.0023), 1 BLURT = $0.0023.
 *
 * All black-hat defenses are baked into the WHERE clause:
 *   - status='live' AT QUERY TIME (defense against post-and-cancel)
 *   - fee_status in verified set (real economic skin)
 *   - kind='fixed' (no circular dependency on external pricing)
 *   - created_at within window AND past grace period (defeats race)
 *   - account has prior verified trade (Sybil cold-start floor)
 *   - account not in any signal table (cp123-cp125 reputation filter)
 */
async function queryTier1Orders(
	config: MorphitNativeFetcherConfig,
	windowHours: number,
	graceMinutes: number
): Promise<RawOrderRow[]> {
	const result = await config.db.query<{
		account: string;
		price_str: string;
		permlink: string;
	}>(
		`SELECT o.account,
		        (o.price_model->>'price')::numeric::text AS price_str,
		        o.permlink
		   FROM orders o
		  WHERE o.status = 'live'
		    AND o.fee_status IN ('verified', 'verified_by_attestation')
		    AND o.asset = $1
		    AND o.fiat_currency = $2
		    AND o.price_model->>'kind' = 'fixed'
		    AND (o.price_model->>'price')::numeric > 0
		    AND o.created_at <= NOW() - INTERVAL '${graceMinutes} minutes'
		    AND o.created_at >= NOW() - INTERVAL '${windowHours} hours'
		    AND EXISTS (
		        SELECT 1 FROM orders prev
		         WHERE prev.account = o.account
		           AND prev.fee_status IN ('verified', 'verified_by_attestation')
		           AND prev.created_at < o.created_at
		    )
		    AND NOT EXISTS (
		        SELECT 1 FROM suspicious_reciprocity sr
		         WHERE sr.account_a = o.account OR sr.account_b = o.account
		    )
		    AND NOT EXISTS (
		        SELECT 1 FROM related_accounts ra
		         WHERE ra.account_a = o.account OR ra.account_b = o.account
		    )
		    AND NOT EXISTS (
		        SELECT 1 FROM one_way_pile_on owpo,
		                     jsonb_array_elements(owpo.attacking_reviewers) attacker
		         WHERE attacker->>'reviewer' = o.account
		    )
		    AND NOT EXISTS (
		        SELECT 1 FROM review_concentration rc
		         WHERE rc.reviewer = o.account
		    )
		    -- cp209 — instance-local moderation: exclude orders from
		    -- accounts THIS operator has blocked (operator_blocks,
		    -- state='blocked'), so a manually-blocked seller can't
		    -- move this instance's derived native price.  Inert when
		    -- $3 is '' (no operator matches '').
		    AND NOT EXISTS (
		        SELECT 1 FROM operator_blocks ob
		         WHERE ob.operator = $3
		           AND ob.blocked = o.account
		           AND ob.state = 'blocked'
		    )`,
		[config.asset.toUpperCase(), config.denominationFiat.toUpperCase(), config.operatorAccountName]
	);

	const rows: RawOrderRow[] = [];
	for (const r of result.rows) {
		const p = parseFloat(r.price_str);
		if (Number.isFinite(p) && p > 0) {
			rows.push({
				account: r.account,
				implied_price_in_denomination: p,
				source_permlink: r.permlink
			});
		}
	}
	return rows;
}

/**
 * Tier 2 query: orders where asset trades against ANY stablecoin via
 * payment_methods.  Each order contributes a stablecoin-denominated
 * price; we treat each eligible stablecoin as ≈$1 (Tier 2's peg
 * assumption, guarded by the cross-stablecoin depeg detector).
 *
 * Note on direction:
 *   - asset='BLURT', payment_method='pay_usdt' means "seller wants
 *     USDT in exchange for BLURT".  The price field of a 'fixed'
 *     price_model is USDT-per-BLURT (or fiat_currency-per-BLURT if
 *     fiat_currency is something other than USD).  We treat that
 *     numeric price as the implied USD price under the peg assumption.
 *
 * The black-hat resistance is the same set of WHERE-clause guards
 * as Tier 1.
 */
async function queryTier2Orders(
	config: MorphitNativeFetcherConfig,
	eligibleStablecoins: ReadonlyArray<string>,
	windowHours: number,
	graceMinutes: number
): Promise<Array<RawOrderRow & { via_stablecoin: string }>> {
	if (eligibleStablecoins.length === 0) return [];

	const payKeys = eligibleStablecoins.map((s) => `pay_${s.toLowerCase()}`);

	const result = await config.db.query<{
		account: string;
		price_str: string;
		permlink: string;
		payment_methods: string[];
	}>(
		`SELECT o.account,
		        (o.price_model->>'price')::numeric::text AS price_str,
		        o.permlink,
		        o.payment_methods
		   FROM orders o
		  WHERE o.status = 'live'
		    AND o.fee_status IN ('verified', 'verified_by_attestation')
		    AND o.asset = $1
		    AND o.price_model->>'kind' = 'fixed'
		    AND (o.price_model->>'price')::numeric > 0
		    AND o.payment_methods && $2::text[]
		    AND o.created_at <= NOW() - INTERVAL '${graceMinutes} minutes'
		    AND o.created_at >= NOW() - INTERVAL '${windowHours} hours'
		    AND EXISTS (
		        SELECT 1 FROM orders prev
		         WHERE prev.account = o.account
		           AND prev.fee_status IN ('verified', 'verified_by_attestation')
		           AND prev.created_at < o.created_at
		    )
		    AND NOT EXISTS (
		        SELECT 1 FROM suspicious_reciprocity sr
		         WHERE sr.account_a = o.account OR sr.account_b = o.account
		    )
		    AND NOT EXISTS (
		        SELECT 1 FROM related_accounts ra
		         WHERE ra.account_a = o.account OR ra.account_b = o.account
		    )
		    AND NOT EXISTS (
		        SELECT 1 FROM one_way_pile_on owpo,
		                     jsonb_array_elements(owpo.attacking_reviewers) attacker
		         WHERE attacker->>'reviewer' = o.account
		    )
		    AND NOT EXISTS (
		        SELECT 1 FROM review_concentration rc
		         WHERE rc.reviewer = o.account
		    )
		    -- cp209 — instance-local moderation: exclude orders from
		    -- accounts THIS operator has blocked (operator_blocks,
		    -- state='blocked').  Inert when $3 is '' (no operator
		    -- matches '').
		    AND NOT EXISTS (
		        SELECT 1 FROM operator_blocks ob
		         WHERE ob.operator = $3
		           AND ob.blocked = o.account
		           AND ob.state = 'blocked'
		    )`,
		[config.asset.toUpperCase(), payKeys, config.operatorAccountName]
	);

	const rows: Array<RawOrderRow & { via_stablecoin: string }> = [];
	for (const r of result.rows) {
		const p = parseFloat(r.price_str);
		if (!Number.isFinite(p) || p <= 0) continue;
		// Pick the FIRST eligible stablecoin from the order's payment
		// methods.  An order may accept multiple stablecoins; we
		// attribute it to one for the via-stablecoin tally.  Defense
		// against double-counting: each order contributes ONCE, not
		// once per accepted stablecoin.
		const stablecoin = eligibleStablecoins.find((sc) =>
			r.payment_methods.includes(`pay_${sc.toLowerCase()}`)
		);
		if (!stablecoin) continue; // shouldn't happen given the WHERE
		rows.push({
			account: r.account,
			implied_price_in_denomination: p,
			via_stablecoin: stablecoin.toLowerCase(),
			source_permlink: r.permlink
		});
	}
	return rows;
}

// ─── Pure helpers ───────────────────────────────────────────────────

/**
 * Compute per-trader median.  Each distinct account → one median
 * price.  Implements the per-trader contribution cap (defense A):
 * no account can contribute more than one vote regardless of how
 * many orders they posted.
 */
function computePerTraderMedians(rows: ReadonlyArray<RawOrderRow>): Map<string, number> {
	const byTrader = new Map<string, number[]>();
	for (const r of rows) {
		const list = byTrader.get(r.account) ?? [];
		list.push(r.implied_price_in_denomination);
		byTrader.set(r.account, list);
	}
	const out = new Map<string, number>();
	for (const [trader, prices] of byTrader) {
		out.set(trader, medianOfNumbers(prices));
	}
	return out;
}

/** Plain numeric median.  Assumes non-empty input; caller checks. */
function medianOfNumbers(nums: ReadonlyArray<number>): number {
	if (nums.length === 0) {
		throw new Error('medianOfNumbers called with empty array');
	}
	const sorted = [...nums].sort((a, b) => a - b);
	const mid = sorted.length / 2;
	return sorted.length % 2 === 1
		? sorted[Math.floor(mid)]!
		: (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function isWithinEnvelope(price: number, min: number, max: number): boolean {
	return Number.isFinite(price) && price >= min && price <= max;
}

function nullResult(
	asOf: string,
	reason: string,
	config: MorphitNativeFetcherConfig
): NativeDerivationResult {
	return {
		price: null,
		tier_used: null,
		tier_attempted: [],
		contributing_traders: [],
		depeg_report: {
			status: {},
			usable_pair_count: 0,
			pair_details: [],
			window_hours: config.windowHours ?? NATIVE_WINDOW_HOURS,
			threshold: 0
		},
		window_hours: config.windowHours ?? NATIVE_WINDOW_HOURS,
		as_of: asOf,
		null_reason: reason
	};
}
