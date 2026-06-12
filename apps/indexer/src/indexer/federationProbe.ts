/**
 * Morphit indexer — federation probe scheduler (Phase D.5).
 *
 * Drives the live status of the federation directory:
 *
 *   - Every tick, picks instances due for probing from
 *     `known_instances` based on their last_probe_status and
 *     last_probed_at.
 *   - For each probe-due instance, fires three HTTP fetches:
 *       GET /v1/instance       — branding + relay_account
 *       GET /v1/health         — status + indexed_block + lag
 *       GET /v1/orderbook?limit=1   — recent activity sample
 *   - Computes goodness from the three responses; persists.
 *   - Backs off on failure; drops after 7 consecutive failure days.
 *
 * Goodness criteria — all must hold for status='good':
 *   1. /v1/health returns status: 'ok' (not 'degraded')
 *   2. /v1/instance.relay_account == operator_account from chain
 *   3. chain_lag_sec < 90 (≈30 blocks)
 *   4. /v1/orderbook has ≥1 order in last 7 days, OR the instance
 *      is <7 days old (grace period for new operators)
 *
 * If 1-3 hold but 4 fails, status='quiet' — still listed in the
 * directory, but flagged so users can pick a busier instance.
 *
 * Privacy note (deferred to Phase F+): probes go out from this
 * indexer's IP address.  Aggregate cross-instance traffic is
 * inherent to federation discovery.  Tor-routing the probes is
 * possible but not v1 scope.
 */

import type pg from 'pg';

import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent } from 'undici';

import type { Database } from '$db/pool';
import { logger } from '$log';

const log = logger('federation-probe');

/** Goodness threshold values. */
const MAX_HEALTH_AGE_MS = 60 * 60 * 1000; // 1h — health response considered fresh
const MAX_CHAIN_LAG_SEC = 90; // ~30 blocks at 3s/block

/** Decide a self-reachable instance's status from its own chain lag.
 *  We can't network-probe ourselves (hairpin NAT), but the indexer
 *  knows its own lag directly: report 'syncing' while still catching up
 *  (lag over the same threshold a peer probe uses), 'good' once current.
 *  A null lag (poller not yet running / head unknown) is treated as
 *  'good' — the pre-syncing behaviour. */
export function selfReachableStatus(lagBlocks: number | null): ProbeStatus {
	return lagBlocks !== null && lagBlocks * 3 > MAX_CHAIN_LAG_SEC ? 'syncing' : 'good';
}
const ORDERBOOK_ACTIVITY_GRACE_DAYS = 7; // newer instances exempt
const FAILURE_DROP_DAYS = 7; // drop row after 7d of consecutive failures
/** Probe schedule, by current status.  Picks the longest interval
 *  applicable; "never" gets 0 to probe ASAP. */
const PROBE_INTERVAL_MS = {
	never: 0,
	good: 10 * 60 * 1000,
	quiet: 10 * 60 * 1000,
	syncing: 10 * 60 * 1000,
	stale: 60 * 60 * 1000,
	unreachable: 60 * 60 * 1000,
	mismatch: 60 * 60 * 1000
} as const;
/** HTTP timeout per fetch.  Three fetches per probe → 15s worst-case. */
const FETCH_TIMEOUT_MS = 5_000;
/** Bounded concurrency for the probe pool.  Caps memory + outbound
 *  socket count.  Operators in dense federations can raise via env. */
const DEFAULT_CONCURRENCY = 10;
/** Cap on the number of instances we'll track at all.  Beyond this,
 *  the indexer skips populating new known_instances rows and emits
 *  a warning.  Won't matter for years; sized for "small federation". */
const MAX_TRACKED_INSTANCES = 200;

export type ProbeStatus =
	| 'never'
	| 'good'
	| 'quiet'
	| 'syncing'
	| 'stale'
	| 'unreachable'
	| 'mismatch';

