/**
 * reachability-revert-smoke — pins the harden/install dead-man's-switch (v1.16.14):
 * a scheduled auto-revert that restores SSH + firewall + Docker if the operator
 * can't confirm reachability after a run that changed them. Structural: the module
 * runs real systemd-run / sshd / systemctl, so we assert the mechanism's shape
 * rather than executing it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = readFileSync(join(OPS, 'src', 'init', 'reachabilityRevert.ts'), 'utf8');
const wire = readFileSync(join(OPS, 'src', 'init', 'runAnsibleInstall.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) pass++;
	else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

// ── the mechanism ──
check('gated to root + systemd (no-ops safely elsewhere)', /process\.getuid/.test(mod) && /systemd-run', \['--version'/.test(mod));
check('arm snapshots sshd_config (+ drop-ins) before the run', /cpSync\('\/etc\/ssh\/sshd_config'/.test(mod) && /sshd_config\.d/.test(mod));
check('arm does NOT schedule (only snapshots) — a failed run never reverts', /Does NOT schedule/.test(mod));
check('revert restores the EXACT pre-run firewall rules (no hardcoded clearnet opens — hidden-only safe)', /ufw-user\.rules/.test(mod) && /ufw reload/.test(mod) && !/ufw allow 80\/tcp/.test(mod) && !/ufw allow 443\/tcp/.test(mod));
check('arm snapshots the ufw rule files + revert restores SSH + Docker', /cpSync\('\/etc\/ufw\/user\.rules'/.test(mod) && /restart ssh/.test(mod) && /restart docker/.test(mod));
check('schedules via a transient systemd timer (survives a dropped SSH session)', /systemd-run/.test(mod) && /--on-active=\$\{/.test(mod));
check('cancel stops the timer + service + resets + cleans up', /stop', `\$\{UNIT\}\.timer/.test(mod) && /reset-failed/.test(mod) && /rmSync\(REVERT_DIR/.test(mod));
check('confirm prompt is TIMED (AbortController, gives up when the window closes)', /AbortController/.test(mod) && /ac\.abort\(\)/.test(mod));
check('revert window is LONGER than the prompt window (just-in-time confirm still cancels)', /promptWindowSec \+ 10/.test(mod));
check('confirm is SSH-focused (immediate/binary), not site-focused', /NEW SSH login/.test(mod));

// ── the wiring ──
check('install arms the guard BEFORE the playbook run', /armReachabilityRevert\(\)[\s\S]{0,200}assembleInstall\(/.test(wire));
check('install confirms-or-reverts AFTER a successful run', /res\.ok[\s\S]{0,400}confirmReachabilityOrRevert\(reachabilityGuard\)/.test(wire));

if (fail === 0) {
	console.log(`\u2713 all ${pass} reachability-revert checks passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} reachability-revert checks FAILED`);
	process.exit(1);
}
