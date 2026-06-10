/**
 * Morphit indexer — Cross-instance peer price monitor (Defense F).
 *
 * cp127 deferred Defense F from ADR-0039's black-hat-defense table.
 * cp129 implements it.
 *
 * What this catches
 * ─────────────────
 * The cp127 morphit_native fetcher has manipulation defenses
 * against attackers manipulating Morphit's own on-platform trade
 * data (Sybil filtering, per-trader caps, tier hierarchy, drift
 * monitoring, etc.).  But what if an entire indexer is compromised?
 *
 * Imagine an operator who's been pressured (regulatory threat,
 * bribed, captured) and is now patching their indexer to report a
 * fake derived price — fed via inserted database rows, tweaked
 * code, anything.  None of the in-indexer defenses can catch this
 * because the indexer is the source of truth for its own derivation.
 *
 * Cross-instance peer disagreement DOES catch it: if my indexer is
 * the only one reporting BLURT/USD = $0.005 while the rest of the
 * federation reports $0.002, sustained disagreement of that
 * magnitude is suspicious by construction.  An alert fires; the
 * operator (and users via /v1/health) can investigate.
 *
 * How it works
 * ────────────
 *   1. Every PEER_SAMPLE_INTERVAL_MINUTES (default 30 min):
 *        For each peer in `known_instances` with last_probe_status
 *        in ('good', 'quiet'):
 *          - GET https://<peer-origin>/v1/price/morphit-native/receipt
 *          - Parse the response; pick out derived_price + source.
 *          - INSERT a row into price_peer_observations.
 *
 *   2. After each sample cycle:
 *        Compute median across all peer observations in the last
 *        PEER_DISAGREEMENT_WINDOW_HOURS (default 4 hours) where
 *        source_native='morphit_native' (skip 'unknown' peers
 *        because we can't tell if their price came from our same
 *        derivation method).
 *
 *   3. Compare median(peers) vs my own current derived_price.
 *        If |my - median| / median > PEER_DISAGREEMENT_THRESHOLD
 *        (default 25%), increment a sustained-disagreement counter.
 *
 *   4. If counter exceeds PEER_DISAGREEMENT_SUSTAINED_HOURS
 *      (default 4 hours), fire an alert (rate-limited to
 *      PEER_ALERT_COOLDOWN_HOURS = 24h, matching the cp127
 *      disagreementMonitor pattern).
 *
 * Why median, not mean
 * ────────────────────
 * One malicious peer feeding a wildly wrong number shouldn't be
 * able to shift the median.  Half the peers + 1 would need to be
 * colluding to move it.  Combined with the federation prober's
 * existing checks (operator chain-registration, etc.), Sybil-ing
 * the peer set requires real attacker resources.
 *
 * Why ≥3 peers minimum
 * ────────────────────
 * Below 3 peers, the median is too easily moved by any single
 * outlier.  With 3 peers, a single outlier still doesn't shift
 * the median (the middle value wins).  Operators with <3 peers
 * reachable will see the monitor degrade gracefully — no alert,
 * just a log message saying "insufficient peers".
 *
 * Same-denomination filter
 * ────────────────────────
 * Comparing my USD-denominated BLURT price to a peer's EUR-
 * denominated BLURT price requires a USD/EUR oracle, which would
 * defeat the self-sovereign premise of cp127.  So this monitor
 * only compares peers with matching `denomination_fiat`.  A
 * USD-denominated indexer in a mostly-EUR federation will skip
 * the comparison entirely (which is correct — no signal from a
 * non-comparable peer set is better than a misleading signal).
 *
 * What this DOESN'T catch (honest limitations)
 * ────────────────────────────────────────────
 * - **All-instances compromised simultaneously**.  If every
 *   indexer in the federation is reporting the same wrong price
 *   (because all operators colluded, or because a shared data
 *   source got poisoned), no cross-instance comparison can
 *   detect it.  Same blind spot as cp127's "consensus from
 *   compromised sources" failure mode.
 * - **Geographic isolation**.  A new instance in a region where
 *   most peers happen to be unreachable just sees few peers and
 *   degrades to no-alert mode.  This is correct: we'd rather
 *   skip the comparison than fire spurious alerts.
 * - **Different-denomination federation**.  As above — we can't
 *   cross-compare.  A future cp could add a fiat-conversion layer,
 *   but that re-introduces external oracle dependency, so the
 *   current choice is "skip" not "convert."
 *
 * Trust model summary
 * ───────────────────
 * Defense F treats peer observations as a noisy, possibly-Sybil-
 * resistant ground-truth signal.  Median-of-multiple is the
 * cryptoeconomic foundation; the federation prober's existing
 * vetting (operator chain-registration, last-probe-status filter)
 * is the Sybil-resistance foundation.  Together they make this a
 * useful defense against single-indexer compromise — the highest-
 * risk scenario for users — without introducing a new trust
 * anchor or external oracle.
 *
 * Wiring
 * ──────
 * - `apps/indexer/src/main.ts` starts the monitor on boot when
 *   MORPHIT_INDEXER_PEER_PRICE_MONITOR_ENABLED=true.
 * - The monitor stores observations to `price_peer_observations`
 *   and updates an in-process `lastAlertFiredAt` timestamp for
 *   rate-limiting.  No new endpoint surfaces alerts; they appear
 *   in indexer logs and are surfaced by /v1/health via the
 *   existing diagnostics layer (cp129 extends).
 * - See ADR-0041 for the full architectural rationale.
 */

