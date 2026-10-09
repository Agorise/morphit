/**
 * Relay heals for installed nodes (v1.20.1).
 *
 * 1. THE STATE DIRECTORY. v1.20.0 put the relay's state (the SIGNUPS_DISABLED
 *    switch and the persisted daily sign-up ceiling) in /var/lib/morphit/relay.
 *    /var/lib/morphit belongs to the `morphit` user (0750) and the relay runs as
 *    root with an EMPTY capability set, so it cannot even enter it: on all three
 *    live boxes the ceiling was never kept and a switch file there was never
 *    seen (2026-09-30). The state now lives in /var/lib/morphit-relay (the unit's
 *    StateDirectory). This heal moves whatever an operator put in the old
 *    directory — above all a SIGNUPS_DISABLED file, so paused sign-ups STAY
 *    paused — and leaves a link at the old path, so the documented
 *    `touch /var/lib/morphit/relay/SIGNUPS_DISABLED` keeps working.
 *
 * 2. A RELAY THAT IS ENABLED BUT NOT RUNNING. The upgrade restarts only the
 *    services that are running; morphitir's relay had exited with status 0
 *    three days earlier (see apps/relay/src/lib/processGuard.ts), was enabled,
 *    and was skipped. An enabled relay is meant to run: start it and check.
 *
 * `root` relocates every path (tests); '' on a real box.
 */
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	copyFileSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	readlinkSync,
	chmodSync
} from 'node:fs';
import { join } from 'node:path';
import { startDotsSpinner } from '../init/spinner.ts';

export const RELAY_STATE_DIR = '/var/lib/morphit-relay';
export const LEGACY_RELAY_STATE_DIR = '/var/lib/morphit/relay';

export type StateDirOutcome =
	| { kind: 'no-morphit-dir' }
	| { kind: 'linked'; moved: readonly string[] }
	| { kind: 'already' }
	| { kind: 'left-alone'; reason: string };

export function healRelayStateDir(root = '', log: (m: string) => void = () => {}): StateDirOutcome {
	const target = `${root}${RELAY_STATE_DIR}`;
	const legacy = `${root}${LEGACY_RELAY_STATE_DIR}`;
	const parent = `${root}/var/lib/morphit`;
	if (!existsSync(parent)) return { kind: 'no-morphit-dir' };
	try {
		mkdirSync(target, { recursive: true, mode: 0o700 });
		chmodSync(target, 0o700);
	} catch (err) {
		return { kind: 'left-alone', reason: `could not create ${RELAY_STATE_DIR}: ${String(err)}` };
	}
	let st: ReturnType<typeof lstatSync> | null = null;
	try {
		st = lstatSync(legacy);
	} catch {
		st = null;
	}
	if (st?.isSymbolicLink()) {
		const to = readlinkSync(legacy);
		if (to === RELAY_STATE_DIR || to === target) return { kind: 'already' };
		return {
			kind: 'left-alone',
			reason: `${LEGACY_RELAY_STATE_DIR} is a link to ${to}; left as it is`
		};
	}
	const moved: string[] = [];
	if (st?.isDirectory()) {
		// /var/lib/morphit is the morphit account's home, so it can make this
		// directory itself and fill it (a SIGNUPS_DISABLED, a reset daily-ceiling
		// file, links …) for root to move into the relay's private state on every
		// upgrade (review G1). The relay of v1.20.0, the only one that wrote here,
		// ran as root: take files only from a root-owned directory.
		if (st.uid !== 0) {
			return {
				kind: 'left-alone',
				reason: `${LEGACY_RELAY_STATE_DIR} was not made by the relay (owner uid ${st.uid}); nothing was taken from it. On this server check: sudo ls -la ${LEGACY_RELAY_STATE_DIR}`
			};
		}
		for (const name of readdirSync(legacy)) {
			const from = join(legacy, name);
			const to = join(target, name);
			// Only plain files the relay wrote; never a link or anything else.
			const entry = lstatSync(from);
			if (!entry.isFile() || entry.uid !== 0) {
				moved.push(`${name} (left out: not a file the relay wrote)`);
				continue;
			}
			if (existsSync(to)) {
				// The new directory's copy is the live one; keep the old aside.
				renameSync(from, `${to}.from-v1.20.0`);
				moved.push(`${name} (kept aside as ${name}.from-v1.20.0)`);
				continue;
			}
			try {
				renameSync(from, to);
			} catch {
				copyFileSync(from, to);
				rmSync(from, { force: true });
			}
			moved.push(name);
		}
		try {
			rmdirSync(legacy);
		} catch (err) {
			return {
				kind: 'left-alone',
				reason: `could not replace ${LEGACY_RELAY_STATE_DIR}: ${String(err)}`
			};
		}
	} else if (st !== null) {
		return {
			kind: 'left-alone',
			reason: `${LEGACY_RELAY_STATE_DIR} is not a directory; left as it is`
		};
	}
	try {
		symlinkSync(RELAY_STATE_DIR, legacy);
	} catch (err) {
		return {
			kind: 'left-alone',
			reason: `could not link ${LEGACY_RELAY_STATE_DIR}: ${String(err)}`
		};
	}
	if (moved.includes('SIGNUPS_DISABLED'))
		log(`Relay: sign-ups stay paused — SIGNUPS_DISABLED moved to ${RELAY_STATE_DIR}.`);
	log(
		`Relay: its state (the sign-up switch and daily ceiling) now lives in ${RELAY_STATE_DIR}, which the relay can write; ${LEGACY_RELAY_STATE_DIR} points there.`
	);
	return { kind: 'linked', moved };
}

