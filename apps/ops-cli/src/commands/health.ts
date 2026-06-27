/**
 * `morphit-ops health` (beta11 item 2) — live indexer health, via API.
 *
 * WHY THIS EXISTS, separate from the `status` dashboard.  The Status
 * dashboard (#10, status.ts) reads the operator config file and the
 * Postgres DB directly.  On a hardened deploy the install tree +
 * `morphit.config.env` are root-owned, so a `morphit`-user running
 * `morphit-ops status` hits EACCES before it can show anything (the
 * exact wall Ken's prod box hit).  This view instead asks the
 * indexer's OWN HTTP endpoint — `/v1/health` — which:
 *
 *   - needs NO config file and NO DB credentials (it's just an HTTP
 *     GET), so it works regardless of file permissions / which user
 *     you're running as;
 *   - returns the indexer's self-reported sync state in ~200 bytes:
 *     synced-or-behind, the last indexed block, the chain head, the
 *     lag between them, uptime, and how many Blurt RPC endpoints are
 *     currently reachable (the beta5 "is it the indexer or is it RPC?"
 *     question, answered at a glance).
 *
 * It is strictly READ-ONLY (one HTTP GET) and never touches the host.
 *
 * URL resolution (no file access — all from flags + process.env, so
 * it can't EACCES):
 *   1. `--url=<full URL>`                         (highest)
 *   2. `MORPHIT_OPS_HEALTH_URL` env  (full URL)
 *   3. `--host=` / `--port=` flags, else
 *      `MORPHIT_INDEXER_LISTEN_HOST` / `_LISTEN_PORT` env, else
 *      the canonical loopback default `127.0.0.1:8081`
 *   When a URL from (1)/(2) has no real path, `/v1/health` is appended,
 *   so `--url=http://127.0.0.1:8081` and `--url=https://morphit.io`
 *   both Just Work.
 */

import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultRepoRoot } from '../lib/repoRoot.ts';

export interface HealthCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

/** The indexer's default loopback HTTP bind (config.ts
 *  MORPHIT_INDEXER_LISTEN_HOST/_PORT defaults). */
export const DEFAULT_INDEXER_HOST = '127.0.0.1';
export const DEFAULT_INDEXER_PORT = '8081';

// ─── PURE helpers (unit-tested) ─────────────────────────────────────

/** If `raw` is a bare origin (no path, or just `/`), append the
 *  `/v1/health` path; otherwise leave the operator's path alone.
 *  Returns the original string if it can't be parsed as a URL (the
 *  caller surfaces the fetch error in that case).  PURE. */
export function ensureHealthPath(raw: string): string {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return raw;
	}
	if (u.pathname === '' || u.pathname === '/') {
		u.pathname = '/v1/health';
	}
	return u.toString();
}

/** Resolve the health endpoint URL from flags + env, with NO file
 *  access (so it can never EACCES on a root-owned config).  PURE. */
export function resolveHealthUrl(
	flags: Readonly<Record<string, string>>,
	env: Readonly<Record<string, string | undefined>>
): string {
	const explicit = flags.url ?? env.MORPHIT_OPS_HEALTH_URL;
	if (explicit !== undefined && explicit.trim() !== '') {
		return ensureHealthPath(explicit.trim());
	}
	const host =
		(flags.host ?? env.MORPHIT_INDEXER_LISTEN_HOST ?? DEFAULT_INDEXER_HOST).trim() ||
		DEFAULT_INDEXER_HOST;
	const port =
		(flags.port ?? env.MORPHIT_INDEXER_LISTEN_PORT ?? DEFAULT_INDEXER_PORT).trim() ||
		DEFAULT_INDEXER_PORT;
	return `http://${host}:${port}/v1/health`;
}

// ─── Relay + multi-target resolution (beta14) ───────────────────────

/** The relay's default loopback HTTP bind (apps/relay config
 *  MORPHIT_RELAY_LISTEN_HOST/_PORT defaults). */
export const DEFAULT_RELAY_PORT = '8080';

