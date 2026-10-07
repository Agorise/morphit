/**
 * The web-proxy heals (BunkerWeb WAF + privacy/headers) run in the BACKGROUND
 * on a BunkerWeb box. (v1.20.1)
 *
 * WHY. The upgrade runs every post-upgrade heal in one child process that the
 * upgrade (the OLD version's code — this release cannot change it) kills after
 * 300 s. A BunkerWeb settings change takes one scheduler rebuild to apply and,
 * when it has to be undone, another; on a network where BunkerWeb's downloads
 * time out that is ~2 minutes EACH (morphitir, 2026-09-30). Inside 300 s,
 * shared with every other heal, it could never finish: the change was always
 * rolled back, the operator got a warning, and nothing improved on the next
 * upgrade either.
 *
 * WHAT. On a box where BunkerWeb runs, the upgrade starts `morphit-ops
 * __web-heal` as its own short-lived systemd unit (morphit-web-heal, removed
 * when it ends, at most 45 min), which applies and verifies with the time
 * BunkerWeb needs. The upgrade shows its progress while it has time left, and
 * says plainly when it continues in the background; `sudo morphit-ops status`
 * shows the result afterwards (the state file below). No systemd-run, or no
 * BunkerWeb: the heals run in the upgrade as before.
 */
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	openSync,
	readSync,
	closeSync,
	fstatSync,
	constants as fsConstants
} from 'node:fs';
import { dirname } from 'node:path';
import {
	ROOT_STATE_DIR,
	ensureOwnDir,
	freshFileNoFollow,
	readNoFollow,
	writeNoFollow
} from './noFollowFs.ts';

export const WEB_HEAL_UNIT = 'morphit-web-heal';
export const WEB_HEAL_SUBCOMMAND = '__web-heal';
/** Longest the background unit may run (systemd RuntimeMaxSec). */
export const WEB_HEAL_MAX_S = 45 * 60;

// Root's files, in directories only root may write (review G1): they lived in
// the morphit account's home, where a link it planted made root write through
// it (and where it could forge the reported result).
export const webHealStatePath = (): string =>
	process.env.MORPHIT_WEB_HEAL_STATE ?? `${ROOT_STATE_DIR}/web-heal.json`;
export const webHealLogPath = (): string =>
	process.env.MORPHIT_WEB_HEAL_LOG ?? '/var/log/morphit/web-heal.log';

export interface WebHealState {
	readonly state: 'running' | 'done';
	readonly startedAt: string;
	readonly finishedAt?: string;
	/** The web-proxy heal's outcome kind (applied, already, rolled-back, …). */
	readonly result?: string;
	readonly detail?: string;
	/** Warnings the run printed (into the web-heal log). */
	readonly warnings?: number;
}

export function readWebHealState(path = webHealStatePath()): WebHealState | null {
	try {
		const txt = readNoFollow(path);
		if (txt === null) return null;
		const j = JSON.parse(txt) as WebHealState;
		return j && (j.state === 'running' || j.state === 'done') && typeof j.startedAt === 'string'
			? j
			: null;
	} catch {
		return null;
	}
}

export function writeWebHealState(s: WebHealState, path = webHealStatePath()): void {
	try {
		ensureOwnDir(dirname(path));
		writeNoFollow(path, `${JSON.stringify(s)}\n`, 0o640);
	} catch {
		/* best-effort: the status line just stays unknown */
	}
}

/** One calm line for an outcome kind. PURE. */
export function describeWebHeal(s: WebHealState, nowMs: number): string {
	const ago = (iso: string | undefined): string => {
		const t = Date.parse(iso ?? '');
		if (!Number.isFinite(t)) return '';
		const m = Math.max(0, Math.floor((nowMs - t) / 60_000));
		return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
	};
	if (s.state === 'running') return `being applied in the background (started ${ago(s.startedAt)})`;
	const n = s.warnings ?? 0;
	const warned =
		n > 0
			? `; ${n === 1 ? 'one warning' : `${n} warnings`}, see on this server: sudo cat ${webHealLogPath()}`
			: '';
	return `${describeOutcome(s, ago)}${warned}`;
}

