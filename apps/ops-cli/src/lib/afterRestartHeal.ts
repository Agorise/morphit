/**
 * Heals that need the services already running THIS release.
 *
 * The upgrade's self-heal phase runs the new release's code, but before the
 * upgrade restarts the indexer and relay — and on the upgrade TO a release the
 * restart loop is the previous release's code, which knows nothing of new
 * phases. So the self-heal phase starts a short-lived systemd unit
 * (morphit-after-upgrade-heal) that waits until every Morphit service that was
 * running has been restarted (systemd's ActiveEnterTimestampMonotonic later
 * than the moment it was started), then runs those heals and exits. Its output
 * goes to a log file the operator is pointed at.
 */
import { spawnSync } from 'node:child_process';
import { lutimesSync, mkdirSync, readFileSync } from 'node:fs';
import { freshFileNoFollow, writeNoFollow } from './noFollowFs.ts';
import { dirname } from 'node:path';
import { BASE_FETCH_TIMEOUT_MS } from './frontendBaseFetch.ts';
import { EGRESS_HEAL_MAX_MS } from './torOnlyEgressHeal.ts';

export const AFTER_RESTART_SUBCOMMAND = '__post-upgrade-after-restart';
export const AFTER_RESTART_UNIT = 'morphit-after-upgrade-heal';
/** Longest wait for the restarts, then the heals run anyway. */
export const AFTER_RESTART_WAIT_MS = 15 * 60_000;
/** Longest wait for the background web heal to be idle (waitForUnitIdle). */
export const WEB_HEAL_IDLE_MAX_MS = 10 * 60_000;
/** The heals before the egress heal (hidden RPC list … fee address check):
 *  each a few local calls. The fetch, last, takes only what is left. */
export const EARLY_HEALS_MAX_MS = 10 * 60_000;
/** Kept for the end of the unit (the rebuild's start, the summary, "Done."). */
export const UNIT_END_RESERVE_MS = 2 * 60_000;
/** The unit's time limit (systemd RuntimeMaxSec), from the steps' own limits
 *  in the order the unit runs them: the restarts, the early heals, the egress
 *  heal (after the web heal is idle), the frontend base fetch through Tor and
 *  the wait for the web heal before the rebuild onto it. The fetch fits its
 *  pull into what is left (fetchFrontendBaseNow), so the unit is never killed
 *  in the middle of it. */
export const UNIT_MAX_S = Math.ceil(
	(AFTER_RESTART_WAIT_MS +
		EARLY_HEALS_MAX_MS +
		WEB_HEAL_IDLE_MAX_MS +
		EGRESS_HEAL_MAX_MS +
		BASE_FETCH_TIMEOUT_MS +
		WEB_HEAL_IDLE_MAX_MS +
		UNIT_END_RESERVE_MS) /
		1000
);

/** How long the frontend base fetch may pull when the unit stops at
 *  `deadline`: at most BASE_FETCH_TIMEOUT_MS, leaving the wait for the web
 *  heal and the end of the unit. */
export function baseFetchBudgetMs(deadline: number, now: number = Date.now()): number {
	return Math.min(
		BASE_FETCH_TIMEOUT_MS,
		deadline - now - WEB_HEAL_IDLE_MAX_MS - UNIT_END_RESERVE_MS
	);
}

/** When the after-restart unit running this process is stopped (ms). */
export function afterRestartDeadline(
	now: number = Date.now(),
	uptimeS: number = process.uptime()
): number {
	return now - uptimeS * 1000 + UNIT_MAX_S * 1000;
}

export function afterRestartLogPath(): string {
	return process.env.MORPHIT_AFTER_RESTART_LOG ?? '/var/log/morphit/after-upgrade-heal.log';
}

/** Microseconds since boot (the clock systemd's *Monotonic timestamps use). */
export function monotonicMicros(
	readUptime: () => string = () => readFileSync('/proc/uptime', 'utf8')
): number | null {
	const s = Number(readUptime().trim().split(/\s+/)[0]);
	return Number.isFinite(s) ? Math.floor(s * 1e6) : null;
}

type Run = (
	cmd: string,
	args: string[],
	o: object
) => { status: number | null; stdout?: string | Buffer | null };

