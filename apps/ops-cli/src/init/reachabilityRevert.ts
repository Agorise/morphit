/**
 * reachabilityRevert.ts — a dead-man's-switch for Ansible runs that change SSH or
 * the firewall (the hardening role).
 *
 * Two outages seen on installed instances were "the run completed but cut off
 * access": a root-only SSH lockout, and the public site going dark when enabling
 * UFW wiped Docker's forwarding chains. The per-cause guards (SSH lockout-guard,
 * Docker chain re-assertion, post-harden self-test) close those two specific holes;
 * THIS is the belt-and-suspenders that catches ANY future reachability regression.
 *
 * Mechanism: before the reachability-affecting run we snapshot sshd's config and
 * write a revert script. After the run we SCHEDULE that revert via `systemd-run`
 * (a transient timer that fires independently of the operator's SSH session) and
 * ask the operator to confirm they can still reach the box. Confirm → we cancel the
 * timer. No confirmation within the window (walked away, session dropped, genuinely
 * locked out) → the revert fires and restores SSH + the web ports + Docker's
 * forwarding, so a bad harden self-heals in ~2 minutes instead of stranding anyone.
 *
 * It restores REACHABILITY (keyed SSH login + the pre-run firewall rules + Docker),
 * not a byte-perfect pre-harden state. Other hardening can also cut reachability
 * (a kernel setting such as net.ipv4.ip_forward=0 stops Docker's published ports);
 * those have their own guards and heals and are not undone here.
 *
 * The script runs as root from a transient timer, so it lives in a root-only
 * directory (/var/lib/morphit-root, 0700) and the timer is scheduled only after
 * the directory, the script and the snapshot files are checked to be root's and
 * writable by no one else. (It used to sit under /var/lib/morphit, which belongs
 * to the service user: whoever ran as that user could edit what root then ran.)
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export const REVERT_DIR = '/var/lib/morphit-root/reachability-revert';
const REVERT_DIR_DEFAULT = REVERT_DIR;
const UNIT = 'morphit-reachability-revert';

/** Test seam: where the snapshot lives. */
export interface RevertOptions {
	dir?: string;
}

const run = (cmd: string, args: string[]): { error?: Error; status: number | null } =>
	spawnSync(cmd, args, { encoding: 'utf8' });

/**
 * Why `dir` (and everything in it, and its parent) cannot be trusted as the
 * source of a script root runs; null when it can. Owner must be root (uid 0),
 * nothing may be a symlink, and nothing may be writable by group or others.
 */
export function revertDirProblem(dir: string): string | null {
	const check = (p: string, wantDir: boolean): string | null => {
		let st;
		try {
			st = lstatSync(p);
		} catch {
			return `${p} is missing`;
		}
		if (st.isSymbolicLink()) return `${p} is a symlink`;
		if (wantDir ? !st.isDirectory() : !st.isFile() && !st.isDirectory())
			return `${p} is not what was written`;
		if (st.uid !== 0) return `${p} is owned by uid ${st.uid}, not root`;
		if ((st.mode & 0o022) !== 0)
			return `${p} is writable by others (mode ${(st.mode & 0o777).toString(8)})`;
		return null;
	};
	const walk = (p: string): string | null => {
		const own = check(p, true);
		if (own) return own;
		for (const n of readdirSync(p)) {
			const q = join(p, n);
			const st = lstatSync(q);
			const bad = st.isDirectory() && !st.isSymbolicLink() ? walk(q) : check(q, false);
			if (bad) return bad;
		}
		return null;
	};
	return check(dirname(dir), true) ?? walk(dir);
}

/** True only where we can actually snapshot sshd + schedule a transient timer as
 *  root on a systemd box. Everywhere else this whole mechanism no-ops safely. */
export function reachabilityRevertAvailable(): boolean {
	if (typeof process.getuid === 'function' && process.getuid() !== 0) return false;
	const r = spawnSync('systemd-run', ['--version'], { encoding: 'utf8' });
	return !r.error && r.status === 0;
}

export interface RevertHandle {
	readonly armed: boolean;
	readonly dir?: string;
}

/**
 * Snapshot SSH config + write the revert script. Does NOT schedule the timer yet
 * (so a failed/aborted run before the confirm step never triggers a revert).
 */
