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

import { networkInterfaces, cpus, totalmem, freemem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';

import { classifySeeding, resolveHealthDiskPath, type SeedingProblem } from '@morphit/node-health';

import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { parseCanaryTimestamp } from '../canaryTime.ts';

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
			['show', unit, '--property=ActiveState,LoadState,SubState', '--no-pager'],
			{ stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, encoding: 'utf8' }
		);
	} catch {
		return 'unknown';
	}
	const load = /LoadState=(\S+)/.exec(out)?.[1];
	if (load === 'not-found' || load === 'masked') return 'not-installed';
	const active = /ActiveState=(\S+)/.exec(out)?.[1];
	const sub = /SubState=(\S+)/.exec(out)?.[1];
	switch (active) {
		case 'active':
			return 'active';
		case 'failed':
			return 'failed';
		case 'activating':
		case 'reloading':
			// SubState=auto-restart means the unit already FAILED and systemd is
			// restarting it (Restart=on-failure) — i.e. it's crash-looping, not
			// starting for the first time. Reporting that as "starting" hides a
			// real problem (a matrix-bot with a bad token or a homeserver it can't
			// reach can sit here forever). Surface it as failed so the operator
			// knows to check `journalctl -u <unit>`. A genuine first start is
			// SubState=start / start-pre / start-post — still "starting".
			return sub === 'auto-restart' ? 'failed' : 'activating';
		case 'inactive':
		case 'deactivating':
			return 'inactive';
		default:
			return 'unknown';
	}
}

export interface CanaryStatus {
	readonly state: 'fresh' | 'stale' | 'overdue' | 'missing' | 'unparsable';
	readonly generatedAt: string | null;
	readonly validThrough: string | null;
	readonly detail: string;
}

export interface AideBaselineStatus {
	readonly state: 'built' | 'building' | 'failed' | 'not-configured';
	readonly detail: string;
}

/** AIDE filesystem-integrity baseline state (cp680–cp682). The baseline builds
 *  in a deferred background one-shot that SELF-REMOVES on success, so the raw
 *  service state is misleading (absent = done, not missing). Combine on-disk
 *  facts instead, so a background failure is visible here even without Matrix:
 *   - /var/lib/aide/aide.db present            → built
 *   - /var/lib/morphit/aide-init-failed marker → failed
 *   - morphit-aide-init.service active         → building
 *   - service failed                           → failed
 *   - none of the above                        → not-configured
 *  Read-only. */
export function checkAideBaseline(): AideBaselineStatus {
	if (existsSync('/var/lib/aide/aide.db')) {
		return { state: 'built', detail: 'integrity baseline built; daily check active' };
	}
	const failed = {
		state: 'failed' as const,
		detail:
			'baseline build FAILED — see `sudo journalctl -u morphit-aide-init.service`; it retries on next boot'
	};
	if (existsSync('/var/lib/morphit/aide-init-failed')) return failed;
	const svc = checkService('morphit-aide-init');
	if (svc === 'active' || svc === 'activating') {
		return {
			state: 'building',
			detail: 'baseline building in the background (idle priority) — no action needed'
		};
	}
	if (svc === 'failed') return failed;
	return { state: 'not-configured', detail: 'intrusion detection (AIDE) not enabled on this node' };
}

export interface TlsCertStatus {
	readonly state: 'valid' | 'expiring' | 'expired' | 'not-found';
	readonly daysLeft: number | null;
	readonly detail: string;
}

/** Days until the cert actually SERVED on the live HTTPS port expires, or null
 *  if nothing valid is served / openssl is unavailable. Unlike the file check,
 *  this sees the cert regardless of who manages it — host certbot OR BunkerWeb's
 *  own auto-SSL living inside its data volume — so a BunkerWeb-managed cert no
 *  longer reads as "no cert". */
export function probeServedCertDaysLeft(hostPort = '127.0.0.1:443'): number | null {
	try {
		const out = execFileSync(
			'bash',
			[
				'-c',
				`echo | openssl s_client -connect ${hostPort} 2>/dev/null | openssl x509 -enddate -noout 2>/dev/null`
			],
			{ encoding: 'utf8', timeout: 4000 }
		);
		const notAfter = /notAfter=(.+)/.exec(out)?.[1]?.trim();
		if (notAfter === undefined || notAfter.length === 0) return null;
		const exp = new Date(notAfter).getTime();
		if (Number.isNaN(exp)) return null;
		return Math.floor((exp - Date.now()) / 86_400_000);
	} catch {
		return null;
	}
}

/** Map a days-to-expiry number to a TlsCertStatus. `served` tailors the detail
 *  wording for a cert seen on the wire (vs read from a file). */
function tlsStatusFromDays(days: number, served: boolean): TlsCertStatus {
	if (days < 0)
		return { state: 'expired', daysLeft: days, detail: `certificate EXPIRED ${-days} day(s) ago — renew now` };
	if (days < 30)
		return {
			state: 'expiring',
			daysLeft: days,
			detail: `expires in ${days} day(s) — auto-renewal should run`
		};
	const how = served ? 'served by the web front, ' : '';
	return { state: 'valid', daysLeft: days, detail: `valid, ${how}${days} day(s) to expiry (auto-renews)` };
}

/** TLS certificate status. Prefers host certbot certs in `liveDir`; when none is
 *  found there, falls back to `servedProbe` (the cert actually served on 443) so
 *  a BunkerWeb-managed cert — which lives in BunkerWeb's own volume, not
 *  /etc/letsencrypt — is recognised instead of reported as "not set up". cp684. */