/** Resolve the relay's /v1/health URL from env (no flags — `--url` is
 *  indexer-scoped), with the same no-file-access guarantee.  PURE. */
export function resolveRelayHealthUrl(
	env: Readonly<Record<string, string | undefined>>
): string {
	const host =
		(env.MORPHIT_RELAY_LISTEN_HOST ?? DEFAULT_INDEXER_HOST).trim() || DEFAULT_INDEXER_HOST;
	const port =
		(env.MORPHIT_RELAY_LISTEN_PORT ?? DEFAULT_RELAY_PORT).trim() || DEFAULT_RELAY_PORT;
	return `http://${host}:${port}/v1/health`;
}

/** The host's own non-internal IPv4 addresses.  On a containerized
 *  deploy the Docker bridge gateways (docker0 / br-*) live here —
 *  which is exactly where the indexer/relay bind so the frontend
 *  CONTAINER can reach them (and why a loopback-only probe fails even
 *  though the service is up: the #13 symptom).  PURE given the
 *  interface map. */
export function bridgeGatewayHosts(
	ifaces: ReturnType<typeof networkInterfaces>
): string[] {
	const out: string[] = [];
	for (const addrs of Object.values(ifaces)) {
		for (const a of addrs ?? []) {
			if (a.family === 'IPv4' && !a.internal) out.push(a.address);
		}
	}
	return [...new Set(out)];
}

/** Ordered list of health URLs to try: the resolved primary first,
 *  then the same path on each bridge-gateway host at `port`.  The
 *  fallbacks are skipped when the operator pinned an explicit target
 *  (`explicit` true) — we never second-guess an explicit --url/--host.
 *  PURE. */
export function candidateHealthUrls(
	primaryUrl: string,
	explicit: boolean,
	port: string,
	gatewayHosts: string[]
): string[] {
	const urls = [primaryUrl];
	if (!explicit) {
		for (const h of gatewayHosts) urls.push(`http://${h}:${port}/v1/health`);
	}
	return [...new Set(urls)];
}

/** True when the operator pinned the indexer target explicitly (so
 *  auto-probe should stay off).  PURE. */
export function hasExplicitTarget(
	flags: Readonly<Record<string, string>>,
	env: Readonly<Record<string, string | undefined>>
): boolean {
	return (
		(flags.url ?? '').trim() !== '' ||
		(env.MORPHIT_OPS_HEALTH_URL ?? '').trim() !== '' ||
		(flags.host ?? '').trim() !== '' ||
		(env.MORPHIT_INDEXER_LISTEN_HOST ?? '').trim() !== ''
	);
}

// ─── Service + canary checks (beta14) ───────────────────────────────

export type ServiceState =
	| 'active'
	| 'inactive'
	| 'failed'
	| 'activating'
	| 'not-installed'
	| 'unknown';

/** Read-only systemd active-state for a unit via `systemctl show`
 *  (one call; exits 0 even for a missing unit → LoadState=not-found).
 *  Works for any user.  Returns 'unknown' if systemctl isn't on PATH
 *  or the call times out. */
export function checkService(unit: string): ServiceState {
	let out: string;
	try {
		out = execFileSync(
			'systemctl',
			['show', unit, '--property=ActiveState,LoadState', '--no-pager'],
			{ stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, encoding: 'utf8' }
		);
	} catch {
		return 'unknown';
	}
	const load = /LoadState=(\S+)/.exec(out)?.[1];
	if (load === 'not-found' || load === 'masked') return 'not-installed';
	const active = /ActiveState=(\S+)/.exec(out)?.[1];
	switch (active) {
		case 'active':
			return 'active';
		case 'failed':
			return 'failed';
		case 'activating':
		case 'reloading':
			return 'activating';
		case 'inactive':
		case 'deactivating':
			return 'inactive';
		default:
			return 'unknown';
	}
}

export interface CanaryStatus {
	readonly state: 'fresh' | 'overdue' | 'missing' | 'unparsable';
	readonly generatedAt: string | null;
	readonly validThrough: string | null;
	readonly detail: string;
}