export interface UnitRuntime {
	systemctl(args: readonly string[]): { status: number; out: string };
	sleep(ms: number): void;
}

const realUnits: UnitRuntime = {
	systemctl: (args) => {
		const r = spawnSync('systemctl', [...args], { encoding: 'utf8', timeout: 30_000 });
		return { status: r.status ?? 1, out: (r.stdout ?? '').trim() };
	},
	sleep: (ms) => {
		spawnSync('sleep', [String(Math.ceil(ms / 1000))], { timeout: ms + 5_000 });
	}
};

export type StartOutcome = 'running' | 'not-enabled' | 'started' | 'failed' | 'no-unit';

/** Start `unit` if it is enabled but not running, and check it stays up. */
export function startIfEnabledButStopped(
	unit: string,
	log: (m: string) => void,
	warn: (m: string) => void,
	rt: UnitRuntime = realUnits,
	/** Shown for the start and the 15 s it is watched (the braille spinner). */
	spinner: (label: string) => () => void = (l) => startDotsSpinner(l)
): StartOutcome {
	const active = rt.systemctl(['is-active', unit]).out;
	if (active === 'active' || active === 'activating' || active === 'reloading') return 'running';
	const enabled = rt.systemctl(['is-enabled', unit]);
	if (enabled.out === '' || /not-found/.test(enabled.out)) return 'no-unit';
	if (enabled.out !== 'enabled') return 'not-enabled';
	log(`${unit} is enabled but was not running (${active || 'inactive'}); starting it…`);
	const stop = spinner(`Starting ${unit} and checking it stays up (15 s)…`);
	let started: boolean;
	let up = false;
	try {
		started = rt.systemctl(['start', unit]).status === 0;
		if (started) {
			rt.sleep(15_000);
			up = rt.systemctl(['is-active', unit]).out === 'active';
		}
	} finally {
		stop();
	}
	if (!started) {
		warn(`${unit} could not be started. See: sudo journalctl -u ${unit} -n 50`);
		return 'failed';
	}
	if (up) {
		log(`✓ ${unit} is running again.`);
		return 'started';
	}
	warn(`${unit} did not stay up after starting. See: sudo journalctl -u ${unit} -n 50`);
	return 'failed';
}
