/**
 * Morphit indexer — /v1/health endpoint.
 *
 * Reports uptime, chain head, indexed head, and the gap between
 * them. The `stale` flag trips when the gap exceeds the configured
 * threshold; it's informational and doesn't change behavior.
 *
 * When either MORPHIT_INDEXER_VERBOSE_HEALTH=true (global) or
 * ?verbose=1 (per-request) is set, the response also includes a
 * `diagnostics` object with the Poller's last error, the current
 * CircuitBreaker snapshot for all explorer URLs, and the live
 * BLURT/USD price source state (which upstream is serving, when
 * it last refreshed, whether it's stale). Useful when operators
 * are triaging "why are BTC orders landing in pending_external"
 * or "why are BLURT fees verifying as underpaid" questions.
 */

import { Hono } from 'hono';

import type { Config } from '$config';
import type { Poller } from '$indexer/poller';
import type { BlurtPriceSource } from '$indexer/price/source';
import type { FxRateSource } from '$indexer/fx/source';
import { buildPriceFeedsHealth } from '$api/priceFeedsHealth';
import type { DisagreementMonitor } from '$indexer/price/disagreementMonitor';
import type { PeerSampleCycleResult } from '$indexer/price/peerPriceMonitor';
import { orderbookEventBus } from '$indexer/orderbookEventBus';
import { chatEventBus } from '$indexer/chatEventBus';
import type { HeadTailer } from '$indexer/headTailer';

// Keep in sync with the root package.json `version`.  The
// version-consistency-smoke (Part 122 cp20) fails the build if
// this constant drifts from any other package.json or from the
// relay's VERSION constant.  When bumping for a new release,
// update all 10 package.json files + this constant +
// apps/relay/src/api/health.ts VERSION + the example response
// in docs/API.md in the same commit.
const INDEXER_VERSION = '1.7.0';

// Blurt produces one block every 3 seconds. Used to translate the
// block-lag count into a human "seconds behind" figure in the
// /v1/health `lag_blocks_note`, so an operator eyeballing the
// endpoint can tell at a glance whether a given lag is normal
// (a healthy indexer trails head by only a handful of blocks —
// network + write latency) without having to do the arithmetic.
const BLURT_BLOCK_SECONDS = 3;

