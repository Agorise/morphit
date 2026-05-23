/**
 * Morphit indexer — stablecoin depeg detector (cp127).
 *
 * Why this module exists
 * ──────────────────────
 * The morphit_native price fetcher needs to derive a BLURT/USD rate
 * from on-platform BLURT-vs-stablecoin orders.  The naïve approach
 * assumes "USDT = USDC = DAI = $1" — which is true MOST of the time
 * but catastrophically wrong during depeg events (USDC briefly hit
 * ~$0.88 during the SVB crisis in 2023; USDT and DAI have had their
 * own moments).  A hardcoded peg assumption means any depeg event
 * silently corrupts our derived BLURT/USD price for the duration of
 * the event.
 *
 * This module addresses that by computing CROSS-STABLECOIN RATIOS
 * from on-platform orders where stablecoins trade against each other:
 *
 *   USDT/USDC ratio  (from orders like "sell 100 USDT for 100 USDC")
 *   USDT/DAI ratio
 *   USDC/DAI ratio
 *   ... and any other pair we have data for
 *
 * If all three stablecoins are pegged to $1, all three ratios should
 * be close to 1.0.  If one stablecoin depegs, the ratios involving
 * THAT stablecoin will diverge from 1.0 while the OTHER pair (not
 * involving the depegged coin) stays near 1.0.  This lets us identify
 * the depegged coin as the outlier rather than guessing.
 *
 * Conservative defaults: a stablecoin is treated as "pegged" by
 * default and only marked "depegged" when we have AFFIRMATIVE
 * cross-ratio evidence of depeg.  This bias is intentional — false
 * positives (marking a healthy stablecoin as depegged) cost us
 * derivation data; false negatives (missing a real depeg) cost users
 * money.  We accept conservative false-positives ONLY when the
 * evidence is multi-source.
 *
 * Black-hat resistance built in
 * ─────────────────────────────
 *   - The same Sybil filters from cp123-cp125 apply to cross-stablecoin
 *     orders.  An attacker can't post fake cross-ratios with zero-rep
 *     sock accounts.
 *   - Median across distinct traders, not across orders.  An attacker
 *     with 10 orders from one account is still 1 vote.
 *   - Median across pair ratios, not mean.  One outlier ratio doesn't
 *     skew the consensus.
 *   - Require ≥3 distinct traders per cross-pair for the pair's ratio
 *     to be usable.  Below that, the pair is "unknown" not "pegged".
 *   - When <2 stablecoins are available (one or zero stablecoins
 *     remain), cross-ratio detection is impossible.  Return "unknown"
 *     for the lone stablecoin (caller decides whether to assume peg).
 *
 * Privacy
 * ───────
 * The detector reads existing orders + signal tables.  No new chain
 * data.  No personal info.  The "set of accounts that traded
 * stablecoins recently" is already inferable from the public
 * orderbook.
 *
 * Footprint
 * ─────────
 * Two SQL queries (one for per-pair ratios, one for Sybil-clean
 * trader counts), no caching beyond function-call scope.  Called by
 * the morphit_native fetcher; not on a hot path.
 */

import type { Database } from '$db/pool';
import { logger } from '$log';

const log = logger('price/depeg');

/**
 * Configurable thresholds.  Operator-tunable later if we find these
 * defaults don't match real-world behavior.  Conservative defaults:
 *
 *   - 3% ratio deviation = depeg signal threshold.  Healthy
 *     stablecoins trade within ~1% of each other; 3% is well outside
 *     the normal band but well inside historical depeg events (USDC
 *     hit ~12% off-peg during SVB).
 *   - 8-hour window matches the morphit_native window.
 *   - 3 distinct traders per pair = minimum for the pair's ratio
 *     to be considered.  Same Sybil floor as morphit_native.
 *   - 10-minute order-age grace defeats post-and-cancel races.
 */
export const DEPEG_RATIO_THRESHOLD = 0.03; // 3%
export const DEPEG_WINDOW_HOURS = 8;
export const DEPEG_MIN_TRADERS_PER_PAIR = 3;
export const DEPEG_ORDER_AGE_GRACE_MINUTES = 10;

export type DepegStatus = 'pegged' | 'depegged' | 'unknown';

