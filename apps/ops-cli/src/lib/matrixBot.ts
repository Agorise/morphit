/**
 * matrix-bot lifecycle helper for morphit-ops.
 *
 * The morphit-matrix-bot sidecar is installed by default but only RUNS
 * when the operator has configured a valid alert destination — its own
 * opt-in gate (`apps/matrix-bot/src/main.ts`) exits 0 cleanly when
 * `MORPHIT_MATRIX_BOT_ALERT_MXID` is empty. This module gives morphit-ops
 * the matching half: read that field from the bot's env file, decide
 * whether the bot SHOULD run, and drive systemd accordingly
 * (enable+restart vs disable+stop) — so the service auto-starts when the
 * operator sets a matrix username and auto-stops when they clear it, and
 * `morphit-ops upgrade` re-checks the field on every upgrade.
 *
 * Single source of truth: `/etc/morphit/matrix-bot.env`. The bot reads
 * its config from THIS file via the systemd `EnvironmentFile=` directive
 * (it does NOT read morphit.config.env — see apps/matrix-bot/src/config.ts).
 * The secret access token lives here too, so this module is careful to
 * edit only the MXID line and never rewrite or echo the token.
 *
 * Memory's @user:server vs #room:server rule is enforced: a value that
 * parses as a room alias (`#room:server`) is REJECTED with a pointed
 * message — routing private operator alerts to a public room would leak
 * security telemetry. Validation reuses parseMxid from
 * @morphit/operator-config (the same validator the bot itself uses).
 *
 * Pure helpers (readiness decision, env-line upsert/clear, systemctl
 * argv) are exported and injectable so the decision logic is unit-
 * testable without a live systemd, a real sudo, or touching /etc.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync, chmodSync, chownSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { matrixBotPostureText } from './unitPrivilegeHeal.ts';
import { envFlagOn, homeserverRoute } from './matrixRoute.ts';
import { runAsync } from './spinRun.ts';
import { startDotsSpinner } from '../init/spinner.ts';

export { envFlagOn, homeserverRoute };

import { parseMxid, type MatrixMxid } from '@morphit/operator-config';

/** Default location of the matrix-bot env file (the systemd unit's
 *  `EnvironmentFile=`). Overridable for tests. */
export const MATRIX_BOT_ENV_PATH = '/etc/morphit/matrix-bot.env';

/** The systemd unit this module manages. */
export const MATRIX_BOT_UNIT = 'morphit-matrix-bot.service';

/** The env keys we read. */
const KEY_MXID = 'MORPHIT_MATRIX_BOT_ALERT_MXID';
const KEY_TOKEN = 'MORPHIT_MATRIX_BOT_ACCESS_TOKEN';
export const KEY_HOMESERVER = 'MORPHIT_MATRIX_BOT_HOMESERVER';
/** 1 on a tor-only node: the bot (apps/matrix-bot/src/config.ts) refuses any
 *  homeserver that is not loopback or a .onion reached through KEY_SOCKS. */
export const KEY_TOR_ONLY = 'MORPHIT_MATRIX_BOT_TOR_ONLY';
export const KEY_SOCKS = 'MORPHIT_MATRIX_BOT_SOCKS_PROXY';

/** The literal placeholder token shipped in matrix-bot.env.example — an
 *  operator who copied the example but never pasted a real token still
 *  has this value, which is NOT a working token. */
const PLACEHOLDER_TOKEN = 'syt_...';

/** Parsed view of the bot env file (only the fields the lifecycle
 *  cares about). Raw, untrimmed-by-key strings; `null` when the file
 *  doesn't exist. */
export interface MatrixBotEnv {
	readonly exists: boolean;
	/** Raw value of MORPHIT_MATRIX_BOT_ALERT_MXID, or '' if absent. */
	readonly mxidRaw: string;
	/** Raw value of MORPHIT_MATRIX_BOT_ACCESS_TOKEN, or '' if absent. */
	readonly tokenRaw: string;
	/** Raw values of the homeserver, tor-only and SOCKS keys ('' if absent). */
	readonly homeserverRaw?: string;
	readonly torOnlyRaw?: string;
	readonly socksRaw?: string;
}