export function armReachabilityRevert(opts: RevertOptions = {}): RevertHandle {
	if (!reachabilityRevertAvailable()) return { armed: false };
	const dir = opts.dir ?? REVERT_DIR_DEFAULT;
	try {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dirname(dir), 0o700);
		chmodSync(dir, 0o700);
		if (existsSync('/etc/ssh/sshd_config')) {
			cpSync('/etc/ssh/sshd_config', `${dir}/sshd_config`);
		}
		if (existsSync('/etc/ssh/sshd_config.d')) {
			cpSync('/etc/ssh/sshd_config.d', `${dir}/sshd_config.d`, { recursive: true });
		}
		// Snapshot the EXACT firewall rules so the revert restores the box's real
		// posture — NOT a hardcoded clearnet 22/80/443. A hidden-only instance may
		// deliberately have NO clearnet ports open (Tor-only SSH included); blindly
		// re-opening them would expose a box that must stay clearnet-free.
		if (existsSync('/etc/ufw/user.rules')) {
			cpSync('/etc/ufw/user.rules', `${dir}/ufw-user.rules`);
		}
		if (existsSync('/etc/ufw/user6.rules')) {
			cpSync('/etc/ufw/user6.rules', `${dir}/ufw-user6.rules`);
		}
		const script =
			'#!/bin/bash\n' +
			'# Morphit reachability auto-revert — restores access after a harden/install\n' +
			'# that cut off SSH or the public site. Written by morphit-ops before the run.\n' +
			'set +e\n' +
			`cp -a ${dir}/sshd_config /etc/ssh/sshd_config 2>/dev/null\n` +
			`if [ -d ${dir}/sshd_config.d ]; then cp -a ${dir}/sshd_config.d/. /etc/ssh/sshd_config.d/ 2>/dev/null; fi\n` +
			'systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null\n' +
			"# Restore the EXACT pre-run firewall rules (preserves a hidden-only box's\n" +
			'# posture — no clearnet ports get opened that were not open before).\n' +
			`if [ -f ${dir}/ufw-user.rules ]; then\n` +
			`  cp -a ${dir}/ufw-user.rules /etc/ufw/user.rules 2>/dev/null\n` +
			`  [ -f ${dir}/ufw-user6.rules ] && cp -a ${dir}/ufw-user6.rules /etc/ufw/user6.rules 2>/dev/null\n` +
			'  ufw reload 2>/dev/null || systemctl restart ufw 2>/dev/null\n' +
			'fi\n' +
			'systemctl restart docker 2>/dev/null\n' +
			`logger -t ${UNIT} "auto-reverted SSH + firewall (exact pre-run rules) + docker after an unconfirmed harden/install" 2>/dev/null\n`;
		writeFileSync(`${dir}/revert.sh`, script, { mode: 0o700 });
		return { armed: true, dir };
	} catch {
		return { armed: false };
	}
}

/**
 * Schedule the revert to fire in `windowSec` via a transient systemd timer —
 * only after re-checking that what root will run is still root's alone.
 */
function scheduleRevert(handle: RevertHandle, windowSec: number): string | null {
	const dir = handle.dir ?? REVERT_DIR_DEFAULT;
	const problem = revertDirProblem(dir);
	if (problem) return problem;
	const r = run('systemd-run', [
		`--on-active=${windowSec}s`,
		`--unit=${UNIT}`,
		'/bin/bash',
		`${dir}/revert.sh`
	]);
	return !r.error && (r.status === 0 || r.status === null)
		? null
		: 'systemd-run could not schedule the timer';
}

/** Cancel a scheduled revert (operator confirmed reachability) + clean up. */
export function cancelReachabilityRevert(handle: RevertHandle = { armed: false }): void {
	run('systemctl', ['stop', `${UNIT}.timer`]);
	run('systemctl', ['stop', `${UNIT}.service`]);
	run('systemctl', ['reset-failed', `${UNIT}.timer`, `${UNIT}.service`]);
	try {
		rmSync(handle.dir ?? REVERT_DIR_DEFAULT, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

/** A confirm prompt that gives up (returns false) exactly when the window closes,
 *  so the terminal never hangs after the timer has fired. */
async function timedConfirm(question: string, windowSec: number): Promise<boolean> {
	const ac = new AbortController();
	const rl = createInterface({ input: stdin, output: stdout });
	const timer = setTimeout(() => ac.abort(), windowSec * 1000);
	try {
		const ans = (await rl.question(`${question} [y/N] `, { signal: ac.signal }))
			.trim()
			.toLowerCase();
		return ans === 'y' || ans === 'yes';
	} catch {
		return false; // aborted = window elapsed = NOT confirmed
	} finally {
		clearTimeout(timer);
		rl.close();
	}
}

/**
 * Arm-and-confirm: schedule the revert, then ask the operator to confirm they can
 * still reach the box. Confirm → cancel. Otherwise the revert fires. The prompt is
 * SSH-focused (immediate + binary), not site-focused — a fresh install's site may
 * still be starting, and the Docker/site path is already guarded + fail-loud in the
 * hardening role. `promptWindowSec` < the scheduled window so a just-in-time confirm
 * cleanly cancels before the timer fires.
 */
export async function confirmReachabilityOrRevert(
	handle: RevertHandle,
	promptWindowSec = 120
): Promise<void> {
	if (!handle.armed) return;
	const revertWindowSec = promptWindowSec + 10;
	const notScheduled = scheduleRevert(handle, revertWindowSec);
	if (notScheduled !== null) {
		// Couldn't schedule — don't pretend there's a safety net.
		cancelReachabilityRevert(handle);
		console.log('');
		console.log(`  The automatic SSH/firewall revert was not armed (${notScheduled}).`);
		console.log(
			'  Check from a NEW SSH session that you can still log in before closing this one.'
		);
		return;
	}
	console.log('');
	console.log('  ─────────────────────────────────────────────────────────');
	console.log('  SAFETY: an automatic revert is armed.');
	console.log(
		`  If you do NOT confirm below within ${promptWindowSec}s, this box will restore SSH`
	);
	console.log('  + the firewall + Docker on its own — in case this run just cut off your');
	console.log('  access. Test it RIGHT NOW, from another terminal / your laptop:');
	console.log('');
	console.log('     ssh into the box again in a NEW session (do not close this one)');
	console.log('');
	console.log('  If that new login works, you are safe to confirm.');
	console.log('  ─────────────────────────────────────────────────────────');
	const ok = await timedConfirm('Confirmed — a NEW SSH login still works?', promptWindowSec);
	if (ok) {
		cancelReachabilityRevert(handle);
		console.log('  ✓ Confirmed — safety auto-revert cancelled; hardening kept.');
	} else {
		console.log('');
		console.log('  ⏱ Not confirmed — the box is auto-reverting SSH + firewall + Docker now to');
		console.log('     restore access. Re-check that you can reach it, then re-run install/harden.');
	}
}