export function checkTlsCert(
	liveDir = '/etc/letsencrypt/live',
	servedProbe?: () => number | null
): TlsCertStatus {
	const servedFallback = (): TlsCertStatus => {
		const days = servedProbe ? servedProbe() : null;
		return days === null
			? {
					state: 'not-found',
					daysLeft: null,
					detail:
						'no HTTPS certificate. A clearnet node must be reachable from the ' +
						'internet on ports 80/443 for the Let\u2019s Encrypt challenge \u2014 a ' +
						'home/CGNAT connection (no inbound) can never get one, so use tor-only ' +
						'mode there. A tor-only node needs no certificate (.onion/.i2p are ' +
						'self-authenticating). If this is a reachable clearnet host, certbot ' +
						'may still be in progress \u2014 re-check shortly.'
				}
			: tlsStatusFromDays(days, true);
	};
	let domains: string[];
	try {
		domains = readdirSync(liveDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return servedFallback();
	}
	let soonest: number | null = null;
	for (const dom of domains) {
		const certPath = join(liveDir, dom, 'cert.pem');
		if (!existsSync(certPath)) continue;
		try {
			const out = execFileSync('openssl', ['x509', '-enddate', '-noout', '-in', certPath], {
				encoding: 'utf8',
				timeout: 3000
			});
			const m = /notAfter=(.+)/.exec(out);
			const notAfter = m?.[1]?.trim();
			if (notAfter === undefined || notAfter.length === 0) continue;
			const exp = new Date(notAfter).getTime();
			if (Number.isNaN(exp)) continue;
			const days = Math.floor((exp - Date.now()) / 86_400_000);
			if (soonest === null || days < soonest) soonest = days;
		} catch {
			/* openssl missing or cert unreadable — skip this one */
		}
	}
	if (soonest === null) return servedFallback();
	return tlsStatusFromDays(soonest, false);
}

/** The alert MXID(s) the matrix-bot is configured to DM, from its env file.
 *  Read-only; null when unset/unreadable. Lets health confirm the bot targets
 *  the address the operator entered, not just that the service is up. cp684. */
export function readMatrixMxid(envPath = '/etc/morphit/matrix-bot.env'): string | null {
	try {
		const txt = readFileSync(envPath, 'utf8');
		const m = /^MORPHIT_MATRIX_BOT_ALERT_MXID=(.*)$/m.exec(txt);
		const v = m?.[1]?.trim();
		return v !== undefined && v.length > 0 ? v : null;
	} catch {
		return null;
	}
}

/** Whether the matrix-bot is installed and whether it has a token yet, from its
 *  env file. Lets health distinguish "not installed" (no env — the bot was never
 *  set up) from "token needed" (env present but the access token is empty — the
 *  unit is staged and stopped, waiting for a token via `morphit-ops matrix`). */
export function readMatrixBotSetup(envPath = '/etc/morphit/matrix-bot.env'): {
	installed: boolean;
	hasToken: boolean;
} {
	try {
		const txt = readFileSync(envPath, 'utf8');
		const m = /^MORPHIT_MATRIX_BOT_ACCESS_TOKEN=(.*)$/m.exec(txt);
		const tok = m?.[1]?.trim();
		return { installed: true, hasToken: tok !== undefined && tok.length > 0 };
	} catch {
		return { installed: false, hasToken: false };
	}
}

/** Warn when a served canary has less than this much validity left. Normal
 *  weekly refresh keeps a far wider margin, so a low margin means the refresh
 *  has stalled — flag it while there's still time to re-run, BEFORE it expires
 *  and readers see a false tamper signal. */
const CANARY_STALE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

/** Freshness of the operator warrant-canary served at `/canary.txt`
 *  (the file in `apps/web/build/`, the nginx web root).  Parses the
 *  `Valid through:` line and compares it to `now`.  PURE given the
 *  path and clock (the only I/O is reading the file). */
export function checkCanary(filePath: string, now: Date): CanaryStatus {
	if (!existsSync(filePath)) {
		return {
			state: 'missing',
			generatedAt: null,
			validThrough: null,
			detail:
				'not published yet — the canary embeds live freshness proofs (a recent ' +
				'Blurt chain-head, a BTC price, a news headline), so it needs network and ' +
				'publishes on its own once this box is online. To sign one now, run ' +
				'sudo morphit-ops harden (or scripts/canary/setup.sh on your operator machine).'
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
	// Parse explicitly: `new Date(str)` on a non-ISO string is
	// implementation-defined (a different runtime may return NaN, or read the
	// stamp as LOCAL time and skew the staleness window by hours). The canary's
	// freshness IS the security signal — it doesn't get to depend on V8 quirks.
	const deadline = new Date(parseCanaryTimestamp(validThrough));
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
	// cp622 — still valid but running LOW on validity: the weekly refresh has
	// likely stalled (an upgrade wiped the canary and it wasn't re-run, or the
	// timer died). Normal operation keeps a wide margin, so warn now — while
	// there's still time — instead of waiting for it to expire.
	const msLeft = deadline.getTime() - now.getTime();
	if (msLeft < CANARY_STALE_WINDOW_MS) {
		const daysLeft = Math.max(0, Math.floor(msLeft / 86_400_000));
		return {
			state: 'stale',
			generatedAt,
			validThrough,
			detail:
				`expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — your weekly ` +
				'refresh may have stalled; re-run it (bash ~/.morphit/update-canary.sh)'
		};
	}
	return { state: 'fresh', generatedAt, validThrough, detail: 'current' };
}

/** Resolve the canary file inside the install tree.  It reads the
 *  SERVED copy — nginx's web root is the `build/` dir, so `/canary.txt`
 *  is served from `apps/web/build/canary.txt`, NOT `static/`.  (cp431:
 *  was `static/`, which is only the build-time source and is never the
 *  file the public actually fetches — so health reported "missing" even
 *  with a live, verified canary at the URL.) */
export function canaryFilePath(): string {
	return join(defaultRepoRoot(), 'apps', 'web', 'build', 'canary.txt');
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
	/** cp372 — per-source FX + crypto feed health from the verbose
	 *  body's `diagnostics.price_feeds`.  null when the verbose block
	 *  is absent (verboseHealth off, relay health, or a pre-field
	 *  indexer build) — the renderer then shows a one-line hint. */
	readonly priceFeeds: PriceFeedsHealthSummary | null;
	/** cp403 [1] — chat head-block fast-path status from the operator-only
	 *  top-level `fastpath` block (same X-Morphit-Local-Health gate as
	 *  price_feeds). null when absent (relay health, or a pre-fast-path
	 *  indexer build) — the renderer then shows a one-line hint. */
	readonly fastPath: FastPathSummary | null;
}

/** v1.7.0 — head-block fast-path status (mirrors the indexer's
 *  HeadTailerStatus). `running` + a rising `scannedHead` → it's actively
 *  tailing the chain head.
 *
 *  `enabled` was REMOVED with the knob it reported (ADR-0051). It could only
 *  ever say `true`, and an operator who read it once and concluded fast was
 *  optional was worse off than one who never saw it. What they actually need
 *  is whether it's tailing and how far behind head it is — which is what the
 *  renderer now shows. */
/** How many blocks behind head the tailer may sit and still be "keeping up".
 *  The scanner polls every ~2s and Blurt blocks are ~3s, so 0-2 blocks is
 *  normal and anything past a handful means it is not delivering the ≤6s the
 *  whole fast path exists for. */
export const FASTPATH_HEALTHY_LAG_BLOCKS = 4;

export interface FastPathSummary {
	readonly running: boolean;
	readonly scannedHead: number | null;
	readonly emitted: number | null;
	readonly lastError: string | null;
}

/** One source's health within a feed (FX or a crypto asset). */
export interface FeedSourceRow {
	readonly name: string;
	readonly ok: boolean;
	readonly lastOkAgeS: number | null;
	/** This provider's last reported reading (crypto: asset→fiat price;
	 *  null = never succeeded or FX row). */
	readonly price: number | null;
}
/** One feed's rolled-up health (FX, or BLURT/BTC/XMR). */
export interface FeedHealthRow {
	readonly label: string;
	readonly source: string;
	readonly stale: boolean;
	readonly outlierRejected: boolean;
	readonly up: number;
	readonly total: number;
	/** FX feeds report a whole currency table, not a single price, so
	 *  they render as a rolled-up summary rather than per-source prices. */
	readonly isCrypto: boolean;
	readonly sources: FeedSourceRow[];
}
export interface PriceFeedsHealthSummary {
	readonly fxEnabled: boolean;
	readonly feeds: FeedHealthRow[];
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
		priceFeed: parsePriceFeed(b.price_feed),
		priceFeeds: parsePriceFeedsHealth(b.price_feeds),
		fastPath: parseFastPath(b.fastpath)
	};
}

/** Interpret the operator-only top-level `fastpath` block from a
 *  `/v1/health` body (present only when the X-Morphit-Local-Health
 *  header is sent, which the ops-cli does). Keys are camelCase — the
 *  indexer forwards its ChatHeadTailerStatus object verbatim. PURE. */
export function parseFastPath(v: unknown): FastPathSummary | null {
	if (v === null || typeof v !== 'object') return null;
	const o = v as Record<string, unknown>;
	return {
		running: o.running === true,
		scannedHead: numOrNull(o.scannedHead),
		emitted: numOrNull(o.emitted),
		lastError: typeof o.lastError === 'string' ? safe(o.lastError) : null
	};
}

/** Interpret the top-level `price_feeds` block from a `/v1/health`
 *  body.  PURE.  Returns null when the block is absent (operator-local
 *  header not sent / stripped at the public edge / relay health /
 *  pre-field build).  Tolerant of partial shapes so a future field
 *  change never crashes the view. */
export function parsePriceFeedsHealth(priceFeeds: unknown): PriceFeedsHealthSummary | null {
	if (priceFeeds === null || typeof priceFeeds !== 'object') return null;
	const block = priceFeeds as Record<string, unknown>;

	const rows = (raw: unknown): FeedSourceRow[] => {
		if (!Array.isArray(raw)) return [];
		return raw.flatMap((r) => {
			if (r === null || typeof r !== 'object') return [];
			const o = r as Record<string, unknown>;
			const name = typeof o.name === 'string' ? safe(o.name) : null;
			if (name === null) return [];
			return [
				{
					name,
					ok: o.ok === true,
					lastOkAgeS: numOrNull(o.last_ok_age_s),
					price: numOrNull(o.price)
				}
			];
		});
	};
	const toFeed = (label: string, isCrypto: boolean, v: unknown): FeedHealthRow | null => {
		if (v === null || typeof v !== 'object') return null;
		const o = v as Record<string, unknown>;
		const sources = rows(o.sources);
		return {
			label,
			source: typeof o.source === 'string' ? safe(o.source) : 'unknown',
			stale: o.stale === true,
			outlierRejected: o.outlier_rejected === true,
			up: sources.filter((s) => s.ok).length,
			total: sources.length,
			isCrypto,
			sources
		};
	};

	const feeds: FeedHealthRow[] = [];
	const fx = block.fx as Record<string, unknown> | undefined;
	const fxEnabled = !!fx && fx.enabled === true;
	if (fxEnabled) {
		const row = toFeed('FX (USD→fiat)', false, fx);
		if (row) feeds.push(row);
	}
	const crypto = block.crypto;
	if (crypto !== null && typeof crypto === 'object') {
		// Stable display order; only assets actually present are shown.
		for (const asset of ['BLURT', 'BTC', 'XMR']) {
			const row = toFeed(asset, true, (crypto as Record<string, unknown>)[asset]);
			if (row) feeds.push(row);
		}
		// Any other assets the operator configured, appended after.
		for (const asset of Object.keys(crypto as Record<string, unknown>)) {
			if (['BLURT', 'BTC', 'XMR'].includes(asset)) continue;
			const row = toFeed(asset, true, (crypto as Record<string, unknown>)[asset]);
			if (row) feeds.push(row);
		}
	}
	if (feeds.length === 0 && !fxEnabled) return null;
	return { fxEnabled, feeds };
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
	| 'unknown'
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
	// If the indexer can't reach ANY Blurt RPC, it cannot see the chain head — so
	// its sync state is UNVERIFIABLE. Report "unknown" rather than trusting a
	// stale `synced` flag (an offline / just-started node otherwise looks synced
	// with a bogus 0-block lag).
	if (summary.rpcAllDown) {
		return {
			kind: 'unknown',
			summary,
			exitCode: 1,
			message:
				"The indexer is running, but it can't reach any Blurt RPC right now — so its " +
				"sync state is unknown (it has no chain head to compare against). It resyncs " +
				'automatically once an RPC endpoint becomes reachable.'
		};
	}
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

/** One RPC endpoint's per-node health, as returned by /v1/rpc-endpoints. */
export interface RpcEndpointRow {
	readonly url: string;
	readonly transport: 'clearnet' | 'tor' | 'i2p' | 'local';
	readonly healthy: boolean;
	readonly latencyMs: number | null;
}

/** Parse a /v1/rpc-endpoints body into rows. PURE + tolerant of shape drift. */
export function parseRpcEndpointRows(body: unknown): RpcEndpointRow[] {
	if (body === null || typeof body !== 'object') return [];
	const arr = (body as { endpoints?: unknown }).endpoints;
	if (!Array.isArray(arr)) return [];
	const rows: RpcEndpointRow[] = [];
	for (const e of arr) {
		if (e === null || typeof e !== 'object') continue;
		const o = e as Record<string, unknown>;
		if (typeof o.url !== 'string') continue;
		const t = o.transport;
		const transport =
			t === 'tor' || t === 'i2p' || t === 'local' ? t : 'clearnet';
		rows.push({
			url: o.url,
			transport,
			healthy: o.healthy === true,
			latencyMs: typeof o.latencyMs === 'number' ? o.latencyMs : null
		});
	}
	return rows;
}

/** Fetch the indexer's per-endpoint RPC health. Derives /v1/rpc-endpoints?probe=1
 *  from the health URL. Best-effort: returns null on any failure (the summary
 *  count from /v1/health still renders). */
async function fetchRpcEndpoints(healthUrl: string, timeoutMs = 22000): Promise<RpcEndpointRow[] | null> {
	let url: string;
	try {
		const u = new URL(healthUrl);
		u.pathname = u.pathname.replace(/\/v1\/health$/, '/v1/rpc-endpoints');
		if (!u.pathname.endsWith('/v1/rpc-endpoints')) u.pathname = '/v1/rpc-endpoints';
		u.search = '?probe=1';
		url = u.toString();
	} catch {
		return null;
	}
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: { accept: 'application/json', 'x-morphit-local-health': '1' },
			redirect: 'manual'
		});
		if (res.status < 200 || res.status >= 300) return null;
		return parseRpcEndpointRows(JSON.parse(await res.text()));
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

/** Short label for a transport (badge column). PURE. */
export function transportLabel(t: RpcEndpointRow['transport']): string {
	return t === 'tor' ? 'Tor' : t === 'i2p' ? 'I2P' : t === 'local' ? 'local' : 'clearnet';
}

/** Compact an endpoint URL for the per-node list: drop the scheme, and elide the
 *  long middle of a 56-char .onion/.b32.i2p host so the line stays readable.
 *  PURE. */
export function shortEndpoint(url: string): string {
	let host = url;
	try {
		const u = new URL(url);
		host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
	} catch {
		host = url.replace(/^https?:\/\//, '');
	}
	// Elide a long opaque label (onion/i2p) but keep any :port suffix.
	const m = host.match(/^([a-z2-7]{20,})(\.[a-z0-9.]+)(:\d+)?$/i);
	const label = m?.[1];
	if (m && label && label.length > 16) {
		return `${label.slice(0, 6)}\u2026${label.slice(-6)}${m[2] ?? ''}${m[3] ?? ''}`;
	}
	return host;
}

async function fetchHealth(url: string, timeoutMs = 5000): Promise<FetchedHealth> {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), timeoutMs);
	// cp381: request the operator-only per-source price-feed health.
	// The ops-cli hits the indexer directly on the internal bridge, so
	// this header reaches it; the public edge strips X-Morphit-Local-Health
	// (proxy_set_header … ""), so a public caller can never forge it. The
	// indexer returns the top-level `price_feeds` block only when the
	// header is present — the gated `diagnostics` (operator balances /
	// drain signal, NEW-9-8) still needs MORPHIT_INDEXER_VERBOSE_HEALTH
	// and isn't requested here.
	try {
		const res = await fetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: { accept: 'application/json', 'x-morphit-local-health': '1' },
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

// ─── Backups (v1.8.9) ─────────────────────────────────────────────
//
// WHY THIS EXISTS. The built-in daily backup shipped in v1.8.4 and never
// produced a single dump on any Debian/Ubuntu host: the script ran
// `set -o pipefail` under dash, which rejects it, and because `set` is a
// special builtin the shell died on the spot — silently, before pg_dump, every
// night. `morphit-ops health` reported indexer sync, relay, price feeds and
// canary freshness, and said NOTHING about backups, so the failure went unseen
// for three releases. An operator's most important disaster-recovery artefact
// was the one thing the health command didn't look at.
//
// The decisive signal is not "did the timer fire" but "did the timer fire and
// leave nothing behind" — that is exactly the shape the dash bug had. So we
// compare the newest dump against the timer's own last trigger, and surface a
// FAILED unit directly.

/** Raw facts, gathered by `readBackupFacts`. Split out so the decision logic
 *  below stays pure and unit-testable. */
export interface BackupFacts {
	/** Whether /etc/morphit/backup.env exists at all — absent simply means the
	 *  operator hasn't opted into the built-in backup, which is not a fault. */
	readonly configured: boolean;
	/** False when the env file or the dump directory can't be read by THIS
	 *  user — an inspection failure, not a backup failure. Never conflate the
	 *  two: reporting "no backups" because we lacked permission would be a lie. */
	readonly readable: boolean;
	readonly dir: string | null;
	readonly newest: { readonly name: string; readonly atMs: number; readonly bytes: number } | null;
	/** The TIMER's last trigger. A manual `systemctl start` does not update it,
	 *  so a hand-run dump never reads as a failure. Null when unavailable. */
	readonly lastTriggerMs: number | null;
	/** The one-shot service sitting in systemd's `failed` state. */
	readonly serviceFailed: boolean;
}

export interface BackupStatus {
	readonly state: 'fresh' | 'stale' | 'failing' | 'missing' | 'not-configured' | 'unreadable';
	readonly detail: string;
	readonly newestName: string | null;
	readonly ageMs: number | null;
	readonly bytes: number | null;
}

/** The timer is daily, so a dump older than this means at least one run was
 *  lost. Wide enough to absorb the unit's RandomizedDelaySec jitter. */
export const BACKUP_STALE_AFTER_MS = 36 * 60 * 60 * 1000;
/** A healthy run writes its dump within seconds of the trigger. More than this
 *  between "the timer fired" and "the newest dump" means it fired and produced
 *  nothing — the silent-failure signature. */
export const BACKUP_TRIGGER_SLACK_MS = 15 * 60 * 1000;
/** Below this, the file cannot be a dump of the Morphit schema.
 *
 *  WHY (cp526). Before the status-capture fix in `ops/backup/morphit-backup.sh`,
 *  a FAILED pg_dump still left a valid ~20-byte gzip member behind, which the
 *  script renamed to a real backup name and reported as written. Freshness
 *  alone therefore CANNOT be trusted: the dash bug's successor produces a dump
 *  that is perfectly recent and completely useless, and this check is what
 *  stops us blessing it. The floor is deliberately far below anything real —
 *  the indexer schema alone gzips to tens of KB, so a legitimate dump is never
 *  within two orders of magnitude of 1 KiB and false positives are impossible.
 *  Any operator who ran v1.8.4–v1.8.9 through a DB hiccup has these on disk. */
export const BACKUP_MIN_PLAUSIBLE_BYTES = 1024;

/** PURE given the facts and the clock. */
export function checkBackups(facts: BackupFacts, now: Date): BackupStatus {
	const none = { newestName: null, ageMs: null, bytes: null } as const;
	if (!facts.configured) {
		return {
			state: 'not-configured',
			detail:
				'no /etc/morphit/backup.env — the built-in daily backup is not set up ' +
				'(run `morphit-ops harden` and pick "Set up automatic daily database backups")',
			...none
		};
	}
	if (!facts.readable) {
		return {
			state: 'unreadable',
			detail:
				'configured, but this user cannot read the env file or the backup directory — ' +
				're-run as the morphit user (or with sudo) to see backup freshness',
			...none
		};
	}
	const newestName = facts.newest?.name ?? null;
	const bytes = facts.newest?.bytes ?? null;
	const ageMs = facts.newest === null ? null : now.getTime() - facts.newest.atMs;

	// A failed unit is the most direct evidence there is; say so before anything
	// else, and point at the journal rather than making the operator guess.
	if (facts.serviceFailed) {
		return {
			state: 'failing',
			detail:
				'morphit-backup.service is in a FAILED state — inspect it with ' +
				'`sudo journalctl -u morphit-backup.service -e --no-pager`',
			newestName,
			ageMs,
			bytes
		};
	}
	if (facts.newest === null) {
		return {
			state: 'missing',
			detail:
				facts.lastTriggerMs === null
					? 'configured, but no dump has ever been written — start one now with ' +
						'`sudo systemctl start morphit-backup.service` and watch it report a byte count'
					: 'the timer HAS fired but no dump exists — the backup is running and failing; ' +
						'check `sudo journalctl -u morphit-backup.service -e --no-pager`',
			newestName: null,
			ageMs: null,
			bytes: null
		};
	}
	// A dump too small to BE a dump. Checked before the timing rules because it
	// is a direct fact about the artefact rather than an inference from clocks,
	// and because a truncated dump is typically brand new — it would otherwise
	// sail through both the trigger and staleness checks and read as "fresh".
	if (facts.newest.bytes < BACKUP_MIN_PLAUSIBLE_BYTES) {
		return {
			state: 'failing',
			detail:
				`the newest dump is only ${facts.newest.bytes} bytes — far too small to be a real ` +
				'dump, so a run failed and kept the fragment; check ' +
				'`sudo journalctl -u morphit-backup.service -e --no-pager`, and delete the ' +
				'undersized files so they cannot be mistaken for restore points',
			newestName,
			ageMs,
			bytes
		};
	}
	// Fired, but left nothing newer behind: the exact shape of the dash bug.
	if (
		facts.lastTriggerMs !== null &&
		facts.lastTriggerMs > facts.newest.atMs + BACKUP_TRIGGER_SLACK_MS
	) {
		return {
			state: 'failing',
			detail:
				'the timer fired more recently than the newest dump — a run produced nothing; ' +
				'check `sudo journalctl -u morphit-backup.service -e --no-pager`',
			newestName,
			ageMs,
			bytes
		};
	}
	if (ageMs !== null && ageMs > BACKUP_STALE_AFTER_MS) {
		return {
			state: 'stale',
			detail:
				'the newest dump is over a day and a half old — at least one nightly run was missed',
			newestName,
			ageMs,
			bytes
		};
	}
	return { state: 'fresh', detail: 'a recent dump is on disk', newestName, ageMs, bytes };
}

/** The TIMER's last trigger as epoch ms, or null when unavailable.
 *  `--timestamp=unix` is asked for explicitly so the value arrives as `@<secs>`
 *  and never has to be parsed out of a locale-formatted date — the same trap
 *  documented on the canary clock above. Anything unexpected degrades to null,
 *  which only costs the "fired but wrote nothing" check. */
export function readBackupTimerLastTrigger(): number | null {
	let out: string;
	try {
		out = execFileSync(
			'systemctl',
			[
				'show',
				'morphit-backup.timer',
				'--property=LastTriggerUSec',
				'--value',
				'--timestamp=unix',
				'--no-pager'
			],
			{ stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, encoding: 'utf8' }
		);
	} catch {
		return null;
	}
	const secs = /^@(\d+)$/.exec(out.trim())?.[1];
	if (secs === undefined) return null;
	const ms = Number(secs) * 1000;
	return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Gather backup facts from disk + systemd. All I/O lives here. */
export function readBackupFacts(envPath = '/etc/morphit/backup.env'): BackupFacts {
	const serviceFailed = checkService('morphit-backup.service') === 'failed';
	const lastTriggerMs = readBackupTimerLastTrigger();
	if (!existsSync(envPath)) {
		return {
			configured: false,
			readable: false,
			dir: null,
			newest: null,
			lastTriggerMs,
			serviceFailed
		};
	}
	let txt: string;
	try {
		txt = readFileSync(envPath, 'utf8');
	} catch {
		// 640 root:morphit — a different user simply can't look. Not a fault.
		return { configured: true, readable: false, dir: null, newest: null, lastTriggerMs, serviceFailed };
	}
	const raw = /^\s*BACKUP_DIR=(.*)$/m.exec(txt)?.[1]?.trim() ?? '';
	const dir = raw.replace(/^['"]|['"]$/g, '');
	if (dir === '') {
		return { configured: true, readable: false, dir: null, newest: null, lastTriggerMs, serviceFailed };
	}
	let newest: BackupFacts['newest'] = null;
	try {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith('.sql.gz')) continue; // ignore .partial and anything else
			const st = statSync(`${dir}/${name}`);
			if (newest === null || st.mtimeMs > newest.atMs) {
				newest = { name, atMs: st.mtimeMs, bytes: st.size };
			}
		}
	} catch (err) {
		// A backup dir that doesn't exist yet (ENOENT) is NOT a permission
		// problem — it's a fresh node whose first scheduled dump hasn't run
		// (the backup script creates the dir on first run). Report it as
		// readable-but-empty so checkBackups gives the helpful "no dump yet,
		// start one now" message instead of a scary "unreadable". A genuine
		// permission error (EACCES/EPERM — dir is 700 morphit:morphit and we're
		// some other non-root user) stays unreadable.
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return { configured: true, readable: true, dir, newest: null, lastTriggerMs, serviceFailed };
		}
		return { configured: true, readable: false, dir, newest: null, lastTriggerMs, serviceFailed };
	}
	return { configured: true, readable: true, dir, newest, lastTriggerMs, serviceFailed };
}

/** "13h ago" / "2d ago" / "45m ago" — coarse on purpose; this is a glanceable
 *  freshness cue, not an audit trail. */
export function formatBackupAge(ms: number): string {
	const mins = Math.floor(ms / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** Human size for a dump, matching the `ls -lh` shape operators already read. */
export function formatBackupSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// ─── IPFS / IPNS release seeding (cp667) ───────────────────────────
//
// Every instance runs a small Kubo node that PINS the signed release to IPFS and
// REBROADCASTS the on-chain IPNS record to the DHT, so releases stay hosted and
// ipns://<name> stays resolvable as long as ANY instance is alive (Decentraliz-
// ation #2). Nothing tells the operator whether their box is actually doing its
// share — this check does, read-only, from systemd state + the last run result.

/** Read-only last-run result of a (oneshot) unit via `systemctl show`.  The
 *  pin/rebroadcast services carry SuccessExitStatus=0 1, so a transient exit-1
 *  is still Result=success; only a real failure (exit-code/signal/timeout) trips
 *  `failed`. `ranMs` is the age of the last completed run, or null if never run
 *  / unreadable. */
export function readServiceResult(unit: string): { failed: boolean; ranMs: number | null } {
	try {
		const out = execFileSync(
			'systemctl',
			['show', unit, '--property=Result,ExecMainExitTimestamp', '--no-pager'],
			{ stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, encoding: 'utf8' }
		);
		const result = /Result=(\S+)/.exec(out)?.[1] ?? 'success';
		const tsStr = (/ExecMainExitTimestamp=(.*)/.exec(out)?.[1] ?? '').trim();
		let ranMs: number | null = null;
		if (tsStr !== '' && tsStr !== 'n/a') {
			const d = Date.parse(tsStr);
			if (!Number.isNaN(d)) ranMs = Date.now() - d;
		}
		return { failed: result !== 'success', ranMs };
	} catch {
		return { failed: false, ranMs: null };
	}
}

export type IpfsSeedingState = 'ok' | 'degraded' | 'down' | 'not-configured' | 'unknown';

export interface IpfsSeedingFacts {
	daemon: ServiceState;
	pinTimer: ServiceState;
	rebroadcastTimer: ServiceState;
	pinFailed: boolean;
	pinRanMs: number | null;
	rebroadcastFailed: boolean;
	rebroadcastRanMs: number | null;
}

export interface IpfsSeedingStatus {
	readonly state: IpfsSeedingState;
	readonly detail: string;
}

/** Gather the read-only systemd facts for the IPFS pin + IPNS rebroadcast. */
export function readIpfsSeedingFacts(): IpfsSeedingFacts {
	const pin = readServiceResult('morphit-ipfs-pin.service');
	const reb = readServiceResult('morphit-ipns-rebroadcast.service');
	return {
		daemon: checkService('ipfs'),
		pinTimer: checkService('morphit-ipfs-pin.timer'),
		rebroadcastTimer: checkService('morphit-ipns-rebroadcast.timer'),
		pinFailed: pin.failed,
		pinRanMs: pin.ranMs,
		rebroadcastFailed: reb.failed,
		rebroadcastRanMs: reb.ranMs
	};
}

/** Render one degraded-problem kind into the CLI's operator-facing wording
 *  (with the journalctl remediation hint), using this node's facts. */
function opsProblemText(p: SeedingProblem, f: IpfsSeedingFacts): string {
	switch (p) {
		case 'pin-timer':
			return `release-pin timer ${f.pinTimer}`;
		case 'rebroadcast-timer':
			return `IPNS-rebroadcast timer ${f.rebroadcastTimer}`;
		case 'pin-failed':
			return 'last pin FAILED (journalctl -u morphit-ipfs-pin)';
		case 'rebroadcast-failed':
			return 'last IPNS rebroadcast FAILED (journalctl -u morphit-ipns-rebroadcast)';
	}
}

/** Decide whether this node is successfully seeding releases to IPFS/IPNS. PURE.
 *  The STATE decision is the shared classifier (@morphit/node-health) so this
 *  CLI view and the public /v1/health endpoint can never drift (cp707); only
 *  the CLI's richer DETAIL wording (remediation hints + last-run ages) lives
 *  here. */
export function checkIpfsSeeding(f: IpfsSeedingFacts): IpfsSeedingStatus {
	const cls = classifySeeding(f);
	switch (cls.reason) {
		case 'not-configured':
			return {
				state: 'not-configured',
				detail: 'not set up — optional; enable with morphit-ops harden \u2192 \u201cSet up IPFS release hosting\u201d'
			};
		case 'unreadable':
			return { state: 'unknown', detail: 'could not read systemd state (no systemctl?)' };
		case 'daemon-down':
			return {
				state: 'down',
				detail: `Kubo (ipfs) daemon is ${f.daemon}; releases are NOT being seeded. Check: sudo systemctl status ipfs`
			};
		case 'degraded':
			return { state: 'degraded', detail: cls.problems.map((p) => opsProblemText(p, f)).join('; ') };
		case 'ok': {
			const pinAge = f.pinRanMs !== null ? formatBackupAge(f.pinRanMs) : 'pending first run';
			const rebAge = f.rebroadcastRanMs !== null ? formatBackupAge(f.rebroadcastRanMs) : 'pending first run';
			return {
				state: 'ok',
				detail: `pinning the signed release to IPFS (last ${pinAge}) + rebroadcasting the IPNS record to the DHT (last ${rebAge})`
			};
		}
	}
}

// ─── System resources (local host, read-only, non-privileged) ──────
//
// CPU / memory / disk for the box the node runs on, so the operator
// can spot a saturated CPU, a memory squeeze, or a filling disk at a
// glance — often the real reason an indexer starts lagging.  All reads
// are unprivileged: os.cpus()/totalmem(), /proc/meminfo, and statfs
// of the health disk path (MORPHIT_HEALTH_DISK_PATH, default '/')
// never EACCES for a normal user, so this preserves the view's
// "works regardless of file permissions" property.

export interface SystemResources {
	readonly cpuPct: number | null; // 0..100 busy across all cores
	readonly memUsedGB: number | null;
	readonly memTotalGB: number | null;
	readonly memPct: number | null; // 0..100
	readonly diskUsedGB: number | null;
	readonly diskAvailGB: number | null;
	readonly diskTotalGB: number | null;
	readonly diskPct: number | null; // 0..100
}

/** Bytes → GiB, one decimal.  PURE. */
export function bytesToGB(bytes: number): number {
	return Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10;
}

/** Clamp to an integer 0..100.  PURE. */
export function clampPct(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}

/** Aggregate idle + total jiffies across all cores.  PURE given input. */
export function cpuTimesTotals(
	list: ReadonlyArray<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>
): { idle: number; total: number } {
	let idle = 0;
	let total = 0;
	for (const cpu of list) {
		const t = cpu.times;
		idle += t.idle;
		total += t.user + t.nice + t.sys + t.idle + t.irq;
	}
	return { idle, total };
}

/** Busy% from two cpu-times snapshots (b after a).  null if no delta. PURE. */
export function cpuBusyPct(
	a: { idle: number; total: number },
	b: { idle: number; total: number }
): number | null {
	const dTotal = b.total - a.total;
	const dIdle = b.idle - a.idle;
	if (dTotal <= 0) return null;
	return clampPct((1 - dIdle / dTotal) * 100);
}

/** Parse MemTotal/MemAvailable (bytes) from /proc/meminfo text.  null
 *  if either line is absent (non-Linux, or no MemAvailable).  PURE. */
export function parseMeminfo(text: string): { totalBytes: number; availBytes: number } | null {
	const mt = text.match(/^MemTotal:\s+(\d+)\s+kB/m);
	const ma = text.match(/^MemAvailable:\s+(\d+)\s+kB/m);
	if (!mt || !ma) return null;
	return { totalBytes: Number(mt[1]) * 1024, availBytes: Number(ma[1]) * 1024 };
}

/** Sample the host once.  Never throws — any failed metric is left
 *  null and the view degrades to "unavailable" for that line. */
export async function readSystemResources(): Promise<SystemResources> {
	let cpuPct: number | null = null;
	let memUsedGB: number | null = null;
	let memTotalGB: number | null = null;
	let memPct: number | null = null;
	let diskUsedGB: number | null = null;
	let diskAvailGB: number | null = null;
	let diskTotalGB: number | null = null;
	let diskPct: number | null = null;

	// CPU: two snapshots ~150ms apart → busy fraction.
	try {
		const a = cpuTimesTotals(cpus());
		await new Promise((r) => setTimeout(r, 150));
		const b = cpuTimesTotals(cpus());
		cpuPct = cpuBusyPct(a, b);
	} catch {
		/* leave null */
	}

	// Memory: prefer /proc/meminfo MemAvailable (counts reclaimable cache
	// as free, the honest "used"); fall back to os.totalmem/freemem.
	try {
		let totalBytes: number;
		let availBytes: number;
		let parsed: { totalBytes: number; availBytes: number } | null = null;
		try {
			parsed = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'));
		} catch {
			parsed = null;
		}
		if (parsed) {
			totalBytes = parsed.totalBytes;
			availBytes = parsed.availBytes;
		} else {
			totalBytes = totalmem();
			availBytes = freemem();
		}
		const usedBytes = Math.max(0, totalBytes - availBytes);
		memTotalGB = bytesToGB(totalBytes);
		memUsedGB = bytesToGB(usedBytes);
		if (totalBytes > 0) memPct = clampPct((usedBytes / totalBytes) * 100);
	} catch {
		/* leave null */
	}

	// Disk: the filesystem holding the node's DATA (cp708).  Defaults to
	// `/` (the VPS's drive on a single-disk box; Docker volumes / the DB
	// live under it), but a split-volume node points
	// MORPHIT_HEALTH_DISK_PATH at its data mount so this figure tracks the
	// volume that actually fills.  Falls back to `/` if that path can't be
	// stat'd, so a stray env value never blanks the figure.  statfs is
	// Node 18.15+.
	try {
		const diskPath = resolveHealthDiskPath(process.env);
		let st;
		try {
			st = await statfs(diskPath);
		} catch (e) {
			if (diskPath === '/') throw e;
			st = await statfs('/');
		}
		const bsize = Number(st.bsize);
		const totalBytes = Number(st.blocks) * bsize;
		const availBytes = Number(st.bavail) * bsize; // usable by non-root
		const freeBytes = Number(st.bfree) * bsize; // incl. root-reserved
		const usedBytes = Math.max(0, totalBytes - freeBytes);
		diskTotalGB = bytesToGB(totalBytes);
		diskAvailGB = bytesToGB(availBytes);
		diskUsedGB = bytesToGB(usedBytes);
		// `df`-style use%: used relative to (used + available-to-non-root),
		// not raw total — matches `df -h /` (reserved blocks are excluded
		// from the denominator), the figure an operator cross-checks.
		const usableBytes = usedBytes + availBytes;
		if (usableBytes > 0) diskPct = clampPct((usedBytes / usableBytes) * 100);
	} catch {
		/* leave null */
	}

	return {
		cpuPct,
		memUsedGB,
		memTotalGB,
		memPct,
		diskUsedGB,
		diskAvailGB,
		diskTotalGB,
		diskPct
	};
}

/** Colour a string by usage %: red ≥90, yellow ≥80, plain below.  PURE
 *  given the colour helper. */
export function pctColored(c: ReturnType<typeof color>, pct: number | null, s: string): string {
	if (pct === null) return s;
	return pct >= 90 ? c.red(s) : pct >= 80 ? c.yellow(s) : s;
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
	const backups = checkBackups(readBackupFacts(), now);
	const aide = checkAideBaseline();
	const tls = checkTlsCert('/etc/letsencrypt/live', () => probeServedCertDaysLeft());
	const matrixMxid = readMatrixMxid();
	const ipfsSeeding = checkIpfsSeeding(readIpfsSeedingFacts());

	// Local host CPU / memory / disk (read-only, non-privileged).
	const sys = await readSystemResources();
	// Per-endpoint RPC health (transport + latency), best-effort — only when the
	// indexer is reachable. Falls back to the summary count on any failure.
	const rpcEndpointRows =
		indexer.kind === 'synced' || indexer.kind === 'behind' || indexer.kind === 'unknown'
			? await fetchRpcEndpoints(indexerProbe.url)
			: null;

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
					system: {
						cpu_pct: sys.cpuPct,
						mem_pct: sys.memPct,
						mem_used_gb: sys.memUsedGB,
						mem_total_gb: sys.memTotalGB,
						disk_pct: sys.diskPct,
						disk_used_gb: sys.diskUsedGB,
						disk_avail_gb: sys.diskAvailGB,
						disk_total_gb: sys.diskTotalGB
					},
					services: Object.fromEntries(services.map((s) => [s.unit, s.state])),
					aide_baseline: { state: aide.state, detail: aide.detail },
					tls_cert: { state: tls.state, days_left: tls.daysLeft, detail: tls.detail },
					matrix_alert_mxid: matrixMxid,
					canary,
					backups: {
						state: backups.state,
						newest_name: backups.newestName ?? null,
						bytes: backups.bytes ?? null,
						age_ms: backups.ageMs ?? null,
						detail: backups.detail
					},
					// cp667 — is this node doing its share of hosting the release +
					// keeping IPNS alive? Zabbix can alert on state !== 'ok'/'not-configured'.
					ipfs_seeding: {
						state: ipfsSeeding.state,
						detail: ipfsSeeding.detail
					}
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
		indexer.kind === 'synced'
			? c.green('✓')
			: indexer.kind === 'behind' || indexer.kind === 'unknown'
				? c.yellow('⚠')
				: c.red('✗');
	console.log('');
	console.log(`  ${c.bold('Indexer')}   ${c.dim(safe(indexerProbe.url))}`);
	console.log(`  ${iTag} ${indexer.message}`);
	const s = indexer.summary;
	if (s !== null) {
		// When no RPC is reachable the indexer can't see the chain, so sync state,
		// chain head, and lag are all UNKNOWN — don't render a misleading
		// "synced / 0 blocks" from stale fields.
		const syncLabel = s.rpcAllDown
			? c.yellow('unknown')
			: s.synced
				? c.green('synced')
				: c.yellow('behind');
		console.log(`      Sync state:    ${syncLabel}`);
		console.log(`      Last block:    ${s.indexedBlock ?? 'unknown'}`);
		console.log(`      Chain head:    ${s.rpcAllDown ? 'unknown' : (s.chainHeadBlock ?? 'unknown')}`);
		const lag = s.lagBlocks;
		const lagStr = s.rpcAllDown || lag === null ? 'unknown' : `${lag} block${lag === 1 ? '' : 's'}`;
		console.log(`      Lag:           ${!s.rpcAllDown && lag !== null && lag > 0 ? c.yellow(lagStr) : lagStr}`);
		if (s.lagNote !== null && !s.rpcAllDown) console.log(`                     ${c.dim(s.lagNote)}`);
		// Count reachable from the per-endpoint rows the operator actually sees (a
		// fresh active probe), not the pool's passive health count — otherwise the
		// header ("7/10") can disagree with the ✓/✗ rows below it ("8 green").
		const rowsHealthy =
			rpcEndpointRows !== null && rpcEndpointRows.length > 0
				? { healthy: rpcEndpointRows.filter((r) => r.healthy).length, total: rpcEndpointRows.length }
				: null;
		const rpcHealthy = rowsHealthy?.healthy ?? s.rpcHealthy;
		const rpcTotal = rowsHealthy?.total ?? s.rpcTotal;
		const rpcStr =
			rpcHealthy !== null && rpcTotal !== null ? `${rpcHealthy}/${rpcTotal} reachable` : 'unknown';
		console.log(`      Blurt RPC:     ${rpcHealthy === 0 ? c.red(rpcStr) : rpcStr}`);
		// Per-endpoint breakdown (transport · host · latency · reachable) so the
		// operator sees WHICH nodes are up — including the Tor/I2P/local ones, not
		// just a clearnet count. Rendered only when the indexer served the list.
		if (rpcEndpointRows !== null && rpcEndpointRows.length > 0) {
			for (const r of rpcEndpointRows) {
				const badge = transportLabel(r.transport).padEnd(8);
				const host = shortEndpoint(r.url).padEnd(30);
				const lat = r.healthy && r.latencyMs !== null ? `${r.latencyMs} ms`.padStart(7) : '   —   ';
				const mark = r.healthy ? c.green('\u2713') : c.dim('\u2717 warming up / unreachable');
				const line = `${c.dim(badge)} ${host} ${r.healthy ? lat : c.dim(lat)}  ${mark}`;
				console.log(`                     ${line}`);
			}
		}
		// cp684 — make the FAST catch-up explicit: a behind node fetches blocks
		// from all reachable endpoints at once (one prefetch window per endpoint).
		if (!s.synced && s.rpcHealthy !== null && s.rpcHealthy > 0) {
			console.log(
				`                     ${c.dim(`catching up in parallel from ${s.rpcHealthy} node${s.rpcHealthy === 1 ? '' : 's'} at once`)}`
			);
		}
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
		// cp381 — per-source price-feed health (operator-only; from the
		// top-level `price_feeds` block, gated by the X-Morphit-Local-Health
		// header the public edge strips).  For crypto feeds, one line per
		// provider — status, the price that provider reported, and its
		// name — so it's obvious which upstream is serving and which is
		// down.  FX has no single per-source price (a whole currency
		// table), so it stays a rolled-up summary.
		if (s.priceFeeds !== null) {
			const denom = s.priceFeed?.denomination ?? 'USD';
			for (const f of s.priceFeeds.feeds) {
				if (f.isCrypto) {
					for (const src of f.sources) {
						const status = src.ok ? c.green('on  ') : c.red('down');
						const px =
							src.ok && src.price !== null
								? `1 ${f.label} \u2248 ${src.price} ${denom}`
								: `1 ${f.label} \u2248 ${c.dim('??')} ${denom}`;
						const age =
							src.lastOkAgeS === null
								? src.ok
									? ''
									: c.dim(' (never answered)')
								: c.dim(` (${fmtUptime(src.lastOkAgeS)} ago)`);
						console.log(
							`      Price feed:    ${status} \u2014 ${px} (${safe(src.name)})${age}`
						);
					}
					if (f.outlierRejected) {
						console.log(
							`                     ${c.yellow('⚠ provider disagreement')} ${c.dim('— an outlier was dropped from the median')}`
						);
					}
				} else {
					// FX feed: rolled-up summary (no single per-source price).
					const allUp = f.total > 0 && f.up === f.total;
					const tag = f.stale
						? c.red('✗')
						: !allUp || f.outlierRejected
							? c.yellow('⚠')
							: c.green('✓');
					const cnt = `${f.up}/${f.total} src`;
					const fresh = f.stale ? c.yellow('STALE') : 'fresh';
					const dis = f.outlierRejected ? ` · ${c.yellow('⚠ disagreement')}` : '';
					console.log(
						`      FX feed:       ${tag} ${cnt} · ${fresh} · ${c.dim(safe(f.source))}${dis}`
					);
					for (const src of f.sources.filter((x) => !x.ok)) {
						const age = src.lastOkAgeS === null ? 'never' : `${fmtUptime(src.lastOkAgeS)} ago`;
						console.log(`            ${c.dim(`↳ ${safe(src.name)} down (last ok: ${age})`)}`);
					}
				}
			}
		} else if (s.priceFeed !== null && s.priceFeed.enabled) {
			console.log(
				`      ${c.dim('Price feeds:   per-source status unavailable (older indexer build)')}`
			);
		}
		// v1.7.0 — head-block fast path (operator-only; same top-level block +
		// X-Morphit-Local-Health gate as the price feeds above).
		//
		// This used to lead with on/off. That line is gone with the knob it
		// reported (ADR-0051): it could only ever say "on", and a status field
		// that can't vary is noise at best and misleading at worst — an operator
		// who reads "on" infers "off" is a thing they might want.
		//
		// What replaces it is the number that actually matters: how far behind
		// the chain head the tailer is. "Running" is not the question; "is it
		// KEEPING UP" is. A tailer that is running but 400 blocks behind is a
		// broken tailer, and the old line called that one "on".
		if (s.fastPath !== null) {
			const fp = s.fastPath;
			let line: string;
			if (!fp.running) {
				line = c.yellow('starting \u2014 not tailing yet');
			} else if (fp.scannedHead === null || fp.scannedHead <= 0) {
				line = c.yellow('tailing \u2014 head not established yet');
			} else {
				// Lag against the chain head we already read for this same body,
				// so the two numbers can never disagree.
				const lag = s.chainHeadBlock !== null ? s.chainHeadBlock - fp.scannedHead : null;
				const lagTxt =
					lag === null
						? ` @ head block ${fp.scannedHead}`
						: lag <= FASTPATH_HEALTHY_LAG_BLOCKS
							? ` ${c.dim(`\u2014 ${lag} block(s) behind head`)}`
							: ` ${c.yellow(`\u2014 ${lag} blocks behind head`)}`;
				const delivered = fp.emitted !== null ? ` ${c.dim(`(${fp.emitted} delivered)`)}` : '';
				const state = lag !== null && lag > FASTPATH_HEALTHY_LAG_BLOCKS ? c.yellow('lagging') : c.green('keeping up');
				line = `${state}${lagTxt}${delivered}`;
			}
			console.log(`      Fast path:     ${line}`);
			if (fp.lastError !== null) {
				console.log(`            ${c.dim(`↳ last error: ${fp.lastError}`)}`);
			}
		} else {
			// Indexer up but no fastpath block → a pre-fast-path build.
			console.log(
				`      ${c.dim('Fast path:     status unavailable (older indexer build)')}`
			);
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

	// ── System resources block (local host, read-only) ──
	console.log('');
	console.log(`  ${c.bold('System')}    ${c.dim('(this host)')}`);
	console.log(
		`      CPU:           ${
			sys.cpuPct === null ? c.dim('unavailable') : pctColored(c, sys.cpuPct, `${sys.cpuPct}%`)
		}`
	);
	console.log(
		`      Memory:        ${
			sys.memUsedGB === null || sys.memTotalGB === null
				? c.dim('unavailable')
				: pctColored(
						c,
						sys.memPct,
						`${sys.memUsedGB} / ${sys.memTotalGB} GB (${sys.memPct ?? '?'}%)`
					)
		}`
	);
	console.log(
		`      Disk (/):      ${
			sys.diskUsedGB === null || sys.diskTotalGB === null
				? c.dim('unavailable')
				: pctColored(
						c,
						sys.diskPct,
						`${sys.diskUsedGB} / ${sys.diskTotalGB} GB used (${sys.diskPct ?? '?'}%), ${
							sys.diskAvailGB ?? '?'
						} GB free`
					)
		}`
	);

	// ── Services block ──
	console.log('');
	console.log(`  ${c.bold('Services')}  ${c.dim('(systemd, read-only)')}`);
	for (const svc of services) {
		// matrix-bot: an installed-but-tokenless bot is STAGED, not broken — the
		// unit + deps are in place and it just needs a token. Show that plainly
		// instead of the raw "stopped"/"not installed" systemd state.
		if (svc.unit === 'morphit-matrix-bot') {
			const mb = readMatrixBotSetup();
			if (mb.installed && !mb.hasToken) {
				console.log(
					`      ${svc.unit} ${c.yellow('\u26a0 token needed')} ${c.dim('\u2014 add it with  sudo morphit-ops \u2192 Matrix alerts')}`
				);
				continue;
			}
		}
		console.log(serviceLine(c, svc.unit, svc.state));
	}
	// matrix-bot: confirm it's DMing the address the operator entered, not just
	// that the service is up (cp684).
	{
		const mb = services.find((s) => s.unit === 'morphit-matrix-bot');
		if (mb !== undefined && (mb.state === 'active' || mb.state === 'activating')) {
			console.log(
				matrixMxid !== null
					? `                     ${c.dim(`alerts → ${matrixMxid}`)}`
					: `                     ${c.yellow('alert address NOT set — set MORPHIT_MATRIX_BOT_ALERT_MXID')}`
			);
		}
	}
	// HTTPS / TLS certificate (cp684).
	{
		const tlsTag =
			tls.state === 'valid'
				? c.green('✓')
				: tls.state === 'expiring'
					? c.yellow('⚠')
					: tls.state === 'expired'
						? c.red('✗')
						: c.dim('–');
		console.log(`      ${tlsTag} ${'HTTPS / TLS cert'.padEnd(22)} ${c.dim(tls.detail)}`);
	}
	// AIDE baseline: a deferred background one-shot that self-removes on success,
	// so it needs its own line (raw service state would read "not installed" once
	// done). A background FAILURE surfaces here even without Matrix alerts.
	{
		const aideTag =
			aide.state === 'built'
				? c.green('✓')
				: aide.state === 'failed'
					? c.red('✗')
					: aide.state === 'building'
						? c.yellow('⋯')
						: c.dim('–');
		console.log(`      ${aideTag} ${'AIDE baseline'.padEnd(22)} ${c.dim(aide.detail)}`);
	}

	// ── Backups block ──
	// Deliberately sits next to Services and Canary: all three answer "is the
	// boring background thing that protects me actually happening?".
	console.log('');
	const backupTag =
		backups.state === 'fresh'
			? c.green('✓')
			: backups.state === 'failing' || backups.state === 'missing'
				? c.red('✗')
				: backups.state === 'not-configured'
					? c.dim('○')
					: c.yellow('⚠');
	console.log(`  ${c.bold('Backups')}   ${backupTag} ${backups.state}`);
	if (backups.newestName !== null && backups.ageMs !== null && backups.bytes !== null) {
		console.log(
			`      Newest dump:   ${safe(backups.newestName)} ` +
				`${c.dim(`(${formatBackupSize(backups.bytes)}, ${formatBackupAge(backups.ageMs)})`)}`
		);
	}
	console.log(`      ${c.dim(backups.detail)}`);

	// ── Canary block ──
	console.log('');
	const canaryTag =
		canary.state === 'fresh'
			? c.green('✓')
			: canary.state === 'overdue' || canary.state === 'missing'
				? c.red('✗')
				: c.yellow('⚠');
	console.log(`  ${c.bold('Canary')}    ${canaryTag} ${canary.state}`);
	if (canary.validThrough !== null) console.log(`      Valid through: ${safe(canary.validThrough)}`);
	console.log(`      ${c.dim(canary.detail)}`);

	// ── IPFS / IPNS release seeding block ──
	// Is this node doing its share of hosting the release + keeping the IPNS
	// name alive? (Decentralization #2 — the network survives on it.)
	console.log('');
	const seedTag =
		ipfsSeeding.state === 'ok'
			? c.green('✓')
			: ipfsSeeding.state === 'down'
				? c.red('✗')
				: ipfsSeeding.state === 'not-configured'
					? c.dim('○')
					: ipfsSeeding.state === 'unknown'
						? c.dim('?')
						: c.yellow('⚠');
	console.log(`  ${c.bold('IPFS/IPNS release seeding')}  ${seedTag} ${ipfsSeeding.state}`);
	console.log(`      ${c.dim(ipfsSeeding.detail)}`);

	console.log('');
	console.log('━'.repeat(60));
	console.log('');
	return indexer.exitCode;
}
