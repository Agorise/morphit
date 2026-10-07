/**
 * Post-upgrade self-heal for the reverse-proxy containers of an INSTALLED node
 * (v1.20.0 deep review: C1 privacy, C2 headers, B11 host.docker.internal;
 * reworked in wave 4 against morphit.io's real, hand-made stack).
 *
 * WHY A HEAL. `morphit-ops upgrade` does not re-render the Ansible templates,
 * and morphit.io's stack (/opt/bunkerweb: nginx, crowdsec, certbot, redis,
 * postgres, onion-service, frontend …) was set up by hand. So the v1.20.0
 * fixes to ops/bunkerweb/{docker-compose.yml,bunkerweb.env.example} and the
 * Ansible templates would reach only NEW installs. (The frontend's nginx.conf
 * is delivered by the existing frontend config heal in upgrade.ts, which runs
 * first; this heal VERIFIES what the running frontend serves — see the end.)
 *
 * WHICH CONTAINERS — by evidence, never by name. The frontend is the one
 * container that mounts this install's web build. The public edge is the one
 * running container whose IMAGE is bunkerity/bunkerweb (not -scheduler, -ui or
 * -autoconf); with several, the one publishing host port 443. Anything else —
 * no such container, several, a container Compose did not start — and the
 * edge is left alone with a calm note. On morphit.io a name match picked the
 * onion service, whose re-creation can change the .onion address.
 *
 * WHAT IT CHANGES, and only when it is missing:
 *  - the env file the edge's Compose service reads (`env_file`, as Compose
 *    itself reports it): a LOG_FORMAT that names no visitor, and Morphit's
 *    CONTENT_SECURITY_POLICY / PERMISSIONS_POLICY / REFERRER_POLICY /
 *    X_FRAME_OPTIONS. A value the operator set is kept, except a LOG_FORMAT
 *    that logs addresses, and the BunkerWeb features that send visitor data
 *    to third parties (BunkerNet, DNSBL, the reverse-DNS black/white/grey
 *    lists, the anonymous report, a third-party or misplaced anti-bot), which
 *    are always turned off (lib/bunkerwebPrivacy.ts). Those are then checked
 *    where BunkerWeb really reads them: the variables.env its scheduler
 *    generated inside the edge container, and the scheduler's environment.
 *  - the Compose files the containers came from (ALL of them, from their own
 *    labels): the edge keeps no Docker log (its error, ban and ModSecurity
 *    lines name visitors), the frontend's log is bounded, and
 *    host.docker.internal → the gateway of the network the frontend is REALLY
 *    on (observed) instead of docker0's host-gateway. A service whose logging
 *    the operator configured keeps it.
 *  - no country list (no Morphit instance blocks by country), whoever set it:
 *    what BunkerWeb runs with (variables.env) is read after every run; a list
 *    saved in BunkerWeb's web UI — which BunkerWeb never lets an env file
 *    replace — is removed from its database inside the scheduler (after a
 *    backup; lib/bunkerwebPrivacy.ts COUNTRY_DB_PY) and seen gone; any other
 *    (an Autoconf label, a compose `environment:` entry) is named with where
 *    to clear it. When that cannot be checked, the result says so (never
 *    "nothing to change").
 *  - CrowdSec: when a CrowdSec container reads the edge's log (its acquisition
 *    names the edge, or cannot be read), or any other container can read logs
 *    through the Docker socket, `driver: none` would blind it. Then the edge
 *    keeps a small rotating log instead (`local`, 5 MB × 1: addresses stay in
 *    it briefly) and LOG_FORMAT is left as it is, and the heal says so.
 *
 * NEVER BREAK THE SITE. Only the edge, the frontend and a BunkerWeb scheduler
 * that reads the SAME env file (BunkerWeb 1.5 builds its config when the
 * scheduler starts) are ever recreated, with `up -d --no-deps`. The edits are
 * made on bytes (a BOM, CRLF and non-UTF-8 bytes survive; mixed line endings
 * are left alone). After writing, Compose's own merged model must show exactly
 * the planned values (an override file or an `environment:` entry can win),
 * or the originals go back and nothing restarts. Then ONE `up`, and what was
 * changed is observed: the containers run on the same published ports, their
 * log drivers, extra hosts and environment are as planned, the edge's nginx
 * uses the new log format, a Referrer-Policy the heal set is served, and the
 * frontend still reaches the indexer. Otherwise the originals are restored
 * byte for byte, the same containers are brought back, and running + ports
 * are checked again before anything says the site is fine.
 *
 * ON TIME. The whole self-heal child is killed at SELF_HEAL_CHILD_TIMEOUT_MS.
 * This heal gives itself at most HEAL_BUDGET_MS (and never past that kill),
 * starts a change only with time for the change, its check AND a rollback,
 * and restores the files if it is terminated mid-change.
 *
 * ONE ADDRESS TO THE INDEXER, AS SERVED. On every run the frontend's
 * EFFECTIVE config is read from inside the running container (`nginx -T`) and
 * every location that proxies to the relay (:8080) or the indexer (:8081) must
 * send `X-Forwarded-For $morphit_relay_xff` and an empty X-Real-IP — else the
 * indexer's per-address limits key on whatever a visitor typed. The same dump
 * must also show a page CSP with no inline script or eval, `server_tokens off`,
 * and every proxied location clearing the visitor-set internal headers
 * (VISITOR_HEADERS_CLEARED), and a missing file answered with 404. A config file
 * newer than the running nginx gets a graceful reload; a container that does
 * not have it is rebuilt ONCE (time permitting) and checked again; otherwise a
 * calm warning names the exact command.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readSchedulerCycle, dockerLogsSince, type SchedulerCycle } from './bunkerwebScheduler.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { torSocksFromEnv } from './torOnlyOsHeal.ts';
import {
	bundledBaseFile,
	frontendBaseState,
	loadBundledFrontendBase,
	withTagOnlyFrom
} from './frontendBaseImage.ts';
import {
	BUNKERWEB_PRIVACY_KEYS,
	BUNKERWEB_PRIVACY_SETTINGS,
	COUNTRY_DB_PY,
	bunkerwebSettingsProblems,
	countryChangeLine,
	countryKeyOf,
	countryListsInSettings,
	envEntries,
	isCountryListKey,
	parseCountryDb,
	parseCountryRemoval,
	planBunkerwebPrivacy,
	type CountryDb,
	type CountryRow
} from './bunkerwebPrivacy.ts';

// ── Canonical values (kept equal to ops/bunkerweb/bunkerweb.env.example by the
//    vitest; the csp-header-consistency smoke keeps that file equal to the rest).
export const MORPHIT_CSP =
	"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://rpc.drakernoise.com https://blurtrpc.dagobert.uk https://rpc.blurt.blog https://rpc.beblurt.com https://blurt-rpc.saboin.com; media-src 'none'; object-src 'none'; child-src 'none'; frame-src 'none'; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'";
/** The base image ops/bunkerweb/frontend/Dockerfile pins (its label; the
 *  vitest keeps the two equal). A frontend built from another is rebuilt. */
export const FRONTEND_BASE_LABEL = 'org.morphit.frontend-base';
export const FRONTEND_BASE =
	'nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94';
export const MORPHIT_PERMISSIONS_POLICY =
	'camera=(self), microphone=(), geolocation=(), interest-cohort=()';
export const MORPHIT_LOG_FORMAT = `'$host [$time_local] "$request_method $uri" $status $body_bytes_sent'`;

/** upgrade.ts kills the whole `__post-upgrade-selfheal` child after this. */
export const SELF_HEAL_CHILD_TIMEOUT_MS = 300_000;
/** This heal's own ceiling, compose up and rollback included. */
export const HEAL_BUDGET_MS = 120_000;

/** nginx variables that identify a visitor. */
const ADDRESS_VARS =
	/\$(remote_addr|binary_remote_addr|http_x_forwarded_for|http_x_real_ip|realip_remote_addr|proxy_add_x_forwarded_for)\b/;

export interface Plan {
	readonly text: string;
	readonly changes: readonly string[];
	/** Compose services this plan edits. */
	readonly touched?: readonly string[];
	/** What stops applying because of a change (said once, plainly). */
	readonly notices?: readonly string[];
}

// ─── bytes ──────────────────────────────────────────────────────────────

