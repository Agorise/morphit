#!/usr/bin/env tsx
/**
 * backup-install-parity — cp514 (post-v1.8.7 operator-install audit).
 *
 * FOUR FILES INDEPENDENTLY NAME THE SAME TWO FACTS, and when any of them drifts
 * an operator ends up with a backup that never runs — silently, nightly:
 *
 *   FACT 1 — where morphit-backup.sh is installed.
 *     - ops/systemd/morphit-backup.service   ExecStart=<path>
 *     - ops/ansible/roles/morphit/tasks/main.yml   dest: <path>
 *     - apps/ops-cli/src/commands/init.ts    printed `install` line
 *     - apps/ops-cli/src/commands/harden.ts  printed `install` line
 *     - docs/OPERATIONS.md                   documented `install` line
 *   Ansible had drifted to /usr/local/bin while the unit said
 *   /usr/local/lib/morphit → systemd couldn't find it → 203/EXEC on EVERY
 *   Ansible-provisioned node.
 *
 *   FACT 2 — /etc/morphit/backup.env must be readable by the unit's User=.
 *     The unit runs User=morphit; the script gates on `[ -r "$BACKUP_ENV" ]`.
 *     OPERATIONS.md and the init wizard both said `-m 600 -o root -g root`,
 *     so the operator's FIRST `systemctl start` failed with
 *     `cannot read /etc/morphit/backup.env`. The Ansible template was the only
 *     one that had it right (root:morphit 0640).
 *
 * Neither defect is visible from inside any single file — which is exactly why
 * they shipped. This smoke pins them ACROSS files.
 *
 * Tamper tests (each must turn this red):
 *   - Point the Ansible `dest:` back at /usr/local/bin → fails.
 *   - Change the unit's ExecStart without updating the installers → fails.
 *   - Restore `-m 600 -o root -g root` in OPERATIONS.md or init.ts → fails.
 *   - Drop the Ansible docker-group task → fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

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

console.log('\n── backup-install-parity (cp514) ─────────────────────\n');

const unit = read('ops/systemd/morphit-backup.service');
const ansible = read('ops/ansible/roles/morphit/tasks/main.yml');
const init = read('apps/ops-cli/src/commands/init.ts');
const harden = read('apps/ops-cli/src/commands/harden.ts');
const ops = read('docs/OPERATIONS.md');

// ─── FACT 1: one canonical script path everywhere ────────────────
const execStart = /^ExecStart=(\S+)$/m.exec(unit)?.[1] ?? '';
check('the unit declares an ExecStart path', execStart.length > 0);
check(
	`the canonical path is /usr/local/lib/morphit/morphit-backup.sh (got ${execStart || 'nothing'})`,
	execStart === '/usr/local/lib/morphit/morphit-backup.sh'
);
const installDir = '/usr/local/lib/morphit';
check(
	'ANSIBLE deploys morphit-backup.sh to the unit\'s ExecStart path',
	new RegExp(`dest:\\s*${execStart.replace(/[/.]/g, '\\$&')}`).test(ansible),
	'a mismatch here is invisible until systemd fails 203/EXEC on a live node'
);
check(
	'ANSIBLE creates the install directory before copying into it',
	new RegExp(`path:\\s*${installDir.replace(/[/.]/g, '\\$&')}[\\s\\S]{0,120}?state:\\s*directory`).test(ansible)
);
for (const [label, src] of [
	['init wizard', init],
	['harden wizard', harden],
	['OPERATIONS.md', ops]
] as const) {
	// The DESTINATION is what must agree; how each file spells the SOURCE
	// differs legitimately (harden builds it with path.join segments, the docs
	// use a repo-relative slash path), so match the script name loosely.
	check(
		`${label} installs the script to the same ${installDir}/`,
		src.includes(`${installDir}/`) && /morphit-backup\.sh/.test(src),
		'every install path must agree with the unit or the service cannot start'
	);
}
check(
	'nothing still installs the backup script to /usr/local/bin',
	![ansible, init, harden, ops].some((src) => /\/usr\/local\/bin\/morphit-backup\.sh/.test(src)),
	'the old drifted path — systemd looks in /usr/local/lib/morphit'
);

// ─── FACT 2: the env file is readable by the unit's User= ────────
const unitUser = /^User=(\S+)$/m.exec(unit)?.[1] ?? '';
check(`the unit runs as a non-root user (got "${unitUser}")`, unitUser === 'morphit');
check(
	'ANSIBLE templates backup.env group-readable by the service group',
	/dest:\s*\/etc\/morphit\/backup\.env[\s\S]{0,200}?group:\s*"\{\{ morphit_service_group \}\}"[\s\S]{0,80}?mode:\s*'0640'/.test(
		ansible
	)
);
for (const [label, src] of [
	['init wizard', init],
	['harden wizard', harden],
	['OPERATIONS.md', ops]
] as const) {
	check(
		`${label} installs backup.env as 640 root:${unitUser} (readable by the unit)`,
		new RegExp(`install -m 640 -o root -g ${unitUser}`).test(src),
		`600 root:root makes the script's [ -r $BACKUP_ENV ] guard fail on the first start`
	);
	check(
		`${label} no longer installs backup.env root-only`,
		!/install -m 600 -o root -g root/.test(src)
	);
}

// ─── The containerized-DB precondition ───────────────────────────
check(
	'ANSIBLE grants the service user docker access when a DB container is set',
	/ansible\.builtin\.user:[\s\S]{0,200}?groups:\s*docker[\s\S]{0,200}?when:\s*morphit_db_container/.test(
		ansible
	),
	'the docker-exec dump path loud-fails without it — and the bunkerweb role provisions exactly that topology'
);
check(
	'that grant is gated on a container actually being configured (root-equivalent)',
	/when:\s*morphit_db_container \| default\(''\) \| length > 0/.test(ansible)
);
check(
	'OPERATIONS.md documents the docker-group precondition',
	/usermod -aG docker/.test(ops)
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} backup-install-parity checks passed` : '✗ backup-install-parity FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