export interface FederationProbeConfig {
	readonly intervalMs: number; // how often the scheduler ticks
	readonly concurrency?: number;
	/** This instance's own public origin. The scheduler never fires a
	 *  network probe at its own origin — a box reaching its own public
	 *  URL requires hairpin NAT / loopback that many deployments lack,
	 *  so a self-probe spuriously reports 'unreachable'. When set, the
	 *  matching directory row is marked reachable locally instead. */
	readonly selfOrigin?: string;
	/** Our own chain lag in blocks, read directly from the local poller
	 *  (not over HTTP).  Lets the self-reachable path report 'syncing'
	 *  while we're still catching up, instead of a misleading 'good'.
	 *  Returns null when unknown (poller not yet running). */
	readonly localLagBlocks?: () => number | null;
}

/** Normalize an origin for self-comparison: trim, drop any trailing
 *  slash(es), lowercase. `https://Morphit.IO/` and `https://morphit.io`
 *  must compare equal. */
function normalizeOrigin(origin: string): string {
	return origin.trim().replace(/\/+$/, '').toLowerCase();
}

export interface KnownInstanceRow {
	origin: string;
	operator_account: string;
	registered_at_time: Date;
	last_probed_at: Date | null;
	last_probe_status: string | null;
	consecutive_failures: number;
}

export interface ProbeOutcome {
	status: ProbeStatus;
	error: string | null;
	cachedName: string | null;
	cachedTagline: string | null;
	cachedContactUrl: string | null;
	cachedAltNetworks: unknown | null;
	cachedIndexedBlock: number | null;
	cachedChainLagSec: number | null;
}

export class FederationProbeScheduler {
	private lastScanAt = 0;
	private inFlight = false;
	private readonly concurrency: number;

	constructor(
		private readonly db: Database,
		private readonly config: FederationProbeConfig
	) {
		this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
	}

	/** Tick entry point; safe to call every poller tick. */
	async maybeScan(): Promise<void> {
		const now = Date.now();
		if (now - this.lastScanAt < this.config.intervalMs) return;
		if (this.inFlight) return; // previous tick still working
		this.lastScanAt = now;
		this.inFlight = true;
		try {
			await this.scanOnce();
		} catch (err) {
			log.error('scan_unexpected_error', {}, err);
		} finally {
			this.inFlight = false;
		}
	}

	/** One full pass: pick due instances, probe in parallel pools,
	 *  drop dead ones. */
	async scanOnce(): Promise<{ probed: number; dropped: number }> {
		// Step 1: drop instances dead for too long.
		const dropped = await this.dropFailedInstances();

		// Step 2: pick instances due for probing.
		const due = await this.pickDueInstances();
		if (due.length === 0) return { probed: 0, dropped };

		// Step 3: probe with bounded concurrency.
		await this.probePool(due);
		return { probed: due.length, dropped };
	}

	private async dropFailedInstances(): Promise<number> {
		// 7 days of consecutive failures, at the 1-hour failure
		// interval, = 168 probe attempts.  The earlier age-based
		// query (`last_probed_at < NOW() - 7 days`) was buggy: every
		// failed probe bumps last_probed_at to NOW(), so the age
		// clause was never true and rows accumulated forever.
		// (F-27 audit fix.)
		const failureCountThreshold =
			(FAILURE_DROP_DAYS * 24 * 60 * 60 * 1000) / PROBE_INTERVAL_MS.unreachable;
		const result = await this.db.query<{ origin: string }>(
			`DELETE FROM known_instances
			 WHERE consecutive_failures >= $1
			 RETURNING origin`,
			[failureCountThreshold]
		);
		if (result.rowCount && result.rowCount > 0) {
			log.info('dropped_dead_instances', {
				count: result.rowCount,
				origins: result.rows.map((r) => r.origin)
			});
		}
		return result.rowCount ?? 0;
	}

