/**
 * operationalHealth — cp667.
 *
 * A small, CACHED snapshot of host-operational facts the indexer folds into the
 * PUBLIC /v1/health body so an operator (or a peer) can poll one URL and see, at
 * a glance, three things the bare indexer status never showed:
 *
 *   - ipfs_seeding — is this node doing its share of hosting the signed release
 *     on IPFS and rebroadcasting the ipns:// record? (Decentralization #2.)
 *   - system       — CPU / memory / disk usage on the box.
 *   - relay        — is the (optional) relay reachable?
 *
 * WHY CACHED. /v1/health is a HOT endpoint — federation peers probe it on a
 * cadence. Sampling CPU, shelling out to `systemctl` three times, and HTTP-
 * probing the relay on EVERY request would be wasteful and could stall the event
 * loop. Instead we keep a module-level snapshot and refresh it at most once per
 * TTL, STALE-WHILE-REVALIDATE: the handler reads the cached value synchronously
 * and never awaits; when the value is older than the TTL it kicks off ONE async
 * refresh in the background (guarded so concurrent probes don't stampede) and
 * serves the current value meanwhile. The first probe sees nulls until the first
 * refresh lands (we also prime one refresh at route setup).
 *
 * The CPU figure is a busy-fraction diffed between successive refreshes (no
 * blocking sleep): the first refresh only records a baseline (cpu_pct null), the
 * next reports the average over the interval since.
 *
 * NOTE on containerization: on the standard bare-metal systemd install the
 * indexer runs on the host, so /proc + statfs + systemctl reflect the host. In a
 * containerized indexer these read the container's view (or systemctl is absent
 * → seeding 'unknown'); every field degrades to null / 'unknown' rather than
 * lying or throwing.
 *
 * The pure seeding decision here MIRRORS ops-cli's checkIpfsSeeding; the two
 * should be unified into a shared package (see docs/REVISIT-LIST.md).
 */

