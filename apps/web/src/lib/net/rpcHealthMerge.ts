/**
 * rpcHealthMerge — reconcile a fresh active-probe result with the passive
 * (smoothed pool) health snapshot for the stats-page RPC endpoints card.
 *
 * WHY: the card shows the passive snapshot instantly, then fires ONE fresh
 * `?probe=1` ping and repaints with it. A single fresh ping is one sample — a
 * node on flaky WiFi, or a jittery Tor/I2P circuit, can miss that one request
 * while being up the vast majority of the time (the smoothed snapshot still
 * reads healthy). Letting that lone miss flip the node to a hard "unreachable"
 * cries wolf — exactly the false alarm on the stats page.
 *
 * RULE: trust a fresh SUCCESS (it carries current latency). But a fresh miss
 * that is (a) a transient transport blip — `network` or `timeout` — and (b) not
 * yet sustained (`consecutive_failures <= 1`), on a node the passive snapshot
 * still calls healthy, is shown as UP with its last-known latency, not
 * "unreachable". A real outage still goes red: the passive health drops too and
 * the failures climb, so this only ever suppresses the single-sample flicker.
 *
 * Pure + dependency-free so it's unit-tested directly.
 */
import type { RpcEndpointHealth } from '@morphit/indexer-client';

/** A fresh miss we treat as a transient blip rather than an outage. */
function isTransientMiss(f: RpcEndpointHealth): boolean {
	return (
		!f.healthy &&
		(f.failure_reason === 'network' || f.failure_reason === 'timeout') &&
		(f.consecutive_failures ?? 0) <= 1
	);
}

/**
 * Merge a fresh probe list over the passive baseline (keyed by URL).
 * - fresh healthy            → keep fresh (current latency)
 * - fresh transient miss AND passive healthy → keep the passive (healthy, last-known latency)
 * - otherwise                → keep fresh (genuine problem: sustained, or a non-transient reason)
 */
export function mergeFreshOverPassive(
	fresh: readonly RpcEndpointHealth[],
	passiveByUrl: ReadonlyMap<string, RpcEndpointHealth>
): RpcEndpointHealth[] {
	return fresh.map((f) => {
		if (f.healthy) return f;
		if (isTransientMiss(f)) {
			const p = passiveByUrl.get(f.url);
			if (p && p.healthy) return { ...p };
		}
		return f;
	});
}

/** Build the URL→health lookup from a passive snapshot. */
export function passiveIndex(
	passive: readonly RpcEndpointHealth[]
): Map<string, RpcEndpointHealth> {
	return new Map(passive.map((e) => [e.url, e]));
}