/** Freshness of the operator warrant-canary (`apps/web/static/
 *  canary.txt`, regenerated weekly by cron).  Parses the
 *  `Valid through:` line and compares it to `now`.  PURE given the
 *  path and clock (the only I/O is reading the file). */
export function checkCanary(filePath: string, now: Date): CanaryStatus {
	if (!existsSync(filePath)) {
		return {
			state: 'missing',
			generatedAt: null,
			validThrough: null,
			detail: 'not generated yet — run scripts/canary/generate.sh (weekly via cron)'
		};
	}
	let txt: string;
	try {
		txt = readFileSync(filePath, 'utf8');
	} catch {
		return {
			state: 'unparsable',
			generatedAt: null,
			validThrough: null,
			detail: 'could not read the file'
		};
	}
	const generatedAt = /^Generated:\s*(.+)$/m.exec(txt)?.[1]?.trim() ?? null;
	const validThrough = /^Valid through:\s*(.+)$/m.exec(txt)?.[1]?.trim() ?? null;
	if (validThrough === null) {
		return {
			state: 'unparsable',
			generatedAt,
			validThrough: null,
			detail: 'no "Valid through" date — is this still the template?'
		};
	}
	const deadline = new Date(validThrough);
	if (Number.isNaN(deadline.getTime())) {
		return {
			state: 'unparsable',
			generatedAt,
			validThrough,
			detail: 'unrecognized "Valid through" date'
		};
	}
	if (now.getTime() > deadline.getTime()) {
		return {
			state: 'overdue',
			generatedAt,
			validThrough,
			detail: 'past its "valid through" date — regenerate it'
		};
	}
	return { state: 'fresh', generatedAt, validThrough, detail: 'current' };
}

/** Resolve the canary file inside the install tree (best-effort). */
export function canaryFilePath(): string {
	return join(defaultRepoRoot(), 'apps', 'web', 'static', 'canary.txt');
}

/** The fields we read out of a `/v1/health` body.  Only the always-
 *  present (non-verbose) fields — the gated `diagnostics` block is
 *  not required and not read here. */
export interface HealthSummary {
	readonly synced: boolean;
	readonly status: string;
	readonly version: string | null;
	readonly indexedBlock: number | null;
	readonly chainHeadBlock: number | null;
	readonly lagBlocks: number | null;
	readonly lagNote: string | null;
	readonly uptimeSec: number | null;
	readonly rpcHealthy: number | null;
	readonly rpcTotal: number | null;
	/** True only when every configured Blurt RPC endpoint is in
	 *  cooldown — i.e. RPC, not the indexer, is the reason for a
	 *  stalled sync. */
	readonly rpcAllDown: boolean;
	/** Relay only: Web Push delivery enabled (all three VAPID fields
	 *  set).  null when the field is absent (the indexer health, or a
	 *  relay built before this field existed). */
	readonly webPush: boolean | null;
	/** Relay only: the relay account's liquid BLURT balance. The
	 *  account_creation_fee is paid inline per signup, so this balance
	 *  gates signup readiness. null when absent (e.g. indexer health). */
	readonly relayBalance: string | null;
	/** Indexer only: BLURT/USD price-feed state from the non-verbose
	 *  body's `price_feed`.  null when the field is absent (relay health,
	 *  or an indexer built before this field existed). */
	readonly priceFeed: PriceFeedSummary | null;
}

/** Compact BLURT/USD price-feed state surfaced on the non-verbose
 *  `/v1/health` body (`price_feed`).  `enabled:false` → the operator
 *  has the feed switched off (UI shows BLURT only).  `stale:true` →
 *  the feed is on but no live upstream has succeeded (serving the
 *  static floor). */
export interface PriceFeedSummary {
	readonly enabled: boolean;
	readonly blurtFiat: number | null;
	readonly denomination: string | null;
	readonly source: string | null;
	readonly stale: boolean;
}