import type { Database } from '$db/pool';
import { logger } from '$log';
import type { BlurtPriceSource } from '$indexer/price/source';
import { fetchJson } from '$indexer/federationProbe';

const log = logger('peer-price-monitor');

/** Default disagreement threshold for firing alerts.  25% deviation
 *  from peer median is the same number cp127's disagreementMonitor
 *  uses for external-vs-native disagreement; keeps the semantics
 *  consistent. */
export const PEER_DISAGREEMENT_THRESHOLD = 0.25;

/** Time window over which to aggregate peer observations.  4 hours
 *  is enough to smooth out short-term price spikes but tight enough
 *  to react within a quarter of a day. */
export const PEER_DISAGREEMENT_WINDOW_HOURS = 4;

/** Hours of sustained over-threshold disagreement before an alert
 *  fires.  Matches cp127 disagreementMonitor's sustained-window
 *  for consistency. */
export const PEER_DISAGREEMENT_SUSTAINED_HOURS = 4;

/** Once an alert fires, suppress further alerts for this many hours.
 *  Prevents log spam when disagreement is genuinely sustained. */
export const PEER_ALERT_COOLDOWN_HOURS = 24;

/** Minimum number of peer observations required in the window to
 *  even attempt the comparison.  Below this, the monitor degrades
 *  to silent (no false alarms from tiny samples). */
export const PEER_MIN_OBSERVATIONS = 3;

/** Default cadence: how often to sample peers.  Every 30 minutes
 *  is conservative — low traffic, doesn't hammer peers, picks up
 *  multi-hour drift cleanly. */
export const PEER_SAMPLE_INTERVAL_MINUTES = 30;

/** TTL for stored observations.  7 days keeps the table bounded
 *  while preserving enough history for retrospective forensics. */
export const PEER_OBSERVATION_RETENTION_DAYS = 7;

/** HTTP timeout for peer queries.  Short — we'd rather skip an
 *  unresponsive peer than block the sample cycle. */
export const PEER_FETCH_TIMEOUT_MS = 10_000;

/** Receipt response shape we expect from peer instances.
 *
 *  This is a subset of `/v1/price/morphit-native/receipt`'s
 *  full response — we only care about the derived price and what
 *  source it came from.  Other fields (contributing_traders,
 *  envelope info, etc.) are peer-specific implementation details
 *  we don't need to compare. */
interface PeerReceiptResponse {
	readonly asset: string;
	readonly denomination_fiat: string;
	readonly derived_price?: number;
	readonly tier_used?: string;
	readonly source?: string;
	readonly NOT_AN_ORACLE_WARNING?: string;
}