	private async pickDueInstances(): Promise<readonly KnownInstanceRow[]> {
		// Probe-due query: rows where the time-since-last-probe exceeds
		// the per-status interval.  We compute the per-status threshold
		// in SQL via CASE for a single round-trip.
		const goodMs = PROBE_INTERVAL_MS.good;
		const failMs = PROBE_INTERVAL_MS.unreachable;
		const result = await this.db.query<KnownInstanceRow>(
			`SELECT origin, operator_account, registered_at_time,
			        last_probed_at, last_probe_status, consecutive_failures
			 FROM known_instances
			 WHERE last_probe_status = 'never'
			    OR last_probed_at IS NULL
			    OR (
			        last_probe_status IN ('good', 'quiet', 'syncing')
			        AND last_probed_at < NOW() - INTERVAL '${Math.floor(goodMs / 1000)} seconds'
			    )
			    OR (
			        last_probe_status IN ('stale', 'unreachable', 'mismatch')
			        AND last_probed_at < NOW() - INTERVAL '${Math.floor(failMs / 1000)} seconds'
			    )
			 ORDER BY last_probed_at NULLS FIRST
			 LIMIT ${MAX_TRACKED_INSTANCES}`,
			[]
		);
		return result.rows;
	}

	private async probePool(instances: readonly KnownInstanceRow[]): Promise<void> {
		// Simple promise-pool: walks an index, each worker pulls the
		// next index until exhausted.  No external dep; fits the
		// "few hundred instances" scale.
		let cursor = 0;
		const workers: Promise<void>[] = [];
		const next = async (): Promise<void> => {
			while (cursor < instances.length) {
				const i = cursor++;
				const inst = instances[i];
				if (inst === undefined) return;
				// Self-origin: never probe our own public URL over the
				// network (fragile — needs hairpin NAT/loopback). We are
				// demonstrably up (we're the one running this probe), so
				// mark the directory row reachable locally instead.
				if (
					this.config.selfOrigin !== undefined &&
					normalizeOrigin(inst.origin) === normalizeOrigin(this.config.selfOrigin)
				) {
					try {
						await this.persistSelfReachable(inst);
					} catch (err) {
						log.error('self_persist_threw', { origin: inst.origin }, err);
					}
					continue;
				}
				try {
					const outcome = await probeOne(inst);
					await this.persistOutcome(inst, outcome);
				} catch (err) {
					// Defensive: probeOne should never throw, but if it
					// does we don't want to skip persisting *something*.
					log.error('probe_threw', { origin: inst.origin }, err);
					await this.persistOutcome(inst, {
						status: 'unreachable',
						error: err instanceof Error ? err.message : String(err),
						cachedName: null,
						cachedTagline: null,
						cachedContactUrl: null,
						cachedAltNetworks: null,
						cachedIndexedBlock: null,
						cachedChainLagSec: null
					});
				}
			}
		};
		for (let w = 0; w < Math.min(this.concurrency, instances.length); w++) {
			workers.push(next());
		}
		await Promise.all(workers);
	}

	private async persistOutcome(inst: KnownInstanceRow, outcome: ProbeOutcome): Promise<void> {
		const isSuccess =
			outcome.status === 'good' || outcome.status === 'quiet' || outcome.status === 'syncing';
		// On success: store cached snapshot, reset failure counter.
		// On failure: leave cached_* untouched (last successful values
		// stay visible in the directory until probe recovers), increment
		// failure counter.
		if (isSuccess) {
			await this.db.query(
				`UPDATE known_instances SET
					last_probed_at = NOW(),
					last_probe_status = $2,
					last_probe_error = NULL,
					cached_name = $3,
					cached_tagline = $4,
					cached_contact_url = $5,
					cached_alt_networks = $6,
					cached_indexed_block = $7,
					cached_chain_lag_sec = $8,
					consecutive_failures = 0
				 WHERE origin = $1`,
				[
					inst.origin,
					outcome.status,
					outcome.cachedName,
					outcome.cachedTagline,
					outcome.cachedContactUrl,
					outcome.cachedAltNetworks,
					outcome.cachedIndexedBlock,
					outcome.cachedChainLagSec
				]
			);
		} else {
			await this.db.query(
				`UPDATE known_instances SET
					last_probed_at = NOW(),
					last_probe_status = $2,
					last_probe_error = $3,
					consecutive_failures = consecutive_failures + 1
				 WHERE origin = $1`,
				[inst.origin, outcome.status, outcome.error]
			);
		}
	}