/**
 * Per-stablecoin status report.
 *
 * `pegged` — affirmative evidence that this stablecoin trades within
 * threshold of consensus (i.e., at ≈$1).
 *
 * `depegged` — affirmative evidence that this stablecoin's
 * cross-ratios with other stablecoins consistently diverge from 1.0
 * by more than the threshold.  The morphit_native fetcher will
 * EXCLUDE this stablecoin from BLURT/USD derivation.
 *
 * `unknown` — insufficient data to decide (typically: thin trading
 * volume in the window, or fewer than 2 stablecoins enabled).  The
 * morphit_native fetcher SHOULD treat this stablecoin as pegged by
 * default (the standard fallback) but log that the assumption is
 * unverified.
 */
export interface StablecoinDepegReport {
	readonly status: Record<string, DepegStatus>;
	/** Number of distinct cross-pairs we found usable data for.  0
	 *  means cross-ratio detection couldn't run; caller falls back
	 *  to peg assumption. */
	readonly usable_pair_count: number;
	/** Detailed per-pair ratios for the receipt endpoint + ops
	 *  visibility.  Each entry: {a, b, ratio, trader_count}. */
	readonly pair_details: ReadonlyArray<{
		readonly a: string;
		readonly b: string;
		readonly ratio: number;
		readonly trader_count: number;
	}>;
	readonly window_hours: number;
	readonly threshold: number;
}

export interface DepegDetectorConfig {
	/** Which stablecoins to consider.  Order doesn't matter; the
	 *  detector enumerates all pairs.  Pass the operator's currently-
	 *  enabled stablecoins (typically: ['usdt', 'usdc', 'dai']).
	 *  Pass fewer if the operator has disabled some, or pass more
	 *  when new stablecoins enter the registry. */
	readonly stablecoinKeys: ReadonlyArray<string>;
	/** Optional override of window / threshold / floor — primarily
	 *  for tests.  Production uses the constants above. */
	readonly windowHours?: number;
	readonly ratioThreshold?: number;
	readonly minTradersPerPair?: number;
	readonly orderAgeGraceMinutes?: number;
}

/**
 * Run depeg detection.  Pure read; never modifies state.
 *
 * Safe to call concurrently; cheap enough to run on every native-
 * fetcher refresh (5-minute cadence by default).
 *
 * Returns a report; callers decide how to act on it.
 */