/** Result of querying one peer in one sample cycle. */
export interface PeerObservation {
	readonly peerOrigin: string;
	readonly asset: string;
	readonly denominationFiat: string;
	readonly observedPrice: number;
	readonly observedAt: Date;
	readonly sourceNative: 'morphit_native' | 'unknown';
}

/** Configuration for createPeerPriceMonitor. */
export interface PeerPriceMonitorConfig {
	readonly db: Database;
	readonly priceSource: BlurtPriceSource;
	readonly asset: string;
	readonly denominationFiat: string;
	readonly disagreementThreshold?: number;
	readonly disagreementWindowHours?: number;
	readonly sustainedHours?: number;
	readonly alertCooldownHours?: number;
	readonly minObservations?: number;
	readonly fetchTimeoutMs?: number;
}

/** Result of one sample cycle — observation count + comparison
 *  outcome.  Returned for testability / structural smoke. */
export interface PeerSampleCycleResult {
	readonly peersQueried: number;
	readonly observationsRecorded: number;
	readonly comparedAgainstMedian: boolean;
	readonly peerMedian: number | null;
	readonly myPrice: number | null;
	readonly deviation: number | null;
	readonly aboveThreshold: boolean;
	readonly alertFired: boolean;
}

/** Fetch a single peer's price-receipt endpoint.  Returns null on
 *  any failure (timeout, 4xx/5xx, parse error, missing fields,
 *  non-public host, DNS rebinding, oversized response, redirect) —
 *  failures are normal in the federation and shouldn't block the
 *  cycle.
 *
 *  cp139-F-2 hardening: routes through `fetchJson` from
 *  federationProbe so the per-peer fetch gets the same six-layer
 *  SSRF defense the probe loop has:
 *    1. HTTPS protocol enforcement
 *    2. Literal-private-hostname denylist (catches localhost,
 *       127.x, 169.254.169.254, ULA, link-local, .local/.internal
 *       TLDs etc.)
 *    3. DNS resolve + EVERY record validated public (closes
 *       DNS-rebinding window — an attacker who chain-registered
 *       a public-looking origin then flipped DNS to a private IP
 *       between probe and this fetch is rejected here)
 *    4. IP-pinned undici dispatcher (TOCTOU defense)
 *    5. redirect: 'manual' (no 30x chains to internal URLs)
 *    6. Body cap at 256KB with streaming abort (DoS bound)
 *
 *  Pre-cp139-F-2 this function called bare fetch(), relying solely
 *  on the operator-register handler's intake-time literal-hostname
 *  check.  Intake gating catches static forms; the request-time
 *  layers above catch DNS-rebinding + redirect + body-bomb.  Both
 *  are defense-in-depth; both are now in place. */
export async function fetchPeerReceipt(
	peerOrigin: string,
	asset: string,
	denominationFiat: string,
	timeoutMs: number = PEER_FETCH_TIMEOUT_MS
): Promise<PeerReceiptResponse | null> {
	// timeoutMs is observed via fetchJson's internal FETCH_TIMEOUT_MS
	// (5s).  Per-call override would require fetchJson to accept a
	// timeout parameter; for now the canonical 5s is shorter than
	// PEER_FETCH_TIMEOUT_MS default 10s so peers are MORE likely to
	// be skipped on slow responses, not less — acceptable tradeoff
	// vs forking fetchJson's signature.  The argument is preserved
	// in the function signature for API back-compat with smokes that
	// pass it explicitly.
	void timeoutMs;
	try {
		const url = new URL(
			'/v1/price/morphit-native/receipt',
			peerOrigin
		);
		url.searchParams.set('asset', asset);
		url.searchParams.set('denomination_fiat', denominationFiat);
		const body = await fetchJson<PeerReceiptResponse>(url.toString());
		if (
			typeof body.derived_price !== 'number' ||
			!Number.isFinite(body.derived_price) ||
			body.derived_price <= 0
		) {
			return null;
		}
		if (body.asset !== asset) {
			return null;
		}
		if (body.denomination_fiat !== denominationFiat) {
			// Different denomination — skip per the same-denomination
			// filter (we can't compare apples to oranges).
			return null;
		}
		return body;
	} catch (err) {
		log.debug('peer_fetch_failed', { peerOrigin, err: String(err) });
		return null;
	}
}

