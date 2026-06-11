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
	readonly uptimeSec: number | null;
	readonly rpcHealthy: number | null;
	readonly rpcTotal: number | null;
	/** True only when every configured Blurt RPC endpoint is in
	 *  cooldown — i.e. RPC, not the indexer, is the reason for a
	 *  stalled sync. */
	readonly rpcAllDown: boolean;
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
		uptimeSec: numOrNull(b.uptime_sec),
		rpcHealthy,
		rpcTotal,
		rpcAllDown: rpcTotal !== null && rpcTotal > 0 && rpcHealthy === 0
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

export async function runHealth(ctx: HealthCtx): Promise<number> {
	const c = color(ctx.colorEnabled);
	const json = ctx.flags.json === 'true';
	const url = resolveHealthUrl(ctx.flags, process.env);

	const fetched = await fetchHealth(url);
	const outcome = classifyHealthResult(fetched);

	if (json) {
		console.log(
			JSON.stringify(
				{
					url,
					outcome: outcome.kind,
					message: outcome.message,
					health: outcome.summary
				},
				null,
				2
			)
		);
		return outcome.exitCode;
	}

	const tag =
		outcome.kind === 'synced'
			? c.green('✓')
			: outcome.kind === 'behind'
				? c.yellow('⚠')
				: c.red('✗');

	console.log('');
	console.log('━'.repeat(60));
	console.log('  Indexer health (live, via /v1/health)');
	console.log('━'.repeat(60));
	console.log('');
	console.log(`  ${c.dim('Endpoint:')} ${safe(url)}`);
	console.log('');
	console.log(`  ${tag} ${outcome.message}`);
	console.log('');

	const s = outcome.summary;
	if (s !== null) {
		const syncLabel = s.synced ? c.green('synced') : c.yellow('behind');
		console.log(`      Sync state:     ${syncLabel}`);
		console.log(`      Last block:     ${s.indexedBlock ?? 'unknown'}`);
		console.log(`      Chain head:     ${s.chainHeadBlock ?? 'unknown'}`);
		const lag = s.lagBlocks;
		const lagStr =
			lag === null ? 'unknown' : `${lag} block${lag === 1 ? '' : 's'}`;
		console.log(`      Lag:            ${lag !== null && lag > 0 ? c.yellow(lagStr) : lagStr}`);
		const rpcStr =
			s.rpcHealthy !== null && s.rpcTotal !== null
				? `${s.rpcHealthy}/${s.rpcTotal} reachable`
				: 'unknown';
		console.log(
			`      Blurt RPC:      ${s.rpcAllDown ? c.red(rpcStr) : rpcStr}`
		);
		console.log(`      Uptime:         ${fmtUptime(s.uptimeSec)}`);
		if (s.version !== null) console.log(`      Version:        ${safe(s.version)}`);
		console.log('');
	} else {
		console.log(
			`  ${c.dim('Tip:')} the Status dashboard (status) needs the config + DB and may`
		);
		console.log(
			'       hit a permission error as a non-root user; this view does not.'
		);
		console.log('');
	}

	console.log('━'.repeat(60));
	console.log('');
	return outcome.exitCode;
}