import { cpus, totalmem, freemem, networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { Agent } from 'undici';

// cp772 — a dedicated DIRECT dispatcher used ONLY for the local relay health
// probe, so it bypasses the global hidden-service routing dispatcher the indexer
// installs (Tor/I2P for chain reads). The relay is always a local service; its
// probe must connect directly, never through the routing layer.
const directRelayDispatcher = new Agent();

import {
	classifySeeding,
	resolveHealthDiskPath,
	type SeedingState as SharedSeedingState,
	type SeedingProblem
} from '@morphit/node-health';

// Re-export the shared type under the local name so the rest of the
// indexer keeps importing `SeedingState` from here unchanged (cp707).
export type SeedingState = SharedSeedingState;

export interface SystemBlock {
	cpu_pct: number | null;
	mem_pct: number | null;
	mem_used_gb: number | null;
	mem_total_gb: number | null;
	disk_pct: number | null;
	disk_used_gb: number | null;
	disk_total_gb: number | null;
	disk_avail_gb: number | null;
}

export interface OperationalSnapshot {
	ipfs_seeding: { state: SeedingState; detail: string };
	system: SystemBlock;
	relay: { up: boolean };
}

export interface SeedingFacts {
	daemon: ServiceState;
	pinTimer: ServiceState;
	rebroadcastTimer: ServiceState;
	pinFailed: boolean;
	rebroadcastFailed: boolean;
}

type ServiceState = 'active' | 'inactive' | 'failed' | 'activating' | 'not-installed' | 'unknown';

const DEFAULT_SNAPSHOT: OperationalSnapshot = {
	ipfs_seeding: { state: 'unknown', detail: 'not sampled yet' },
	system: {
		cpu_pct: null,
		mem_pct: null,
		mem_used_gb: null,
		mem_total_gb: null,
		disk_pct: null,
		disk_used_gb: null,
		disk_total_gb: null,
		disk_avail_gb: null
	},
	relay: { up: false }
};

/** Render one degraded-problem kind into the indexer's terse public-endpoint
 *  wording, using this node's facts for the timer states. */
function idxProblemText(p: SeedingProblem, f: SeedingFacts): string {
	switch (p) {
		case 'pin-timer':
			return `pin timer ${f.pinTimer}`;
		case 'rebroadcast-timer':
			return `rebroadcast timer ${f.rebroadcastTimer}`;
		case 'pin-failed':
			return 'last pin failed';
		case 'rebroadcast-failed':
			return 'last rebroadcast failed';
	}
}

/** Decide whether this node is successfully seeding releases to IPFS/IPNS. PURE.
 *  The STATE decision is the shared classifier (@morphit/node-health) so the
 *  CLI health view and the public endpoint can never drift (cp707); only the
 *  terse public-endpoint DETAIL wording lives here. */
export function decideSeeding(f: SeedingFacts): { state: SeedingState; detail: string } {
	const cls = classifySeeding(f);
	switch (cls.reason) {
		case 'not-configured':
			return { state: 'not-configured', detail: 'IPFS release seeding not enabled on this node' };
		case 'unreadable':
			return { state: 'unknown', detail: 'could not read service state' };
		case 'daemon-down':
			return { state: 'down', detail: `ipfs daemon is ${f.daemon}; releases not being seeded` };
		case 'degraded':
			return { state: 'degraded', detail: cls.problems.map((p) => idxProblemText(p, f)).join('; ') };
		case 'ok':
			return { state: 'ok', detail: 'pinning the release + rebroadcasting the IPNS record' };
	}
}

// ── gather helpers (defensive: never throw) ──────────────────────

function bytesToGB(b: number): number {
	return Math.round((b / 1024 ** 3) * 10) / 10;
}
function clampPct(p: number): number {
	return Math.max(0, Math.min(100, Math.round(p)));
}

let prevCpu: { idle: number; total: number } | null = null;

function cpuTotals(): { idle: number; total: number } {
	let idle = 0;
	let total = 0;
	for (const c of cpus()) {
		const t = c.times;
		idle += t.idle;
		total += t.user + t.nice + t.sys + t.idle + t.irq;
	}
	return { idle, total };
}

/** CPU busy % over the interval since the previous sample. null on the first
 *  sample (baseline only) or if the counters didn't advance. */
function sampleCpuPct(): number | null {
	let now: { idle: number; total: number };
	try {
		now = cpuTotals();
	} catch {
		return null;
	}
	const prev = prevCpu;
	prevCpu = now;
	if (prev === null) return null;
	const dTotal = now.total - prev.total;
	const dIdle = now.idle - prev.idle;
	if (dTotal <= 0) return null;
	return clampPct((1 - dIdle / dTotal) * 100);
}

function sampleMem(): { pct: number | null; usedGB: number | null; totalGB: number | null } {
	try {
		let totalBytes: number;
		let availBytes: number;
		try {
			const txt = readFileSync('/proc/meminfo', 'utf8');
			const mt = txt.match(/^MemTotal:\s+(\d+)\s+kB/m);
			const ma = txt.match(/^MemAvailable:\s+(\d+)\s+kB/m);
			if (mt && ma) {
				totalBytes = Number(mt[1]) * 1024;
				availBytes = Number(ma[1]) * 1024;
			} else {
				totalBytes = totalmem();
				availBytes = freemem();
			}
		} catch {
			totalBytes = totalmem();
			availBytes = freemem();
		}
		const used = Math.max(0, totalBytes - availBytes);
		return {
			pct: totalBytes > 0 ? clampPct((used / totalBytes) * 100) : null,
			usedGB: bytesToGB(used),
			totalGB: bytesToGB(totalBytes)
		};
	} catch {
		return { pct: null, usedGB: null, totalGB: null };
	}
}

/** statfs the configured health disk path, falling back to `/` if that
 *  path can't be stat'd — a stray MORPHIT_HEALTH_DISK_PATH must never
 *  blank the disk figure (cp708). */
async function statfsHealthPath(): Promise<Awaited<ReturnType<typeof statfs>>> {
	const path = resolveHealthDiskPath(process.env);
	try {
		return await statfs(path);
	} catch {
		if (path === '/') throw new Error('statfs / failed');
		return await statfs('/');
	}
}

async function sampleDisk(): Promise<{
	pct: number | null;
	usedGB: number | null;
	totalGB: number | null;
	availGB: number | null;
}> {
	try {
		const st = await statfsHealthPath();
		const bsize = Number(st.bsize);
		const totalBytes = Number(st.blocks) * bsize;
		const availBytes = Number(st.bavail) * bsize;
		const freeBytes = Number(st.bfree) * bsize;
		const used = Math.max(0, totalBytes - freeBytes);
		// df-style: used relative to (used + available-to-non-root)
		const denom = used + availBytes;
		return {
			pct: denom > 0 ? clampPct((used / denom) * 100) : null,
			usedGB: bytesToGB(used),
			totalGB: bytesToGB(totalBytes),
			availGB: bytesToGB(availBytes)
		};
	} catch {
		return { pct: null, usedGB: null, totalGB: null, availGB: null };
	}
}

/** systemctl show a unit's ActiveState/LoadState, read-only. 'unknown' if
 *  systemctl is absent (e.g. a containerized indexer). */
function serviceState(unit: string): Promise<ServiceState> {
	return new Promise((resolve) => {
		execFile(
			'systemctl',
			['show', unit, '--property=ActiveState,LoadState', '--no-pager'],
			{ timeout: 2500 },
			(err, stdout) => {
				if (err && stdout === '') {
					resolve('unknown');
					return;
				}
				const load = /LoadState=(\S+)/.exec(stdout)?.[1];
				if (load === 'not-found' || load === 'masked') {
					resolve('not-installed');
					return;
				}
				const active = /ActiveState=(\S+)/.exec(stdout)?.[1];
				switch (active) {
					case 'active':
						resolve('active');
						break;
					case 'failed':
						resolve('failed');
						break;
					case 'activating':
					case 'reloading':
						resolve('activating');
						break;
					case 'inactive':
					case 'deactivating':
						resolve('inactive');
						break;
					default:
						resolve('unknown');
				}
			}
		);
	});
}

function serviceFailed(unit: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFile('systemctl', ['show', unit, '--property=Result', '--no-pager'], { timeout: 2500 }, (err, stdout) => {
			if (err && stdout === '') {
				resolve(false);
				return;
			}
			const result = /Result=(\S+)/.exec(stdout)?.[1] ?? 'success';
			resolve(result !== 'success');
		});
	});
}