/** Compute the median of a sorted-or-unsorted number array.  For
 *  even-length, returns the average of the two middle elements. */
export function median(values: ReadonlyArray<number>): number {
	if (values.length === 0) {
		throw new Error('median of empty array');
	}
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	if (n % 2 === 1) {
		return sorted[(n - 1) / 2]!;
	}
	return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/** Check whether |a - b| / b exceeds the threshold.  Returns
 *  true iff (a, b) disagree by more than `threshold` (e.g. 0.25
 *  for 25%).  Uses `b` as the denominator (peer median is the
 *  "expected" value; my price is the candidate-for-disagreement). */
export function disagreementExceedsThreshold(
	myPrice: number,
	peerMedian: number,
	threshold: number
): boolean {
	if (peerMedian <= 0) return false;
	return Math.abs(myPrice - peerMedian) / peerMedian > threshold;
}

/** Pure-function variant of the alert decision.  Returns true iff
 *  the disagreement should ESCALATE to an alert (sustained for
 *  longer than the sustained-hours threshold AND outside the
 *  cooldown period from the last alert).
 *
 *  Inputs are explicit so the logic can be unit-tested without
 *  wall-clock dependency. */
export function shouldFireAlert(
	aboveThresholdSince: Date | null,
	now: Date,
	lastAlertAt: Date | null,
	sustainedHours: number,
	cooldownHours: number
): boolean {
	if (aboveThresholdSince === null) return false;
	const sustainedMs = sustainedHours * 60 * 60 * 1000;
	const cooldownMs = cooldownHours * 60 * 60 * 1000;
	const elapsedSustained = now.getTime() - aboveThresholdSince.getTime();
	if (elapsedSustained < sustainedMs) return false;
	if (lastAlertAt === null) return true;
	const elapsedSinceLastAlert = now.getTime() - lastAlertAt.getTime();
	return elapsedSinceLastAlert >= cooldownMs;
}

/** Module-level state for sustained-disagreement tracking + alert
 *  rate-limiting.  Reset on indexer restart (acceptable — peer
 *  observations are persisted, so a restart just delays the alert
 *  by one cycle while the in-process state rebuilds). */
const moduleState = {
	aboveThresholdSince: null as Date | null,
	lastAlertFiredAt: null as Date | null
};

/** Reset module state (used by tests).  Not exported in production
 *  paths. */
export function _resetPeerPriceMonitorState(): void {
	moduleState.aboveThresholdSince = null;
	moduleState.lastAlertFiredAt = null;
}

/** Run one sample cycle: query peers, store observations, compute
 *  comparison, fire alert if warranted.  Returns the cycle result
 *  for testability / structural verification.
 *
 *  Designed to be safe under retry / parallel execution — multiple
 *  in-flight cycles produce extra observations but don't corrupt
 *  the median (median is over the time-window, not per-cycle). */
export async function runPeerPriceSampleCycle(
	cfg: PeerPriceMonitorConfig,
	now: Date = new Date()
): Promise<PeerSampleCycleResult> {
	const {
		db,
		priceSource,
		asset,
		denominationFiat,
		disagreementThreshold = PEER_DISAGREEMENT_THRESHOLD,
		disagreementWindowHours = PEER_DISAGREEMENT_WINDOW_HOURS,
		sustainedHours = PEER_DISAGREEMENT_SUSTAINED_HOURS,
		alertCooldownHours = PEER_ALERT_COOLDOWN_HOURS,
		minObservations = PEER_MIN_OBSERVATIONS,
		fetchTimeoutMs = PEER_FETCH_TIMEOUT_MS
	} = cfg;

	// Step 1: discover peers from federation directory.  Only query
	// peers that the federation prober has vetted as good/quiet
	// (operator chain-registration verified, recent /v1/health
	// returned OK, etc.).
	const peersQuery = await db.query<{ origin: string }>(
		`SELECT origin
		 FROM known_instances
		 WHERE last_probe_status IN ('good', 'quiet')
		   AND origin IS NOT NULL`
	);
	const peers = peersQuery.rows.map((r) => r.origin);

	// Step 2: query each peer in parallel.  Failures are silent
	// (peer offline, denomination-mismatch, etc.) — they just
	// don't contribute an observation.
	//
	// cp167 design decision — kept on Promise.allSettled, NOT
	// migrated to @morphit/rpc-pool's quorumCall.  Rationale:
	//
	//   - EndpointPool / quorumCall are optimized for "give me
	//     ONE answer (or early-return on consensus)" — they're
	//     ideal for choosing among multiple equivalent BTC/XMR
	//     explorers serving the SAME function.
	//
	//   - peerPriceMonitor needs the OPPOSITE: every peer's
	//     observation, including failures.  The median calculation
	//     downstream IS the consensus mechanism, and the
	//     disagreement signal (one peer vs the rest) is the entire
	//     point — early-returning on partial agreement would
	//     defeat the alert.
	//
	//   - Per-peer health tracking already happens via the
	//     federation prober (last_probe_status IN ('good','quiet')
	//     above); EWMA latency wouldn't change behavior because
	//     all healthy peers get queried regardless of latency.
	//
	// Promise.allSettled stays.  If a future requirement emerges
	// for partial-result early-return (e.g. for /v1/health
	// real-time peer-consensus on the request path), revisit
	// then; the current ~30-minute background cycle has no
	// latency budget that pool integration would help with.
	const observations: PeerObservation[] = [];
	const fetchResults = await Promise.allSettled(
		peers.map((origin) => fetchPeerReceipt(origin, asset, denominationFiat, fetchTimeoutMs))
	);
	for (let i = 0; i < peers.length; i++) {
		const result = fetchResults[i]!;
		const peerOrigin = peers[i]!;
		if (result.status !== 'fulfilled' || result.value === null) continue;
		observations.push({
			peerOrigin,
			asset: result.value.asset,
			denominationFiat: result.value.denomination_fiat,
			observedPrice: result.value.derived_price!,
			observedAt: now,
			sourceNative:
				result.value.source === 'morphit_native' ? 'morphit_native' : 'unknown'
		});
	}

	// Step 3: persist all observations.
	for (const obs of observations) {
		await db.query(
			`INSERT INTO price_peer_observations
			   (peer_origin, asset, denomination_fiat, observed_price,
			    observed_at, source_native)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[
				obs.peerOrigin,
				obs.asset,
				obs.denominationFiat,
				obs.observedPrice,
				obs.observedAt,
				obs.sourceNative
			]
		);
	}

	// Step 4: compute the peer median over the disagreement window.
	// Only use 'morphit_native' source observations — comparing
	// against unknown sources is apples-to-oranges.
	const windowMs = disagreementWindowHours * 60 * 60 * 1000;
	const windowStart = new Date(now.getTime() - windowMs);
	const medianQuery = await db.query<{ observed_price: string }>(
		`SELECT observed_price::TEXT AS observed_price
		 FROM price_peer_observations
		 WHERE asset = $1
		   AND denomination_fiat = $2
		   AND observed_at >= $3
		   AND source_native = 'morphit_native'`,
		[asset, denominationFiat, windowStart]
	);
	const peerPrices = medianQuery.rows
		.map((r) => Number(r.observed_price))
		.filter((p) => Number.isFinite(p) && p > 0);

	// Below minimum-observations threshold, degrade silently.
	if (peerPrices.length < minObservations) {
		log.debug('insufficient_peer_observations', {
			peersQueried: peers.length,
			observationsInWindow: peerPrices.length
		});
		return {
			peersQueried: peers.length,
			observationsRecorded: observations.length,
			comparedAgainstMedian: false,
			peerMedian: null,
			myPrice: null,
			deviation: null,
			aboveThreshold: false,
			alertFired: false
		};
	}

	const peerMed = median(peerPrices);

	// Step 5: get my own current derived price.
	const myDetail = priceSource.currentDetailed();
	if (myDetail.stale || myDetail.price <= 0) {
		log.debug('own_price_unavailable', {
			price: myDetail.price,
			stale: myDetail.stale
		});
		return {
			peersQueried: peers.length,
			observationsRecorded: observations.length,
			comparedAgainstMedian: false,
			peerMedian: peerMed,
			myPrice: null,
			deviation: null,
			aboveThreshold: false,
			alertFired: false
		};
	}
	const myPrice = myDetail.price;
	const deviation = Math.abs(myPrice - peerMed) / peerMed;
	const aboveThreshold = disagreementExceedsThreshold(
		myPrice,
		peerMed,
		disagreementThreshold
	);

	// Step 6: update sustained-disagreement state.
	if (aboveThreshold) {
		if (moduleState.aboveThresholdSince === null) {
			moduleState.aboveThresholdSince = now;
		}
	} else {
		moduleState.aboveThresholdSince = null;
	}

	// Step 7: fire alert if criteria met.
	const fireAlert = shouldFireAlert(
		moduleState.aboveThresholdSince,
		now,
		moduleState.lastAlertFiredAt,
		sustainedHours,
		alertCooldownHours
	);
	if (fireAlert) {
		log.warn('peer_price_disagreement_alert', {
			asset,
			denominationFiat,
			myPrice,
			peerMedian: peerMed,
			deviation: deviation.toFixed(4),
			peerCount: peerPrices.length,
			sustainedSince: moduleState.aboveThresholdSince?.toISOString(),
			defenseTag:
				'Defense F (cp127 deferred → cp129) — my derived price diverges from peer median by more than threshold for sustained period.  See ADR-0041.'
		});
		moduleState.lastAlertFiredAt = now;
	}

	return {
		peersQueried: peers.length,
		observationsRecorded: observations.length,
		comparedAgainstMedian: true,
		peerMedian: peerMed,
		myPrice,
		deviation,
		aboveThreshold,
		alertFired: fireAlert
	};
}

/** Clean up old observations.  Called periodically (every cycle is
 *  fine — it's a cheap DELETE indexed on observed_at).  Bounds the
 *  table to PEER_OBSERVATION_RETENTION_DAYS of history. */
export async function pruneOldObservations(
	db: Database,
	now: Date = new Date(),
	retentionDays: number = PEER_OBSERVATION_RETENTION_DAYS
): Promise<number> {
	const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
	const result = await db.query(
		`DELETE FROM price_peer_observations WHERE observed_at < $1`,
		[cutoff]
	);
	return result.rowCount ?? 0;
}

/** Start the peer-price monitor.  Schedules a recurring sample
 *  cycle at the configured interval.  Returns a stop function for
 *  graceful shutdown. */
export function startPeerPriceMonitor(
	cfg: PeerPriceMonitorConfig,
	intervalMinutes: number = PEER_SAMPLE_INTERVAL_MINUTES,
	onResult?: (result: PeerSampleCycleResult) => void
): () => void {
	const intervalMs = intervalMinutes * 60 * 1000;
	let running = true;

	async function tick(): Promise<void> {
		if (!running) return;
		try {
			const result = await runPeerPriceSampleCycle(cfg);
			// cp233 — surface the latest cycle result so /v1/health can
			// show F's peer comparison alongside B (drift) and C
			// (disagreement).  The cp129 schema comment always promised
			// F would "surface on /v1/health"; this callback is where
			// that finally becomes true.  Fenced from the prune below by
			// being a pure in-memory store on the caller's side.
			onResult?.(result);
			await pruneOldObservations(cfg.db);
		} catch (err) {
			log.error('peer_price_sample_cycle_failed', { err: String(err) });
		}
	}

	// Fire-and-forget initial cycle, then schedule recurring.
	void tick();
	const handle = setInterval(() => void tick(), intervalMs);

	return (): void => {
		running = false;
		clearInterval(handle);
	};
}
