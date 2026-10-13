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
check(
	'gated to root + systemd (no-ops safely elsewhere)',
	/process\.getuid/.test(mod) && /systemd-run', \['--version'/.test(mod)
);
check(
	'arm does NOT schedule (only snapshots) — a failed run never reverts',
	/Does NOT schedule/.test(mod)
);
check(
	'revert never replaces the firewall rule set (it emptied it on a fresh box) — behaviour: test/reachabilityRevertScript.test.ts',
	!/ufw reload/.test(mod) && !/ufw-user\.rules/.test(mod) && /ufw limit \$\{p\}\/tcp/.test(mod)
);
// What arm snapshots and what the revert restores are exercised, not matched:
// test/reachabilityRevert.test.ts and test/reachabilityRevertScript.test.ts.
check(
	'schedules via a transient systemd timer (survives a dropped SSH session)',
	/systemd-run/.test(mod) && /--on-active=\$\{/.test(mod)
);
check(
	'cancel stops the timer + service + resets + cleans up',
	/stop', `\$\{UNIT\}\.timer/.test(mod) &&
		/reset-failed/.test(mod) &&
		/rmSync\(handle\.dir \?\? REVERT_DIR_DEFAULT/.test(mod)
);
check(
	"the snapshot lives in a root-only directory, not the service user's /var/lib/morphit",
	/REVERT_DIR = '\/var\/lib\/morphit-root\//.test(mod)
);
check(
	"the timer is scheduled only after the directory is re-checked as root's alone (behaviour: test/reachabilityRevert.test.ts)",
	/const problem = revertDirProblem\(dir\);\s*if \(problem\) return problem;/.test(mod)
);
check(
	'confirm prompt is TIMED (AbortController, gives up when the window closes)',
	/AbortController/.test(mod) && /ac\.abort\(\)/.test(mod)
);
check(
	'revert window is LONGER than the prompt window (just-in-time confirm still cancels)',
	/promptWindowSec \+ 10/.test(mod)
);
check('confirm is SSH-focused (immediate/binary), not site-focused', /NEW SSH login/.test(mod));

// ── the wiring ── is exercised, not matched: test/installWizardRun.test.ts runs
// the real wizard and checks the guard is armed before the playbook and the
// question asked only after a playbook that succeeded (v1.21.7: a regex here
// broke when the confirm moved into afterInstall, with the behaviour intact).

if (fail === 0) {
	console.log(`\u2713 all ${pass} reachability-revert checks passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} reachability-revert checks FAILED`);
	process.exit(1);
}