async function probeRelay(url: string, timeoutMs: number): Promise<boolean> {
	if (url.length === 0) return false;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			headers: { accept: 'application/json', 'user-agent': 'morphit-indexer/operational-health-relay-probe' },
			// cp772 — the relay is a LOCAL service (loopback / host / docker bridge).
			// Its probe MUST go direct, never through the global hidden-service
			// routing dispatcher the indexer installs for chain reads over Tor/I2P:
			// that router breaks the local connection (proven in the field — a plain
			// fetch to the relay returns 200, the same fetch through the router
			// fails, which is why /v1/health read relay:up:false on a healthy relay).
			// A dedicated direct undici Agent bypasses the global dispatcher.
			dispatcher: directRelayDispatcher
		} as unknown as Parameters<typeof fetch>[1]);
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(t);
	}
}

/** Parse the IPv4 default gateway out of /proc/net/route text (or null). Pure —
 *  the file-reading wrapper is `defaultGatewayV4`. Exported for the regression
 *  smoke. */
export function parseDefaultGatewayV4(routeText: string): string | null {
	const lines = routeText.split('\n').slice(1);
	for (const line of lines) {
		const f = line.trim().split(/\s+/);
		// Destination 00000000 = the default route; Gateway (field 2) is a
		// little-endian hex IPv4. Skip a 0.0.0.0 gateway (no real next hop).
		if (f[1] === '00000000' && f[2] && f[2] !== '00000000' && /^[0-9A-Fa-f]{8}$/.test(f[2])) {
			const h = f[2];
			const octets = [h.slice(6, 8), h.slice(4, 6), h.slice(2, 4), h.slice(0, 2)].map((o) =>
				parseInt(o, 16)
			);
			return octets.join('.');
		}
	}
	return null;
}

/** The IPv4 default gateway from /proc/net/route (or null). When the indexer
 *  runs INSIDE a container, its default gateway IS the Docker bridge gateway —
 *  the very address the relay binds to (e.g. 172.18.0.1) so bridge peers can
 *  reach it. `networkInterfaces()` only yields the container's OWN addresses,
 *  never the gateway, so without this the containerized indexer never probes
 *  where the relay actually is and reports it falsely down — even though
 *  `morphit-ops health`, running on the HOST (where the gateway IS a local
 *  interface), sees it up. This closes that gap. */
function defaultGatewayV4(): string | null {
	try {
		return parseDefaultGatewayV4(readFileSync('/proc/net/route', 'utf8'));
	} catch {
		return null;
	}
}

