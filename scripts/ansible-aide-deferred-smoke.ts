#!/usr/bin/env tsx
/**
 * ansible-aide-deferred — cp680.
 *
 * The AIDE filesystem-integrity baseline hashes the whole disk (20-45+ min on a
 * low-power CPU). It used to run synchronously inside the wizard, blowing the
 * 15-minute install target. It doesn't need to block: the baseline is built from
 * the freshly-installed files either way. So it now runs as a DEFERRED,
 * idle-priority background oneshot that never competes with the indexer sync.
 *
 * Invariant guarded here: the wizard does NOT wait on AIDE — no synchronous
 * `aideinit` / `async_status` poll — and the deferred service exists, is started
 * non-blocking, runs at idle priority, and is idempotent.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const aide = readFileSync(join(REPO, 'ops/ansible/roles/hardening/tasks/aide.yml'), 'utf8');
const playbook = readFileSync(join(REPO, 'ops/ansible/playbook.yml'), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── ansible-aide-deferred (cp680) ──────────────────────\n');

// 1. the wizard must NOT block on AIDE: no synchronous poll-until-finished
check(
	'no blocking async_status wait on AIDE in the wizard',
	!/async_status/.test(aide),
	'the wizard must not wait for the baseline to finish'
);
check(
	'no synchronous `aideinit` command task in the play',
	!/ansible\.builtin\.command:\s*aideinit/.test(aide),
	'aideinit must run from the deferred service script, not inline'
);

// 2. deferred service is installed by hardening, but STARTED only in post_tasks
//    (after every role has written the files AIDE watches — cp681).
check('a morphit-aide-init.service unit is installed', /morphit-aide-init\.service/.test(aide));
check(
	'the hardening role does NOT start the build inline (would hash files mid-write)',
	!/systemctl start --no-block morphit-aide-init/.test(aide),
	'starting before the morphit role writes /etc/morphit + code = inaccurate baseline'
);
check(
	'the build is started in post_tasks with systemctl --no-block (after all writes)',
	/post_tasks:[\s\S]*systemctl start --no-block morphit-aide-init\.service/.test(playbook),
	'post_tasks runs after every role, so the baseline is captured from the settled install'
);
check(
	'the post_tasks start is gated on the service unit still being present',
	/post_aide_service\.stat\.exists/.test(playbook),
	'no-op when intrusion detection is off or the service already self-removed'
);

// 3. it runs at idle priority so it never competes with the chain sync
check(
	'the service runs at idle CPU + IO priority',
	/CPUSchedulingPolicy=idle/.test(aide) && /IOSchedulingClass=idle/.test(aide)
);

// 4. reboot-safe: real db created only by atomic rename; partial .new discarded;
//    interrupted build retries on boot (service enabled).
check(
	'the real aide.db is created only by an atomic rename (reboot-safe)',
	/mv -f \/var\/lib\/aide\/aide\.db\.new \/var\/lib\/aide\/aide\.db/.test(aide),
	'a reboot mid-build must leave aide.db ABSENT, never half-written'
);
check(
	'a partial aide.db.new from an interrupted run is discarded before rebuild',
	/rm -f \/var\/lib\/aide\/aide\.db\.new/.test(aide)
);
check(
	'the service is enabled so an interrupted build retries on the next boot',
	/enabled:\s*true/.test(aide)
);

// 5. self-removing: after the baseline exists, the one-shot deletes itself.
check(
	'the builder disables the service after completion',
	/systemctl disable morphit-aide-init\.service/.test(aide)
);
check(
	'the builder removes the unit file and its own script after completion',
	/rm -f \/etc\/systemd\/system\/morphit-aide-init\.service/.test(aide) &&
		/rm -f \/usr\/local\/lib\/morphit\/morphit-aide-init\.sh/.test(aide)
);
check(
	'self-removal is NOT gated by a ConditionPathExists directive (which would skip cleanup)',
	!/^\s*ConditionPathExists=/m.test(aide),
	'cleanup lives in ExecStart, so the unit must run its script every time until removed'
);

// 6. the daily check tolerates a not-yet-built baseline
check(
	'the daily check skips until the baseline exists',
	/\[ -f \/var\/lib\/aide\/aide\.db \] \|\| exit 0/.test(aide)
);

// 7. FAILURE VISIBILITY (cp682) — a background failure must never be silent.
check(
	'the builder traps failure and logs a high-priority error',
	/trap on_exit EXIT/.test(aide) && /logger -p daemon\.err -t morphit-aide-init/.test(aide),
	'a background failure must surface loudly (journal + Matrix via systemd-monitor)'
);
check(
	'the builder drops a failure marker on failure and clears it on success',
	/> \/var\/lib\/morphit\/aide-init-failed/.test(aide) &&
		/rm -f \/var\/lib\/morphit\/aide-init-failed/.test(aide)
);
check(
	'on failure the service stays failed (self-remove is AFTER a successful build)',
	// the self-remove block must come after the aideinit/mv success path, guarded
	// by set -eu so a failed aideinit exits before cleanup.
	/set -eu/.test(aide) &&
		aide.indexOf('aideinit -y -f') < aide.indexOf('systemctl disable morphit-aide-init.service')
);
{
	const monitor = readFileSync(
		join(REPO, 'ops/scripts/morphit-systemd-monitor.sh'),
		'utf8'
	);
	check(
		'systemd-monitor auto-watches every morphit-*.service (so it catches a failed AIDE unit)',
		/grep '\^morphit-'/.test(monitor) && /is-failed/.test(monitor),
		'a failed morphit-aide-init.service is reported to the operator with no extra wiring'
	);
}

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} aide-deferred checks passed` : '✗ ansible-aide-deferred FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
