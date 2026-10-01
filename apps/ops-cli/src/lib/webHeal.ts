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
	readFileSync,
	statSync,
	writeFileSync,
	openSync,
	readSync,
	closeSync
} from 'node:fs';
import { dirname } from 'node:path';

export const WEB_HEAL_UNIT = 'morphit-web-heal';
export const WEB_HEAL_SUBCOMMAND = '__web-heal';
/** Longest the background unit may run (systemd RuntimeMaxSec). */
export const WEB_HEAL_MAX_S = 45 * 60;

export const webHealStatePath = (): string =>
	process.env.MORPHIT_WEB_HEAL_STATE ?? '/var/lib/morphit/web-heal.json';
export const webHealLogPath = (): string =>
	process.env.MORPHIT_WEB_HEAL_LOG ?? '/var/lib/morphit/web-heal.log';

export interface WebHealState {
	readonly state: 'running' | 'done';
	readonly startedAt: string;
	readonly finishedAt?: string;
	/** The web-proxy heal's outcome kind (applied, already, rolled-back, …). */
	readonly result?: string;
	readonly detail?: string;
}

export function readWebHealState(path = webHealStatePath()): WebHealState | null {
	try {
		const j = JSON.parse(readFileSync(path, 'utf8')) as WebHealState;
		return j && (j.state === 'running' || j.state === 'done') && typeof j.startedAt === 'string'
			? j
			: null;
	} catch {
		return null;
	}
}

export function writeWebHealState(s: WebHealState, path = webHealStatePath()): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(s)}\n`, { mode: 0o640 });
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
	const when = ago(s.finishedAt);
	switch (s.result) {
		case 'applied':
			return `applied and checked (${when})`;
		case 'already':
			return `already in place (checked ${when})`;
		case 'no-proxy':
			return `no web containers to change (checked ${when})`;
		case 'rolled-back':
			return `not applied — ${s.detail ?? 'a check did not pass'}; the previous settings were put back (${when})`;
		default:
			return `not applied (${s.result ?? 'unknown'}${s.detail ? `: ${s.detail}` : ''}; ${when})`;
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
			writeFileSync(log, '', { mode: 0o640 });
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
	readonly spinner: (label: string) => () => void;
}

function readLogFromFile(from: number): [string, number] {
	const p = webHealLogPath();
	try {
		if (!existsSync(p)) return ['', from];
		const size = statSync(p).size;
		if (size <= from) return ['', size < from ? 0 : from];
		const fd = openSync(p, 'r');
		try {
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
			if (clean.trim() !== '') deps.info(clean);
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