function numOrNull(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Interpret a parsed `/v1/health` JSON body.  PURE.  Tolerant of a
 *  missing field (reports it as null) so a future endpoint shape never
 *  crashes the view.  `synced` is the inverse of the endpoint's own
 *  `stale`/`degraded` signal. */
export function summarizeHealth(body: unknown): HealthSummary {
	const b = (body ?? {}) as Record<string, unknown>;
	const stale = b.stale === true || b.status === 'degraded';
	const rpcHealthy = numOrNull(b.rpc_endpoints_healthy);
	const rpcTotal = numOrNull(b.rpc_endpoints_total);
	return {
		synced: !stale,
		status: typeof b.status === 'string' ? b.status : 'unknown',
		version: typeof b.version === 'string' ? b.version : null,
		indexedBlock: numOrNull(b.indexed_block),
		chainHeadBlock: numOrNull(b.chain_head_block),
		lagBlocks: numOrNull(b.lag_blocks),
		lagNote: typeof b.lag_blocks_note === 'string' ? b.lag_blocks_note : null,
		uptimeSec: numOrNull(b.uptime_sec),
		rpcHealthy,
		rpcTotal,
		rpcAllDown: rpcTotal !== null && rpcTotal > 0 && rpcHealthy === 0,
		webPush: typeof b.web_push === 'boolean' ? b.web_push : null,
		relayBalance: typeof b.blurt_balance === 'string' ? b.blurt_balance : null,
		priceFeed: parsePriceFeed(b.price_feed)
	};
}

/** Interpret the `price_feed` object on a `/v1/health` body.  PURE.
 *  Returns null when the field is absent or not an object with a
 *  boolean `enabled` (relay health, or a pre-field indexer build). */
export function parsePriceFeed(v: unknown): PriceFeedSummary | null {
	if (v === null || typeof v !== 'object') return null;
	const p = v as Record<string, unknown>;
	if (typeof p.enabled !== 'boolean') return null;
	return {
		enabled: p.enabled,
		blurtFiat: numOrNull(p.blurt_fiat),
		denomination: typeof p.denomination_fiat === 'string' ? p.denomination_fiat : null,
		source: typeof p.source === 'string' ? p.source : null,
		stale: p.stale === true
	};
}

export type HealthOutcomeKind =
	| 'synced'
	| 'behind'
	| 'unreachable'
	| 'not-indexer'
	| 'http-error';

export interface HealthOutcome {
	readonly kind: HealthOutcomeKind;
	readonly summary: HealthSummary | null;
	readonly message: string;
	/** Process exit code: 0 healthy, 1 reachable-but-behind, 2 can't reach. */
	readonly exitCode: number;
}

/** Map a fetch result to an outcome.  PURE — given the HTTP status,
 *  whether the body parsed as JSON, and the parsed body. */
export function classifyHealthResult(args: {
	readonly fetchError: string | null;
	readonly httpStatus: number | null;
	readonly jsonOk: boolean;
	readonly body: unknown;
}): HealthOutcome {
	const { fetchError, httpStatus, jsonOk, body } = args;
	if (fetchError !== null) {
		return {
			kind: 'unreachable',
			summary: null,
			exitCode: 2,
			message:
				'Could not reach the indexer. It may not be running yet, or it is ' +
				'listening on a different host/port. Start it (or check the systemd ' +
				'service), or pass --url / --port if it is not on the default ' +
				'127.0.0.1:8081. Container/Docker deployments often bind the bridge ' +
				'gateway rather than loopback — e.g. try ' +
				'--url http://172.18.0.1:8081/v1/health. (This view never needs sudo.)'
		};
	}
	if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
		return {
			kind: 'http-error',
			summary: null,
			exitCode: 2,
			message: `The health URL returned HTTP ${httpStatus}. Check the URL and that the indexer (not a proxy 404) is answering it.`
		};
	}
	if (!jsonOk) {
		return {
			kind: 'not-indexer',
			summary: null,
			exitCode: 2,
			message:
				'The health URL answered, but not with indexer JSON (likely an HTML page ' +
				'from your web server or reverse proxy). Point at the indexer directly — by ' +
				'default http://127.0.0.1:8081/v1/health — or fix the /v1/ proxy route.'
		};
	}
	const summary = summarizeHealth(body);
	if (summary.synced) {
		return {
			kind: 'synced',
			summary,
			exitCode: 0,
			message: 'The indexer is up and synced with the chain.'
		};
	}
	return {
		kind: 'behind',
		summary,
		exitCode: 1,
		message: summary.rpcAllDown
			? 'The indexer is running but behind the chain, and ALL Blurt RPC endpoints are ' +
				'currently unreachable — so RPC, not the indexer, is the bottleneck. It should ' +
				'catch up once an RPC endpoint recovers.'
			: 'The indexer is running but still catching up to the chain head. This is normal ' +
				'right after a (re)start; re-check in a moment.'
	};
}