	/** Self-instance reachability: the indexer IS this origin, so a
	 *  network probe is unnecessary and unreliable. Flip status to
	 *  'good' and clear the failure counter, but DO NOT touch the
	 *  cached_* snapshot — the directory keeps showing the instance's
	 *  name/tagline/contact from its last real refresh. */
	private async persistSelfReachable(inst: KnownInstanceRow): Promise<void> {
		// We can't network-probe our own public URL (hairpin-NAT fragile),
		// but we ARE the indexer — so we know our own chain lag directly.
		// Report 'syncing' while we're still catching up (same lag
		// threshold a peer probe uses), 'good' once current.  This is why
		// our own directory row no longer sits at a misleading 'good'
		// during initial sync — it shows 'syncing' until caught up.
		const lagBlocks = this.config.localLagBlocks?.() ?? null;
		const selfStatus: ProbeStatus = selfReachableStatus(lagBlocks);
		await this.db.query(
			`UPDATE known_instances SET
				last_probed_at = NOW(),
				last_probe_status = $2,
				last_probe_error = NULL,
				consecutive_failures = 0
			 WHERE origin = $1`,
			[inst.origin, selfStatus]
		);
	}
}

// ─── Single-instance probe ───────────────────────────────────────

/** Probe one instance.  Always resolves with a ProbeOutcome; never
 *  throws (errors caught and converted to status='unreachable'). */
export async function probeOne(inst: KnownInstanceRow): Promise<ProbeOutcome> {
	const { origin, operator_account, registered_at_time } = inst;

	// Fetch /v1/instance.
	let instanceData: InstanceShape;
	try {
		instanceData = await fetchJson<InstanceShape>(`${origin}/v1/instance`);
	} catch (err) {
		return mkUnreachable(`instance_fetch: ${errMsg(err)}`);
	}
	if (!isInstanceShape(instanceData)) {
		return mkMismatch('instance_response_malformed');
	}
	if (instanceData.relay_account !== operator_account) {
		return mkMismatch(
			`relay_account mismatch: chain=${operator_account} instance=${instanceData.relay_account}`
		);
	}

	// Fetch /v1/health.
	let healthData: HealthShape;
	try {
		healthData = await fetchJson<HealthShape>(`${origin}/v1/health`);
	} catch (err) {
		return mkUnreachable(`health_fetch: ${errMsg(err)}`);
	}
	if (!isHealthShape(healthData)) {
		return mkStale('health_response_malformed');
	}
	if (healthData.status !== 'ok') {
		return mkStale(`health_status: ${healthData.status}`);
	}

	// Compute chain_lag_sec.  /v1/health doesn't return this directly;
	// we approximate from lag_blocks (3s per block on Blurt).
	const chainLagSec = healthData.lag_blocks * 3;
	if (chainLagSec > MAX_CHAIN_LAG_SEC) {
		// Reachable and /v1/health is 'ok' — it's just behind, i.e. catching
		// up (initial sync or a brief fall-behind), not broken.  'stale' is
		// reserved for degraded/malformed health (an actual problem).
		return mkSyncing(instanceData, healthData, chainLagSec);
	}

	// Fetch /v1/orderbook?limit=1 — recent-activity check.
	let orderbookData: OrderbookShape;
	try {
		orderbookData = await fetchJson<OrderbookShape>(`${origin}/v1/orderbook?limit=1`);
	} catch (err) {
		// Non-fatal — if the orderbook endpoint is missing or errors,
		// the instance is still usable for messaging.  Treat as quiet.
		return mkQuiet(instanceData, healthData, chainLagSec);
	}
	const hasRecentActivity =
		isOrderbookShape(orderbookData) &&
		orderbookData.orders.length > 0 &&
		isWithinDays(orderbookData.orders[0]?.created_at, ORDERBOOK_ACTIVITY_GRACE_DAYS);

	if (hasRecentActivity) {
		return mkGood(instanceData, healthData, chainLagSec);
	}

	// New-instance grace period: <7 days old → still good.
	const ageMs = Date.now() - registered_at_time.getTime();
	const isNewInstance = ageMs < ORDERBOOK_ACTIVITY_GRACE_DAYS * 24 * 60 * 60 * 1000;
	if (isNewInstance) {
		return mkGood(instanceData, healthData, chainLagSec);
	}

	// Old instance, no recent activity → quiet.
	return mkQuiet(instanceData, healthData, chainLagSec);
}

