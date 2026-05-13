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
import { orderbookEventBus } from '$indexer/orderbookEventBus';
import { chatEventBus } from '$indexer/chatEventBus';

// Keep this in sync with apps/indexer/package.json version. Read at
// module-load time; no runtime cost.
const INDEXER_VERSION = '0.1.0-phase3b';

export function healthRoute(
	config: Config,
	poller: Poller,
	priceSource: BlurtPriceSource | null
): Hono {
	const app = new Hono();
	const bootTime = Date.now();

	app.get('/', (c) => {
		const status = poller.getStatus();
		const uptimeSec = Math.floor((Date.now() - bootTime) / 1000);
		const lagBlocks = Math.max(0, status.chainHeadBlock - status.indexedBlock);
		const stale = lagBlocks > config.staleLagThreshold;

		const body: Record<string, unknown> = {
			status: stale ? ('degraded' as const) : ('ok' as const),
			version: INDEXER_VERSION,
			uptime_sec: uptimeSec,
			chain_head_block: status.chainHeadBlock,
			indexed_block: status.indexedBlock,
			lag_blocks: lagBlocks,
			stale
		};

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
			const snap = poller.explorerBreaker.snapshot();
			const now = Date.now();
			const explorers: Array<{
				url: string;
				state: string;
				consecutive_failures: number;
				cooldown_remaining_ms: number;
			}> = [];
			for (const [url, s] of snap) {
				explorers.push({
					url,
					state: poller.explorerBreaker.stateOf(url),
					consecutive_failures: s.consecutiveFailures,
					cooldown_remaining_ms: Math.max(0, s.cooldownUntil - now)
				});
			}

			// Price source diagnostics. The source's currentDetailed()
			// returns which upstream is serving right now (klingex,
			// coingecko, or static_floor), when it was last refreshed,
			// and a stale flag. Operators triaging USD-display issues
			// can see at a glance whether they're on a live feed or
			// whether the feed is disabled entirely (the default).
			const price =
				priceSource !== null
					? (() => {
							const d = priceSource.currentDetailed();
							return {
								enabled: true,
								blurt_usd: d.price,
								source: d.source,
								updated_at: d.updated_at.toISOString(),
								stale: d.stale
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

			body.diagnostics = {
				last_error: status.lastError,
				last_error_at: status.lastErrorAt ? status.lastErrorAt.toISOString() : null,
				started_at: status.startedAt.toISOString(),
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