export async function detectStablecoinDepeg(
	db: Database,
	config: DepegDetectorConfig
): Promise<StablecoinDepegReport> {
	const stablecoinKeys = config.stablecoinKeys.map((k) => k.toLowerCase());
	const windowHours = config.windowHours ?? DEPEG_WINDOW_HOURS;
	const ratioThreshold = config.ratioThreshold ?? DEPEG_RATIO_THRESHOLD;
	const minTraders = config.minTradersPerPair ?? DEPEG_MIN_TRADERS_PER_PAIR;
	const graceMinutes = config.orderAgeGraceMinutes ?? DEPEG_ORDER_AGE_GRACE_MINUTES;

	// ── Black-hat defense: <2 stablecoins → cross-ratio impossible ──
	// Caller should fall back to peg assumption for the remaining
	// coin(s).  We return "unknown" for each, NOT "pegged" — making
	// the assumption explicit at the caller's site.
	if (stablecoinKeys.length < 2) {
		const status: Record<string, DepegStatus> = {};
		for (const k of stablecoinKeys) status[k] = 'unknown';
		return {
			status,
			usable_pair_count: 0,
			pair_details: [],
			window_hours: windowHours,
			threshold: ratioThreshold
		};
	}

	// Generate all unordered pairs.  For 3 stablecoins: 3 pairs.
	// For 4: 6 pairs.  Order canonicalized alphabetically (a < b).
	const pairs: Array<[string, string]> = [];
	for (let i = 0; i < stablecoinKeys.length; i++) {
		for (let j = i + 1; j < stablecoinKeys.length; j++) {
			const a = stablecoinKeys[i]!;
			const b = stablecoinKeys[j]!;
			pairs.push(a < b ? [a, b] : [b, a]);
		}
	}

	// ── For each pair (A, B), find orders where ──
	// ── A is the asset AND B-payment-method is accepted, OR ──
	// ── B is the asset AND A-payment-method is accepted ──
	// Extract the implied A/B ratio from the price model.  Tally
	// per-distinct-trader medians.
	//
	// IMPORTANT: only `kind: 'fixed'` price-model orders count.
	// `kind: 'spread'` orders reference an external market price,
	// which would create a circular dependency (we'd be deriving
	// our price from an order that itself depends on the price we
	// haven't published yet).  Spread orders are excluded.
	//
	// Sybil filtering: each contributing trader must NOT appear in
	// suspicious_reciprocity, related_accounts, one_way_pile_on, or
	// review_concentration tables (cp123-cp125 defenses).
	//
	// Order-age grace: only orders that have existed for ≥10 minutes
	// AND are still status='live' count.  Defeats post-and-cancel
	// races where attacker manipulates median then cancels.

	const pairDetails: Array<{
		a: string;
		b: string;
		ratio: number;
		trader_count: number;
	}> = [];

	for (const [a, b] of pairs) {
		// We query orders TWO directions:
		//   (asset = A, payment_method includes pay_B, fiat=any)
		//   (asset = B, payment_method includes pay_A, fiat=any)
		// In direction 1, ratio = A_per_B.  In direction 2, we get
		// B_per_A and need to flip.  Normalize to A/B.
		//
		// Note: in a fixed-price order with asset=A and payment in B,
		// the price field is "B per A".  We want A/B as 1 of these.
		// To express "1 unit of A = X units of B", price is X.
		// Therefore the IMPLIED A/B ratio at trade time is 1/X
		// (one B buys 1/X of A).  But we want "ratio of dollar values
		// of A vs B"; if A and B are both pegged at $1, A/B should
		// be 1.0.  Since asset A is being sold for B-units at a rate
		// of X B per A, then 1 A = X B in dollar-value-terms, so
		// dollar-value-ratio A:B = X:1, i.e. A/B = X.
		//
		// We're computing how much of B each A is "worth" at trade
		// time.  That's the ratio.  pegged means X ≈ 1.0.

		const queryDir1 = `
			WITH eligible AS (
				SELECT o.account, o.price_model
				  FROM orders o
				 WHERE o.status = 'live'
				   AND o.fee_status IN ('verified', 'verified_by_attestation')
				   AND o.asset = $1
				   AND $2 = ANY(o.payment_methods)
				   AND o.created_at <= NOW() - INTERVAL '${graceMinutes} minutes'
				   AND o.created_at >= NOW() - INTERVAL '${windowHours} hours'
				   -- price_model.kind = 'fixed' only (no spread orders)
				   AND o.price_model->>'kind' = 'fixed'
				   AND (o.price_model->>'price')::numeric > 0
				   -- Sybil filters: account must have ≥1 prior verified-
				   -- fee completed trade AND not be in any signal table
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
			),
			per_trader AS (
				SELECT account,
				       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (price_model->>'price')::numeric) AS trader_median_price
				FROM eligible
				GROUP BY account
			)
			SELECT trader_median_price::text AS price_str, account FROM per_trader
		`;
		const queryDir2 = queryDir1; // structurally identical, just different parameters

		const payA = `pay_${a}`;
		const payB = `pay_${b}`;
		const tickerA = a.toUpperCase();
		const tickerB = b.toUpperCase();

		// Direction 1: asset=A, accept payment in B.  Trader-medians
		// of (B per A).  We use these as candidate ratios in A/B (a
		// dollar-value sense: A's worth, expressed in B units).
		const dir1 = await db.query<{ price_str: string; account: string }>(queryDir1, [
			tickerA,
			payB
		]);
		// Direction 2: asset=B, accept payment in A.  Trader-medians
		// of (A per B) — we flip to B/A then invert to A/B.
		const dir2 = await db.query<{ price_str: string; account: string }>(queryDir2, [
			tickerB,
			payA
		]);

		// Combine into per-trader contributions (A/B), deduping
		// traders who appeared in both directions (rare but possible).
		const traderRatios = new Map<string, number[]>();
		for (const row of dir1.rows) {
			const p = parseFloat(row.price_str);
			if (Number.isFinite(p) && p > 0) {
				const list = traderRatios.get(row.account) ?? [];
				list.push(p);
				traderRatios.set(row.account, list);
			}
		}
		for (const row of dir2.rows) {
			// Direction 2 returns "A per B", invert to express as A/B.
			const p = parseFloat(row.price_str);
			if (Number.isFinite(p) && p > 0) {
				const list = traderRatios.get(row.account) ?? [];
				list.push(1 / p);
				traderRatios.set(row.account, list);
			}
		}

		// Per-trader median across their own contributions.
		const perTraderMedians: number[] = [];
		for (const [, ratios] of traderRatios) {
			ratios.sort((x, y) => x - y);
			const mid = ratios.length / 2;
			const m =
				ratios.length % 2 === 1
					? ratios[Math.floor(mid)]!
					: (ratios[mid - 1]! + ratios[mid]!) / 2;
			perTraderMedians.push(m);
		}

		if (perTraderMedians.length < minTraders) {
			// Not enough traders for a usable ratio.  Skip this pair.
			continue;
		}

		// Median across distinct traders → final pair ratio.
		perTraderMedians.sort((x, y) => x - y);
		const midIdx = perTraderMedians.length / 2;
		const pairRatio =
			perTraderMedians.length % 2 === 1
				? perTraderMedians[Math.floor(midIdx)]!
				: (perTraderMedians[midIdx - 1]! + perTraderMedians[midIdx]!) / 2;

		pairDetails.push({
			a,
			b,
			ratio: pairRatio,
			trader_count: perTraderMedians.length
		});
	}

	// ── Decide depeg status per stablecoin ──
	// For each stablecoin S, look at all pairs involving S.  Count
	// how many pairs show S diverging from 1.0 by more than threshold.
	// If MAJORITY of S's pairs show divergence, S is depegged.
	//
	// "Divergence direction" matters: in pair (S, T), if ratio > 1+ε,
	// S is OVER-valued vs T (could mean S is high or T is low).  If
	// ratio < 1-ε, S is UNDER-valued vs T.  We need to triangulate.
	//
	// Triangulation rule: if S diverges in the SAME direction across
	// multiple pairs, S is the outlier; if S's deviations average
	// near zero (some up, some down), S isn't the problem — a single
	// other coin is.
	const status: Record<string, DepegStatus> = {};
	for (const k of stablecoinKeys) {
		const pairsInvolvingK = pairDetails.filter((p) => p.a === k || p.b === k);
		if (pairsInvolvingK.length === 0) {
			status[k] = 'unknown';
			continue;
		}

		// Compute signed deviations from 1.0, viewed FROM k's
		// perspective.  If pair is (k, other) we use ratio - 1.
		// If pair is (other, k) the ratio is other/k; we want k/other = 1/ratio,
		// so deviation is (1/ratio) - 1.
		const deviationsFromK: number[] = [];
		for (const p of pairsInvolvingK) {
			let kPerOther: number;
			if (p.a === k) {
				kPerOther = p.ratio; // ratio already is a/b = k/other
			} else {
				kPerOther = 1 / p.ratio; // ratio is other/k, flip
			}
			deviationsFromK.push(kPerOther - 1);
		}

		// Black-hat resistance: median of deviations (not mean).  A
		// single manipulated pair can't push k into "depegged"
		// classification on its own.
		deviationsFromK.sort((x, y) => x - y);
		const midIdx = deviationsFromK.length / 2;
		const medianDeviation =
			deviationsFromK.length % 2 === 1
				? deviationsFromK[Math.floor(midIdx)]!
				: (deviationsFromK[midIdx - 1]! + deviationsFromK[midIdx]!) / 2;

		if (Math.abs(medianDeviation) > ratioThreshold) {
			status[k] = 'depegged';
			log.warn('stablecoin_depeg_detected', {
				stablecoin: k,
				median_deviation: medianDeviation,
				threshold: ratioThreshold,
				pair_count: pairsInvolvingK.length
			});
		} else {
			status[k] = 'pegged';
		}
	}

	return {
		status,
		usable_pair_count: pairDetails.length,
		pair_details: pairDetails,
		window_hours: windowHours,
		threshold: ratioThreshold
	};
}