export function healthRoute(
	config: Config,
	poller: Poller,
	priceSource: BlurtPriceSource | null,
	// cp233 — Defense C: per-asset disagreement monitors, read for the
	// verbose price block's `disagreement` surface.  Defaulted so any
	// caller that doesn't wire it sees an empty map (→ disagreement
	// reports null), never a crash.
	disagreementMonitors: ReadonlyMap<string, DisagreementMonitor> = new Map(),
	// cp233 — Defense F: latest peer-monitor cycle result per asset,
	// read for the verbose price block's `peer` surface.  Defaulted so
	// a caller that doesn't wire it sees an empty map (→ peer null).
	peerMonitorResults: ReadonlyMap<string, PeerSampleCycleResult> = new Map(),
	// cp372/cp381 — multi-source FX + crypto feed status for the
	// operator-only top-level `price_feeds` block (morphit-ops node-health
	// view), gated on the X-Morphit-Local-Health header the public edge
	// strips.  Defaulted so callers that don't wire them see fx disabled /
	// no crypto feeds.
	fxSource: FxRateSource | null = null,
	multiAssetSources: ReadonlyMap<string, BlurtPriceSource> = new Map(),
	// cp403 [1] — chat head-block fast-path tailer. Its status
	// (enabled/running/watermark/emitted/last error) is surfaced in the
	// operator-only top-level `fastpath` block (beside `price_feeds`,
	// same X-Morphit-Local-Health gate) so the morphit-ops node-health
	// view can show admins whether fast chat is on. Defaulted so a caller
	// that doesn't wire it reports the fast path as absent, never a crash.
	headTailer: HeadTailer | null = null
): Hono {
	const app = new Hono();
	const bootTime = Date.now();

	app.get('/', (c) => {
		const status = poller.getStatus();
		const uptimeSec = Math.floor((Date.now() - bootTime) / 1000);
		const lagBlocks = Math.max(0, status.chainHeadBlock - status.indexedBlock);
		const stale = lagBlocks > config.staleLagThreshold;

		// Compact RPC-pool health for at-a-glance triage on the PUBLIC
		// body: how many of the configured Blurt RPC endpoints are
		// currently reachable (out of cooldown). If this reads 0 while
		// the node is behind, RPC — not the indexer — is the problem
		// (exactly the beta5 firefight). Per-endpoint URLs/detail stay
		// in the gated verbose block below.
		const rpcSnap = poller.rpcEndpointSnapshot;
		const nowMs = Date.now();
		const rpcEndpointsHealthy = rpcSnap.filter((e) => e.cooldownUntil <= nowMs).length;

		const body: Record<string, unknown> = {
			status: stale ? ('degraded' as const) : ('ok' as const),
			version: INDEXER_VERSION,
			uptime_sec: uptimeSec,
			chain_head_block: status.chainHeadBlock,
			indexed_block: status.indexedBlock,
			lag_blocks: lagBlocks,
			// Human context for `lag_blocks` so an operator curling
			// /v1/health knows whether the number is fine without
			// memorising thresholds. A healthy indexer trails chain
			// head by only a handful of blocks; we report "normal" as
			// up to the same `staleLagThreshold` the `stale` flag uses
			// (so the note and the flag never disagree), with the
			// equivalent seconds-behind at Blurt's 3s block time.
			lag_blocks_note: `0\u2013${config.staleLagThreshold} is normal (~${
				config.staleLagThreshold * BLURT_BLOCK_SECONDS
			}s behind; Blurt makes a block every ${BLURT_BLOCK_SECONDS}s)`,
			stale,
			rpc_endpoints_healthy: rpcEndpointsHealthy,
			rpc_endpoints_total: rpcSnap.length
		};

		// Compact price-feed state on the PUBLIC (non-verbose) body so
		// `morphit-ops health` can show whether the BLURT/USD feed is on
		// and serving a live price, without needing the gated verbose
		// token.  Nothing sensitive here — the price itself is already
		// public via /v1/listing-fee (`blurt_price_fiat`); the per-
		// upstream/forensic detail (drift, disagreement, peer) stays in
		// the verbose `diagnostics.price` block below.  `enabled:false`
		// means the operator has MORPHIT_INDEXER_PRICE_FEED_ENABLED off
		// (the UI shows BLURT only); `stale:true` means the feed is on
		// but no live upstream has succeeded (serving the static floor).
		body.price_feed =
			priceSource !== null
				? (() => {
						const d = priceSource.currentDetailed();
						return {
							enabled: true as const,
							blurt_fiat: d.price,
							denomination_fiat: config.priceFeedDenominationFiat,
							source: d.source,
							stale: d.stale
						};
					})()
				: { enabled: false as const };

		// cp381 — per-source price-feed health (which providers are up,
		// each provider's last reading, seconds since each answered,
		// provider-disagreement).  This is what `morphit-ops health`
		// renders by default so an operator can see at a glance which
		// upstream is serving and which is down.
		//
		// OPERATOR-ONLY: gated on a request header the ops-cli sends
		// (it hits the indexer directly on the internal bridge) and the
		// public edge strips (`proxy_set_header X-Morphit-Local-Health "";`
		// in ops/nginx/*.conf + BunkerWeb), so a public caller can never
		// forge it.  Deliberately NOT in the gated `diagnostics` block:
		// that block also carries `operator_balances` (the NEW-9-8
		// drain signal), which must stay behind the full verbose gate.
		// Per-source feed health is low-sensitivity (the committed price
		// is already public on `price_feed` above, and the provider list
		// is documented in ADR-0004), but exposing which of *this*
		// operator's feeds are momentarily down would shave the
		// price-manipulation opacity the median-of-many design relies on —
		// hence operator-only rather than public.
		const localDiag = c.req.header('x-morphit-local-health') === '1';
		if (localDiag) {
			body.price_feeds = buildPriceFeedsHealth(fxSource, multiAssetSources);
			// cp403 [1] — chat head-block fast-path status, surfaced in the
			// same operator-only top-level block as price_feeds so the
			// morphit-ops node-health view can show admins whether fast
			// the fast path is tailing and keeping up (alongside FX + price
			// feeds). Low sensitivity: a head watermark and a counter, no user
			// data. null when the tailer wasn't wired.
			// v1.7.0 — key renamed `chat_fastpath` → `fastpath` with the tailer
			// it reports: it covers more than chat now (ADR-0051).
			body.fastpath = headTailer ? headTailer.getStatus() : null;
		}

		// Audit 2026-05 finding NEW-9-8: verbose mode now requires
		// the server-side MORPHIT_INDEXER_VERBOSE_HEALTH flag to be
		// on.  Pre-fix, any caller passing ?verbose=1 got the full
		// diagnostics block including operator-account balance
		// state — which leaks below-threshold signal to a public
		// attacker timing a drain attempt.  Post-fix, verbose mode
		// is operator-opt-in only; ?verbose=1 alone has no effect
		// when the server-side flag is off.
		const verbose = config.verboseHealth && c.req.query('verbose') === '1';
		if (verbose) {
			// cp166 — explorer health was previously sourced from a
			// shared CircuitBreaker; each fee verifier now owns its
			// own EndpointPool with latency-aware ordering, and the
			// poller's `explorerHealthSnapshot` accessor merges
			// both verifiers' snapshots into one list keyed by URL.
			// New field: `ewma_latency_ms` — the rolling-average
			// successful-call latency in ms; `null` until the
			// endpoint has succeeded at least once.  Strict superset
			// of the old breaker output (which had no latency view).
			const snap = poller.explorerHealthSnapshot;
			const now = Date.now();
			const explorers: Array<{
				url: string;
				state: string;
				consecutive_failures: number;
				cooldown_remaining_ms: number;
				ewma_latency_ms: number | null;
			}> = [];
			for (const s of snap) {
				const cooldownRemaining = Math.max(0, s.cooldownUntil - now);
				// Derive a human-readable state from the same three
				// signals the old breaker exposed: `open` while
				// cooldown active, `closed` once back to zero
				// consecutive failures, `half_open` during the brief
				// window between cooldown expiry and the next attempt.
				const state =
					cooldownRemaining > 0
						? 'open'
						: s.consecutiveFailures > 0
							? 'half_open'
							: 'closed';
				explorers.push({
					url: s.url,
					state,
					consecutive_failures: s.consecutiveFailures,
					cooldown_remaining_ms: cooldownRemaining,
					ewma_latency_ms: s.ewmaLatencyMs
				});
			}

			// Price source diagnostics. The source's currentDetailed()
			// returns which upstream is serving right now (
			// coingecko, or static_floor), when it was last refreshed,
			// and a stale flag. Operators triaging USD-display issues
			// can see at a glance whether they're on a live feed or
			// whether the feed is disabled entirely (the default).
			const price =
				priceSource !== null
					? (() => {
							const d = priceSource.currentDetailed();
							// cp233 — Defense B (slow-drift) surface.
							// driftStatus() is optional on the interface;
							// when present and non-null (drift monitoring is
							// wired and at least one refresh has committed),
							// report deviation from the moving baseline and
							// whether a sustained-divergence alert has fired.
							// Operators watch `drift.alert` for a price being
							// slowly walked away from baseline — the attack
							// the per-cycle smoothing cap cannot catch.
							const drift = priceSource.driftStatus?.() ?? null;
							// cp233 — Defense C surface.  The price block is
							// BLURT-scoped (blurt_usd above), so read the BLURT
							// monitor's last check: whether the self-sovereign
							// native price currently disagrees with the external
							// market price, and whether a sustained-divergence
							// alert has fired.  null when C isn't wired for BLURT
							// (native pricing disabled) or no cycle has run yet.
							const disagree =
								disagreementMonitors.get('BLURT')?.lastCheck() ?? null;
							const peerResult = peerMonitorResults.get('BLURT') ?? null;
							return {
								enabled: true,
								blurt_usd: d.price,
								source: d.source,
								updated_at: d.updated_at.toISOString(),
								stale: d.stale,
								drift: drift
									? {
											baseline: drift.baseline_price,
											deviation: drift.deviation,
											above_threshold: drift.above_threshold,
											sustained_hours: drift.above_threshold_sustained_hours,
											alert: drift.alert_fired
										}
									: null,
								disagreement: disagree
									? {
											active: disagree.active,
											external_source: disagree.external_source,
											external_price: disagree.external_price,
											native_price: disagree.native_price,
											deviation: disagree.deviation,
											sustained_hours: disagree.sustained_hours,
											alert: disagree.alert_fired
										}
									: null,
								// cp233 — Defense F (peer) surface.  Latest
								// peer-comparison cycle for BLURT: how many peers
								// were queried, the peer median vs our own price,
								// the deviation, and whether an alert fired.  null
								// until the first cycle runs (or when the peer
								// monitor is disabled).  Together with drift (B)
								// and disagreement (C) above, all three price-
								// manipulation defenses are now visible here —
								// finally making good on the cp129 schema comment.
								peer: peerResult
									? {
											peers_queried: peerResult.peersQueried,
											compared_against_median: peerResult.comparedAgainstMedian,
											peer_median: peerResult.peerMedian,
											my_price: peerResult.myPrice,
											deviation: peerResult.deviation,
											above_threshold: peerResult.aboveThreshold,
											alert: peerResult.alertFired
										}
									: null
							};
						})()
					: { enabled: false };

			// Operator-account balance scanner snapshot. Reports every
			// account the operator has opted-in to monitoring
			// (threshold > 0) with its current below/above state and
			// last observed balance. Empty list when the feature is
			// not configured.
			const balanceState = poller.getOperatorBalanceState();
			const operatorBalancesCfg = [
				{
					name: config.relayAccount,
					role: 'relay',
					threshold: config.operatorBalanceRelayThresholdBlurt
				},
				{
					name: config.feeRecipient,
					role: 'fees',
					threshold: config.operatorBalanceFeesThresholdBlurt
				}
			].filter((a) => a.threshold > 0);
			const operator_balances = operatorBalancesCfg.map((a) => {
				const s = balanceState.get(a.name);
				return {
					account: a.name,
					role: a.role,
					threshold_blurt: a.threshold,
					below_threshold: s?.below ?? null,
					last_observed_blurt: s?.lastObservedBlurt ?? null
				};
			});

			// The Blurt RPC pool that polls blocks — the feed whose
			// total failure froze sync in the beta5 firefight. Same
			// per-endpoint shape as `explorers` above, plus the age of
			// the last successful response. Operators triaging a
			// stalled sync read this to see which endpoints are dead.
			const rpc_endpoints = rpcSnap.map((s) => {
				const cooldownRemaining = Math.max(0, s.cooldownUntil - now);
				const state =
					cooldownRemaining > 0
						? 'open'
						: s.consecutiveFailures > 0
							? 'half_open'
							: 'closed';
				return {
					url: s.url,
					state,
					consecutive_failures: s.consecutiveFailures,
					cooldown_remaining_ms: cooldownRemaining,
					ewma_latency_ms: s.ewmaLatencyMs,
					last_success_age_s:
						s.lastSuccessAt > 0 ? Math.floor((now - s.lastSuccessAt) / 1000) : null
				};
			});

			body.diagnostics = {
				last_error: status.lastError,
				last_error_at: status.lastErrorAt ? status.lastErrorAt.toISOString() : null,
				started_at: status.startedAt.toISOString(),
				rpc_endpoints,
				explorers,
				price,
				operator_balances,
				// SSE subscriber counts.  Useful for operators
				// triaging "is anyone watching the live orderbook
				// stream right now?" and as a sanity check that
				// the bus is wired correctly (a value > 0 confirms
				// orderbook handlers can reach SSE consumers).
				// (F-1 audit fix.)
				sse_subscribers: {
					orderbook: orderbookEventBus.subscriberCount,
					chat: chatEventBus.subscriberCount
				}
			};
		}

		// Health is always fresh — no caching.
		c.header('cache-control', 'no-store');
		return c.json(body);
	});

	return app;
}