function describeOutcome(s: WebHealState, ago: (iso: string | undefined) => string): string {
	const when = ago(s.finishedAt);
	const d = s.detail;
	switch (s.result) {
		case 'applied':
			return `applied and checked (${when})`;
		case 'already':
			return `already in place (checked ${when})`;
		case 'no-proxy':
			return `no web containers to change (checked ${when})`;
		case 'country-list':
			return `in place, except: ${d ?? 'BunkerWeb still runs with a country list'} (${when})`;
		case 'unchecked':
			return `checked, except: ${d ?? 'one check could not run'} (${when})`;
		case 'rolled-back':
			return `not applied — ${d ?? 'a check did not pass'}; the previous settings were put back (${when})`;
		case 'invalid-compose':
			return `not applied — ${d ?? 'Docker Compose would not give the new settings'}; the original files are back and nothing was restarted (${when})`;
		case 'no-time':
			return `not applied — not enough time was left; the next sudo morphit-ops upgrade does it (${when})`;
		case 'apply-failed':
			return `not applied — a settings file could not be copied or written first, so nothing was changed (${when})`;
		case 'left-alone':
			return `left as they are — ${d ?? 'they could not be checked'} (${when})`;
		case 'error':
			return `stopped by an error${d ? ` — ${d}` : ''} (${when})`;
		default:
			return `ended without a result this version knows${d ? ` — ${d}` : ''} (${when})`;
	}
}

/** The `morphit-ops status` row for the last web heal: a short value and how
 *  it is marked. A country list left in BunkerWeb is not "not applied" (every
 *  other setting is in place); a check that could not run is neither ok nor
 *  a failure. PURE. */
export function webHealStatusRow(s: WebHealState): {
	readonly value: string;
	readonly status: 'ok' | 'warn' | 'info';
} {
	if (s.state === 'running') return { value: 'applying', status: 'ok' };
	const warned = (s.warnings ?? 0) > 0;
	switch (s.result) {
		case 'applied':
		case 'already':
		case 'no-proxy':
			return warned
				? {
						value: s.result === 'applied' ? 'applied, with warnings' : 'in place, with warnings',
						status: 'warn'
					}
				: { value: 'ok', status: 'ok' };
		case 'country-list':
			return { value: 'in place, except a country list', status: 'warn' };
		case 'unchecked':
			return warned
				? { value: 'not fully checked, with warnings', status: 'warn' }
				: { value: 'not fully checked', status: 'info' };
		case 'left-alone':
			return { value: 'left as they are', status: 'warn' };
		case 'error':
			return { value: 'not finished', status: 'warn' };
		default:
			return { value: 'not applied', status: 'warn' };
	}
}

export interface LaunchDeps {
	readonly run?: typeof spawnSync;
	readonly nodePath?: string;
	readonly cliPath?: string;
}

/** Start the background unit. 'already-running' when one is still at work. */
export function launchWebHeal(
	deps: LaunchDeps = {}
): 'launched' | 'already-running' | 'unavailable' {
	const run = deps.run ?? spawnSync;
	const node = deps.nodePath ?? process.execPath;
	const cli = deps.cliPath ?? process.argv[1] ?? '';
	if (!cli) return 'unavailable';
	try {
		if (
			run('systemctl', ['is-active', '--quiet', WEB_HEAL_UNIT], {
				encoding: 'utf8',
				timeout: 10_000
			}).status === 0
		)
			return 'already-running';
		const log = webHealLogPath();
		try {
			mkdirSync(dirname(log), { recursive: true });
			// A NEW root-owned file: systemd opens this path by name to append.
			freshFileNoFollow(log, '', 0o640);
		} catch {
			/* the unit still runs; only the progress echo is lost */
		}
		const r = run(
			'systemd-run',
			[
				`--unit=${WEB_HEAL_UNIT}`,
				'--collect',
				'--quiet',
				'--description=Morphit: apply the web-proxy (BunkerWeb) settings',
				`--property=RuntimeMaxSec=${WEB_HEAL_MAX_S}`,
				`--property=StandardOutput=append:${log}`,
				`--property=StandardError=append:${log}`,
				'--setenv=NO_COLOR=1',
				node,
				cli,
				WEB_HEAL_SUBCOMMAND
			],
			{ encoding: 'utf8', timeout: 20_000 }
		);
		return r.status === 0 ? 'launched' : 'unavailable';
	} catch {
		return 'unavailable';
	}
}