// ─── I/O (best-effort, never throws) ────────────────────────────────

interface FetchedHealth {
	fetchError: string | null;
	httpStatus: number | null;
	jsonOk: boolean;
	body: unknown;
}

async function fetchHealth(url: string, timeoutMs = 5000): Promise<FetchedHealth> {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: { accept: 'application/json' },
			redirect: 'manual'
		});
		const text = await res.text();
		let body: unknown = null;
		let jsonOk = false;
		try {
			body = JSON.parse(text);
			jsonOk = body !== null && typeof body === 'object';
		} catch {
			jsonOk = false;
		}
		return { fetchError: null, httpStatus: res.status, jsonOk, body };
	} catch (err) {
		return {
			fetchError: err instanceof Error ? err.message : String(err),
			httpStatus: null,
			jsonOk: false,
			body: null
		};
	} finally {
		clearTimeout(t);
	}
}

// ─── Render ─────────────────────────────────────────────────────────

function color(enabled: boolean) {
	const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
	return {
		green: wrap('32'),
		yellow: wrap('33'),
		red: wrap('31'),
		dim: wrap('2'),
		bold: wrap('1'),
		cyan: wrap('36')
	};
}

/** Strip control bytes from a value coming off the wire before we
 *  print it (defense-in-depth — the indexer is the operator's own,
 *  but the field is still external input). */
