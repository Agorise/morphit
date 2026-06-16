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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { parseMxid, type MatrixMxid } from '@morphit/operator-config';

/** Default location of the matrix-bot env file (the systemd unit's
 *  `EnvironmentFile=`). Overridable for tests. */
export const MATRIX_BOT_ENV_PATH = '/etc/morphit/matrix-bot.env';

/** The systemd unit this module manages. */
export const MATRIX_BOT_UNIT = 'morphit-matrix-bot.service';

/** The env keys we read. */
const KEY_MXID = 'MORPHIT_MATRIX_BOT_ALERT_MXID';
const KEY_TOKEN = 'MORPHIT_MATRIX_BOT_ACCESS_TOKEN';

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
				| 'placeholder-token';
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
export function parseMatrixBotEnvText(text: string): { mxidRaw: string; tokenRaw: string } {
	let mxidRaw = '';
	let tokenRaw = '';
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
		if (key === KEY_MXID) mxidRaw = val;
		else if (key === KEY_TOKEN) tokenRaw = val;
	}
	return { mxidRaw, tokenRaw };
}

/** Read + parse the matrix-bot env file. Missing file → exists:false. */
export function readMatrixBotEnv(path: string = MATRIX_BOT_ENV_PATH): MatrixBotEnv {
	if (!existsSync(path)) return { exists: false, mxidRaw: '', tokenRaw: '' };
	const { mxidRaw, tokenRaw } = parseMatrixBotEnvText(readFileSync(path, 'utf-8'));
	return { exists: true, mxidRaw, tokenRaw };
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

/** Read the matrix-bot healthcheck port from the env file (default 9876). */
export function readMatrixBotHealthcheckPort(path: string = MATRIX_BOT_ENV_PATH): number {
	if (!existsSync(path)) return MATRIX_BOT_DEFAULT_HEALTHCHECK_PORT;
	return parseMatrixBotHealthcheckPort(readFileSync(path, 'utf-8'));
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

/** Persist a new alert-MXID value into the env file (read-modify-write),
 *  preserving the token + comments. The file must already exist (it
 *  carries the secret token; we never create a token-bearing file from
 *  scratch here). Returns false if the file is absent. */
export function writeAlertMxid(value: string, path: string = MATRIX_BOT_ENV_PATH): boolean {
	if (!existsSync(path)) return false;
	const next = upsertEnvKey(readFileSync(path, 'utf-8'), KEY_MXID, value);
	writeFileSync(path, next, { mode: 0o600 });
	return true;
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

	if (!run) {
		const { cmd, args } = systemctlArgv(root, 'disable', '--now', MATRIX_BOT_UNIT);
		const { status } = exec(cmd, args);
		return { action: 'disable-stop', ok: status === 0 };
	}

	// run === true: reload (in case the unit file changed on upgrade),
	// enable for autostart, then start-or-restart.
	let ok = true;
	{
		const { cmd, args } = systemctlArgv(root, 'daemon-reload');
		const { status } = exec(cmd, args);
		if (status !== 0) ok = false;
	}
	{
		const { cmd, args } = systemctlArgv(root, 'enable', MATRIX_BOT_UNIT);
		const { status } = exec(cmd, args);
		if (status !== 0) ok = false;
	}
	{
		const verb = opts.restart ? 'restart' : 'start';
		const { cmd, args } = systemctlArgv(root, verb, MATRIX_BOT_UNIT);
		const { status } = exec(cmd, args);
		if (status !== 0) ok = false;
	}
	return { action: opts.restart ? 'enable-restart' : 'enable-start', ok };
}