/** Build the candidate relay-health URLs. The relay's up/down is measured with
 *  ZERO configuration: we always auto-probe the relay across every local address
 *  it could bind — loopback, each host IPv4 (which INCLUDES the docker bridge
 *  address like 172.18.0.1 that a container-fronted relay listens on), and the
 *  default gateway — at the relay's canonical health path. A configured
 *  MORPHIT_INDEXER_RELAY_HEALTH_URL is honoured verbatim in addition, but is not
 *  required. Pure — exported for the regression smoke. cp771. */
export function buildRelayCandidates(
	configured: string,
	ipv4Addrs: readonly string[],
	gateway: string | null
): string[] {
	const urls: string[] = [];
	// The relay itself always serves /v1/health on its own listen port (8080 by
	// default). We probe THAT locally, not whatever public path/port a reverse
	// proxy might expose — so a configured public URL never misdirects the local
	// probe.
	let localPort = '8080';
	if (configured) {
		urls.push(configured); // honour an explicit URL verbatim, first
		try {
			const u = new URL(configured);
			// Reuse the configured port for local probes ONLY if it's a real relay
			// port — a public 80/443 in front of a proxy is never where the relay
			// itself listens.
			if (u.port && u.port !== '80' && u.port !== '443') localPort = u.port;
		} catch {
			/* configured isn't a URL (e.g. empty) — auto-probe below still runs */
		}
	}
	// cp771 — ALWAYS auto-probe every local address, regardless of `configured`.
	// This is what makes relay up/down "just work": on a container-fronted host the
	// relay binds the docker bridge (172.18.0.1), which appears in ipv4Addrs; on a
	// bare-metal host it binds loopback. Both are covered with no config.
	for (const a of ipv4Addrs) urls.push(`http://${a}:${localPort}/v1/health`);
	if (gateway) urls.push(`http://${gateway}:${localPort}/v1/health`);
	urls.push(`http://127.0.0.1:${localPort}/v1/health`);
	return [...new Set(urls)];
}

/** Candidate relay-health URLs to try: the configured one first, then the same
 *  path on each of the host's own (non-loopback) IPv4 addresses, then the default
 *  gateway. On a CONTAINERIZED deploy the relay binds to the Docker bridge
 *  gateway (e.g. 172.18.0.1) so peers can reach it — NOT to 127.0.0.1 — so a
 *  loopback-only probe reports the relay down even though it's up. This mirrors
 *  the fallback `morphit-ops health` uses so /v1/health's relay.up agrees with
 *  the CLI instead of falsely reading down. */
function relayProbeCandidates(configured: string): string[] {
	const addrs: string[] = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const a of list ?? []) {
			if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
		}
	}
	return buildRelayCandidates(configured, addrs, defaultGatewayV4());
}

/** True if the relay answers on ANY candidate address. Probes run in parallel;
 *  the first success wins. Kept off the hot request path (background refresh).
 *  cp769 — no longer bails on an empty configured URL: loopback is always probed
 *  (relayProbeCandidates guarantees it), so an unset/empty RELAY_HEALTH_URL can't
 *  make a healthy local relay read down. */
async function probeRelayAny(configured: string, timeoutMs: number): Promise<boolean> {
	const results = await Promise.all(
		relayProbeCandidates(configured).map((u) => probeRelay(u, timeoutMs))
	);
	return results.some(Boolean);
}

// ── cached snapshot, stale-while-revalidate ──────────────────────

let cached: OperationalSnapshot = DEFAULT_SNAPSHOT;
let lastRefreshMs = 0;
let refreshing = false;
// cp766 — a wedge guard: if a refresh somehow never settles (e.g. a probe hangs
// past its own timeout), don't let `refreshing` block every future refresh
// forever — which would freeze /v1/health at its initial null/false/"not sampled
// yet" defaults. After this long an in-flight refresh is treated as abandoned.
let refreshStartedMs = 0;
const REFRESH_MAX_INFLIGHT_MS = 30_000;

function kickRefresh(relayHealthUrl: string, now: number): void {
	const inflightStuck = refreshing && now - refreshStartedMs > REFRESH_MAX_INFLIGHT_MS;
	if (refreshing && !inflightStuck) return;
	refreshing = true;
	refreshStartedMs = now;
	refresh(relayHealthUrl)
		.catch(() => {
			/* leave the previous snapshot in place */
		})
		.finally(() => {
			refreshing = false;
		});
}

/** Group the ipfs-seeding probes (systemctl reads) into one independently-
 *  failable block. */