// ─── Helpers ─────────────────────────────────────────────────────

interface InstanceShape {
	name: string | null;
	tagline: string | null;
	contact_url: string | null;
	alt_networks: {
		tor: string | null;
		lokinet: string | null;
		// New fields (post-2026-05).  Either may be absent on a
		// remote instance running an older release.
		i2p_b32?: string | null;
		i2p_name?: string | null;
		// Legacy single field (pre-2026-05).  We accept it on the
		// wire, but persist normalized into i2p_b32 / i2p_name
		// based on suffix so future reads are uniform.
		i2p?: string | null;
		nostr: string | null;
	};
	relay_account: string;
}

interface HealthShape {
	status: 'ok' | 'degraded';
	indexed_block: number;
	lag_blocks: number;
}

interface OrderbookShape {
	orders: Array<{ created_at?: string }>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInstanceShape(v: unknown): v is InstanceShape {
	if (!isPlainObject(v)) return false;
	if (typeof v.relay_account !== 'string') return false;
	if (!isPlainObject(v.alt_networks)) return false;
	return true;
}

function isHealthShape(v: unknown): v is HealthShape {
	if (!isPlainObject(v)) return false;
	if (v.status !== 'ok' && v.status !== 'degraded') return false;
	if (typeof v.lag_blocks !== 'number') return false;
	if (typeof v.indexed_block !== 'number') return false;
	return true;
}

function isOrderbookShape(v: unknown): v is OrderbookShape {
	return isPlainObject(v) && Array.isArray(v.orders);
}

function isWithinDays(iso: string | undefined, days: number): boolean {
	if (iso === undefined) return false;
	const t = Date.parse(iso);
	if (isNaN(t)) return false;
	return Date.now() - t < days * 24 * 60 * 60 * 1000;
}

import { isPrivateHostname, isPrivateIp } from '@morphit/net-defense';

/**
 * Check whether a hostname string (as it appears in a URL) is
 * one of the obviously-private literal forms.
 *
 * cp154 — implementation lifted to `@morphit/net-defense` so the
 * MCP server can consume the same primitive.  This module
 * re-exports it under the original name to keep existing
 * indexer call sites and smoke imports working.
 *
 * Exported for testing.  Used by fetchJson() before any DNS work.
 */
export { isPrivateHostname };

/**
 * Check whether a *resolved IP address* (as returned by DNS lookup,
 * canonical form — not user-supplied) is in a private range.
 *
 * cp154 — implementation lifted to `@morphit/net-defense`.  See
 * the re-export note above.
 *
 * Exported for testing.  Cp3 of Part 122 — DNS-rebinding closure.
 */
export { isPrivateIp };

/**
 * Resolve `hostname` via DNS, validate EVERY returned address
 * against isPrivateIp(), and return the first valid (public)
 * record.  Throws if any resolved IP is private — the closes
 * the DNS-rebinding gap from cp7 REVISIT §A.
 *
 * Why "every record must be public" rather than "at least one":
 * an attacker controlling DNS can return [203.0.113.1, 127.0.0.1].
 * If we connect to the first, we hit the public IP — fine.  But
 * subsequent reconnects, retries, or a different load-balancer
 * selection could pick the private one.  By requiring ALL records
 * to be public, we ensure no fork of the connection can land on
 * an internal address.
 *
 * Cp3 of Part 122 — DNS-rebinding closure.
 */
async function resolveAndValidatePublicIp(hostname: string): Promise<{
	address: string;
	family: 4 | 6;
}> {
	let records: Array<{ address: string; family: number }>;
	try {
		records = await dnsLookup(hostname, { all: true, verbatim: true });
	} catch (err) {
		throw new Error(
			`fetchJson: DNS lookup failed for ${hostname}: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
	}
	if (records.length === 0) {
		throw new Error(`fetchJson: hostname ${hostname} has no DNS records`);
	}
	for (const r of records) {
		if (isPrivateIp(r.address)) {
			throw new Error(
				`fetchJson: refusing to probe ${hostname} — resolves to private IP ${r.address}`
			);
		}
	}
	const first = records[0]!;
	const family: 4 | 6 = first.family === 6 ? 6 : 4;
	return { address: first.address, family };
}

/**
 * Test-only hook for injecting a stub resolver.  Production code
 * MUST NOT set this; it's `null` at runtime in normal operation.
 * Smokes that stub `globalThis.fetch` also stub this so the test
 * is offline-deterministic.
 */
let _dnsResolverForTesting: typeof resolveAndValidatePublicIp | null = null;
export function _setDnsResolverForTesting(
	resolver: typeof resolveAndValidatePublicIp | null
): void {
	_dnsResolverForTesting = resolver;
}

/**
 * Build an undici Agent whose connect-time DNS lookup returns
 * `pinnedIp` for `expectedHostname` and refuses any other
 * hostname.  This closes the TOCTOU between our pre-validation
 * lookup and undici's connect-time lookup — the connection
 * cannot land on an IP we didn't pre-validate.
 *
 * SNI + cert validation continue to use `expectedHostname`
 * (undici derives them from the URL, not from `lookup`).
 * Host header similarly uses the URL hostname for vhost routing.
 *
 * Cp3 of Part 122 — DNS-rebinding closure.
 */
function buildPinnedAgent(
	expectedHostname: string,
	pinnedIp: string,
	pinnedFamily: 4 | 6
): Agent {
	return new Agent({
		connect: {
			lookup: (
				hostname: string,
				_opts: unknown,
				cb: (err: Error | null, address: string, family: number) => void
			): void => {
				// Defensive: if undici ever calls lookup with a
				// different hostname than the one we pre-validated
				// (e.g. due to a redirect or a future API change),
				// fail closed.  redirect:'manual' should already
				// prevent this, but defense-in-depth.
				if (hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
					cb(
						new Error(
							`pinned agent: refusing unexpected hostname ${hostname} (pinned to ${expectedHostname})`
						),
						'',
						0
					);
					return;
				}
				cb(null, pinnedIp, pinnedFamily);
			}
		}
	});
}

/**
 * Public-only-host JSON fetch with full SSRF defense.
 *
 * Six layers of defense:
 *   1. HTTPS protocol enforcement
 *   2. Literal-hostname denylist (isPrivateHostname)
 *   3. DNS resolution + EVERY record validated public
 *      (resolveAndValidatePublicIp — Cp3 DNS-rebinding closure)
 *   4. IP-pinned undici dispatcher (TOCTOU defense)
 *   5. redirect: 'manual' (no following 30x to internal URLs)
 *   6. Body cap with streaming abort (MAX_BYTES = 256KB)
 *
 * Used by:
 *   - federationProbe probe loop (canonical caller)
 *   - peerPriceMonitor's per-peer receipt fetch (cp139-F-2 fix)
 *
 * Exported for use by other indexer subsystems that fetch from
 * peer instances stored in known_instances.  Any new fetch site
 * that accepts a peer-supplied origin URL MUST route through this
 * helper rather than calling fetch() directly.
 */
export async function fetchJson<T>(url: string): Promise<T> {
	// Audit 2026-05 finding 5-5: defense-in-depth re-validation
	// of the origin host before firing.  Even if a malicious
	// origin slipped past registration (older row, manual DB
	// insert, future regex-bypass via Unicode tricks), we reject
	// at the request-time layer so the indexer's own network
	// can't be probed.
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error('fetchJson: malformed url');
	}
	if (parsed.protocol !== 'https:') {
		throw new Error('fetchJson: non-https origin');
	}
	const hostname = parsed.hostname.toLowerCase();
	// First defense: literal-hostname denylist (catches obvious
	// `https://localhost/`, `https://127.0.0.1/`, etc.).
	if (isPrivateHostname(hostname)) {
		throw new Error('fetchJson: refusing to probe non-public host');
	}
	// Second defense (Part 122 cp3 — DNS-rebinding closure):
	// Resolve the hostname BEFORE fetch, validate every returned
	// IP, and pin the resolved IP via a custom undici dispatcher
	// so the connection can't land on a different IP than the
	// one we validated.
	const resolver = _dnsResolverForTesting ?? resolveAndValidatePublicIp;
	const { address: pinnedIp, family: pinnedFamily } = await resolver(hostname);
	const pinnedAgent = buildPinnedAgent(hostname, pinnedIp, pinnedFamily);

	const ctrl = new AbortController();
	const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(url, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				'user-agent': 'morphit-indexer/federation-probe'
			},
			signal: ctrl.signal,
			redirect: 'manual', // Audit 2026-05 finding 5-6: don't follow redirects
			// Part 122 cp3 — pin the resolved IP at the connect layer.
			// Without this, undici would do its own DNS lookup which
			// could return a different (private) IP than what we
			// pre-validated.
			// @ts-expect-error — `dispatcher` is a node-fetch undici extension
			// that isn't in the standard fetch signature but is supported by
			// Node's bundled undici-based fetch.
			dispatcher: pinnedAgent
		});
		if (!resp.ok) {
			throw new Error(`HTTP ${resp.status}`);
		}
		// Audit 2026-05 finding NEW-9-11: cap response body size so a
		// hostile registered instance can't waste arbitrary bytes/CPU
		// per probe by returning a multi-GB response.  Two layers:
		// (1) check Content-Length header if present, reject early.
		// (2) stream the body and abort once we've accumulated more
		//     than the cap, in case Content-Length is missing or
		//     misreported.  Legitimate Morphit responses are well
		//     under 64KB; 256KB is comfortably above that and
		//     comfortably below pathological.
		const MAX_BYTES = 256 * 1024;
		const contentLength = resp.headers.get('content-length');
		if (contentLength !== null) {
			const declared = parseInt(contentLength, 10);
			if (Number.isFinite(declared) && declared > MAX_BYTES) {
				throw new Error(
					`fetchJson: response too large (declared ${declared} bytes, cap ${MAX_BYTES})`
				);
			}
		}
		const body = resp.body;
		if (body === null) {
			throw new Error('fetchJson: empty response body');
		}
		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value === undefined) continue;
				total += value.byteLength;
				if (total > MAX_BYTES) {
					ctrl.abort();
					throw new Error(`fetchJson: response exceeded cap (${total} bytes > ${MAX_BYTES})`);
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const buf = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			buf.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const text = new TextDecoder('utf-8').decode(buf);
		return JSON.parse(text) as T;
	} finally {
		clearTimeout(timeout);
	}
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Normalize the alt_networks blob from a probed instance into the
 *  post-2026-05 shape (i2p_b32 + i2p_name, no legacy `i2p`).  Stored
 *  in cached_alt_networks; the directory's row→entry shim
 *  (instancesStreamHelpers.normalizeAltNetworks) ALSO normalizes
 *  on read, so older cache rows still deliver the right shape until
 *  they get re-cached on the next successful probe.  Doing it on
 *  WRITE means cache rows go cold faster — once an instance has
 *  been re-probed, all callers see the new shape. */
function normalizeAltNetworksForCache(an: InstanceShape['alt_networks']): {
	tor: string | null;
	lokinet: string | null;
	i2p_b32: string | null;
	i2p_name: string | null;
	nostr: string | null;
} {
	let i2pB32 = an.i2p_b32 ?? null;
	let i2pName = an.i2p_name ?? null;
	const legacy = an.i2p ?? null;
	if (legacy !== null && i2pB32 === null && i2pName === null) {
		if (legacy.toLowerCase().endsWith('.b32.i2p')) {
			i2pB32 = legacy;
		} else if (legacy.toLowerCase().endsWith('.i2p')) {
			i2pName = legacy;
		}
	}
	return {
		tor: an.tor,
		lokinet: an.lokinet,
		i2p_b32: i2pB32,
		i2p_name: i2pName,
		nostr: an.nostr
	};
}

function mkGood(inst: InstanceShape, health: HealthShape, chainLagSec: number): ProbeOutcome {
	return {
		status: 'good',
		error: null,
		cachedName: inst.name,
		cachedTagline: inst.tagline,
		cachedContactUrl: inst.contact_url,
		cachedAltNetworks: normalizeAltNetworksForCache(inst.alt_networks),
		cachedIndexedBlock: health.indexed_block,
		cachedChainLagSec: chainLagSec
	};
}

function mkQuiet(inst: InstanceShape, health: HealthShape, chainLagSec: number): ProbeOutcome {
	return {
		status: 'quiet',
		error: null,
		cachedName: inst.name,
		cachedTagline: inst.tagline,
		cachedContactUrl: inst.contact_url,
		cachedAltNetworks: normalizeAltNetworksForCache(inst.alt_networks),
		cachedIndexedBlock: health.indexed_block,
		cachedChainLagSec: chainLagSec
	};
}

/** Reachable, valid, and /v1/health is 'ok' — but the chain lag exceeds
 *  the freshness threshold.  The instance is up and serving; it's just
 *  catching up.  Distinct from 'stale' (degraded health / a real
 *  problem) and 'unreachable' (HTTP failed).  Caches the snapshot like a
 *  healthy probe since the instance data is valid. */
function mkSyncing(inst: InstanceShape, health: HealthShape, chainLagSec: number): ProbeOutcome {
	return {
		status: 'syncing',
		error: null,
		cachedName: inst.name,
		cachedTagline: inst.tagline,
		cachedContactUrl: inst.contact_url,
		cachedAltNetworks: normalizeAltNetworksForCache(inst.alt_networks),
		cachedIndexedBlock: health.indexed_block,
		cachedChainLagSec: chainLagSec
	};
}

function mkStale(reason: string): ProbeOutcome {
	return {
		status: 'stale',
		error: reason,
		cachedName: null,
		cachedTagline: null,
		cachedContactUrl: null,
		cachedAltNetworks: null,
		cachedIndexedBlock: null,
		cachedChainLagSec: null
	};
}

function mkUnreachable(reason: string): ProbeOutcome {
	return {
		status: 'unreachable',
		error: reason,
		cachedName: null,
		cachedTagline: null,
		cachedContactUrl: null,
		cachedAltNetworks: null,
		cachedIndexedBlock: null,
		cachedChainLagSec: null
	};
}

function mkMismatch(reason: string): ProbeOutcome {
	return {
		status: 'mismatch',
		error: reason,
		cachedName: null,
		cachedTagline: null,
		cachedContactUrl: null,
		cachedAltNetworks: null,
		cachedIndexedBlock: null,
		cachedChainLagSec: null
	};
}

void MAX_HEALTH_AGE_MS; // currently unused (we re-fetch every probe);
//  reserved for a future "trust last successful
//  fetch up to 1h" optimization.
