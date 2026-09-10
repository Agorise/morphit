/**
 * reachabilityRevert.ts — a dead-man's-switch for Ansible runs that change SSH or
 * the firewall (the hardening role).
 *
 * Both of the outages that stranded the maintainer's flagship were "the run completed but cut
 * off access": a root-only SSH lockout, and the public site going dark when enabling
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
 * It restores REACHABILITY (keyed SSH login + 22/80/443 + Docker forwarding), not a
 * byte-perfect pre-harden state — getting the operator/users back in is the goal;
 * the rest of hardening (sysctl, auditd, …) doesn't affect reachability.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const REVERT_DIR = '/var/lib/morphit/reachability-revert';
const REVERT_SCRIPT = `${REVERT_DIR}/revert.sh`;
const UNIT = 'morphit-reachability-revert';

/** True only where we can actually snapshot sshd + schedule a transient timer as
 *  root on a systemd box. Everywhere else this whole mechanism no-ops safely. */
export function reachabilityRevertAvailable(): boolean {
	if (typeof process.getuid === 'function' && process.getuid() !== 0) return false;
	const r = spawnSync('systemd-run', ['--version'], { encoding: 'utf8' });
	return !r.error && r.status === 0;
}

export interface RevertHandle {
	readonly armed: boolean;
}

/**
 * Snapshot SSH config + write the revert script. Does NOT schedule the timer yet
 * (so a failed/aborted run before the confirm step never triggers a revert).
 */
export function armReachabilityRevert(): RevertHandle {
	if (!reachabilityRevertAvailable()) return { armed: false };
	try {
		rmSync(REVERT_DIR, { recursive: true, force: true });
		mkdirSync(REVERT_DIR, { recursive: true, mode: 0o700 });
		if (existsSync('/etc/ssh/sshd_config')) {
			cpSync('/etc/ssh/sshd_config', `${REVERT_DIR}/sshd_config`);
		}
		if (existsSync('/etc/ssh/sshd_config.d')) {
			cpSync('/etc/ssh/sshd_config.d', `${REVERT_DIR}/sshd_config.d`, { recursive: true });
		}
		// Snapshot the EXACT firewall rules so the revert restores the box's real
		// posture — NOT a hardcoded clearnet 22/80/443. A hidden-only instance may
		// deliberately have NO clearnet ports open (Tor-only SSH included); blindly
		// re-opening them would expose a box that must stay clearnet-free (the maintainer).
		if (existsSync('/etc/ufw/user.rules')) {
			cpSync('/etc/ufw/user.rules', `${REVERT_DIR}/ufw-user.rules`);
		}
		if (existsSync('/etc/ufw/user6.rules')) {
			cpSync('/etc/ufw/user6.rules', `${REVERT_DIR}/ufw-user6.rules`);
		}
		const script =
			'#!/bin/bash\n' +
			'# Morphit reachability auto-revert — restores access after a harden/install\n' +
			'# that cut off SSH or the public site. Written by morphit-ops before the run.\n' +
			'set +e\n' +
			`cp -a ${REVERT_DIR}/sshd_config /etc/ssh/sshd_config 2>/dev/null\n` +
			`if [ -d ${REVERT_DIR}/sshd_config.d ]; then cp -a ${REVERT_DIR}/sshd_config.d/. /etc/ssh/sshd_config.d/ 2>/dev/null; fi\n` +
			'systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null\n' +
			'# Restore the EXACT pre-run firewall rules (preserves a hidden-only box\'s\n' +
			'# posture — no clearnet ports get opened that were not open before).\n' +
			`if [ -f ${REVERT_DIR}/ufw-user.rules ]; then\n` +
			`  cp -a ${REVERT_DIR}/ufw-user.rules /etc/ufw/user.rules 2>/dev/null\n` +
			`  [ -f ${REVERT_DIR}/ufw-user6.rules ] && cp -a ${REVERT_DIR}/ufw-user6.rules /etc/ufw/user6.rules 2>/dev/null\n` +
			'  ufw reload 2>/dev/null || systemctl restart ufw 2>/dev/null\n' +
			'fi\n' +
			'systemctl restart docker 2>/dev/null\n' +
			`logger -t ${UNIT} "auto-reverted SSH + firewall (exact pre-run rules) + docker after an unconfirmed harden/install" 2>/dev/null\n`;
		writeFileSync(REVERT_SCRIPT, script, { mode: 0o700 });
		return { armed: true };
	} catch {
		return { armed: false };
	}
}

/** Schedule the revert to fire in `windowSec` via a transient systemd timer. */
function scheduleRevert(windowSec: number): boolean {
	const r = spawnSync(
		'systemd-run',
		[`--on-active=${windowSec}s`, `--unit=${UNIT}`, '/bin/bash', REVERT_SCRIPT],
		{ encoding: 'utf8' }
	);
	return !r.error && (r.status === 0 || r.status === null);
}

/** Cancel a scheduled revert (operator confirmed reachability) + clean up. */
export function cancelReachabilityRevert(): void {
	spawnSync('systemctl', ['stop', `${UNIT}.timer`], { stdio: 'ignore' });
	spawnSync('systemctl', ['stop', `${UNIT}.service`], { stdio: 'ignore' });
	spawnSync('systemctl', ['reset-failed', `${UNIT}.timer`, `${UNIT}.service`], { stdio: 'ignore' });
	try {
		rmSync(REVERT_DIR, { recursive: true, force: true });
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
	if (!scheduleRevert(revertWindowSec)) {
		// Couldn't schedule — don't pretend there's a safety net.
		cancelReachabilityRevert();
		return;
	}
	console.log('');
	console.log('  ─────────────────────────────────────────────────────────');
	console.log('  SAFETY: an automatic revert is armed.');
	console.log(`  If you do NOT confirm below within ${promptWindowSec}s, this box will restore SSH`);
	console.log('  + the firewall + Docker on its own — in case this run just cut off your');
	console.log('  access. Test it RIGHT NOW, from another terminal / your laptop:');
	console.log('');
	console.log('     ssh into the box again in a NEW session (do not close this one)');
	console.log('');
	console.log('  If that new login works, you are safe to confirm.');
	console.log('  ─────────────────────────────────────────────────────────');
	const ok = await timedConfirm('Confirmed — a NEW SSH login still works?', promptWindowSec);
	if (ok) {
		cancelReachabilityRevert();
		console.log('  ✓ Confirmed — safety auto-revert cancelled; hardening kept.');
	} else {
		console.log('');
		console.log('  ⏱ Not confirmed — the box is auto-reverting SSH + firewall + Docker now to');
		console.log('     restore access. Re-check that you can reach it, then re-run install/harden.');
	}
}