/** Readiness decision: should the matrix-bot run, and if not, why. */
export type MatrixBotReadiness =
	| { readonly run: true; readonly mxids: ReadonlyArray<MatrixMxid> }
	| {
			readonly run: false;
			readonly reason:
				| 'no-env-file'
				| 'no-mxid'
				| 'mxid-is-room'
				| 'invalid-mxid'
				| 'no-token'
				| 'placeholder-token'
				| 'clearnet-on-tor-only';
			/** The offending raw value, when relevant (for messaging). */
			readonly detail?: string;
	  };

/**
 * Parse a `KEY=value` env file's MXID + token values WITHOUT a full env
 * parser (we don't want to choke on the comments/shape of the operator's
 * hand-edited file). Reads only the LAST uncommented assignment of each
 * key — matching systemd's EnvironmentFile last-wins semantics. Values
 * are returned verbatim except surrounding whitespace and one optional
 * layer of matching quotes are stripped (systemd strips quotes too).
 */
export function parseMatrixBotEnvText(text: string): {
	mxidRaw: string;
	tokenRaw: string;
	homeserverRaw: string;
	torOnlyRaw: string;
	socksRaw: string;
} {
	const v: Record<string, string> = {};
	for (const lineRaw of text.split(/\r?\n/)) {
		const line = lineRaw.trim();
		if (line === '' || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		// Strip one matching pair of surrounding quotes.
		if (
			val.length >= 2 &&
			((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
		) {
			val = val.slice(1, -1);
		}
		v[key] = val;
	}
	return {
		mxidRaw: v[KEY_MXID] ?? '',
		tokenRaw: v[KEY_TOKEN] ?? '',
		homeserverRaw: v[KEY_HOMESERVER] ?? '',
		torOnlyRaw: v[KEY_TOR_ONLY] ?? '',
		socksRaw: v[KEY_SOCKS] ?? ''
	};
}

/** Read + parse the matrix-bot env file. Missing file → exists:false. */
export function readMatrixBotEnv(path: string = MATRIX_BOT_ENV_PATH): MatrixBotEnv {
	if (!existsSync(path)) return { exists: false, mxidRaw: '', tokenRaw: '' };
	return { exists: true, ...parseMatrixBotEnvText(readFileSync(path, 'utf-8')) };
}

/** The healthcheck-port env key + its default (mirrors the bot's own
 *  config.ts default of 9876). `morphit-ops matrix test` POSTs the bot's
 *  loopback healthcheck server at this port to trigger a self-test DM. */
const KEY_HEALTHCHECK_PORT = 'MORPHIT_MATRIX_BOT_HEALTHCHECK_PORT';
export const MATRIX_BOT_DEFAULT_HEALTHCHECK_PORT = 9876;

/** Parse the healthcheck port out of the bot env text (last-wins, same
 *  quote/comment handling as parseMatrixBotEnvText). Falls back to the
 *  default for a missing / malformed / out-of-range value, so the caller
 *  always gets a usable port. */
export function parseMatrixBotHealthcheckPort(text: string): number {
	let raw = '';
	for (const lineRaw of text.split(/\r?\n/)) {
		const line = lineRaw.trim();
		if (line === '' || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (key !== KEY_HEALTHCHECK_PORT) continue;
		let val = line.slice(eq + 1).trim();
		if (
			val.length >= 2 &&
			((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
		) {
			val = val.slice(1, -1);
		}
		raw = val; // last-wins
	}
	const n = Number.parseInt(raw, 10);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : MATRIX_BOT_DEFAULT_HEALTHCHECK_PORT;
}

/** Read the matrix-bot healthcheck port from the env file (default 9876).
 *  Any failure to read the file — it is missing (ENOENT), or it exists but
 *  is not readable by this process (EACCES: the env file is root-owned 0600
 *  and `morphit-ops` is being run as a non-root user), or it is otherwise
 *  unusable — falls back to the default port, exactly like a malformed /
 *  out-of-range value does. The caller therefore always gets a usable port
 *  and never an unhandled fs error. (An `existsSync` pre-check is not enough:
 *  a present-but-unreadable file passes the existence test and then throws on
 *  the read.) */
export function readMatrixBotHealthcheckPort(path: string = MATRIX_BOT_ENV_PATH): number {
	let text: string;
	try {
		text = readFileSync(path, 'utf-8');
	} catch {
		return MATRIX_BOT_DEFAULT_HEALTHCHECK_PORT;
	}
	return parseMatrixBotHealthcheckPort(text);
}

/** True when the token field holds something that could plausibly be a
 *  real access token (non-empty + not the example placeholder). */
function hasUsableToken(tokenRaw: string): boolean {
	const t = tokenRaw.trim();
	return t.length > 0 && t !== PLACEHOLDER_TOKEN;
}

/**
 * Decide whether the bot should run from a parsed env view. Pure.
 *
 * run === true requires BOTH a well-formed MXID list AND a usable access
 * token — starting with an MXID but no token would crash the bot's
 * parseConfig() and (with Restart=on-failure) restart-loop, so we treat
 * "MXID set, token missing" as not-ready rather than starting it.
 */
export function matrixBotReadiness(env: MatrixBotEnv): MatrixBotReadiness {
	if (!env.exists) return { run: false, reason: 'no-env-file' };

	const raw = env.mxidRaw.trim();
	if (raw === '') return { run: false, reason: 'no-mxid' };

	const parts = raw
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (parts.length === 0) return { run: false, reason: 'no-mxid' };

	const mxids: MatrixMxid[] = [];
	for (const p of parts) {
		if (p.startsWith('#')) return { run: false, reason: 'mxid-is-room', detail: p };
		const parsed = parseMxid(p);
		if (parsed === null) return { run: false, reason: 'invalid-mxid', detail: p };
		mxids.push(parsed);
	}

	if (!hasUsableToken(env.tokenRaw)) {
		return {
			run: false,
			reason: env.tokenRaw.trim() === PLACEHOLDER_TOKEN ? 'placeholder-token' : 'no-token'
		};
	}

	if (envFlagOn(env.torOnlyRaw ?? '')) {
		const route = homeserverRoute(env.homeserverRaw ?? '');
		if (
			route === 'clearnet' ||
			route === 'invalid' ||
			(route === 'onion' && (env.socksRaw ?? '').trim() === '')
		) {
			return {
				run: false,
				reason: 'clearnet-on-tor-only',
				detail: (env.homeserverRaw ?? '').trim()
			};
		}
	}

	return { run: true, mxids };
}

/**
 * Upsert a `KEY=value` assignment in env-file text, preserving comments,
 * ordering, and every other line (notably the secret token line). If an
 * uncommented `KEY=` line exists, its value is replaced in place;
 * otherwise the assignment is appended. Pure.
 */
export function upsertEnvKey(text: string, key: string, value: string): string {
	const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
	let replaced = false;
	const out = text.split('\n').map((line) => {
		if (!replaced && re.test(line)) {
			replaced = true; // first uncommented assignment wins
			return `${key}=${value}`;
		}
		return line;
	});
	if (!replaced) {
		// Trim trailing blank lines to a single separator, then append.
		while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop();
		out.push(`${key}=${value}`);
	}
	// Normalize to exactly one trailing newline.
	return out.join('\n').replace(/\n*$/, '\n');
}

/**
 * Set the alert MXID in the env file to empty (the documented
 * "matrix alerting off" state — the bot's opt-in gate treats empty as
 * unconfigured and exits 0). Keeps the key + comments so the file still
 * documents the field. Pure. */
export function clearEnvKey(text: string, key: string): string {
	return upsertEnvKey(text, key, '');
}

/**
 * Write the bot's secret-free posture next to its env file: whether it runs and
 * which homeserver it talks to (`matrixBotPostureText`). The indexer, which
 * cannot read matrix-bot.env (it holds the token), reads this for its clearnet
 * check. root:morphit 0640 when that group exists, else 0640 as is. Best
 * effort; never throws.
 */
export function writeMatrixBotPosture(
	envText: string,
	envPath: string = MATRIX_BOT_ENV_PATH
): void {
	try {
		const p = join(dirname(envPath), 'matrix-bot.posture');
		writeFileSync(p, matrixBotPostureText(envText), { mode: 0o640 });
		chmodSync(p, 0o640);
		const gid = spawnSync('getent', ['group', 'morphit'], { encoding: 'utf8' });
		const g = Number((gid.stdout ?? '').split(':')[2]);
		if (gid.status === 0 && Number.isInteger(g)) chownSync(p, 0, g);
	} catch {
		/* the indexer then treats the bot as unknown, as before */
	}
}

/** Persist a new alert-MXID value into the env file (read-modify-write),
 *  preserving the token + comments. The file must already exist (it
 *  carries the secret token; we never create a token-bearing file from
 *  scratch here). Returns false if the file is absent. */
export function writeAlertMxid(value: string, path: string = MATRIX_BOT_ENV_PATH): boolean {
	if (!existsSync(path)) return false;
	const next = upsertEnvKey(readFileSync(path, 'utf-8'), KEY_MXID, value);
	writeFileSync(path, next, { mode: 0o600 });
	writeMatrixBotPosture(next, path);
	return true;
}

/**
 * Atomically set BOTH the alert MXID and the access token in one env file. Used by
 * `morphit-ops matrix` to persist morphit-ops-minted credentials with NO
 * hand-editing — written to the live matrix-bot.env (so the bot works now) AND to
 * the operator config (so a re-render keeps them). Creates the file if it doesn't
 * exist yet (the operator config may not have the keys before first use).
 */
export function writeMatrixCreds(
	mxid: string,
	token: string,
	path: string = MATRIX_BOT_ENV_PATH,
	extra: Readonly<Record<string, string>> = {}
): boolean {
	try {
		const base = existsSync(path) ? readFileSync(path, 'utf-8') : '';
		let next = upsertEnvKey(base, KEY_MXID, mxid);
		next = upsertEnvKey(next, KEY_TOKEN, token);
		for (const [k, v] of Object.entries(extra)) next = upsertEnvKey(next, k, v);
		writeFileSync(path, next, { mode: 0o600 });
		writeMatrixBotPosture(next, path);
		return true;
	} catch {
		return false;
	}
}

// ─── systemd glue (sudo-aware, mirrors lib/restartServices.ts + mcp.ts) ──

/** A process runner: returns the exit status (null on spawn error). */
export type SystemctlExec = (cmd: string, args: readonly string[]) => { status: number | null };

const defaultExec: SystemctlExec = (cmd, args) => {
	const r = spawnSync(cmd, args as string[], { stdio: 'inherit' });
	return { status: r.status };
};

function isRoot(): boolean {
	return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Build a sudo-aware `systemctl` argv. Pure. */
export function systemctlArgv(
	root: boolean,
	...systemctlArgs: readonly string[]
): { readonly cmd: string; readonly args: readonly string[] } {
	return root
		? { cmd: 'systemctl', args: [...systemctlArgs] }
		: { cmd: 'sudo', args: ['systemctl', ...systemctlArgs] };
}

/** Outcome of a sync. `action` says what we tried to do to the unit. */
export interface MatrixBotSyncResult {
	readonly action: 'enable-start' | 'enable-restart' | 'disable-stop' | 'none';
	/** true when every systemctl invocation returned status 0. */
	readonly ok: boolean;
}

/**
 * Drive systemd to match the readiness decision.
 *
 *   run === true   → daemon-reload, `enable` (autostart), then `start`
 *                    OR `restart` (restart=true picks up new code on
 *                    upgrade) the unit.
 *   run === false  → `disable --now` (stop + no autostart).
 *
 * Idempotent: enabling an already-enabled/running unit is a no-op for
 * `enable`/`start`; `restart` bounces it. sudo-aware. Returns the action
 * + whether all systemctl calls succeeded so the caller can print a
 * targeted manual fallback.
 */
export function syncMatrixBotService(
	run: boolean,
	opts: { readonly restart?: boolean; readonly exec?: SystemctlExec; readonly root?: boolean } = {}
): MatrixBotSyncResult {
	const exec = opts.exec ?? defaultExec;
	const root = opts.root ?? isRoot();
	let ok = true;
	for (const call of matrixBotSystemctlCalls(run, opts.restart === true)) {
		const { cmd, args } = systemctlArgv(root, ...call);
		const { status } = exec(cmd, args);
		if (status !== 0) ok = false;
	}
	return { action: matrixBotSyncAction(run, opts.restart === true), ok };
}

/** The systemctl calls {@link syncMatrixBotService} makes, in order. PURE.
 *   run === true  → daemon-reload (in case the unit file changed on upgrade),
 *                   enable for autostart, then start-or-restart;
 *   run === false → disable --now. */
function matrixBotSystemctlCalls(run: boolean, restart: boolean): string[][] {
	if (!run) return [['disable', '--now', MATRIX_BOT_UNIT]];
	return [
		['daemon-reload'],
		['enable', MATRIX_BOT_UNIT],
		[restart ? 'restart' : 'start', MATRIX_BOT_UNIT]
	];
}

function matrixBotSyncAction(run: boolean, restart: boolean): MatrixBotSyncResult['action'] {
	return !run ? 'disable-stop' : restart ? 'enable-restart' : 'enable-start';
}

/**
 * {@link syncMatrixBotService} for an operator at the terminal. As root each
 * systemctl call runs without blocking the event loop, under the turning
 * braille spinner, and what systemctl printed is shown after. NOT as root,
 * `sudo` may ask for a password, so it is the plain call (no spinner over a
 * password prompt).
 */
export async function syncMatrixBotServiceAtTerminal(
	run: boolean,
	opts: { readonly restart?: boolean } = {}
): Promise<MatrixBotSyncResult> {
	if (!isRoot()) return syncMatrixBotService(run, opts);
	const restart = opts.restart === true;
	const label = !run
		? 'Stopping the Matrix alert bot…'
		: restart
			? 'Restarting the Matrix alert bot…'
			: 'Starting the Matrix alert bot…';
	let ok = true;
	let output = '';
	const stop = startDotsSpinner(label);
	try {
		for (const call of matrixBotSystemctlCalls(run, restart)) {
			const r = await runAsync('systemctl', call, { timeoutMs: 120_000 });
			output +=
				r.output +
				(r.error !== null
					? `${r.error}\n`
					: r.timedOut
						? `systemctl ${call.join(' ')} did not finish within 2 minutes and was stopped; check: sudo systemctl status morphit-matrix-bot\n`
						: '');
			if (r.status !== 0) ok = false;
		}
	} finally {
		stop();
	}
	if (output.trim() !== '') process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
	return { action: matrixBotSyncAction(run, restart), ok };
}

/**
 * Upsert ONLY the alert MXID into the operator config (morphit.config.env),
 * PRESERVING that file's existing mode (0640 — group-readable so the service users
 * can source it). The secret token is NEVER written here; it stays 0600 in
 * matrix-bot.env. Used so the MXID persists across an Ansible re-render without
 * widening the token's exposure (v1.17.0 security review).
 */
export function writeConfigMxid(mxid: string, path: string): boolean {
	try {
		if (!existsSync(path)) return false;
		const mode = statSync(path).mode & 0o777;
		const next = upsertEnvKey(readFileSync(path, 'utf-8'), KEY_MXID, mxid);
		writeFileSync(path, next, { mode });
		return true;
	} catch {
		return false;
	}
}
/** Why a Matrix sign-in did not work, in a form the wizards can explain. */
export type MatrixSignInFailure =
	/** The homeserver says the username or password is wrong (403 M_FORBIDDEN). */
	| 'wrong_password'
	/** Too many attempts: the homeserver asks to wait (429 M_LIMIT_EXCEEDED). */
	| 'rate_limited'
	/** The homeserver does not offer password sign-in. */
	| 'no_password_login'
	/** Nothing at that address answers as a Matrix client API. */
	| 'not_homeserver'
	/** No answer at all (DNS, connection, timeout). */
	| 'unreachable'
	| 'other';

export type MatrixSignIn =
	| { readonly ok: true; readonly token: string; readonly homeserver: string }
	| {
			readonly ok: false;
			readonly why: MatrixSignInFailure;
			/** The homeserver's own errcode/error (or the network error), for the operator. */
			readonly detail: string;
			readonly homeserver: string;
	  };

type Fetch = typeof fetch;

async function getJson(
	url: string,
	f: Fetch
): Promise<{ status: number; body: Record<string, unknown> } | null> {
	try {
		const res = await f(url, { signal: AbortSignal.timeout(15000) });
		let body: Record<string, unknown> = {};
		try {
			const j: unknown = await res.json();
			if (typeof j === 'object' && j !== null) body = j as Record<string, unknown>;
		} catch {
			/* not JSON */
		}
		return { status: res.status, body };
	} catch {
		return null;
	}
}

/** Whether `base` answers as a Matrix client API (GET /_matrix/client/versions). */
async function isClientApi(base: string, f: Fetch): Promise<boolean> {
	const r = await getJson(`${base}/_matrix/client/versions`, f);
	return r !== null && r.status === 200 && Array.isArray(r.body.versions);
}

/**
 * The address to sign in at. Usually what the operator typed; when nothing
 * there answers as a client API, the address the homeserver itself names in
 * its /.well-known/matrix/client (matrix.org → matrix-client.matrix.org), if
 * it is https:// and does answer.
 */
export async function matrixClientBase(homeserver: string, f: Fetch = fetch): Promise<string> {
	const typed = homeserver.replace(/\/+$/, '');
	if (await isClientApi(typed, f)) return typed;
	const wk = await getJson(`${typed}/.well-known/matrix/client`, f);
	const raw = (wk?.body['m.homeserver'] as { base_url?: unknown } | undefined)?.base_url;
	if (typeof raw !== 'string') return typed;
	let found: string;
	try {
		const u = new URL(raw);
		// Only a plain https:// address: no user:password@, query or fragment
		// (the sign-in and the password would be sent with them).
		if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return typed;
		if (u.search !== '' || u.hash !== '') return typed;
		found = u.toString().replace(/\/+$/, '');
	} catch {
		return typed;
	}
	return found !== typed && (await isClientApi(found, f)) ? found : typed;
}

/**
 * Whether an account with this name exists on the homeserver, asked the
 * standard way (GET /_matrix/client/v3/register/available): "missing" when
 * the name is free, "exists" when it is taken, "unknown" when the homeserver
 * does not say (registration closed, endpoint not offered, no answer). Only
 * "missing" is ever acted on.
 */
export async function matrixAccountCheck(
	homeserver: string,
	user: string,
	f: Fetch = fetch
): Promise<'exists' | 'missing' | 'unknown'> {
	const base = homeserver.replace(/\/+$/, '');
	const r = await getJson(
		`${base}/_matrix/client/v3/register/available?username=${encodeURIComponent(user)}`,
		f
	);
	if (r === null) return 'unknown';
	if (r.status === 200 && r.body.available === true) return 'missing';
	if (r.body.errcode === 'M_USER_IN_USE') return 'exists';
	return 'unknown';
}

/**
 * Sign in with a username and password for a FRESH device and an access
 * token that does not expire (no refresh token is asked for, so a homeserver
 * running the Matrix Authentication Service hands out a non-expiring
 * compatibility token). On failure, says why, with the homeserver's words.
 */
export async function matrixSignIn(
	homeserver: string,
	user: string,
	password: string,
	opts: { readonly discover?: boolean; readonly fetch?: Fetch } = {}
): Promise<MatrixSignIn> {
	const f = opts.fetch ?? fetch;
	const base =
		opts.discover === false
			? homeserver.replace(/\/+$/, '')
			: await matrixClientBase(homeserver, f);
	const fail = (why: MatrixSignInFailure, detail: string): MatrixSignIn => ({
		ok: false,
		why,
		detail: detail.slice(0, 300),
		homeserver: base
	});
	let res: Response;
	try {
		res = await f(`${base}/_matrix/client/v3/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal: AbortSignal.timeout(15000),
			// Never followed: a 307/308 would send the password again, to
			// wherever it points — another host, or http:// in the clear.
			redirect: 'manual',
			body: JSON.stringify({
				type: 'm.login.password',
				identifier: { type: 'm.id.user', user },
				password,
				initial_device_display_name: `morphit-alerts-${Date.now()}`
			})
		});
	} catch (e) {
		return fail('unreachable', e instanceof Error ? e.message : String(e));
	}
	if (res.status >= 300 && res.status < 400) {
		const to = res.headers.get('location') ?? '';
		return fail(
			'not_homeserver',
			`it sends the sign-in elsewhere (HTTP ${res.status}${to !== '' ? ` to ${to}` : ''}); type the homeserver's own address`
		);
	}
	let body: Record<string, unknown> = {};
	try {
		const j: unknown = await res.json();
		if (typeof j === 'object' && j !== null) body = j as Record<string, unknown>;
	} catch {
		/* not JSON */
	}
	const errcode = typeof body.errcode === 'string' ? body.errcode : '';
	const error = typeof body.error === 'string' ? body.error : '';
	const detail = [errcode, error].filter((x) => x !== '').join(': ') || `HTTP ${res.status}`;
	if (res.ok) {
		return typeof body.access_token === 'string' && body.access_token.length > 0
			? { ok: true, token: body.access_token, homeserver: base }
			: fail('other', 'the homeserver answered without an access token');
	}
	if (res.status === 429 || errcode === 'M_LIMIT_EXCEEDED') return fail('rate_limited', detail);
	if (res.status === 403 || errcode === 'M_FORBIDDEN') return fail('wrong_password', detail);
	if (errcode === 'M_UNKNOWN' && /login type|unsupported/i.test(error))
		return fail('no_password_login', detail);
	if (!(await isClientApi(base, f))) return fail('not_homeserver', detail);
	const flows = await getJson(`${base}/_matrix/client/v3/login`, f);
	const types = Array.isArray(flows?.body.flows)
		? (flows.body.flows as Array<{ type?: unknown }>).map((x) => x.type)
		: [];
	if (types.length > 0 && !types.includes('m.login.password'))
		return fail('no_password_login', detail);
	return fail('other', detail);
}

/** The token from `matrixSignIn`, or null (the matrix-bot wizard's form). */
export async function mintMatrixToken(
	homeserver: string,
	user: string,
	password: string
): Promise<string | null> {
	// The matrix-bot wizard saves the address as typed, so it signs in there.
	const r = await matrixSignIn(homeserver, user, password, { discover: false });
	return r.ok ? r.token : null;
}