/** When `svc` last became active (µs since boot), or null. */
export function activeSince(svc: string, run: Run = spawnSync as unknown as Run): number | null {
	const r = run('systemctl', ['show', '-p', 'ActiveEnterTimestampMonotonic', '--value', svc], {
		encoding: 'utf8',
		timeout: 10_000
	});
	const v = Number(String(r.stdout ?? '').trim());
	return r.status === 0 && Number.isFinite(v) && v > 0 ? v : null;
}

export function isActive(svc: string, run: Run = spawnSync as unknown as Run): boolean {
	return run('systemctl', ['is-active', '--quiet', svc], { timeout: 10_000 }).status === 0;
}

/**
 * Wait until every service in `services` has become active after `sinceUs`
 * (it was restarted), or `maxMs` passes. Services that are not active are not
 * waited for.
 */
export async function waitForRestarts(
	sinceUs: number,
	services: readonly string[],
	deps: {
		readonly activeSince?: (svc: string) => number | null;
		readonly isActive?: (svc: string) => boolean;
		readonly sleep?: (ms: number) => Promise<void>;
		readonly now?: () => number;
		readonly maxMs?: number;
	} = {}
): Promise<'restarted' | 'timed-out'> {
	const since = deps.activeSince ?? activeSince;
	const active = deps.isActive ?? isActive;
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	const stopAt = now() + (deps.maxMs ?? AFTER_RESTART_WAIT_MS);
	for (;;) {
		const pending = services.filter((s) => active(s) && (since(s) ?? 0) <= sinceUs);
		if (pending.length === 0) return 'restarted';
		if (now() >= stopAt) return 'timed-out';
		await sleep(5_000);
	}
}

/**
 * Wait until `unit` is no longer active (another background job of the same
 * upgrade has finished), or `maxMs` passes.
 */
export async function waitForUnitIdle(
	unit: string,
	deps: {
		readonly isActive?: (svc: string) => boolean;
		readonly sleep?: (ms: number) => Promise<void>;
		readonly now?: () => number;
		readonly maxMs?: number;
	} = {}
): Promise<'idle' | 'timed-out'> {
	const active = deps.isActive ?? isActive;
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	const stopAt = now() + (deps.maxMs ?? WEB_HEAL_IDLE_MAX_MS);
	for (;;) {
		if (!active(unit)) return 'idle';
		if (now() >= stopAt) return 'timed-out';
		await sleep(10_000);
	}
}

/** Start the background unit; it runs `<cli> __post-upgrade-after-restart <sinceUs>`. */
export function launchAfterRestartHeals(
	deps: {
		readonly run?: Run;
		readonly nodePath?: string;
		readonly cliPath?: string;
		readonly sinceUs?: number | null;
	} = {}
): 'launched' | 'already-running' | 'unavailable' {
	const run = deps.run ?? (spawnSync as unknown as Run);
	const cli = deps.cliPath ?? process.argv[1] ?? '';
	const since = deps.sinceUs === undefined ? monotonicMicros() : deps.sinceUs;
	if (!cli || since === null) return 'unavailable';
	try {
		if (
			run('systemctl', ['is-active', '--quiet', AFTER_RESTART_UNIT], { timeout: 10_000 }).status ===
			0
		) {
			return 'already-running';
		}
		const log = afterRestartLogPath();
		try {
			mkdirSync(dirname(log), { recursive: true });
			// A NEW root-owned file in place of whatever is there (a link the
			// morphit account planted …): systemd opens it by name to append.
			freshFileNoFollow(log, '', 0o640);
		} catch {
			/* the unit still runs; only its log is lost */
		}
		const r = run(
			'systemd-run',
			[
				`--unit=${AFTER_RESTART_UNIT}`,
				'--collect',
				'--quiet',
				'--description=Morphit: checks that need the restarted services',
				`--property=RuntimeMaxSec=${UNIT_MAX_S}`,
				`--property=StandardOutput=append:${log}`,
				`--property=StandardError=append:${log}`,
				'--setenv=NO_COLOR=1',
				deps.nodePath ?? process.execPath,
				cli,
				AFTER_RESTART_SUBCOMMAND,
				String(since)
			],
			{ encoding: 'utf8', timeout: 20_000 }
		);
		if (r.status === 0) return 'launched';
		// Not started: the log must not look like this upgrade's run of the
		// checks (the upgrade's last lines would say "still running").
		try {
			writeNoFollow(log, 'The background checks could not be started.\n', 0o640);
			lutimesSync(log, 0, 0);
		} catch {
			/* nothing to correct */
		}
		return 'unavailable';
	} catch {
		return 'unavailable';
	}
}