async function sampleSeeding(): Promise<{ state: SeedingState; detail: string }> {
	const [daemon, pinTimer, rebroadcastTimer, pinFailed, rebroadcastFailed] = await Promise.all([
		serviceState('ipfs'),
		serviceState('morphit-ipfs-pin.timer'),
		serviceState('morphit-ipns-rebroadcast.timer'),
		serviceFailed('morphit-ipfs-pin.service'),
		serviceFailed('morphit-ipns-rebroadcast.service')
	]);
	return decideSeeding({ daemon, pinTimer, rebroadcastTimer, pinFailed, rebroadcastFailed });
}

/** Group the host-resource probes (disk + cpu + mem) into one block. */
async function sampleSystem(): Promise<SystemBlock> {
	const disk = await sampleDisk();
	const cpu = sampleCpuPct();
	const mem = sampleMem();
	return {
		cpu_pct: cpu,
		mem_pct: mem.pct,
		mem_used_gb: mem.usedGB,
		mem_total_gb: mem.totalGB,
		disk_pct: disk.pct,
		disk_used_gb: disk.usedGB,
		disk_total_gb: disk.totalGB,
		disk_avail_gb: disk.availGB
	};
}

/**
 * cp766 — merge a fresh (possibly PARTIAL) sample over the previous snapshot.
 * A block that failed this pass (null) keeps its PREVIOUS value rather than
 * reverting to the null/false default: one timed-out systemctl or relay probe
 * must never blank a health card that was populated a moment ago, and it must
 * never blank the OTHER cards. Pure — unit-tested by operational-health-smoke.
 */
export function mergeOperationalSnapshot(
	prev: OperationalSnapshot,
	next: {
		ipfs_seeding: { state: SeedingState; detail: string } | null;
		system: SystemBlock | null;
		relay: { up: boolean } | null;
	}
): OperationalSnapshot {
	return {
		ipfs_seeding: next.ipfs_seeding ?? prev.ipfs_seeding,
		system: next.system ?? prev.system,
		relay: next.relay ?? prev.relay
	};
}

async function refresh(relayHealthUrl: string): Promise<void> {
	// Each block is sampled INDEPENDENTLY (allSettled) so one failing probe can't
	// blank the others — the bug behind an all-null /v1/health that disagreed with
	// `morphit-ops health` (relay up + resources populated + IPFS seeding). The
	// 5000ms relay timeout matches the CLI's fetchHealth so a bridge-routed /
	// momentarily busy relay the CLI still sees up isn't read down here. This is
	// the background refresh, not the request path — a longer wait is free.
	const [ipfsRes, sysRes, relayRes] = await Promise.allSettled([
		sampleSeeding(),
		sampleSystem(),
		probeRelayAny(relayHealthUrl, 5000)
	]);
	cached = mergeOperationalSnapshot(cached, {
		ipfs_seeding: ipfsRes.status === 'fulfilled' ? ipfsRes.value : null,
		system: sysRes.status === 'fulfilled' ? sysRes.value : null,
		relay: relayRes.status === 'fulfilled' ? { up: relayRes.value } : null
	});
	lastRefreshMs = Date.now();
}

/** How long a cached snapshot is served before a background refresh is kicked
 *  off. Short enough to be current, long enough that a burst of federation
 *  probes doesn't re-sample per request. */
export const OPERATIONAL_TTL_MS = 15_000;

/** Return the cached operational snapshot synchronously. If it is older than the
 *  TTL, kick off ONE background refresh (stale-while-revalidate) and serve the
 *  current value meanwhile. Never throws, never awaits. */
export function getOperationalSnapshot(relayHealthUrl: string, now = Date.now()): OperationalSnapshot {
	if (now - lastRefreshMs > OPERATIONAL_TTL_MS) kickRefresh(relayHealthUrl, now);
	return cached;
}

/** Prime one refresh (call at route setup) so the first probe has data sooner.
 *  Best-effort; failures are swallowed. */
export function primeOperationalSnapshot(relayHealthUrl: string): void {
	kickRefresh(relayHealthUrl, Date.now());
}

/** Test seam: reset the module cache + cpu baseline. */
export function __resetOperationalForTest(): void {
	cached = DEFAULT_SNAPSHOT;
	lastRefreshMs = 0;
	refreshing = false;
	refreshStartedMs = 0;
	prevCpu = null;
}
