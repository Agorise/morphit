/**
 * Install (or bring up to date) a few systemd units from the release and turn
 * their timer on, VERIFYING the result on systemd itself. (v1.20.0)
 *
 * For self-heals that introduce a NEW timer on nodes installed before it
 * existed (the IPFS clean-up; the tor-only time check). refreshUnits.ts only
 * refreshes units that are already installed; this one installs them.
 *
 * Rules: a unit file is written only when its bytes differ, atomically (temp
 * file in the same directory, then rename), mode 0644; a link or special file
 * at the destination is never written through. `systemctl daemon-reload` runs
 * when anything changed, then `enable --now <timer>`, and the timer must then
 * report enabled + active. Never throws.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface UnitsExec {
	(cmd: string, args: readonly string[]): { status: number | null; stdout: string };
}

const realExec: UnitsExec = (cmd, args) => {
	const r = spawnSync(cmd, args as string[], { encoding: 'utf8', timeout: 60_000 });
	return { status: r.status, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
};

export interface InstallUnitsResult {
	readonly ok: boolean;
	/** Unit files written this run. */
	readonly written: readonly string[];
	/** The timer was seen enabled AND active (false when systemd was skipped). */
	readonly timerRunning: boolean;
	readonly detail?: string;
}

export function installAndEnableUnits(opts: {
	/** `<install root>/ops/systemd` */
	readonly templateDir: string;
	/** `/etc/systemd/system` (MORPHIT_SYSTEMD_DIR in tests). */
	readonly systemdDir: string;
	readonly units: readonly string[];
	/** The .timer among `units` to enable + start. */
	readonly timer: string;
	/** Tests: no systemd here — stop at "written". */
	readonly noSystemd?: boolean;
	readonly exec?: UnitsExec;
}): InstallUnitsResult {
	const exec = opts.exec ?? realExec;
	const written: string[] = [];
	try {
		for (const u of opts.units) {
			const incoming = readFileSync(join(opts.templateDir, u));
			const dest = join(opts.systemdDir, u);
			let st;
			try {
				st = lstatSync(dest);
			} catch {
				st = null;
			}
			if (st && (st.isSymbolicLink() || !st.isFile())) {
				return { ok: false, written, timerRunning: false, detail: `${dest} is not a regular file` };
			}
			if (st && readFileSync(dest).equals(incoming)) continue;
			const tmp = join(opts.systemdDir, `.${u}.${randomBytes(4).toString('hex')}.tmp`);
			try {
				writeFileSync(tmp, incoming, { mode: 0o644, flag: 'wx' });
				renameSync(tmp, dest);
			} catch (err) {
				rmSync(tmp, { force: true });
				throw err;
			}
			written.push(u);
		}
	} catch (err) {
		return {
			ok: false,
			written,
			timerRunning: false,
			detail: err instanceof Error ? err.message : String(err)
		};
	}
	if (opts.noSystemd) return { ok: true, written, timerRunning: false };
	if (written.length > 0 && exec('systemctl', ['daemon-reload']).status !== 0) {
		return { ok: false, written, timerRunning: false, detail: 'systemctl daemon-reload failed' };
	}
	exec('systemctl', ['enable', '--now', opts.timer]);
	const enabled = exec('systemctl', ['is-enabled', opts.timer]).stdout.trim() === 'enabled';
	const active = exec('systemctl', ['is-active', opts.timer]).stdout.trim() === 'active';
	return enabled && active
		? { ok: true, written, timerRunning: true }
		: {
				ok: false,
				written,
				timerRunning: false,
				detail: `${opts.timer} is ${enabled ? 'enabled' : 'not enabled'} and ${active ? 'active' : 'not active'}`
			};
}