export interface DecodedText {
	/** latin1-decoded (one char per byte), BOM removed, CRLF → LF. */
	readonly text: string;
	readonly bom: boolean;
	readonly crlf: boolean;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Bytes → text for editing, keeping every byte recoverable. Mixed or bare-CR
 *  line endings → null (left alone). PURE. */
export function decodeConfig(buf: Buffer): DecodedText | null {
	const bom = buf.length >= 3 && buf.subarray(0, 3).equals(BOM);
	const body = buf.subarray(bom ? 3 : 0).toString('latin1');
	const crlf = body.includes('\r\n');
	if (/\r(?!\n)/.test(body) || (crlf && /(^|[^\r])\n/.test(body))) return null;
	return { text: crlf ? body.replace(/\r\n/g, '\n') : body, bom, crlf };
}

/** The inverse of decodeConfig: `encodeConfig(decodeConfig(b).text, d)`
 *  equals `b`. Throws on a character that is not one byte (our insertions are
 *  ASCII). PURE. */
export function encodeConfig(text: string, d: DecodedText): Buffer {
	if (/[^\x00-\xff]/.test(text)) throw new Error('non-byte character in an edited config');
	const body = Buffer.from(d.crlf ? text.replace(/\n/g, '\r\n') : text, 'latin1');
	return d.bom ? Buffer.concat([BOM, body]) : body;
}

// ─── bunkerweb.env ──────────────────────────────────────────────────────

/** Missing keys are appended; an operator's own value is kept, except a
 *  LOG_FORMAT that logs addresses (untouched with `keepLogFormat`) and the
 *  features that send visitor data off the box (always off). PURE. */
export function planBunkerwebEnv(
	text: string,
	opts: {
		keepLogFormat?: boolean;
		/** Re-point REVERSE_PROXY_HOST keys that send to one of `hosts` on :80
		 *  (or no port) at `port` — the frontend's edge listener. */
		edgeTarget?: { readonly hosts: readonly string[]; readonly port: number };
	} = {}
): Plan {
	let out = text;
	const changes: string[] = [];
	if (opts.edgeTarget) {
		const { hosts, port } = opts.edgeTarget;
		out = out.replace(
			/^((?:[A-Za-z0-9.-]+_)?REVERSE_PROXY_HOST(?:_\d+)?)=(.*)$/gm,
			(line, key: string, raw: string) => {
				const m = /^http:\/\/([^/:\s]+)(?::(\d+))?(\/\S*)?$/.exec(envFileValue(raw));
				if (!m || !hosts.includes(m[1]!) || (m[2] ?? '80') !== '80') return line;
				changes.push(
					`BunkerWeb -> the frontend's edge port :${port} (${key}: each visitor gets their own rate-limit bucket)`
				);
				return `${key}=http://${m[1]}:${port}${m[3] ?? ''}`;
			}
		);
	}
	const get = (key: string): string | null => {
		const m = new RegExp(`^${key}=(.*)$`, 'm').exec(out);
		return m ? (m[1] ?? '') : null;
	};
	const set = (key: string, val: string): void => {
		if (new RegExp(`^${key}=`, 'm').test(out)) {
			out = out.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${val}`);
		} else {
			out = `${out.replace(/\n*$/, '')}\n${key}=${val}\n`;
		}
	};
	if (!opts.keepLogFormat) {
		const lf = get('LOG_FORMAT');
		if (lf === null || lf.trim() === '' || ADDRESS_VARS.test(lf) || !lf.trim().startsWith("'")) {
			set('LOG_FORMAT', MORPHIT_LOG_FORMAT);
			changes.push('BunkerWeb access log: no visitor addresses (LOG_FORMAT)');
		}
	}
	const headers: Array<[string, string, string]> = [
		['CONTENT_SECURITY_POLICY', MORPHIT_CSP, 'Content-Security-Policy'],
		[
			'PERMISSIONS_POLICY',
			MORPHIT_PERMISSIONS_POLICY,
			'Permissions-Policy (camera stays allowed for the QR scanner)'
		],
		['REFERRER_POLICY', 'no-referrer', 'Referrer-Policy: no-referrer'],
		['X_FRAME_OPTIONS', 'DENY', 'X-Frame-Options: DENY']
	];
	for (const [key, val, what] of headers) {
		const cur = get(key);
		if (cur === null || cur.trim() === '') {
			set(key, val);
			changes.push(`BunkerWeb header: ${what}`);
		} else if (
			key === 'CONTENT_SECURITY_POLICY' &&
			cur.trim() !== val &&
			isMorphitCsp(envFileValue(cur))
		) {
			// An earlier release's policy (inline script and eval allowed, or an
			// older node list): replaced. An operator's own policy is kept.
			set(key, val);
			changes.push('BunkerWeb header: Content-Security-Policy without inline script or eval');
		}
	}
	const privacy = planBunkerwebPrivacy(out);
	out = privacy.text;
	changes.push(...privacy.changes);
	return { text: out, changes, notices: privacy.notices };
}

/** An env-file value as Compose hands it to the container: surrounding single
 *  quotes are literal-text quotes (no `$` substitution), double quotes are
 *  stripped. Only the shapes the heal writes need to be exact. PURE. */
export function envFileValue(raw: string): string {
	const v = raw.trim();
	if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
	if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
	return v;
}

/** The entries of an env file, as Compose reads them (last one wins; every
 *  form Compose accepts — `KEY = v`, `KEY: v`, a key that starts with a digit
 *  such as `3dshop.example_BLACKLIST_COUNTRY` — see envEntries). PURE. */
export function envFileEntries(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of envEntries(text)) out.set(e.key, e.value);
	return out;
}

/** The REVERSE_PROXY_HOST values of a BunkerWeb env, by key. PURE. */
function reverseProxyHosts(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const [k, v] of envFileEntries(text))
		if (/^(?:[A-Za-z0-9.-]+_)?REVERSE_PROXY_HOST(?:_\d+)?$/.test(k)) out.set(k, v);
	return out;
}

/** The SERVER_NAME a BunkerWeb env serves (first name), or null. PURE. */
export function serverNameOf(envText: string): string | null {
	const m = /^SERVER_NAME=(.*)$/m.exec(envText);
	const v =
		(m?.[1] ?? '')
			.trim()
			.replace(/^["']|["']$/g, '')
			.split(/\s+/)[0] ?? '';
	return v === '' || /\{\{/.test(v) ? null : v;
}

// ─── compose file ───────────────────────────────────────────────────────

const EDGE_LOGGING_NONE = ['    logging:', '      driver: none'];
const EDGE_LOGGING_BOUNDED = [
	'    logging:',
	'      driver: local',
	'      options:',
	'        max-size: "5m"',
	'        max-file: "1"'
];
const FRONTEND_LOGGING = [
	'    logging:',
	'      driver: local',
	'      options:',
	'        max-size: "1m"',
	'        max-file: "2"'
];

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** [start, end) line range of a top-level service block `  <name>:` under
 *  `services:`, or null. Services are indented two spaces (every Morphit
 *  compose layout, and Docker's own examples). PURE. */
export function serviceRange(lines: readonly string[], name: string): [number, number] | null {
	const svc = lines.findIndex((l) => /^services:\s*$/.test(l));
	if (svc < 0) return null;
	let start = -1;
	for (let i = svc + 1; i < lines.length; i++) {
		const l = lines[i]!;
		if (/^[A-Za-z_]/.test(l)) break; // next top-level key (a `#` comment or a Jinja `{% %}` line is not one)
		if (new RegExp(`^  ["']?${escRe(name)}["']?:\\s*$`).test(l)) {
			start = i;
			break;
		}
	}
	if (start < 0) return null;
	let end = start + 1;
	// Ends at the next service or top-level key; comments and Jinja lines at any
	// indent do not end it.
	while (end < lines.length && !/^ {0,2}[A-Za-z_"']/.test(lines[end]!)) end++;
	return [start, end];
}

/** Does this compose text define `service`? PURE. */
export function serviceDefined(text: string, service: string): boolean {
	return serviceRange(text.split('\n'), service) !== null;
}

/** Does this compose text set `logging:` for `service`? PURE. */
export function serviceHasLogging(text: string, service: string): boolean {
	const lines = text.split('\n');
	const r = serviceRange(lines, service);
	return r !== null && lines.slice(r[0] + 1, r[1]).some((l) => /^    logging:/.test(l));
}

/**
 * Add the logging settings to the edge / frontend services when this text has
 * none for them (and `logging` allows it for this file), and point
 * host.docker.internal at `gateway` in those services. Returns the edited text,
 * what changed and which services. An unrecognised layout is left alone. PURE.
 */
export function planCompose(
	text: string,
	services: { readonly edge: string | null; readonly frontend: string | null },
	gateway: string | null,
	opts: {
		readonly edgeLog?: 'none' | 'bounded';
		readonly logging?: { readonly edge?: boolean; readonly frontend?: boolean };
	} = {}
): Plan {
	let lines = text.split('\n');
	const changes: string[] = [];
	const touched = new Set<string>();
	const addLogging = (name: string, block: readonly string[], what: string): void => {
		const r = serviceRange(lines, name);
		if (!r) return;
		const body = lines.slice(r[0] + 1, r[1]);
		if (body.some((l) => /^    logging:/.test(l))) return;
		const cn = body.findIndex((l) => /^    container_name:/.test(l));
		const at = cn >= 0 ? r[0] + 1 + cn + 1 : r[0] + 1;
		lines = [...lines.slice(0, at), ...block, ...lines.slice(at)];
		changes.push(what);
		touched.add(name);
	};
	const pointHost = (name: string): void => {
		if (!gateway) return;
		const r = serviceRange(lines, name);
		if (!r) return;
		for (let i = r[0] + 1; i < r[1]; i++) {
			const m = /^(\s*-\s*["']?)host\.docker\.internal[:=]host-gateway(["']?\s*)$/.exec(lines[i]!);
			if (m) {
				lines[i] = `${m[1]}host.docker.internal:${gateway}${m[2]}`;
				changes.push(`${name}: host.docker.internal -> ${gateway} (the network it is on)`);
				touched.add(name);
			}
		}
	};
	const bounded = opts.edgeLog === 'bounded';
	if (services.edge) {
		if (opts.logging?.edge ?? true)
			addLogging(
				services.edge,
				bounded ? EDGE_LOGGING_BOUNDED : EDGE_LOGGING_NONE,
				bounded
					? `${services.edge}: Docker log small and rotating (5 MB, for CrowdSec)`
					: `${services.edge}: Docker log off (visitor addresses)`
			);
		pointHost(services.edge);
	}
	if (services.frontend) {
		if (opts.logging?.frontend ?? true)
			addLogging(
				services.frontend,
				FRONTEND_LOGGING,
				`${services.frontend}: Docker log bounded (1 MB x 2)`
			);
		pointHost(services.frontend);
	}
	return { text: lines.join('\n'), changes, touched: [...touched] };
}

/** The logging driver the compose text gives `service`, or null. PURE. */
export function composeLogDriver(text: string, service: string): string | null {
	const lines = text.split('\n');
	const r = serviceRange(lines, service);
	if (!r) return null;
	const body = lines.slice(r[0] + 1, r[1]);
	const i = body.findIndex((l) => /^    logging:/.test(l));
	if (i < 0) return null;
	for (let j = i + 1; j < body.length && /^ {6}/.test(body[j]!); j++) {
		const m = /^ {6}driver:\s*["']?([a-z0-9_-]+)/.exec(body[j]!);
		if (m) return m[1]!;
	}
	return null;
}

// ─── Compose's merged model (`docker compose config --format json`) ─────

export interface ModelService {
	readonly image: string | null;
	/** Absolute env_file paths (only with --no-env-resolution); null if not shown. */
	readonly envFiles: readonly string[] | null;
	/** Resolved environment (only without --no-env-resolution). */
	readonly environment: ReadonlyMap<string, string>;
	readonly logDriver: string | null;
	readonly logOptions: Readonly<Record<string, string>>;
	/** Values given to host.docker.internal, in order. */
	readonly dockerHost: readonly string[];
}

/** PURE. null when the JSON is not a Compose model. */
export function parseComposeModel(json: string): Map<string, ModelService> | null {
	let doc: unknown;
	try {
		doc = JSON.parse(json);
	} catch {
		return null;
	}
	const services = (doc as { services?: unknown })?.services;
	if (!services || typeof services !== 'object') return null;
	const out = new Map<string, ModelService>();
	for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
		const s = (raw ?? {}) as Record<string, unknown>;
		const envFiles = Array.isArray(s.env_file)
			? s.env_file
					.map((e) => (typeof e === 'string' ? e : String((e as { path?: unknown })?.path ?? '')))
					.filter((p) => p !== '')
			: typeof s.env_file === 'string'
				? [s.env_file]
				: null;
		const environment = new Map<string, string>();
		if (s.environment && typeof s.environment === 'object' && !Array.isArray(s.environment)) {
			for (const [k, v] of Object.entries(s.environment as Record<string, unknown>))
				if (typeof v === 'string') environment.set(k, v.replace(/\$\$/g, '$'));
		}
		const logging = (s.logging ?? null) as { driver?: unknown; options?: unknown } | null;
		const logOptions: Record<string, string> = {};
		if (logging?.options && typeof logging.options === 'object')
			for (const [k, v] of Object.entries(logging.options as Record<string, unknown>))
				logOptions[k] = String(v);
		const dockerHost: string[] = [];
		const eh = s.extra_hosts;
		const addHost = (h: string, v: string): void => {
			if (h === 'host.docker.internal') dockerHost.push(v);
		};
		if (Array.isArray(eh)) {
			for (const e of eh) {
				const m = /^([^:=]+)[:=](.*)$/.exec(String(e));
				if (m) addHost(m[1]!.trim(), m[2]!.trim());
			}
		} else if (eh && typeof eh === 'object') {
			for (const [h, v] of Object.entries(eh as Record<string, unknown>))
				for (const x of Array.isArray(v) ? v : [v]) addHost(h, String(x));
		}
		out.set(name, {
			image: typeof s.image === 'string' ? s.image : null,
			envFiles,
			environment,
			logDriver: typeof logging?.driver === 'string' ? logging.driver : null,
			logOptions,
			dockerHost
		});
	}
	return out;
}

// ─── the running containers (`docker inspect`) ──────────────────────────

export interface ContainerInfo {
	readonly name: string;
	readonly id: string;
	readonly image: string;
	readonly running: boolean;
	readonly labels: Readonly<Record<string, string>>;
	readonly env: readonly string[];
	readonly logDriver: string;
	readonly logOptions: Readonly<Record<string, string>>;
	readonly extraHosts: readonly string[];
	/** Published ports, normalised and sorted ("0.0.0.0:443->8443/tcp"). */
	readonly ports: readonly string[];
	readonly mounts: readonly string[];
	/** Bind mounts: host source → path in the container. */
	readonly binds: ReadonlyArray<{ readonly source: string; readonly destination: string }>;
	readonly gateways: readonly string[];
}

/** `docker inspect <names…>` JSON → ContainerInfo[]. PURE. */
export function parseDockerInspect(json: string): ContainerInfo[] {
	let arr: unknown;
	try {
		arr = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(arr)) return [];
	return arr.map((raw) => {
		const c = (raw ?? {}) as Record<string, any>;
		const ports: string[] = [];
		for (const [cport, binds] of Object.entries(
			(c.NetworkSettings?.Ports ?? {}) as Record<string, any>
		))
			for (const b of Array.isArray(binds) ? binds : [])
				ports.push(`${b?.HostIp ?? ''}:${b?.HostPort ?? ''}->${cport}`);
		const gateways = Object.values((c.NetworkSettings?.Networks ?? {}) as Record<string, any>)
			.map((n) => String(n?.Gateway ?? ''))
			.filter((g) => /^\d+\.\d+\.\d+\.\d+$/.test(g));
		const logOptions: Record<string, string> = {};
		for (const [k, v] of Object.entries(
			(c.HostConfig?.LogConfig?.Config ?? {}) as Record<string, unknown>
		))
			logOptions[k] = String(v);
		return {
			name: String(c.Name ?? '').replace(/^\//, ''),
			id: String(c.Id ?? ''),
			image: String(c.Config?.Image ?? ''),
			running: c.State?.Running === true,
			labels: (c.Config?.Labels ?? {}) as Record<string, string>,
			env: Array.isArray(c.Config?.Env) ? c.Config.Env.map(String) : [],
			logDriver: String(c.HostConfig?.LogConfig?.Type ?? ''),
			logOptions,
			extraHosts: Array.isArray(c.HostConfig?.ExtraHosts)
				? c.HostConfig.ExtraHosts.map(String)
				: [],
			ports: ports.sort(),
			mounts: Array.isArray(c.Mounts) ? c.Mounts.map((m: any) => String(m?.Source ?? '')) : [],
			binds: Array.isArray(c.Mounts)
				? c.Mounts.map((m: any) => ({
						source: String(m?.Source ?? ''),
						destination: String(m?.Destination ?? '')
					}))
				: [],
			gateways
		};
	});
}

export interface ComposeRef {
	readonly project: string;
	readonly service: string;
	/** Every compose file, in Compose's order. */
	readonly files: readonly string[];
	readonly envFiles: readonly string[];
	readonly workDir: string;
}

/** The Compose project a container came from, from its labels. PURE. */
export function composeRefOf(c: ContainerInfo): ComposeRef | null {
	const l = c.labels;
	const list = (v: string | undefined): string[] =>
		(v ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	const files = list(l['com.docker.compose.project.config_files']);
	const project = (l['com.docker.compose.project'] ?? '').trim();
	const service = (l['com.docker.compose.service'] ?? '').trim();
	if (files.length === 0 || project === '' || service === '') return null;
	return {
		project,
		service,
		files,
		envFiles: list(l['com.docker.compose.project.environment_file']),
		workDir: (l['com.docker.compose.project.working_dir'] ?? '').trim()
	};
}

/** The `docker compose` arguments that address exactly this project. PURE. */
export function composeArgs(ref: ComposeRef, args: readonly string[]): string[] {
	return [
		'compose',
		'-p',
		ref.project,
		...(ref.workDir ? ['--project-directory', ref.workDir] : []),
		...ref.files.flatMap((f) => ['-f', f]),
		...ref.envFiles.flatMap((e) => ['--env-file', e]),
		...args
	];
}

/** The same, as a command an operator can paste. PURE. */
export function composeCommand(ref: ComposeRef, args: readonly string[]): string {
	const q = (s: string): string =>
		/^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
	return ['docker', ...composeArgs(ref, args)].map(q).join(' ');
}

const imageRepo = (image: string, repo: string): boolean =>
	new RegExp(`(^|/)${escRe(repo)}(?=$|[:@])`).test(image);
const isBunkerWebImage = (i: string): boolean => imageRepo(i, 'bunkerity/bunkerweb');
const isSchedulerImage = (i: string): boolean => imageRepo(i, 'bunkerity/bunkerweb-scheduler');
const isCrowdSecImage = (i: string): boolean => imageRepo(i, 'crowdsecurity/crowdsec');
const isBunkerityImage = (i: string): boolean => /(^|\/)bunkerity\//.test(i);
const DOCKER_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'];

export interface Identified {
	readonly frontend: ContainerInfo | null;
	readonly edge: ContainerInfo | null;
	readonly schedulers: readonly ContainerInfo[];
	readonly crowdsec: readonly ContainerInfo[];
	/** Other containers that can read container logs via the Docker socket. */
	readonly socketWatchers: readonly ContainerInfo[];
	/** BunkerWeb containers when there are several and none is known to be
	 *  the public one (then `edge` is null). */
	readonly ambiguous: readonly ContainerInfo[];
	readonly notes: readonly string[];
}

/** Which running container is which — by mounts, image and published port,
 *  never by name. PURE. */
export function identifyContainers(list: readonly ContainerInfo[], buildDir: string): Identified {
	const notes: string[] = [];
	const running = list.filter((c) => c.running);
	const norm = (p: string): string => p.replace(/\/+$/, '');
	const fes = running.filter((c) => c.mounts.some((m) => norm(m) === norm(buildDir)));
	if (fes.length > 1)
		notes.push(
			`More than one container serves this install's web build (${fes.map((c) => c.name).join(', ')}), so their settings were left alone.`
		);
	const frontend = fes.length === 1 ? fes[0]! : null;
	const publishes443 = (c: ContainerInfo): boolean => c.ports.some((p) => /:443->/.test(p));
	let bws = running.filter((c) => c !== frontend && isBunkerWebImage(c.image));
	if (bws.length > 1) bws = bws.filter(publishes443);
	let edge: ContainerInfo | null = null;
	let ambiguous: ContainerInfo[] = [];
	if (bws.length === 1) edge = bws[0]!;
	else if (bws.length > 1 || running.filter((c) => isBunkerWebImage(c.image)).length > 1) {
		ambiguous = running.filter((c) => c !== frontend && isBunkerWebImage(c.image));
		notes.push(
			`Found several BunkerWeb containers and could not tell which one is the public one, so BunkerWeb's settings were left alone.`
		);
	} else {
		const pub = running.filter((c) => c !== frontend && publishes443(c));
		if (pub.length > 0)
			notes.push(
				`The public web entry point on this server (${pub.map((c) => c.name).join(', ')}) is not BunkerWeb, so Morphit leaves its logging and headers to you.`
			);
	}
	const crowdsec = running.filter((c) => isCrowdSecImage(c.image));
	const socketWatchers = running.filter(
		(c) =>
			c !== edge &&
			c !== frontend &&
			!isBunkerityImage(c.image) &&
			!isCrowdSecImage(c.image) &&
			c.mounts.some((m) => DOCKER_SOCKETS.includes(norm(m)))
	);
	return {
		frontend,
		edge,
		schedulers: running.filter((c) => isSchedulerImage(c.image)),
		crowdsec,
		socketWatchers,
		ambiguous,
		notes
	};
}

/**
 * Does this CrowdSec acquisition (acquis.yaml + acquis.d/*, as text) read the
 * edge's log? Unreadable → yes (it may). A `source: docker` entry that names
 * the edge (container_name / container_id / container_name_regexp, or
 * use_container_labels with the edge labelled crowdsec.enable=true), or names
 * no container at all → yes. A file/journal entry mentioning bunkerweb or an
 * nginx access log → yes (the log format decides what it can parse). PURE.
 */
export function crowdsecReadsEdge(acquis: string | null, edge: ContainerInfo): boolean {
	if (acquis === null || acquis.trim() === '') return true;
	const docs = acquis.split(/^---\s*$/m);
	for (const doc of docs) {
		const lines = doc.split('\n').map((l) => l.replace(/\s+#.*$/, ''));
		if (!lines.some((l) => /\S/.test(l) && !/^\s*#/.test(l))) continue;
		const source = /^source:\s*["']?([A-Za-z_]+)/m.exec(doc)?.[1]?.toLowerCase() ?? 'file';
		const values = (key: string): string[] => {
			const out: string[] = [];
			for (let i = 0; i < lines.length; i++) {
				const m = new RegExp(`^${key}:\\s*(.*)$`).exec(lines[i]!);
				if (!m) continue;
				const inline = m[1]!.trim();
				if (inline !== '') {
					const arr = /^\[(.*)\]$/.exec(inline);
					if (arr) out.push(...arr[1]!.split(',').map((s) => s.trim()));
					else out.push(inline);
				} else {
					for (let j = i + 1; j < lines.length && /^\s+-\s*/.test(lines[j]!); j++)
						out.push(lines[j]!.replace(/^\s+-\s*/, '').trim());
				}
			}
			return out.map((v) => v.replace(/^["']|["']$/g, '')).filter(Boolean);
		};
		if (source === 'docker') {
			const names = values('container_name');
			const ids = values('container_id');
			const res = values('container_name_regexp');
			const byLabels = /^use_container_labels:\s*true\b/m.test(doc);
			if (names.length === 0 && ids.length === 0 && res.length === 0 && !byLabels) return true;
			if (names.some((n) => n.replace(/^\//, '') === edge.name)) return true;
			if (ids.some((id) => id !== '' && edge.id.startsWith(id))) return true;
			for (const r of res) {
				try {
					if (new RegExp(r).test(edge.name)) return true;
				} catch {
					return true; // cannot tell
				}
			}
			if (byLabels && edge.labels['crowdsec.enable'] === 'true') return true;
		} else if (/bunkerweb/i.test(doc) || /^\s*type:\s*["']?(nginx|bunkerweb)/m.test(doc)) {
			return true;
		}
	}
	return false;
}

// ─── what the frontend forwards (pure) ──────────────────────────────────

interface NgxDirective {
	readonly name: string;
	readonly args: readonly string[];
	readonly block: readonly NgxDirective[] | null;
}

/** Parse nginx config text (as `nginx -T` prints it; `#` lines, including its
 *  "# configuration file" markers, are comments). Quoted args lose their quotes. */
function parseNgx(text: string): NgxDirective[] {
	const toks: string[] = [];
	for (let i = 0; i < text.length; ) {
		const c = text[i]!;
		if (c === '#') {
			while (i < text.length && text[i] !== '\n') i++;
		} else if (/\s/.test(c)) {
			i++;
		} else if (c === '{' || c === '}' || c === ';') {
			toks.push(c);
			i++;
		} else if (c === '"' || c === "'") {
			let j = i + 1;
			let v = '';
			for (; j < text.length && text[j] !== c; j++) {
				if (text[j] === '\\' && j + 1 < text.length) j++;
				v += text[j];
			}
			toks.push(`\u0000${v}`);
			i = j + 1;
		} else {
			let j = i;
			while (j < text.length && !/[\s;{}#]/.test(text[j]!)) j++;
			toks.push(text.slice(i, j));
			i = j;
		}
	}
	let p = 0;
	const block = (): NgxDirective[] => {
		const out: NgxDirective[] = [];
		while (p < toks.length && toks[p] !== '}') {
			const words: string[] = [];
			while (p < toks.length && !['{', '}', ';'].includes(toks[p]!))
				words.push(toks[p++]!.replace(/^\u0000/, ''));
			if (p >= toks.length) break;
			if (toks[p] === ';') {
				p++;
				if (words.length) out.push({ name: words[0]!, args: words.slice(1), block: null });
			} else if (toks[p] === '{') {
				p++;
				const inner = block();
				if (toks[p] === '}') p++;
				out.push({ name: words[0] ?? '', args: words.slice(1), block: inner });
			} else break;
		}
		return out;
	};
	const all: NgxDirective[] = [];
	while (p < toks.length) {
		all.push(...block());
		if (toks[p] === '}') p++; // a stray brace — keep going
	}
	return all;
}

/** In an `nginx -T` dump: the `log_format <name>` formats, quotes removed. PURE. */
export function nginxLogFormats(dump: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (list: readonly NgxDirective[]): void => {
		for (const d of list) {
			if (d.name === 'log_format' && d.args.length >= 2) {
				const rest = d.args.slice(1);
				// nginx's own rule: `escape=…` may come first; the pieces concatenate.
				const parts = /^escape=/.test(rest[0] ?? '') ? rest.slice(1) : rest;
				out.set(d.args[0]!, parts.join(''));
			}
			if (d.block) walk(d.block);
		}
	};
	walk(parseNgx(dump));
	return out;
}

/**
 * In an `nginx -T` dump of the frontend: the port on which it believes
 * BunkerWeb's X-Real-IP — the `"<port>:1"` key of the map that sets
 * `$morphit_from_bunkerweb` from `$server_port` — provided nginx also listens
 * on it. null: the frontend has no edge listener (older config). PURE.
 */
export function frontendEdgePort(dump: string): number | null {
	const all = parseNgx(dump);
	const find = (
		list: readonly NgxDirective[],
		pred: (d: NgxDirective) => boolean
	): NgxDirective[] =>
		list.flatMap((d) => [...(pred(d) ? [d] : []), ...(d.block ? find(d.block, pred) : [])]);
	const map = find(
		all,
		(d) =>
			d.name === 'map' &&
			d.args[1] === '$morphit_from_bunkerweb' &&
			(d.args[0] ?? '').includes('$server_port')
	)[0];
	if (!map?.block) return null;
	const listens = new Set(
		find(all, (d) => d.name === 'listen').map(
			(d) => /(?:^|:)(\d+)$/.exec(d.args[0] ?? '')?.[1] ?? ''
		)
	);
	for (const e of map.block) {
		const m = /^(\d+):1$/.exec(e.name);
		if (m && e.args[0] === '1' && listens.has(m[1]!)) return Number(m[1]);
	}
	return null;
}

/**
 * v1.20.2 — in an `nginx -T` dump: does the frontend answer a missing FILE
 * with 404 rather than the app page? The release config marks it with
 * `location ^~ /.well-known/ { … try_files $uri =404; }` (beside the
 * root-level-file rule). Before it, /.well-known/ai-catalog.json, /ads.txt and
 * the like came back as the app's HTML with status 200 (PageSpeed: "malformed
 * JSON"). PURE.
 */
export function frontendFileMissesAre404(dump: string): boolean {
	const walk = (list: readonly NgxDirective[]): boolean =>
		list.some(
			(d) =>
				(d.name === 'location' &&
					d.args[0] === '^~' &&
					d.args[1] === '/.well-known/' &&
					(d.block ?? []).some(
						(x) => x.name === 'try_files' && x.args[x.args.length - 1] === '=404'
					)) ||
				(d.block ? walk(d.block) : false)
		);
	return walk(parseNgx(dump));
}

/** Does this CSP's script-src allow neither inline script nor eval? A policy
 *  without script-src falls back to default-src. PURE. */
export function cspScriptSrcStrict(csp: string): boolean {
	const dirs = new Map<string, string[]>();
	for (const part of csp.split(';')) {
		const [name, ...vals] = part.trim().split(/\s+/);
		if (name) dirs.set(name.toLowerCase(), vals);
	}
	const src = dirs.get('script-src') ?? dirs.get('default-src') ?? [];
	return !src.some((v) => v === "'unsafe-inline'" || v === "'unsafe-eval'");
}

/** In an `nginx -T` dump of the frontend: is every page CSP it can send — each
 *  value of the `map $host $morphit_csp`, or a literal Content-Security-Policy
 *  header — free of inline script and eval? false when it sends none. PURE. */
export function frontendCspStrict(dump: string): boolean {
	const all = parseNgx(dump);
	const values: string[] = [];
	const walk = (list: readonly NgxDirective[]): void => {
		for (const d of list) {
			if (d.name === 'map' && d.args[1] === '$morphit_csp' && d.block)
				for (const e of d.block) values.push(e.args[0] ?? '');
			if (
				d.name === 'add_header' &&
				/^content-security-policy$/i.test(d.args[0] ?? '') &&
				!/^\$/.test(d.args[1] ?? '')
			)
				values.push(d.args[1] ?? '');
			if (d.block) walk(d.block);
		}
	};
	walk(all);
	return values.length > 0 && values.every((v) => cspScriptSrcStrict(v));
}

/** Is `csp` a policy Morphit itself wrote (any release) — same directives as
 *  today's canonical one except for script-src (only 'self', 'unsafe-inline',
 *  'unsafe-eval', 'wasm-unsafe-eval') and connect-src (only 'self' and the
 *  canonical Blurt RPC nodes, `rpc.blurt.one` included)? An operator's own
 *  policy is anything else, and is kept. PURE. */
export function isMorphitCsp(csp: string): boolean {
	const parse = (v: string): Map<string, string> => {
		const m = new Map<string, string>();
		for (const part of v.split(';')) {
			const [name, ...vals] = part.trim().split(/\s+/);
			if (name) m.set(name.toLowerCase(), vals.join(' '));
		}
		return m;
	};
	const have = parse(csp);
	const want = parse(MORPHIT_CSP);
	if ([...have.keys()].sort().join() !== [...want.keys()].sort().join()) return false;
	for (const [k, v] of want) {
		if (k === 'script-src' || k === 'connect-src') continue;
		if (have.get(k) !== v) return false;
	}
	const okScript = new Set(["'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'"]);
	const okConnect = new Set([
		"'self'",
		...(want.get('connect-src') ?? '').split(' '),
		'https://rpc.blurt.one'
	]);
	return (
		(have.get('script-src') ?? '').split(' ').every((t) => okScript.has(t)) &&
		(have.get('connect-src') ?? '').split(' ').every((t) => okConnect.has(t))
	);
}

/** Request headers a visitor could set that must never reach the relay or
 *  indexer: the loopback-only health marker, and the per-visitor I2P
 *  destination i2pd adds on its http tunnels (a stable pseudonym). */
export const VISITOR_HEADERS_CLEARED = [
	'x-morphit-local-health',
	'x-i2p-destb64',
	'x-i2p-destb32',
	'x-i2p-desthash'
] as const;

/** In an `nginx -T` dump: does every server hide the nginx version
 *  (`server_tokens off`, own or inherited from http), and does every location
 *  that proxies clear VISITOR_HEADERS_CLEARED (own proxy_set_header lines, or
 *  the enclosing block's when it sets none)? `uncleared` names the failing
 *  locations. PURE. */
export function frontendHidesInternals(dump: string): {
	tokensOff: boolean;
	uncleared: string[];
} {
	let servers = 0;
	let tokensOff = true;
	const uncleared: string[] = [];
	const headersOf = (b: readonly NgxDirective[]): Map<string, string> | null => {
		const set = b.filter((d) => d.name === 'proxy_set_header' && d.args.length >= 1);
		return set.length === 0
			? null
			: new Map(set.map((d) => [d.args[0]!.toLowerCase(), d.args[1] ?? '']));
	};
	const tokensOf = (b: readonly NgxDirective[]): string | null =>
		b.find((d) => d.name === 'server_tokens')?.args[0] ?? null;
	const walk = (
		list: readonly NgxDirective[],
		inherited: Map<string, string> | null,
		tokens: string | null
	): void => {
		for (const d of list) {
			if (!d.block) continue;
			const eff = headersOf(d.block) ?? inherited;
			const tok = tokensOf(d.block) ?? tokens;
			if (d.name === 'server') {
				servers++;
				if (tok !== 'off') tokensOff = false;
			}
			if (d.name === 'location' && d.block.some((x) => x.name === 'proxy_pass'))
				if (!VISITOR_HEADERS_CLEARED.every((h) => eff?.get(h) === ''))
					uncleared.push(d.args.join(' '));
			walk(d.block, eff, tok);
		}
	};
	walk(parseNgx(dump), null, null);
	return { tokensOff: servers > 0 && tokensOff, uncleared };
}

/** The Dockerfile in a stack's frontend build context (<stack dir>/frontend). */
const frontendBuildDockerfile = (ref: ComposeRef): string =>
	join(ref.workDir || dirname(ref.files[0]!), 'frontend', 'Dockerfile');

/** A frontend Dockerfile as Morphit ships it (any release): an nginx base,
 *  the stock default server removed, Morphit's nginx.conf copied in — and
 *  nothing else. PURE. */
export function isMorphitFrontendDockerfile(text: string): boolean {
	const lines = text
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l !== '' && !l.startsWith('#'));
	const rest = lines.filter(
		(l) =>
			!/^FROM nginx:[\w.-]*alpine(@sha256:[0-9a-f]{64})?$/.test(l) &&
			!/^LABEL org\.morphit\.frontend-base=/.test(l)
	);
	return (
		lines.some((l) => /^FROM nginx:/.test(l)) &&
		rest.join('\n') ===
			[
				'RUN rm -f /etc/nginx/conf.d/default.conf',
				'COPY nginx.conf /etc/nginx/conf.d/morphit.conf',
				'EXPOSE 80',
				'CMD ["nginx", "-g", "daemon off;"]'
			].join('\n')
	);
}

/** Ports whose services key per-address limits on X-Forwarded-For. */
const XFF_PORTS = /:(8080|8081)(\/|$)/;

/**
 * In an `nginx -T` dump: every location that proxies to the relay or indexer
 * sends `X-Forwarded-For $morphit_relay_xff` and `X-Real-IP ""` — its own
 * proxy_set_header lines, or (nginx's rule) the enclosing block's when it sets
 * none itself. `proxied` counts those locations; `missing` names the failing
 * ones. PURE.
 */
export function frontendForwardsOneAddress(dump: string): {
	proxied: number;
	missing: string[];
} {
	let proxied = 0;
	const missing: string[] = [];
	const headersOf = (b: readonly NgxDirective[]): Map<string, string> | null => {
		const set = b.filter((d) => d.name === 'proxy_set_header' && d.args.length >= 1);
		return set.length === 0
			? null
			: new Map(set.map((d) => [d.args[0]!.toLowerCase(), d.args[1] ?? '']));
	};
	const walk = (list: readonly NgxDirective[], inherited: Map<string, string> | null): void => {
		for (const d of list) {
			if (!d.block) continue;
			const own = headersOf(d.block);
			const eff = own ?? inherited;
			if (
				d.name === 'location' &&
				d.block.some((x) => x.name === 'proxy_pass' && XFF_PORTS.test(x.args[0] ?? ''))
			) {
				proxied++;
				if (eff?.get('x-forwarded-for') !== '$morphit_relay_xff' || eff?.get('x-real-ip') !== '')
					missing.push(d.args.join(' '));
			}
			walk(d.block, eff);
		}
	};
	walk(parseNgx(dump), null);
	return { proxied, missing };
}

// ─── runtime ────────────────────────────────────────────────────────────

export interface ProxyHealRuntime {
	now(): number;
	/** Every running container, inspected; null when Docker is not usable. */
	containers(timeoutMs: number): ContainerInfo[] | null;
	inspect(names: readonly string[], timeoutMs: number): ContainerInfo[];
	/** `docker compose … config --format json` (+ `--no-env-resolution`). */
	composeConfig(ref: ComposeRef, envFilesUnresolved: boolean, timeoutMs: number): string | null;
	/** acquis.yaml + acquis.d/* inside a CrowdSec container; null if unreadable. */
	crowdsecAcquisition(name: string, timeoutMs: number): string | null;
	readFile(path: string): Buffer | null;
	writeFile(path: string, data: Buffer): boolean;
	/** Copy `path` to a timestamped sibling; the copy's path, or null. */
	backup(path: string): string | null;
	/** `docker compose … up -d --no-deps <services>`; true on success. */
	composeUp(ref: ComposeRef, services: readonly string[], timeoutMs: number): boolean;
	/** From inside `name`: does host.docker.internal:<port> give ANY HTTP answer? */
	reachesHost(name: string, port: number, timeoutMs: number): boolean;
	/** The edge's answer for https://<serverName>/ (asked on 127.0.0.1): status
	 *  and lower-cased headers; null if there was no HTTP answer. */
	edgeProbe(
		serverName: string,
		timeoutMs: number
	): { status: number; headers: Readonly<Record<string, string>> } | null;
	/** `nginx -T` inside a container; null if it cannot be read. */
	nginxT(name: string, timeoutMs: number): string | null;
	/** BunkerWeb's generated /etc/nginx/variables.env inside the edge (what its
	 *  Lua code loads at each reload); null if it cannot be read. Optional:
	 *  absent → the containers' environment is the evidence. */
	bunkerwebSettings?(name: string, timeoutMs: number): string | null;
	/** The frontend-base label of the running container's image ('' when it
	 *  has none); null if it cannot be read. Optional: absent → not checked. */
	frontendBase?(name: string, timeoutMs: number): string | null;
	/** A rebuild of this frontend uses a Dockerfile Morphit shipped, so it
	 *  comes up on the pinned base (and carries its label). Optional: absent →
	 *  assumed. */
	frontendRebuildPinsBase?(ref: ComposeRef): boolean;
	/** A config file inside the container is newer than its start. */
	configNewerThanStart(name: string, timeoutMs: number): boolean;
	/** Graceful `nginx -s reload` inside the container. */
	reloadNginx(name: string, timeoutMs: number): boolean;
	/** Refresh the frontend's build-context nginx.conf from the release and
	 *  `up -d --no-deps --build --force-recreate` it. */
	refreshFrontend(ref: ComposeRef, timeoutMs: number, withBase?: boolean): boolean;
	/** This node takes no clearnet route (lib/hiddenOnly.ts). Optional: absent → no. */
	hiddenOnly?(): boolean;
	/** The pinned frontend base image is on this box and a build can use it
	 *  without a pull (lib/frontendBaseImage.ts). */
	baseImagePresent?(timeoutMs: number): boolean;
	/** `docker load` the offline bundle's copy of the pinned base, if the
	 *  install carries one (vendor/docker); true when it is then proven to be
	 *  the pinned image and usable. */
	loadBundledBase?(timeoutMs: number): boolean;
	/** The RUNNING Docker daemon pulls through Tor's SocksPort
	 *  (dockerDaemonPullsThroughTor). */
	dockerPullsThroughTor?(): boolean;
	/** BunkerWeb's own verdict (lib/bunkerwebScheduler.ts) on the config its
	 *  scheduler(s) built since `sinceIso`. Optional: absent → not consulted. */
	schedulerCycle?(
		schedulers: readonly string[],
		edge: string | null,
		sinceIso: string,
		timeoutMs: number
	): SchedulerCycle;
	/** The country lists saved in BunkerWeb's database, read inside a
	 *  scheduler (COUNTRY_DB_PY); null when that could not run. Optional:
	 *  absent → not consulted. */
	countryRows?(scheduler: string, timeoutMs: number): CountryDb | null;
	/** Remove these web-UI rows (all or none) after a backup, and flag
	 *  BunkerWeb to rebuild; null when nothing was removed. */
	removeCountryRows?(
		scheduler: string,
		rows: readonly CountryRow[],
		timeoutMs: number
	): { backup: string; removed: number } | null;
	/** Run `fn` if the process is told to stop; returns the unregister. */
	onTerminate(fn: () => void): () => void;
	sleep(ms: number): Promise<void>;
	spinner(label: string): () => void;
}

type ComposeOutcome =
	| { kind: 'no-proxy' }
	| { kind: 'already' }
	/** Could not tell safely what to change; nothing was touched. */
	| { kind: 'left-alone'; reason: string }
	/** The edited files would not give the planned values; restored, nothing restarted. */
	| { kind: 'invalid-compose'; reason: string }
	| { kind: 'no-time' }
	| { kind: 'applied'; changes: readonly string[] }
	| { kind: 'rolled-back'; reason: string; restoreVerified: boolean }
	| { kind: 'apply-failed' }
	/** Nothing to change in the files, but BunkerWeb's running settings could
	 *  not be checked for a country list (said in `reason`, with the command). */
	| { kind: 'unchecked'; reason: string }
	/** Everything else is in place; BunkerWeb still runs with a country list
	 *  this heal could not remove (`reason` names where it is set). */
	| { kind: 'country-list'; reason: string };

/** What the running frontend forwards to the relay/indexer (see the header). */
export type ForwardingState = 'ok' | 'refreshed' | 'stale' | 'unknown';

export type ProxyHealOutcome = ComposeOutcome & { forwarding?: ForwardingState };

const INDEXER_PORT = 8081;
const PROBE_MS = 12_000;
const UP_MIN_MS = 20_000;
const UP_MAX_MS = 50_000;
const VERIFY_MIN_MS = 15_000;
const ROLLBACK_RESERVE_MS = 40_000;
const REFRESH_MIN_MS = 60_000;
const REFRESH_WAIT_MS = 15_000;
/** Longest wait for BunkerWeb to rebuild after a country list is removed
 *  (a rebuild took ~2 min on a box whose downloads time out). */
const SETTLE_MAX_MS = 6 * 60_000;

export interface HealOpts {
	readonly runtime: ProxyHealRuntime;
	readonly info: (m: string) => void;
	readonly warn: (m: string) => void;
	/** The install's apps/web/build (identifies the frontend container). */
	readonly buildDir: string;
	/** An absolute time the heal must be finished by (the child's kill). */
	readonly hardStopAt?: number;
	readonly budgetMs?: number;
	/** Time kept back for a rollback (default ROLLBACK_RESERVE_MS). */
	readonly rollbackReserveMs?: number;
	readonly pollMs?: number;
}

interface Clock {
	left(): number;
	/** A timeout: `want`, but never into `reserve` of what is left (min 1 s). */
	t(want: number, reserve?: number): number;
}

export async function applyAndVerifyProxyConfig(opts: HealOpts): Promise<ProxyHealOutcome> {
	const rt = opts.runtime;
	const end = Math.min(rt.now() + (opts.budgetMs ?? HEAL_BUDGET_MS), opts.hardStopAt ?? Infinity);
	const clock: Clock = {
		left: () => end - rt.now(),
		t: (want, reserve = 0) => Math.max(1_000, Math.min(want, end - rt.now() - reserve))
	};
	const stop = rt.spinner('Checking the web containers (visitor privacy and security headers)…');
	let list: ContainerInfo[] | null;
	try {
		list = rt.containers(clock.t(PROBE_MS));
	} finally {
		stop();
	}
	if (list === null)
		return {
			kind: 'left-alone',
			reason:
				'Docker did not list the containers in time, so the web containers could not be checked; on this server check: sudo docker ps'
		};
	let id = identifyContainers(list, opts.buildDir);
	// The frontend first: what it really serves decides whether BunkerWeb may
	// be pointed at its edge listener, and a rebuild here must precede that.
	const fe = id.frontend;
	const feRef = fe ? composeRefOf(fe) : null;
	const fwd: Forwarding =
		fe && feRef
			? await verifyFrontendForwarding(opts, clock, fe, feRef)
			: { state: 'unknown', edgePort: null };
	if (fwd.state === 'refreshed') {
		const st = rt.spinner('Looking at the rebuilt frontend…');
		let again: ContainerInfo[] | null;
		try {
			again = rt.containers(clock.t(PROBE_MS));
		} finally {
			st();
		}
		if (again) id = identifyContainers(again, opts.buildDir);
	}
	const out = await applyComposeAndEnv(opts, clock, id, fwd.edgePort);
	return fe && feRef ? { ...out, forwarding: fwd.state } : out;
}

interface Forwarding {
	readonly state: ForwardingState;
	/** The port the SERVED frontend config believes BunkerWeb's X-Real-IP on. */
	readonly edgePort: number | null;
}

async function verifyFrontendForwarding(
	opts: HealOpts,
	clock: Clock,
	fe: ContainerInfo,
	feRef: ComposeRef
): Promise<Forwarding> {
	const rt = opts.runtime;
	if (clock.left() < 5_000) return { state: 'unknown', edgePort: null };
	interface Seen {
		proxied: number;
		missing: string[];
		edgePort: number | null;
		filesAre404: boolean;
		/** Its page CSP allows no inline script and no eval. */
		cspStrict: boolean;
		/** No nginx version in its headers or error pages. */
		tokensOff: boolean;
		/** Proxied locations that pass visitor-set internal headers on. */
		uncleared: string[];
		/** Built from the pinned base image (true when that cannot be read, or
		 *  when a rebuild would not change it). */
		baseCurrent: boolean;
	}
	/** false only when the label was read, is not the pinned base, and a
	 *  rebuild would put the frontend on it (an operator's own Dockerfile, or a
	 *  service that only names an image, is not judged on its base). */
	const baseOf = (): boolean | null => {
		const b = rt.frontendBase?.(fe.name, clock.t(PROBE_MS)) ?? null;
		if (b === null || b === FRONTEND_BASE) return b === null ? null : true;
		if (rt.frontendRebuildPinsBase?.(feRef) === false) return null;
		return baseReach() === 'here' ? false : null;
	};
	// A rebuild onto the pinned base makes Docker fetch that image when it is
	// not on the box. On a hidden-only node that would be a Docker Hub pull from
	// the box's own address — or, when Docker pulls through Tor, a pull through
	// Tor squeezed into the seconds this rebuild has. So there the base switch
	// waits until the image is here (or loads, checked, from the offline
	// bundle's vendor/docker): while Docker does not pull through Tor ('held'),
	// and while it does, for the after-restart unit's fetch, which has the
	// minutes Tor needs and rebuilds the frontend onto it ('fetching'). Any
	// rebuild meanwhile keeps the Dockerfile's base as it is — also when the
	// label is current but the image itself is gone (`docker image prune -a`).
	// Decided once per run.
	let baseWay: 'here' | 'held' | 'fetching' | null = null;
	const baseReach = (): 'here' | 'held' | 'fetching' => {
		if (baseWay !== null) return baseWay;
		const here = (): boolean => rt.baseImagePresent?.(clock.t(PROBE_MS)) ?? false;
		baseWay =
			rt.hiddenOnly?.() !== true ||
			here() ||
			((rt.loadBundledBase?.(clock.t(UP_MAX_MS, 10_000)) ?? false) && here())
				? 'here'
				: (rt.dockerPullsThroughTor?.() ?? false)
					? 'fetching'
					: 'held';
		const name = FRONTEND_BASE.split('@')[0];
		if (baseWay === 'fetching')
			opts.info(
				`The frontend (${fe.name}) moves to this release's nginx base image (${name}) once that image is on this ` +
					'server: it is being fetched through Tor in the background, by the checks that run after the services ' +
					'restart, and the frontend is rebuilt onto it then. Nothing to do; the site keeps working as it is.'
			);
		else if (baseWay === 'held')
			opts.info(
				`The frontend (${fe.name}) stays on its current nginx base for now: this hidden-only node does not have ` +
					`this release's base image (${name}), and Docker does not pull through Tor yet, so nothing is fetched ` +
					'from Docker Hub. The checks that run after the services restart try to set Docker to pull through Tor, ' +
					'then fetch it that way and rebuild the frontend onto it; they say how that went. The site keeps ' +
					'working as it is.'
			);
		return baseWay;
	};
	const check = (): Seen | null => {
		const dump = rt.nginxT(fe.name, clock.t(PROBE_MS));
		return dump === null
			? null
			: {
					...frontendForwardsOneAddress(dump),
					...frontendHidesInternals(dump),
					edgePort: frontendEdgePort(dump),
					filesAre404: frontendFileMissesAre404(dump),
					cspStrict: frontendCspStrict(dump),
					baseCurrent: baseOf() !== false
				};
	};
	const good = (r: Seen | null): r is Seen =>
		r !== null &&
		r.proxied > 0 &&
		r.missing.length === 0 &&
		r.edgePort !== null &&
		r.filesAre404 &&
		r.cspStrict &&
		r.tokensOff &&
		r.uncleared.length === 0 &&
		r.baseCurrent;
	let stop = rt.spinner('Checking which client address the frontend passes to the indexer…');
	let first: Seen | null;
	let reloadFailed = false;
	try {
		first = check();
		// The files are right; make sure the running nginx has loaded them.
		if (
			good(first) &&
			rt.configNewerThanStart(fe.name, clock.t(PROBE_MS)) &&
			!rt.reloadNginx(fe.name, clock.t(PROBE_MS))
		)
			reloadFailed = true;
	} finally {
		stop();
	}
	// Unreadable, or not a Morphit frontend (nothing proxies to the relay or
	// indexer): nothing to judge.
	if (first === null || first.proxied === 0) return { state: 'unknown', edgePort: null };
	// What was wrong before any rebuild (the type guard below narrows `first`).
	const before: Seen = first;
	if (good(first)) {
		if (reloadFailed)
			opts.warn(
				`The frontend's nginx config is current but ${fe.name} could not reload it; run \`sudo docker exec ${fe.name} nginx -s reload\`.`
			);
		return { state: 'ok', edgePort: first.edgePort };
	}
	const cmd = `sudo ${composeCommand(feRef, ['up', '-d', '--no-deps', '--build', '--force-recreate', feRef.service])}`;
	// Which file the container really loads, when it is bind-mounted.
	const release = join(
		dirname(dirname(dirname(opts.buildDir))),
		'ops/bunkerweb/frontend/nginx.conf'
	);
	const mounted = fe.binds.find((b) => b.destination.startsWith('/etc/nginx/'))?.source ?? null;
	const stale = (r: Seen): Forwarding => {
		const why = [
			r.missing.length > 0
				? `still forwards a visitor-supplied X-Forwarded-For on ${r.missing.join(', ')}`
				: '',
			r.edgePort === null
				? "cannot yet tell BunkerWeb's requests from others (no edge listener), so every clearnet visitor shares one rate-limit bucket"
				: '',
			!r.filesAre404
				? 'answers a missing file (such as /.well-known/…) with the app page instead of 404'
				: '',
			!r.cspStrict ? 'still allows inline script and eval in its Content-Security-Policy' : '',
			!r.tokensOff ? 'still shows its nginx version in headers and error pages' : '',
			r.uncleared.length > 0
				? `still passes visitor-set internal headers (such as X-I2P-DestB32) to the relay or indexer on ${r.uncleared.join(', ')}`
				: '',
			!r.baseCurrent
				? `was built from an older nginx base image than this release's (${FRONTEND_BASE.split('@')[0]})`
				: ''
		]
			.filter(Boolean)
			.join(', and ');
		opts.warn(
			`The frontend (${fe.name}) ${why}. Your site keeps working. ` +
				(mounted && mounted !== release
					? `It loads ${mounted}, not this release's ${release}: copy that file over it, then run: `
					: 'To fix it, run: ') +
				cmd
		);
		return { state: 'stale', edgePort: r.edgePort };
	};
	if (clock.left() < REFRESH_MIN_MS) return stale(first);
	stop = rt.spinner('The frontend runs an older config; rebuilding it from this release…');
	let after: Seen = first;
	let refreshed = false;
	try {
		const withBase = baseReach() === 'here';
		refreshed = rt.refreshFrontend(feRef, clock.t(UP_MAX_MS, 10_000), withBase);
		// A recreated nginx answers within seconds; do not let a rebuild that did
		// not help eat the time the privacy/header change needs.
		const until = rt.now() + REFRESH_WAIT_MS;
		while (refreshed && clock.left() > 5_000 && rt.now() < until) {
			const st = rt.inspect([fe.name], clock.t(PROBE_MS)).find((c) => c.name === fe.name);
			const r = st?.running ? check() : null;
			if (r !== null) after = r;
			if (good(r)) break;
			await rt.sleep(opts.pollMs ?? 3000);
		}
	} finally {
		stop();
	}
	if (refreshed && good(after)) {
		if (before.missing.length > 0 || before.edgePort === null)
			opts.info(
				'✓ The frontend now sends the relay and indexer one address per visitor (X-Forwarded-For), not a list the visitor can add to.'
			);
		if (!before.filesAre404)
			opts.info('✓ The frontend now answers a missing file with 404 instead of the app page.');
		if (!before.cspStrict)
			opts.info(
				'✓ The frontend now sends a Content-Security-Policy with no inline script and no eval (seen in its running config).'
			);
		if (!before.baseCurrent)
			opts.info(
				`✓ The frontend now runs on this release's pinned base image (${FRONTEND_BASE.split('@')[0]}, label read back).`
			);
		if (!before.tokensOff || before.uncleared.length > 0)
			opts.info(
				'✓ The frontend now hides its nginx version and drops visitor-set internal headers before the relay and indexer (seen in its running config).'
			);
		return { state: 'refreshed', edgePort: after.edgePort };
	}
	return stale(after);
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

async function applyComposeAndEnv(
	opts: HealOpts,
	clock: Clock,
	id: Identified,
	feEdgePort: number | null
): Promise<ComposeOutcome> {
	const rt = opts.runtime;
	const reserve = opts.rollbackReserveMs ?? ROLLBACK_RESERVE_MS;
	const note = (m: string): void => opts.info(m);
	for (const n of id.notes) note(n);
	const fe = id.frontend;
	const edge = id.edge;
	const feRef = fe ? composeRefOf(fe) : null;
	const edgeRef = edge ? composeRefOf(edge) : null;
	if (fe && !feRef)
		note(`${fe.name} was not started by Docker Compose, so its settings were left alone.`);
	if (edge && !edgeRef)
		note(
			`${edge.name} was not started by Docker Compose, so BunkerWeb's settings were left alone.`
		);
	// BunkerWeb runs here but cannot be looked at (D-5): never "nothing to change".
	const bwUnchecked: string | null =
		edge && !edgeRef
			? `${edge.name} was not started by Docker Compose, so whether BunkerWeb runs with a country list or with Morphit's privacy settings was not checked; on this server: sudo docker exec ${edge.name} grep COUNTRY /etc/nginx/variables.env`
			: id.ambiguous.length > 0
				? `several BunkerWeb containers run here (${id.ambiguous.map((c) => c.name).join(', ')}) and none is known to be the public one, so whether BunkerWeb runs with a country list was not checked; on this server, for each of them: sudo docker exec <name> grep COUNTRY /etc/nginx/variables.env`
				: null;
	const ref = edgeRef ?? feRef;
	if (!ref) return bwUnchecked ? { kind: 'unchecked', reason: bwUnchecked } : { kind: 'no-proxy' };
	const inProject = (r: ComposeRef | null): boolean =>
		r !== null && r.project === ref.project && sameList(r.files, ref.files);
	const edgeIn = edge && inProject(edgeRef) ? edge : null;
	const feIn = fe && inProject(feRef) ? fe : null;
	const svc = {
		edge: edgeIn ? edgeRef!.service : null,
		frontend: feIn ? feRef!.service : null
	};
	if (fe && feRef && !feIn)
		note(
			`${fe.name} belongs to another Docker Compose project than ${edge?.name ?? 'BunkerWeb'}; its logging was left alone.`
		);

	// ── look (bounded, behind a spinner) ──
	let stop = rt.spinner('Reading the web containers’ Compose settings…');
	let m0Files: Map<string, ModelService> | null;
	let m0: Map<string, ModelService> | null;
	let bounded = false;
	const boundedWhy: string[] = [];
	let reachedBefore = false;
	try {
		const a = rt.composeConfig(ref, true, clock.t(PROBE_MS));
		m0Files = a ? parseComposeModel(a) : null;
		const b = rt.composeConfig(ref, false, clock.t(PROBE_MS));
		m0 = b ? parseComposeModel(b) : null;
		if (edgeIn) {
			for (const cs of id.crowdsec)
				if (crowdsecReadsEdge(rt.crowdsecAcquisition(cs.name, clock.t(PROBE_MS)), edgeIn)) {
					bounded = true;
					boundedWhy.push(`CrowdSec (${cs.name}) reads BunkerWeb's log to ban attackers`);
				}
			if (id.socketWatchers.length > 0) {
				bounded = true;
				boundedWhy.push(
					`${id.socketWatchers.map((c) => c.name).join(', ')} can read container logs through the Docker socket`
				);
			}
		}
		reachedBefore = feIn !== null && rt.reachesHost(feIn.name, INDEXER_PORT, clock.t(PROBE_MS));
	} finally {
		stop();
	}
	if (m0 === null) {
		note(
			`Docker Compose could not read ${ref.files.join(', ')}, so the web containers' settings were left alone.`
		);
		return { kind: 'left-alone', reason: 'compose config failed' };
	}
	if (bounded)
		note(
			`${boundedWhy.join('; ')}, so BunkerWeb keeps a small rotating Docker log (5 MB, overwritten as it fills; ` +
				'visitor addresses stay in it that long) instead of none, and its log format is left as it is.'
		);
	// Re-point host.docker.internal only where the frontend reaches the host
	// today, and only on a single network: then "still reaches it afterwards" is
	// a fair test of the change.
	const gw = reachedBefore && feIn && feIn.gateways.length === 1 ? feIn.gateways[0]! : null;

	// ── which env file (Compose says which one the edge reads) ──
	let envPath: string | null = null;
	/** Why no env file could be chosen (said again if BunkerWeb runs without
	 *  Morphit's privacy settings). */
	let envWhy: string | null = null;
	if (edgeIn) {
		const ef = m0Files?.get(svc.edge!)?.envFiles ?? null;
		if (ef === null)
			envWhy =
				"this server's Docker Compose cannot show which settings file BunkerWeb reads (it is older than the " +
				'`--no-env-resolution` option)';
		else {
			const named = ef.filter((p) => /(^|\/)bunkerweb\.env$/.test(p));
			envPath = named.length === 1 ? named[0]! : ef.length === 1 ? ef[0]! : null;
			if (envPath === null)
				envWhy =
					ef.length === 0
						? "BunkerWeb's settings are not in a file Docker Compose reads for it"
						: `BunkerWeb reads several settings files (${ef.join(', ')})`;
		}
		if (envWhy !== null)
			note(
				`${envWhy[0]!.toUpperCase()}${envWhy.slice(1)}, so BunkerWeb's privacy settings, headers and log format were left alone.`
			);
	}
	const schedulers = edgeIn
		? id.schedulers.filter((s) => {
				const r = composeRefOf(s);
				return (
					r !== null &&
					inProject(r) &&
					envPath !== null &&
					(m0Files?.get(r.service)?.envFiles ?? []).includes(envPath)
				);
			})
		: [];

	// ── plan, on bytes ──
	const originals = new Map<string, Buffer>();
	const decoded = new Map<string, DecodedText>();
	const load = (p: string): DecodedText | null => {
		const b = rt.readFile(p);
		const d = b ? decodeConfig(b) : null;
		if (b && d) {
			originals.set(p, b);
			decoded.set(p, d);
		}
		return d;
	};
	const toWrite = new Map<string, Buffer>();
	const envChanges: string[] = [];
	const envNotices: string[] = [];
	let envFinal: Map<string, string> = new Map();
	let envFinalText = '';
	if (envPath) {
		const d = load(envPath);
		if (!d)
			note(
				`${envPath} could not be read, or mixes line endings, so BunkerWeb's settings were left alone.`
			);
		else {
			// BunkerWeb → the frontend's edge listener, so each clearnet visitor gets
			// their own rate-limit bucket — only when the frontend SERVES one, the
			// target is recognisably this frontend on :80, and the site can be
			// probed before and after (no answer, no change).
			const fe = id.frontend;
			const hosts = fe ? [composeRefOf(fe)?.service ?? '', fe.name].filter(Boolean) : [];
			const targets = [...reverseProxyHosts(d.text).entries()];
			const onPort = (v: string, port: string): boolean => {
				const m = /^http:\/\/([^/:\s]+)(?::(\d+))?(\/\S*)?$/.exec(v);
				return m !== null && hosts.includes(m[1]!) && (m[2] ?? '80') === port;
			};
			const toFe80 = targets.filter(([, v]) => onPort(v, '80'));
			const sn = serverNameOf(d.text);
			let edgeTarget: { hosts: string[]; port: number } | undefined;
			if (toFe80.length > 0) {
				if (feEdgePort === null)
					note(
						"BunkerWeb keeps sending to the frontend's port 80 until the frontend is seen serving this release's " +
							'config, so for now every clearnet visitor shares one rate-limit bucket.'
					);
				else if (sn === null)
					note(
						`BunkerWeb has no SERVER_NAME to check the site with, so its ${toFe80.map(([k]) => k).join(', ')} ` +
							`was left on port 80; set it to port ${feEdgePort} to give each clearnet visitor their own rate-limit bucket.`
					);
				else {
					const st = rt.spinner(
						'Checking the site answers before changing where BunkerWeb sends it…'
					);
					let base: { status: number } | null;
					try {
						base = rt.edgeProbe(sn, clock.t(PROBE_MS));
					} finally {
						st();
					}
					if (base !== null && base.status < 500) edgeTarget = { hosts, port: feEdgePort };
					else
						note(
							'The site did not answer cleanly before any change, so where BunkerWeb sends it was left as it is.'
						);
				}
			} else if (
				feEdgePort !== null &&
				targets.length > 0 &&
				!targets.some(([, v]) => onPort(v, String(feEdgePort)))
			)
				note(
					`BunkerWeb sends to ${targets.map(([, v]) => v).join(', ')}, not recognisably ` +
						`this frontend on port 80, so that was left as it is. Until it targets the frontend's port ${feEdgePort}, ` +
						'every clearnet visitor shares one rate-limit bucket.'
				);
			const p = planBunkerwebEnv(d.text, { keepLogFormat: bounded, edgeTarget });
			envFinalText = p.text;
			envFinal = envFileEntries(p.text);
			if (p.changes.length > 0) {
				toWrite.set(envPath, encodeConfig(p.text, d));
				envChanges.push(...p.changes);
				envNotices.push(...(p.notices ?? []));
			}
		}
	}
	const envBefore =
		envPath && decoded.get(envPath) ? envFileEntries(decoded.get(envPath)!.text) : new Map();
	const changedKeys = [...envFinal.keys()].filter((k) => envFinal.get(k) !== envBefore.get(k));

	for (const f of ref.files) {
		if (!load(f)) {
			note(
				`${f} could not be read, or mixes line endings, so the web containers' settings were left alone.`
			);
			return { kind: 'left-alone', reason: `cannot edit ${f}` };
		}
	}
	const textOf = (f: string): string => decoded.get(f)!.text;
	const lastDefining = (s: string): string | null =>
		[...ref.files].reverse().find((f) => serviceDefined(textOf(f), s)) ?? null;
	const operatorLogging = (s: string): boolean =>
		ref.files.some((f) => serviceHasLogging(textOf(f), s));
	const edgeLogFile = svc.edge && !operatorLogging(svc.edge) ? lastDefining(svc.edge) : null;
	const feLogFile =
		svc.frontend && !operatorLogging(svc.frontend) ? lastDefining(svc.frontend) : null;
	const composeChanges: string[] = [];
	const touched = new Set<string>();
	for (const f of ref.files) {
		const p = planCompose(textOf(f), svc, gw, {
			edgeLog: bounded ? 'bounded' : 'none',
			logging: { edge: f === edgeLogFile, frontend: f === feLogFile }
		});
		if (p.changes.length > 0) {
			toWrite.set(f, encodeConfig(p.text, decoded.get(f)!));
			composeChanges.push(...p.changes);
			for (const t of p.touched ?? []) touched.add(t);
		}
	}
	const hostChanged = (s: string | null): boolean =>
		s !== null && composeChanges.some((c) => c.startsWith(`${s}: host.docker.internal`));

	// Running containers that predate what Compose already says.
	const staleOf = (c: ContainerInfo | null): boolean => {
		const want = c ? m0.get(composeRefOf(c)!.service)?.logDriver : null;
		return c !== null && typeof want === 'string' && c.logDriver !== want;
	};
	const staleEdge = staleOf(edgeIn);
	const staleFe = staleOf(feIn);
	const allChanges = [...envChanges, ...composeChanges];

	// ── no country list may reach BunkerWeb, whoever set it (D-1, D-5) ──
	// What BunkerWeb runs with is its generated variables.env; where a list is
	// saved, BunkerWeb's database says (the row's method). A list saved in its
	// web UI ("ui") is removed there; any other is named with where to clear it.
	const dbSched = ((): ContainerInfo | null => {
		const mine = id.schedulers.filter((c) => inProject(composeRefOf(c)));
		return mine[0] ?? (id.schedulers.length === 1 ? id.schedulers[0]! : null);
	})();
	const pollMs = opts.pollMs ?? 3000;
	const schedSvc = dbSched ? (composeRefOf(dbSched)?.service ?? null) : null;
	/** The command that applies a changed setting: the scheduler (it builds
	 *  BunkerWeb's settings) and the edge, recreated on their files. */
	const applyCmd = (): string => {
		const svcs = [dbSched && inProject(composeRefOf(dbSched)) ? schedSvc : null, svc.edge];
		return `sudo ${composeCommand(ref, ['up', '-d', '--no-deps', ...svcs.filter((x): x is string => !!x)])}`;
	};
	interface CountryCheck {
		/** Lines for the lists this run removed and saw gone (shown with ✓). */
		readonly done: readonly string[];
		/** The country lists BunkerWeb runs with now; null: could not be read. */
		readonly live: readonly string[] | null;
		/** Why nothing could be checked, with the command to look by hand. */
		readonly unchecked?: string;
		/** What is left, where it is set and what to do. */
		readonly left?: string;
		/** BunkerWeb's privacy settings that are not Morphit's, when no settings
		 *  file could be chosen to set them in. */
		readonly privacy?: readonly string[];
	}
	const privacyAll = new Map(
		BUNKERWEB_PRIVACY_SETTINGS.filter((p) => !isCountryListKey(p.key)).map(
			(p) => [p.key, p.value] as const
		)
	);
	const checkCountry = async (waitSince: string | null): Promise<CountryCheck> => {
		if (!edgeIn)
			return bwUnchecked
				? { done: [], live: null, unchecked: bwUnchecked }
				: { done: [], live: [] };
		const edgeName = edgeIn.name;
		const cantRead: CountryCheck = {
			done: [],
			live: null,
			unchecked: `BunkerWeb's running settings (/etc/nginx/variables.env in ${edgeName}) could not be read, so whether it runs with a country list was not checked; on this server: sudo docker exec ${edgeName} grep COUNTRY /etc/nginx/variables.env`
		};
		if (!rt.bunkerwebSettings) return cantRead;
		const read = (): string | null => rt.bunkerwebSettings!(edgeName, clock.t(PROBE_MS));
		let stop = rt.spinner('Checking that BunkerWeb runs with no country list…');
		let vars: string | null;
		try {
			vars = read();
		} finally {
			stop();
		}
		if (vars === null) return cantRead;
		// BunkerWeb's scheduler rebuilds by itself; follow its verdict, re-reading.
		const settle = async (
			since: string,
			label: string
		): Promise<{ vars: string | null; refused: string | null }> => {
			const st = rt.spinner(label);
			let v: string | null = null;
			let refusedWhy: string | null = null;
			const until = rt.now() + SETTLE_MAX_MS;
			try {
				for (;;) {
					let loaded = true;
					if (dbSched && rt.schedulerCycle) {
						const c = rt.schedulerCycle([dbSched.name], edgeName, since, clock.t(PROBE_MS));
						if (c.kind === 'refused') refusedWhy = c.reason;
						loaded = c.kind !== 'pending';
					}
					v = read();
					if (v !== null && countryListsInSettings(v).length === 0) break;
					if (loaded || clock.left() < pollMs + 5_000 || rt.now() + pollMs > until) break;
					await rt.sleep(pollMs);
				}
			} finally {
				st();
			}
			return { vars: v, refused: refusedWhy };
		};
		let refused: string | null = null;
		if (waitSince !== null && countryListsInSettings(vars).length > 0) {
			const r = await settle(
				waitSince,
				'Waiting for BunkerWeb to apply the emptied country lists…'
			);
			if (r.vars !== null) vars = r.vars;
			refused = r.refused;
		}
		// No settings file could be chosen, so the privacy settings were not
		// set: say which ones BunkerWeb runs without (never "nothing to change").
		const privacy: string[] = [];
		if (envPath === null) {
			const have = new Map(
				vars
					.split('\n')
					.map((l) => /^([^=\s]+)=(.*)$/.exec(l.replace(/\r$/, '')))
					.filter((m): m is RegExpExecArray => m !== null)
					.map((m) => [m[1]!, m[2]!.trim()] as const)
			);
			for (const [k, v] of privacyAll)
				if (have.get(k) !== v) privacy.push(`${k}=${have.get(k) ?? '(not shown)'}`);
		}
		let lists = countryListsInSettings(vars);
		if (lists.length === 0) return { done: [], live: [], privacy };
		let db: CountryDb | null = null;
		if (dbSched && rt.countryRows) {
			stop = rt.spinner("Asking BunkerWeb's database where the country list is saved…");
			try {
				db = rt.countryRows(dbSched.name, clock.t(PROBE_MS));
			} finally {
				stop();
			}
		}
		const rowOf = (kv: string): CountryRow | undefined =>
			db?.rows.find((r) => r.value.trim() !== '' && kv.startsWith(`${countryKeyOf(r)}=`));
		const ui = lists.map(rowOf).filter((r): r is CountryRow => r?.method === 'ui');
		const done: string[] = [];
		const removed = new Set<string>();
		let uiWhy: string | null = null;
		if (ui.length > 0) {
			if (!rt.removeCountryRows) uiWhy = "this heal cannot edit BunkerWeb's database here";
			else if (clock.left() < VERIFY_MIN_MS) uiWhy = 'not enough time was left in this upgrade';
			else {
				const since = new Date(rt.now() - 2_000).toISOString();
				stop = rt.spinner(
					"Removing the country list saved in BunkerWeb's web UI (a copy of its database is kept)…"
				);
				let res: { backup: string; removed: number } | null;
				try {
					res = rt.removeCountryRows(dbSched!.name, ui, clock.t(PROBE_MS));
				} finally {
					stop();
				}
				if (res === null || res.removed !== ui.length)
					uiWhy = "BunkerWeb's database did not take the change, so nothing in it was changed";
				else {
					for (const r of ui) removed.add(countryKeyOf(r));
					const r2 = await settle(
						since,
						'Waiting for BunkerWeb to apply it (it rebuilds its settings by itself)…'
					);
					if (r2.vars !== null) vars = r2.vars;
					refused = r2.refused ?? refused;
					lists = countryListsInSettings(vars);
					for (const r of ui)
						if (!lists.some((kv) => kv.startsWith(`${countryKeyOf(r)}=`)))
							done.push(
								countryChangeLine(
									countryKeyOf(r),
									[r.value],
									`was saved in BunkerWeb's web UI: removed from its database; the database as it was is kept at ${res.backup} inside ${dbSched!.name}`
								)
							);
				}
			}
		}
		if (lists.length === 0) return { done, live: [], privacy };
		// ── what is left, and where to clear it ──
		const notYet = refused ?? 'it had not rebuilt its settings in time';
		const parts: string[] = [];
		const stale = lists.filter((kv) => removed.has(kv.slice(0, kv.indexOf('='))));
		if (stale.length > 0)
			parts.push(
				`${stale.join(', ')} was removed from BunkerWeb's database (it was saved in its web UI), but BunkerWeb has not applied that yet (${notYet}); it does at its next rebuild — to rebuild now, on this server run: sudo docker restart ${dbSched!.name}.`
			);
		const rest = lists.filter((kv) => !stale.includes(kv));
		const byMethod = (m: string): string[] => rest.filter((kv) => rowOf(kv)?.method === m);
		const inUi = byMethod('ui');
		if (inUi.length > 0)
			parts.push(
				`${inUi.join(', ')} is saved in BunkerWeb's web UI and was not removed here (${uiWhy ?? 'it was saved again'}): in the web UI, empty it under Global config → Country (a per-site list: Services → the site → Country) and save; BunkerWeb applies that by itself.`
			);
		for (const kv of byMethod('autoconf')) {
			const k = kv.slice(0, kv.indexOf('='));
			const m = /^(?:(.+)_)?((?:BLACKLIST|WHITELIST)_COUNTRY)$/.exec(k);
			parts.push(
				`${kv} comes from BunkerWeb's Autoconf: remove the label bunkerweb.${m?.[2] ?? k}${m?.[1] ? ` from the container labelled bunkerweb.SERVER_NAME=${m[1]}` : ' (or that setting in the environment of the BunkerWeb container Autoconf reads)'}; Autoconf applies that by itself.`
			);
		}
		for (const kv of byMethod('scheduler')) {
			const k = kv.slice(0, kv.indexOf('='));
			const inline = [schedSvc, svc.edge].filter(
				(x): x is string => !!x && (m0Files?.get(x)?.environment.has(k) ?? false)
			);
			const schedFiles = schedSvc ? (m0Files?.get(schedSvc)?.envFiles ?? []) : [];
			parts.push(
				inline.length > 0
					? `${kv} is set by the "environment:" entry ${k} of ${inline.join(' and ')} in ${ref.files.join(', ')}: remove it there, then on this server run: ${applyCmd()}`
					: envPath !== null && envFinal.get(k) === '' && schedFiles.includes(envPath)
						? `${envPath} now leaves ${k} empty, but BunkerWeb has not applied that yet (${notYet}); on this server run: ${applyCmd()}`
						: `${kv} comes from the settings BunkerWeb's scheduler${dbSched ? ` (${dbSched.name})` : ''} reads${schedFiles.length > 0 ? ` (${schedFiles.join(', ')})` : ''}: empty it there, then on this server run: ${applyCmd()}`
			);
		}
		const unknown = rest.filter(
			(kv) => !['ui', 'autoconf', 'scheduler'].includes(rowOf(kv)?.method ?? '')
		);
		if (unknown.length > 0) {
			const why = !dbSched
				? 'no BunkerWeb scheduler runs here to ask its database where it is saved'
				: db === null
					? "BunkerWeb's database could not be read here"
					: db.db === 'other'
						? 'BunkerWeb keeps its settings in a database server (MariaDB or PostgreSQL), which Morphit does not edit'
						: db.db === 'missing'
							? "BunkerWeb's database was not found where its DATABASE_URI points"
							: "BunkerWeb's database does not say where it was saved";
			// The settings file this heal edits is named only when it may hold one.
			const files =
				envPath !== null &&
				unknown.every((kv) => (envFinal.get(kv.slice(0, kv.indexOf('='))) ?? '') === '')
					? []
					: (m0Files?.get(svc.edge!)?.envFiles ?? []);
			parts.push(
				`${unknown.join(', ')}: ${why}. It is set in one of these places — BunkerWeb's web UI (empty it under Global config → Country, or Services → the site → Country, and save), an Autoconf label (bunkerweb.BLACKLIST_COUNTRY or bunkerweb.WHITELIST_COUNTRY), or an "environment:" entry${files.length > 0 ? ' or a settings file' : ''} of BunkerWeb's scheduler${files.length > 0 ? ` (BunkerWeb reads ${files.join(', ')})` : ''}.`
			);
		}
		return {
			done,
			live: lists,
			privacy,
			left: `BunkerWeb still runs with a country list (${lists.join(', ')}). No Morphit instance blocks by country. ${parts.join(' ')}`
		};
	};
	const privacyLeft = (problems: readonly string[]): string =>
		`BunkerWeb runs with settings that tell others about its visitors or keep their addresses (${problems.join(', ')}), and Morphit could not set them: ${envWhy ?? 'its settings file could not be chosen'}. Set them as in ops/bunkerweb/bunkerweb.env.example ("Nothing about a visitor leaves this server") in the file BunkerWeb reads, then on this server run: ${applyCmd()}`;
	/** Nothing in the files to change: the outcome is what the live check says. */
	const unchanged = async (): Promise<ComposeOutcome> => {
		const c = await checkCountry(null);
		for (const d of c.done) opts.info(`✓ ${d}`);
		if ((c.privacy ?? []).length > 0)
			return {
				kind: 'left-alone',
				reason: `${privacyLeft(c.privacy!)}${c.left ? ` ${c.left}` : ''}`
			};
		if (c.left) return { kind: 'country-list', reason: c.left };
		if (c.unchecked) return { kind: 'unchecked', reason: c.unchecked };
		return c.done.length > 0 ? { kind: 'applied', changes: c.done } : { kind: 'already' };
	};
	if (allChanges.length === 0 && !staleEdge && !staleFe) return unchanged();

	const upServices: string[] = [];
	const upNames: string[] = [];
	const addUp = (c: ContainerInfo | null): void => {
		if (!c) return;
		const s = composeRefOf(c)!.service;
		if (!upServices.includes(s)) {
			upServices.push(s);
			upNames.push(c.name);
		}
	};
	if (envChanges.length > 0) for (const s of schedulers) addUp(s);
	if (edgeIn && (envChanges.length > 0 || touched.has(svc.edge!) || staleEdge)) addUp(edgeIn);
	if (feIn && (touched.has(svc.frontend!) || staleFe)) addUp(feIn);
	if (upServices.length === 0) return unchanged();

	if (clock.left() < UP_MIN_MS + VERIFY_MIN_MS + reserve) {
		note(
			'Not enough time was left in this upgrade to change the web containers safely, so nothing was changed; ' +
				'the next `sudo morphit-ops upgrade` does it.'
		);
		return { kind: 'no-time' };
	}
	const portsBefore = new Map(list0(id, upNames).map((c) => [c.name, c.ports] as const));

	// ── back up (checked), write (checked) ──
	const backups: string[] = [];
	for (const p of toWrite.keys()) {
		const b = rt.backup(p);
		const copy = b ? rt.readFile(b) : null;
		if (!b || !copy || !copy.equals(originals.get(p)!)) {
			opts.warn(`Left the web-proxy settings as they are: could not keep a copy of ${p} first.`);
			return { kind: 'apply-failed' };
		}
		backups.push(b);
	}
	const copies = `Copies of your original files: ${backups.join(', ')}.`;
	const restore = (): boolean => {
		let ok = true;
		for (const p of toWrite.keys()) {
			const o = originals.get(p)!;
			if (!rt.writeFile(p, o) || !(rt.readFile(p)?.equals(o) ?? false)) ok = false;
		}
		return ok;
	};
	const unguard = rt.onTerminate(() => {
		restore();
	});
	try {
		for (const [p, b] of toWrite) {
			if (!rt.writeFile(p, b) || !(rt.readFile(p)?.equals(b) ?? false)) {
				const back = restore();
				opts.warn(
					`Left the web-proxy settings as they are: could not write ${p}. ` +
						(back
							? 'The original files are back in place and nothing was restarted.'
							: `Putting the originals back could not be confirmed. ${copies}`)
				);
				return { kind: 'apply-failed' };
			}
		}

		// ── Compose's own merged view must show exactly the plan ──
		stop = rt.spinner('Checking the edited settings with Docker Compose…');
		let m1raw: string | null;
		try {
			m1raw = rt.composeConfig(ref, false, clock.t(PROBE_MS));
		} finally {
			stop();
		}
		const m1 = m1raw ? parseComposeModel(m1raw) : null;
		const planned: string[] = [];
		const ms = (s: string | null) => (s ? (m1?.get(s) ?? null) : null);
		if (!m1) planned.push('Docker Compose does not accept the edited files');
		else {
			const e = ms(svc.edge);
			if (edgeLogFile && e) {
				const want = bounded ? 'local' : 'none';
				if (
					e.logDriver !== want ||
					(bounded && (e.logOptions['max-size'] !== '5m' || e.logOptions['max-file'] !== '1'))
				)
					planned.push(`${svc.edge} would not get the ${want} log driver`);
			}
			const f = ms(svc.frontend);
			if (feLogFile && f && f.logDriver !== 'local')
				planned.push(`${svc.frontend} would not get a bounded log`);
			for (const s of [svc.edge, svc.frontend])
				if (hostChanged(s) && !sameList(ms(s)?.dockerHost ?? [], [gw!]))
					planned.push(`${s} would not get host.docker.internal = ${gw} alone`);
			// (A country list that something else sets is named after the change by
			// the country check — never a reason to put every other change back.)
			if (edgeIn && e)
				for (const k of changedKeys)
					if (!isCountryListKey(k) && e.environment.get(k) !== envFinal.get(k))
						planned.push(`BunkerWeb would not get the new ${k} (something else sets it)`);
		}
		if (planned.length > 0) {
			const back = restore();
			const reason = planned.join('; ');
			opts.warn(
				`Left the web-proxy settings as they are: ${reason}. ` +
					(back
						? 'The original files are back in place and nothing was restarted.'
						: `Putting the originals back could not be confirmed. ${copies}`)
			);
			return { kind: 'invalid-compose', reason };
		}

		// ── apply once, then observe what was changed ──
		stop = rt.spinner(
			'Applying the privacy and header settings to the web containers (each restarts once)…'
		);
		const serverName = envPath ? serverNameOf(envFinalText) : null;
		const expectedLogFormat = changedKeys.includes('LOG_FORMAT')
			? envFinal.get('LOG_FORMAT')!
			: null;
		const expectedReferrer = changedKeys.includes('REFERRER_POLICY')
			? envFinal.get('REFERRER_POLICY')!
			: null;
		let why = '';
		// BunkerWeb's scheduler rebuilds the config AFTER its jobs run and may
		// refuse it (config test failed → it keeps the old one); read its verdict.
		const upSince = new Date(rt.now() - 2_000).toISOString();
		const schedsUp = upNames.filter((n) => schedulers.some((s) => s.name === n));
		let refused: string | null = null;
		// The privacy settings this run changes (lib/bunkerwebPrivacy.ts), and
		// where they were seen live: BunkerWeb's generated settings, or (when
		// that file cannot be read) the containers' environment.
		// Country lists are checked after this, by the country check (which also
		// finds a list saved in BunkerWeb's web UI, that no env file can empty).
		const privacyWant = new Map(
			changedKeys
				.filter((k) => BUNKERWEB_PRIVACY_KEYS.includes(k) && !isCountryListKey(k))
				.map((k) => [k, envFinal.get(k)!] as const)
		);
		const evidence: { seen: 'generated' | 'environment' } = { seen: 'environment' };
		try {
			const up = rt.composeUp(ref, upServices, clock.t(UP_MAX_MS, reserve + VERIFY_MIN_MS));
			why = up ? '' : 'Docker Compose did not finish in time';
			while (up) {
				const problems = verifyApplied();
				why = problems.join('; ');
				if (problems.length === 0 || refused !== null) break;
				if (clock.left() - reserve < (opts.pollMs ?? 3000)) break;
				await rt.sleep(opts.pollMs ?? 3000);
			}
		} finally {
			stop();
		}
		function verifyApplied(): string[] {
			const problems: string[] = [];
			if (schedsUp.length > 0 && rt.schedulerCycle) {
				const c = rt.schedulerCycle(
					schedsUp,
					edgeIn?.name ?? null,
					upSince,
					clock.t(PROBE_MS, reserve)
				);
				// Refused: nothing later will change that — say why, stop waiting.
				if (c.kind === 'refused') {
					refused = c.reason;
					return [c.reason];
				}
				if (c.kind === 'pending') problems.push('BunkerWeb is still rebuilding its settings');
			}
			const now = new Map(
				rt.inspect(upNames, clock.t(PROBE_MS, reserve)).map((c) => [c.name, c] as const)
			);
			for (const n of upNames) {
				const c = now.get(n);
				if (!c?.running) problems.push(`${n} is not running`);
				else if (!sameList(c.ports, portsBefore.get(n) ?? []))
					problems.push(`${n} is not on the same published ports`);
			}
			const e = edgeIn ? now.get(edgeIn.name) : undefined;
			const f = feIn ? now.get(feIn.name) : undefined;
			if (e && edgeLogFile) {
				const want = bounded ? 'local' : 'none';
				if (e.logDriver !== want)
					problems.push(`${e.name} does not use the ${want} log driver yet`);
			}
			if (e && staleEdge && e.logDriver !== m0!.get(svc.edge!)?.logDriver)
				problems.push(`${e.name} still keeps its old Docker log`);
			if (f && (feLogFile || staleFe) && !['local', 'none'].includes(f.logDriver))
				problems.push(`${f.name} still keeps an unbounded Docker log`);
			for (const c of [e, f])
				if (c && hostChanged(composeRefOf(c)?.service ?? null)) {
					const hosts = c.extraHosts.filter((h) => /^host\.docker\.internal[:=]/.test(h));
					if (
						!sameList(
							hosts.map((h) => h.replace(/^host\.docker\.internal[:=]/, '')),
							[gw!]
						)
					)
						problems.push(`${c.name} does not map host.docker.internal to ${gw} yet`);
				}
			if (e)
				for (const k of changedKeys)
					if (!isCountryListKey(k) && !e.env.includes(`${k}=${envFinal.get(k)}`))
						problems.push(`${e.name} does not have the new ${k} yet`);
			if (privacyWant.size > 0) {
				// BunkerWeb's jobs (BunkerNet registration, list downloads, the
				// report) run with the scheduler's environment …
				for (const n of schedsUp)
					for (const [k, v] of privacyWant)
						if (now.get(n) && !now.get(n)!.env.includes(`${k}=${v}`))
							problems.push(`${n} does not have the new ${k} yet`);
				// … and its request-time code with the settings the scheduler
				// generated and pushed to the edge.
				const vars =
					e && rt.bunkerwebSettings
						? rt.bunkerwebSettings(e.name, clock.t(PROBE_MS, reserve))
						: null;
				if (vars !== null) {
					evidence.seen = 'generated';
					problems.push(...bunkerwebSettingsProblems(vars, privacyWant));
				} else evidence.seen = 'environment';
			}
			if (e && expectedLogFormat !== null) {
				const dump = rt.nginxT(e.name, clock.t(PROBE_MS, reserve));
				// Unreadable: the container's environment (checked above) is the evidence.
				if (dump !== null && nginxLogFormats(dump).get('logf') !== expectedLogFormat)
					problems.push(`${e.name} does not use the new log format yet`);
			}
			const retargeted = changedKeys.some((k) => /REVERSE_PROXY_HOST/.test(k));
			if (e && serverName && (expectedReferrer !== null || retargeted)) {
				const got = rt.edgeProbe(serverName, clock.t(PROBE_MS, reserve));
				if (got === null || got.status >= 500)
					problems.push(
						`the site does not answer through ${e.name} (${got?.status ?? 'no answer'})`
					);
				else if (expectedReferrer !== null && got.headers['referrer-policy'] !== expectedReferrer)
					problems.push(`${e.name} does not serve Referrer-Policy: ${expectedReferrer} yet`);
			}
			if (
				feIn &&
				reachedBefore &&
				!rt.reachesHost(feIn.name, INDEXER_PORT, clock.t(PROBE_MS, reserve))
			)
				problems.push(`${feIn.name} cannot reach the indexer through host.docker.internal`);
			return problems;
		}
		if (why === '') {
			const countryKeys = changedKeys.filter(isCountryListKey);
			const keyOfLine = (c: string): string | undefined =>
				countryKeys.find((k) => c.includes(`(${k} `));
			for (const c of allChanges) if (keyOfLine(c) === undefined) opts.info(`✓ ${c}`);
			for (const n of envNotices) opts.info(`${n}.`);
			if (privacyWant.size > 0)
				opts.info(
					evidence.seen === 'generated'
						? '✓ Seen in the settings BunkerWeb runs with (the variables.env its scheduler generated).'
						: "✓ Seen in the BunkerWeb containers' environment (BunkerWeb's generated settings file could not be read)."
				);
			if (staleEdge || staleFe)
				opts.info('✓ The web containers now run with the logging their Compose file sets.');
			// Applied and checked. Then no country list may be left: the ones this
			// run emptied are seen gone (✓), one saved in BunkerWeb's web UI is
			// removed, and any other is named with where to clear it.
			const cc = await checkCountry(countryKeys.length > 0 ? upSince : null);
			for (const c of allChanges) {
				const k = keyOfLine(c);
				if (k === undefined) continue;
				if (cc.live !== null && !cc.live.some((kv) => kv.startsWith(`${k}=`))) opts.info(`✓ ${c}`);
				else
					opts.info(
						`${c} — in ${envPath}; ${cc.live === null ? 'not checked in what BunkerWeb runs with' : 'BunkerWeb still runs with it (see below)'}.`
					);
			}
			for (const d of cc.done) opts.info(`✓ ${d}`);
			if ((cc.privacy ?? []).length > 0) opts.warn(privacyLeft(cc.privacy!));
			if (cc.left) opts.warn(cc.left);
			else if (cc.unchecked)
				opts.info(`${cc.unchecked[0]!.toUpperCase()}${cc.unchecked.slice(1)}.`);
			return { kind: 'applied', changes: [...allChanges, ...cc.done] };
		}

		// ── fall back: the original files, the same containers, checked ──
		const filesBack = restore();
		stop = rt.spinner('The new settings did not check out; putting the previous ones back…');
		let upBack = false;
		let running = false;
		try {
			upBack = rt.composeUp(ref, upServices, clock.t(UP_MAX_MS, 5_000));
			while (true) {
				const now = new Map(
					rt.inspect(upNames, clock.t(PROBE_MS, 2_000)).map((c) => [c.name, c] as const)
				);
				running = upNames.every(
					(n) =>
						now.get(n)?.running === true && sameList(now.get(n)!.ports, portsBefore.get(n) ?? [])
				);
				if (running || clock.left() < (opts.pollMs ?? 3000) + 2_000) break;
				await rt.sleep(opts.pollMs ?? 3000);
			}
		} finally {
			stop();
		}
		const verified = filesBack && upBack && running;
		const cmd = `sudo ${composeCommand(ref, ['up', '-d', '--no-deps', ...upServices])}`;
		opts.warn(
			`The web containers' new privacy/header settings were not applied (${why}). ` +
				(verified
					? `The previous settings were put back and checked: ${upNames.join(', ')} run on the same ports as before. `
					: `Putting the previous settings back could not be confirmed (${[
							filesBack ? '' : 'the original files',
							upBack ? '' : 'Docker Compose',
							running ? '' : 'the containers running on their ports'
						]
							.filter(Boolean)
							.join(
								', '
							)}). Check with \`sudo docker ps\`; to start them on the original files run: ${cmd}. `) +
				copies
		);
		return { kind: 'rolled-back', reason: why, restoreVerified: verified };
	} finally {
		unguard();
	}
}

/** The containers (as first seen) for these names. */
function list0(id: Identified, names: readonly string[]): ContainerInfo[] {
	const all = [id.edge, id.frontend, ...id.schedulers].filter(
		(c): c is ContainerInfo => c !== null
	);
	return names.map((n) => all.find((c) => c.name === n)).filter((c): c is ContainerInfo => !!c);
}

// ─── real entry point ───────────────────────────────────────────────────

/** PURE. A proxy URL that is Tor's SocksPort (`socks5://<SocksPort>`, as the
 *  tor-only egress heal writes it; socks5h too). Any other SOCKS proxy —
 *  another local port included (an ssh -D tunnel, a VPN client) — is not. */
export function isTorSocksProxy(url: string, torSocks: string): boolean {
	const m = /^socks5h?:\/\/([^/]+)\/?$/i.exec(url.trim());
	return m !== null && m[1] === torSocks;
}

/** The RUNNING Docker daemon pulls through Tor: its environment has Tor's
 *  SocksPort (torSocksFromEnv, the one the tor-only egress heal writes) as
 *  its HTTPS proxy, and daemon.json does not send pulls elsewhere. */
export function dockerDaemonPullsThroughTor(
	deps: {
		readonly daemonJson?: () => string | null;
		/** The running daemon's environment (`KEY=value`), or null. */
		readonly daemonEnv?: () => string[] | null;
		readonly torSocks?: () => string;
	} = {}
): boolean {
	const tor = (deps.torSocks ?? (() => torSocksFromEnv()))();
	// daemon.json's "proxies" win over the daemon's environment (Docker 23+):
	// one that is not Tor's makes every pull go there instead.
	const daemonJson = (
		deps.daemonJson ??
		(() => {
			try {
				return readFileSync('/etc/docker/daemon.json', 'utf8');
			} catch {
				return null;
			}
		})
	)();
	if (!daemonJsonProxiesAllowTor(daemonJson, tor)) return false;
	const env = (deps.daemonEnv ?? runningDockerEnv)();
	if (env === null) return false;
	// Go's proxy settings: HTTPS_PROXY, else https_proxy.
	const value = (k: string): string =>
		env.find((e) => e.startsWith(`${k}=`) && e.length > k.length + 1)?.slice(k.length + 1) ?? '';
	const https = value('HTTPS_PROXY') || value('https_proxy');
	const noProxy = env
		.filter((e) => /^no_proxy=/i.test(e))
		.map((e) => e.slice(e.indexOf('=') + 1))
		.join(',');
	return isTorSocksProxy(https, tor) && !noProxyBypassesRegistry(noProxy);
}

/** The environment of the running `docker` unit's main process, or null. */
function runningDockerEnv(): string[] | null {
	try {
		const pid = spawnSync('systemctl', ['show', '-p', 'MainPID', '--value', 'docker'], {
			encoding: 'utf8',
			timeout: 10_000
		}).stdout?.trim();
		if (!pid || !/^[1-9]\d*$/.test(pid)) return null;
		return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
	} catch {
		return null;
	}
}

/** PURE. A NO_PROXY list that sends a Docker registry pull around the proxy
 *  (`*`, or an entry covering docker.io / docker.com, where Docker Hub's
 *  registry and its storage live). */
export function noProxyBypassesRegistry(list: string): boolean {
	return list
		.split(/[,\s]+/)
		.map((e) =>
			e
				.trim()
				.toLowerCase()
				.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
				.replace(/:\d+$/, '')
				.replace(/^\*?\./, '')
		)
		.some((e) => e === '*' || /(^|\.)docker\.(io|com)$/.test(e) || e === 'io' || e === 'com');
}

/** PURE. Docker's daemon.json leaves pulls to Tor: no "proxies" block, or one
 *  whose http/https proxies are Tor's SocksPort (`torSocks`). An unreadable or
 *  malformed file is not proof of anything: false. */
export function daemonJsonProxiesAllowTor(text: string | null, torSocks: string): boolean {
	if (text === null || text.trim() === '') return true;
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return false;
	}
	if (doc === null || typeof doc !== 'object') return false;
	const proxies = (doc as { proxies?: unknown }).proxies;
	if (proxies === undefined) return true;
	if (proxies === null || typeof proxies !== 'object') return false;
	const p = proxies as Record<string, unknown>;
	const tor = (v: unknown): boolean =>
		v === undefined || (typeof v === 'string' && isTorSocksProxy(v, torSocks));
	const np = p['no-proxy'];
	if (np !== undefined && (typeof np !== 'string' || noProxyBypassesRegistry(np))) return false;
	return tor(p['http-proxy']) && tor(p['https-proxy']);
}

function docker(args: string[], timeout = 15_000): { ok: boolean; out: string; missing: boolean } {
	try {
		const r = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
		const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
		return { ok: r.status === 0, out: `${r.stdout ?? ''}`.trim(), missing };
	} catch {
		return { ok: false, out: '', missing: false };
	}
}

/** COUNTRY_DB_PY inside a BunkerWeb scheduler (its image ships python3 and
 *  sqlite3; its DATABASE_URI names the database); its output, or null. */
function countryDbPy(
	scheduler: string,
	mode: 'list' | 'remove',
	stdin: string,
	timeout: number
): string | null {
	try {
		const r = spawnSync(
			'docker',
			['exec', '-i', '-e', `MODE=${mode}`, scheduler, 'python3', '-c', COUNTRY_DB_PY],
			{ input: stdin, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 }
		);
		return r.status === 0 ? (r.stdout ?? '').trim() : null;
	} catch {
		return null;
	}
}

/** The real entry point, run from runSelfHeals (after the frontend config heal). */
export async function healProxyConfig(deps: {
	readonly info: (m: string) => void;
	readonly warn: (m: string) => void;
	readonly spinner: (label: string) => () => void;
	/** The install's apps/web/build, to recognise the frontend container. */
	readonly buildDir: string;
	/** Overall ceiling (default HEAL_BUDGET_MS). The background web heal
	 *  (lib/webHeal.ts) gives a slow BunkerWeb the minutes it needs. */
	readonly budgetMs?: number;
	readonly rollbackReserveMs?: number;
}): Promise<ProxyHealOutcome> {
	const stop = deps.spinner('Looking for the web containers…');
	const ver = docker(['version', '--format', '{{.Server.Version}}'], 10_000);
	stop();
	// No Docker on this server: no web containers. Docker installed but not
	// answering is a problem the operator must see, never "nothing to change".
	if (ver.missing) return { kind: 'no-proxy' };
	if (!ver.ok)
		return {
			kind: 'left-alone',
			reason:
				'Docker is not answering on this server, so the web containers could not be checked; on this server check: sudo systemctl status docker'
		};
	// Inside the re-exec'd self-heal child, finish before its kill.
	const inChild = process.argv.includes('__post-upgrade-selfheal');
	const hardStopAt = inChild
		? Date.now() - process.uptime() * 1000 + SELF_HEAL_CHILD_TIMEOUT_MS - 20_000
		: undefined;
	const inspect = (names: readonly string[], t: number): ContainerInfo[] =>
		names.length === 0 ? [] : parseDockerInspect(docker(['inspect', ...names], t).out || '[]');
	// The offline bundle's saved copy of the pinned frontend base, if any.
	const bundle = bundledBaseFile(dirname(dirname(dirname(deps.buildDir))), FRONTEND_BASE);
	return applyAndVerifyProxyConfig({
		info: deps.info,
		warn: deps.warn,
		buildDir: deps.buildDir,
		hardStopAt,
		budgetMs: deps.budgetMs,
		rollbackReserveMs: deps.rollbackReserveMs,
		runtime: {
			now: () => Date.now(),
			containers: (t) => {
				const ps = docker(['ps', '--format', '{{.Names}}'], t);
				if (!ps.ok) return null;
				const names = ps.out
					.split('\n')
					.map((s) => s.trim())
					.filter(Boolean);
				return inspect(names, t);
			},
			inspect,
			composeConfig: (ref, unresolved, t) => {
				const r = docker(
					composeArgs(ref, [
						'config',
						'--format',
						'json',
						...(unresolved ? ['--no-env-resolution'] : [])
					]),
					t
				);
				return r.ok && r.out !== '' ? r.out : null;
			},
			crowdsecAcquisition: (n, t) => {
				const r = docker(
					[
						'exec',
						n,
						'sh',
						'-c',
						'cat /etc/crowdsec/acquis.yaml 2>/dev/null; for f in /etc/crowdsec/acquis.d/*.yaml /etc/crowdsec/acquis.d/*.yml; do [ -f "$f" ] && { echo ---; cat "$f"; }; done; true'
					],
					t
				);
				return r.ok && r.out !== '' ? r.out : null;
			},
			readFile: (p) => {
				try {
					return readFileSync(p);
				} catch {
					return null;
				}
			},
			// In place, so the file keeps its owner and mode.
			writeFile: (p, data) => {
				try {
					writeFileSync(p, data);
					return true;
				} catch {
					return false;
				}
			},
			backup: (p) => {
				const b = `${p}.bak-proxyheal-${Date.now()}`;
				try {
					copyFileSync(p, b);
					return b;
				} catch {
					return null;
				}
			},
			composeUp: (ref, svcs, t) =>
				docker(composeArgs(ref, ['up', '-d', '--no-deps', ...svcs]), t).ok,
			reachesHost: (n, port, t) => {
				// busybox wget (nginx:alpine): any HTTP status means the path is open;
				// a timeout or "refused" means it is not.
				const secs = String(Math.max(1, Math.min(6, Math.floor(t / 1000) - 1)));
				const r = spawnSync(
					'docker',
					[
						'exec',
						n,
						'wget',
						'-q',
						'-O',
						'/dev/null',
						'-T',
						secs,
						`http://host.docker.internal:${port}/v1/health`
					],
					{ encoding: 'utf8', timeout: t }
				);
				return r.status === 0 || /HTTP\//.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
			},
			edgeProbe: (serverName, t) => {
				const r = spawnSync(
					'curl',
					[
						'-sk',
						'-o',
						'/dev/null',
						'-D',
						'-',
						'--max-time',
						String(Math.max(1, Math.floor(t / 1000) - 1)),
						// A proxy in the environment would make curl ignore --resolve.
						'--noproxy',
						'*',
						'--resolve',
						`${serverName}:443:127.0.0.1`,
						`https://${serverName}/`
					],
					{ encoding: 'utf8', timeout: t }
				);
				const lines = (r.stdout ?? '').split(/\r?\n/);
				const status = /^HTTP\/\S+\s+(\d{3})/.exec(lines[0] ?? '')?.[1];
				if (!status) return null;
				const headers: Record<string, string> = {};
				for (const l of lines.slice(1)) {
					const m = /^([^:]+):\s*(.*?)\s*$/.exec(l);
					if (m) headers[m[1]!.toLowerCase()] = m[2]!;
				}
				return { status: Number(status), headers };
			},
			nginxT: (n, t) => {
				const r = docker(['exec', n, 'nginx', '-T'], t);
				return r.ok && r.out !== '' ? r.out : null;
			},
			bunkerwebSettings: (n, t) => {
				const r = docker(['exec', n, 'cat', '/etc/nginx/variables.env'], t);
				return r.ok && r.out !== '' ? r.out : null;
			},
			frontendBase: (n, t) => {
				const r = docker(
					['inspect', n, '--format', `{{index .Config.Labels "${FRONTEND_BASE_LABEL}"}}`],
					t
				);
				return r.ok ? r.out.trim() : null;
			},
			frontendRebuildPinsBase: (ref) => {
				const d = frontendBuildDockerfile(ref);
				try {
					return existsSync(d) && isMorphitFrontendDockerfile(readFileSync(d, 'utf8'));
				} catch {
					return false;
				}
			},
			configNewerThanStart: (n, t) => {
				const started = Date.parse(
					docker(['inspect', n, '--format', '{{.State.StartedAt}}'], t).out
				);
				const newest = Math.max(
					...docker(
						['exec', n, 'sh', '-c', 'stat -c %Y /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf'],
						t
					)
						.out.split(/\s+/)
						.map(Number)
						.filter(Number.isFinite)
				);
				return Number.isFinite(started) && newest * 1000 > started;
			},
			reloadNginx: (n, t) => docker(['exec', n, 'nginx', '-s', 'reload'], t).ok,
			refreshFrontend: (ref, t, withBase = true) => {
				// The release's nginx.conf into the build context (a stack whose compose
				// file bind-mounts it reads the release copy directly), then rebuild +
				// recreate: a recreated container's nginx loads the new file.
				const src = join(
					dirname(dirname(dirname(deps.buildDir))),
					'ops/bunkerweb/frontend/nginx.conf'
				);
				const ddst = frontendBuildDockerfile(ref);
				const dst = join(dirname(ddst), 'nginx.conf');
				try {
					if (existsSync(src) && existsSync(dirname(dst))) copyFileSync(src, dst);
					// The Dockerfile too (its pinned base) — only over one Morphit
					// shipped; an operator's own is left alone.
					// Not while the pinned base cannot be had without a clearnet pull.
					const dsrc = join(dirname(src), 'Dockerfile');
					if (
						withBase &&
						existsSync(dsrc) &&
						existsSync(ddst) &&
						isMorphitFrontendDockerfile(readFileSync(ddst, 'utf8'))
					) {
						// Docker's classic image store holds a base loaded from the
						// offline bundle by its tag only, and a `FROM name:tag@digest`
						// build would ask the registry for it: there, once the tag is
						// proven to be the pinned image, the build names the tag (the
						// label keeps the pinned reference).
						const text = readFileSync(dsrc, 'utf8');
						writeFileSync(
							ddst,
							frontendBaseState(FRONTEND_BASE, bundle, undefined, 15_000) === 'tag'
								? withTagOnlyFrom(text, FRONTEND_BASE)
								: text
						);
					}
				} catch {
					/* the rebuild below still recreates the container */
				}
				// A build context already naming the pinned base (an earlier run) would
				// pull it: then recreate without rebuilding.
				let build = true;
				try {
					build = withBase || !readFileSync(ddst, 'utf8').includes(FRONTEND_BASE);
				} catch {
					/* no Dockerfile in a build context: Compose decides */
				}
				return docker(
					composeArgs(ref, [
						'up',
						'-d',
						'--no-deps',
						...(build ? ['--build'] : []),
						'--force-recreate',
						ref.service
					]),
					t
				).ok;
			},
			hiddenOnly: () => isHiddenOnlyNode(),
			// Here AND usable without a pull, by digest or (classic image store)
			// by a tag proven to be the pinned image (lib/frontendBaseImage.ts).
			baseImagePresent: (t) => frontendBaseState(FRONTEND_BASE, bundle, undefined, t) !== 'absent',
			// `docker load` the offline bundle's copy, then the same proof.
			loadBundledBase: (t) => loadBundledFrontendBase(FRONTEND_BASE, bundle, t) !== 'absent',
			dockerPullsThroughTor: () => dockerDaemonPullsThroughTor(),
			schedulerCycle: (schedulers, edge, sinceIso, t) => {
				const edgeLogs = edge ? dockerLogsSince(edge, sinceIso, t) : '';
				let pending = false;
				for (const sched of schedulers) {
					const c = readSchedulerCycle(dockerLogsSince(sched, sinceIso, t), edgeLogs);
					if (c.kind === 'refused') return c;
					if (c.kind === 'pending') pending = true;
				}
				return pending ? { kind: 'pending' } : { kind: 'loaded' };
			},
			countryRows: (sched, t) => {
				const out = countryDbPy(sched, 'list', '', t);
				return out === null ? null : parseCountryDb(out);
			},
			removeCountryRows: (sched, rows, t) => {
				const out = countryDbPy(sched, 'remove', JSON.stringify(rows), t);
				return out === null ? null : parseCountryRemoval(out);
			},
			onTerminate: (fn) => {
				const h = (): void => {
					try {
						fn();
					} finally {
						process.exit(143);
					}
				};
				process.once('SIGTERM', h);
				process.once('SIGINT', h);
				return () => {
					process.off('SIGTERM', h);
					process.off('SIGINT', h);
				};
			},
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			spinner: deps.spinner
		}
	});
}
