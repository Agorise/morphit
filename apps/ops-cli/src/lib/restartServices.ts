/**
 * Restart morphit systemd units so a just-written config change takes
 * effect — WITHOUT making the operator remember to run a command by
 * hand.  The indexer + relay read their env files ONCE at boot, so a
 * setting changed via `morphit-ops edit` / `alt-address` (e.g. the
 * Tor/Lokinet/I2P footer address) only goes live after a restart.
 * Grandma-friendly (priority #3): the wizards OFFER to do this for the
 * operator and call here, instead of printing a `systemctl` line the
 * operator has to copy.
 *
 * morphit-ops is sometimes run as root and sometimes via sudo, so we
 * use `sudo systemctl …` only when we're NOT already root.  stdio is
 * inherited so any sudo password prompt + systemctl output is visible
 * to the operator.  This mirrors how `morphit-ops upgrade` restarts the
 * same units (it runs as root, so it uses bare `systemctl`).
 *
 * The process-spawn and the yes/no prompt are injectable (defaulting to
 * the real `spawnSync` + `askYesNo`) so the behavior is unit-testable
 * without spawning real services or blocking on stdin.
 */

import { spawnSync } from 'node:child_process';
import { askYesNo } from '../init/prompt.ts';

/** A restart runner: returns the exit status of `cmd args` (null on a
 *  spawn error, e.g. the binary not found). */
export type RestartExec = (cmd: string, args: readonly string[]) => { status: number | null };

/** Real runner — `systemctl`/`sudo systemctl` with inherited stdio. */
const defaultExec: RestartExec = (cmd, args) => {
	const r = spawnSync(cmd, args as string[], { stdio: 'inherit' });
	return { status: r.status };
};

/** True when the current process is uid 0.  `process.getuid` is
 *  undefined on non-POSIX platforms; morphit-ops only ever runs on
 *  Linux servers, but guard anyway so a typo can't throw. */
function isRoot(): boolean {
	return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Restart each unit in order.  Returns the list of units that FAILED
 * to restart (empty array = all succeeded) so the caller can print a
 * targeted manual fallback for only the ones that didn't take.
 *
 * Accepts unit names with or without the `.service` suffix; systemctl
 * accepts both.  A missing `systemctl`/`sudo` binary (e.g. a non-systemd
 * box) surfaces as a non-zero/null status and lands the unit in the
 * returned failure list — the caller degrades to manual instructions.
 */
export function restartServices(units: readonly string[], exec: RestartExec = defaultExec): string[] {
	const root = isRoot();
	const failed: string[] = [];
	for (const unit of units) {
		const cmd = root ? 'systemctl' : 'sudo';
		const args = root ? ['restart', unit] : ['systemctl', 'restart', unit];
		const { status } = exec(cmd, args);
		if (status !== 0) failed.push(unit);
	}
	return failed;
}

/** `systemctl daemon-reload` (sudo-aware, same root-detection as
 *  restartServices) so a just-refreshed unit FILE is picked up before the
 *  caller restarts the service.  Returns true on success (status 0). */
export function daemonReload(exec: RestartExec = defaultExec): boolean {
	const root = isRoot();
	const cmd = root ? 'systemctl' : 'sudo';
	const args = root ? ['daemon-reload'] : ['systemctl', 'daemon-reload'];
	return exec(cmd, args).status === 0;
}

export interface OfferRestartOpts {
	/** Override the yes/no prompt (defaults to the interactive askYesNo). */
	readonly confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
	/** Override the restart runner (defaults to the real spawnSync one). */
	readonly exec?: RestartExec;
}

/**
 * Interactive companion to {@link restartServices}: OFFER to restart the
 * given units now (defaulting to yes — one keystroke), and do it, with a
 * graceful fallback to a copy-paste `systemctl` line on decline OR on a
 * restart failure (so a non-systemd / unprivileged box still gets clear
 * instructions).  Returns true iff a restart was attempted AND every unit
 * came back successfully.
 */
export async function offerRestart(units: readonly string[], opts: OfferRestartOpts = {}): Promise<boolean> {
	if (units.length === 0) return false;
	const confirm = opts.confirm ?? askYesNo;
	const label = (u: string): string => u.replace(/^morphit-/, '').replace(/\.service$/, '');
	const human = units.map(label).join(' + ');
	const plural = units.length > 1 ? 's' : '';
	const yes = await confirm(
		`Restart the affected service${plural} (${human}) now so the change takes effect?`,
		true
	);
	if (!yes) {
		console.log('\n  Not restarted.  Apply the change later with:');
		for (const u of units) console.log(`      sudo systemctl restart ${label(u)}`);
		console.log('');
		return false;
	}
	const failed = restartServices(units, opts.exec);
	if (failed.length === 0) {
		console.log(`\n  ✓ restarted ${human} — the change is live.`);
		console.log('');
		return true;
	}
	console.log('\n  ✗ Could not restart automatically.  Run this by hand:');
	for (const u of failed) console.log(`      sudo systemctl restart ${label(u)}`);
	console.log('');
	return false;
}