export interface FollowDeps {
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly readState?: () => WebHealState | null;
	/** New text in the log since byte `from`; returns [text, nextOffset]. */
	readonly readLogFrom?: (from: number) => [string, number];
	readonly info: (m: string) => void;
	/** Warnings the unit printed are passed here (counted by the upgrade). */
	readonly warn?: (m: string) => void;
	readonly spinner: (label: string) => () => void;
}

function readLogFromFile(from: number): [string, number] {
	const p = webHealLogPath();
	try {
		if (!existsSync(p)) return ['', from];
		// Never read through a link (review G1).
		const fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
		try {
			const st = fstatSync(fd);
			if (!st.isFile()) return ['', from];
			const size = st.size;
			if (size <= from) return ['', size < from ? 0 : from];
			const buf = Buffer.alloc(size - from);
			readSync(fd, buf, 0, buf.length, from);
			return [buf.toString('utf8'), size];
		} finally {
			closeSync(fd);
		}
	} catch {
		return ['', from];
	}
}

/**
 * Echo the background heal's progress until it finishes or `untilMs`. Returns
 * the final state when it finished (a run started at or after `sinceMs`), else
 * null (still running).
 */
/** PURE. A spinner label written without a terminal: two spaces, then text
 *  that ends in an ellipsis (init/spinner.ts). */
export function isProgressLabel(line: string): boolean {
	return /^ {2}\S.*\u2026$/.test(line);
}

export async function followWebHeal(
	untilMs: number,
	sinceMs: number,
	deps: FollowDeps
): Promise<WebHealState | null> {
	const now = deps.now ?? (() => Date.now());
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const readState = deps.readState ?? (() => readWebHealState());
	const readLog = deps.readLogFrom ?? readLogFromFile;
	let offset = 0;
	let partial = '';
	const flush = (final: boolean): void => {
		const [text, next] = readLog(offset);
		offset = next;
		const lines = (partial + text).split('\n');
		partial = final ? '' : (lines.pop() ?? '');
		for (const l of lines) {
			// strip terminal control sequences a spinner might have written
			const clean = l
				.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
				.replace(/\r/g, '')
				.trimEnd();
			// A wait label the background unit printed (its spinner has no
			// terminal) is progress, not a result: the log keeps it; the
			// upgrade's own spinner already shows that work goes on.
			if (clean.trim() === '' || isProgressLabel(clean)) continue;
			// A warning or error the unit printed (NO_COLOR: "[WARN] …" / "[ERR] …")
			// stays one here: it is counted for the upgrade's last word.
			const w = /^\s*(?:\[WARN\]|\[ERR\]|⚠|✗)\s+(.*)$/.exec(clean);
			if (w && deps.warn) deps.warn(w[1]!);
			else deps.info(clean);
		}
	};
	for (;;) {
		flush(false);
		const s = readState();
		const started = Date.parse(s?.startedAt ?? '');
		if (s?.state === 'done' && Number.isFinite(started) && started >= sinceMs - 5_000) {
			flush(true);
			return s;
		}
		if (now() >= untilMs) return null;
		const stop = deps.spinner('BunkerWeb is applying the new settings…');
		try {
			await sleep(Math.min(2_000, Math.max(0, untilMs - now())));
		} finally {
			stop();
		}
	}
}