function safe(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function fmtUptime(sec: number | null): string {
	if (sec === null) return 'unknown';
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

/** Try each candidate URL in order. Prefer a fully-valid indexer
 *  response (connected + 2xx + JSON); else the first that merely
 *  CONNECTED; else the last attempt (so the caller still gets a
 *  meaningful failure to render). */
async function probeHealth(
	urls: readonly string[]
): Promise<{ url: string; fetched: FetchedHealth }> {
	let firstConnected: { url: string; fetched: FetchedHealth } | null = null;
	let firstResult: { url: string; fetched: FetchedHealth } | null = null;
	for (const url of urls) {
		const fetched = await fetchHealth(url);
		if (firstResult === null) firstResult = { url, fetched };
		if (fetched.fetchError === null) {
			if (
				fetched.httpStatus !== null &&
				fetched.httpStatus >= 200 &&
				fetched.httpStatus < 300 &&
				fetched.jsonOk
			) {
				return { url, fetched };
			}
			if (firstConnected === null) firstConnected = { url, fetched };
		}
	}
	return (
		firstConnected ??
		firstResult ?? {
			url: urls[0] ?? '',
			fetched: { fetchError: 'no target', httpStatus: null, jsonOk: false, body: null }
		}
	);
}

function serviceLine(
	c: ReturnType<typeof color>,
	unit: string,
	state: ServiceState
): string {
	const name = unit.replace(/^morphit-/, '').replace(/\.service$/, '').padEnd(13);
	const dot = (() => {
		switch (state) {
			case 'active':
				return c.green('● active');
			case 'failed':
				return c.red('● failed');
			case 'activating':
				return c.yellow('● starting');
			case 'inactive':
				return c.yellow('○ stopped');
			case 'not-installed':
				return c.dim('— not installed');
			default:
				return c.dim('? unknown (no systemctl?)');
		}
	})();
	return `      ${name} ${dot}`;
}

export async function runHealth(ctx: HealthCtx): Promise<number> {
	const c = color(ctx.colorEnabled);
	const json = ctx.flags.json === 'true';
	const now = new Date();
	const gateways = bridgeGatewayHosts(networkInterfaces());

	// ── Indexer: resolve primary, then auto-probe bridge gateways ──
	const indexerPrimary = resolveHealthUrl(ctx.flags, process.env);
	const indexerExplicit = hasExplicitTarget(ctx.flags, process.env);
	const indexerPort =
		(ctx.flags.port ?? process.env.MORPHIT_INDEXER_LISTEN_PORT ?? DEFAULT_INDEXER_PORT).trim() ||
		DEFAULT_INDEXER_PORT;
	const indexerProbe = await probeHealth(
		candidateHealthUrls(indexerPrimary, indexerExplicit, indexerPort, gateways)
	);
	const indexer = classifyHealthResult(indexerProbe.fetched);

	// ── Relay: resolve primary, then auto-probe ──
	const relayPrimary = resolveRelayHealthUrl(process.env);
	const relayExplicit = (process.env.MORPHIT_RELAY_LISTEN_HOST ?? '').trim() !== '';
	const relayPort =
		(process.env.MORPHIT_RELAY_LISTEN_PORT ?? DEFAULT_RELAY_PORT).trim() || DEFAULT_RELAY_PORT;
	const relayProbe = await probeHealth(
		candidateHealthUrls(relayPrimary, relayExplicit, relayPort, gateways)
	);
	const relay = classifyHealthResult(relayProbe.fetched);
	const relayUp = relay.kind === 'synced' || relay.kind === 'behind';

	// ── Services (read-only systemctl) + canary freshness ──
	const services = [
		{ unit: 'morphit-matrix-bot', state: checkService('morphit-matrix-bot') },
		{ unit: 'morphit-mcp', state: checkService('morphit-mcp') }
	];
	const canary = checkCanary(canaryFilePath(), now);

	if (json) {
		console.log(
			JSON.stringify(
				{
					indexer: { url: indexerProbe.url, outcome: indexer.kind, health: indexer.summary },
					relay: {
						url: relayProbe.url,
						outcome: relay.kind,
						up: relayUp,
						version: relay.summary?.version ?? null,
						uptime_sec: relay.summary?.uptimeSec ?? null,
						web_push: relay.summary?.webPush ?? null,
						blurt_balance: relay.summary?.relayBalance ?? null
					},
					services: Object.fromEntries(services.map((s) => [s.unit, s.state])),
					canary
				},
				null,
				2
			)
		);
		return indexer.exitCode;
	}

	console.log('');
	console.log('━'.repeat(60));
	console.log('  Node health');
	console.log('━'.repeat(60));

	// ── Indexer block ──
	const iTag =
		indexer.kind === 'synced' ? c.green('✓') : indexer.kind === 'behind' ? c.yellow('⚠') : c.red('✗');
	console.log('');
	console.log(`  ${c.bold('Indexer')}   ${c.dim(safe(indexerProbe.url))}`);
	console.log(`  ${iTag} ${indexer.message}`);
	const s = indexer.summary;
	if (s !== null) {
		const syncLabel = s.synced ? c.green('synced') : c.yellow('behind');
		console.log(`      Sync state:    ${syncLabel}`);
		console.log(`      Last block:    ${s.indexedBlock ?? 'unknown'}`);
		console.log(`      Chain head:    ${s.chainHeadBlock ?? 'unknown'}`);
		const lag = s.lagBlocks;
		const lagStr = lag === null ? 'unknown' : `${lag} block${lag === 1 ? '' : 's'}`;
		console.log(`      Lag:           ${lag !== null && lag > 0 ? c.yellow(lagStr) : lagStr}`);
		if (s.lagNote !== null) console.log(`                     ${c.dim(s.lagNote)}`);
		const rpcStr =
			s.rpcHealthy !== null && s.rpcTotal !== null
				? `${s.rpcHealthy}/${s.rpcTotal} reachable`
				: 'unknown';
		console.log(`      Blurt RPC:     ${s.rpcAllDown ? c.red(rpcStr) : rpcStr}`);
		console.log(`      Uptime:        ${fmtUptime(s.uptimeSec)}`);
		if (s.version !== null) console.log(`      Version:       ${safe(s.version)}`);
		if (s.priceFeed !== null) {
			const pf = s.priceFeed;
			let pfLine: string;
			if (!pf.enabled) {
				pfLine = c.dim('off (USD display disabled — UI shows BLURT only)');
			} else if (pf.stale) {
				pfLine = c.yellow('on but stale — no live upstream (serving static floor)');
			} else {
				const denom = pf.denomination ?? 'USD';
				const px = pf.blurtFiat !== null ? `1 BLURT \u2248 ${pf.blurtFiat} ${denom}` : 'live';
				const src = pf.source !== null ? ` (${pf.source})` : '';
				pfLine = `${c.green('on')} \u2014 ${px}${src}`;
			}
			console.log(`      Price feed:    ${pfLine}`);
		}
	} else if (indexer.kind === 'unreachable') {
		console.log(`      ${c.dim('Not reachable on loopback or any bridge gateway. If it binds')}`);
		console.log(`      ${c.dim('a non-default address, pass --url or set MORPHIT_OPS_HEALTH_URL.')}`);
	}

	// ── Relay block ──
	console.log('');
	console.log(`  ${c.bold('Relay')}     ${c.dim(safe(relayProbe.url))}`);
	if (relayUp) {
		const rs = relay.summary;
		console.log(`  ${c.green('✓')} up`);
		if (rs?.version != null) console.log(`      Version:       ${safe(rs.version)}`);
		console.log(`      Uptime:        ${fmtUptime(rs?.uptimeSec ?? null)}`);
		if (rs?.webPush != null) {
			console.log(
				`      Web push:      ${rs.webPush ? c.green('✓ enabled') : c.dim('○ disabled (no VAPID keys)')}`
			);
		}
		// Relay liquid BLURT: it pays the ~100 BLURT account-creation fee
		// inline per signup (Blurt disabled the ACT model at HF2), so this
		// balance gates signup readiness — the relay refuses signups when
		// it can't cover the fee plus a small margin.
		if (rs?.relayBalance != null) {
			console.log(`      BLURT balance: ${safe(rs.relayBalance)}`);
		}
	} else if (relay.kind === 'unreachable') {
		console.log(`  ${c.red('✗')} not reachable on loopback or any bridge gateway`);
		console.log(`      ${c.dim('the relay is optional — only needed if your node broadcasts')}`);
		console.log(`      ${c.dim('user-signed ops. If you run it, check that its container or')}`);
		console.log(`      ${c.dim('systemd service is up and publishes its port to the host.')}`);
	} else {
		console.log(`  ${c.yellow('⚠')} answered, but not as the relay (${relay.kind})`);
	}

	// ── Services block ──
	console.log('');
	console.log(`  ${c.bold('Services')}  ${c.dim('(systemd, read-only)')}`);
	for (const svc of services) console.log(serviceLine(c, svc.unit, svc.state));

	// ── Canary block ──
	console.log('');
	const canaryTag =
		canary.state === 'fresh' ? c.green('✓') : canary.state === 'overdue' ? c.red('✗') : c.yellow('⚠');
	console.log(`  ${c.bold('Canary')}    ${canaryTag} ${canary.state}`);
	if (canary.validThrough !== null) console.log(`      Valid through: ${safe(canary.validThrough)}`);
	console.log(`      ${c.dim(canary.detail)}`);

	console.log('');
	console.log('━'.repeat(60));
	console.log('');
	return indexer.exitCode;
}
