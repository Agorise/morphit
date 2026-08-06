/**
 * ansible-os-derivative smoke (cp226).
 *
 * Guards the change that lets the Ansible playbook run on Ubuntu-24.04
 * derivatives (Linux Mint 22, Pop!_OS 24.04, Zorin 17), not just Ubuntu
 * 24.04 itself — for sysadmins whose box is a Mint Cinnamon/MATE/Xfce
 * desktop.
 *
 * The playbook gates on the Ubuntu BASE codename (`noble`) read from
 * /etc/os-release's UBUNTU_CODENAME — which Ubuntu and its derivatives
 * all carry — instead of a strict `ansible_distribution == "Ubuntu"` +
 * version pair (Mint reports as "Linuxmint", so the strict pair refused
 * to run).  And the codename-pinned apt repos (Docker, Trivy) must key
 * off that base codename, not `ansible_distribution_release` (which on a
 * derivative is the derivative's own codename, e.g. Mint's "wilma", that
 * the Ubuntu repos don't publish → 404).
 *
 * Ansible can't run in CI, so these are source-shape assertions (same
 * approach as ansible-structural-smoke).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
let pass = 0;
let fail = 0;
function ok(n: string): void {
	console.log(`  ✓ ${n}`);
	pass++;
}
function bad(n: string, d = ''): void {
	console.error(`  ✗ ${n}`);
	if (d) console.error(`      ${d}`);
	fail++;
}
function expect(n: string, cond: boolean, d = ''): void {
	cond ? ok(n) : bad(n, d);
}

console.log('\n── ansible-os-derivative smoke (cp226) ──\n');

const playbook = readFileSync(join(REPO_ROOT, 'ops/ansible/playbook.yml'), 'utf-8');
const dockerTasks = readFileSync(join(REPO_ROOT, 'ops/ansible/roles/bunkerweb/tasks/main.yml'), 'utf-8');
const trivyTasks = readFileSync(join(REPO_ROOT, 'ops/ansible/roles/trivy_monitor/tasks/main.yml'), 'utf-8');

// ─── Playbook OS gate ───
expect(
	'playbook: derives the Ubuntu base codename from UBUNTU_CODENAME in /etc/os-release',
	/UBUNTU_CODENAME/.test(playbook) && /\/etc\/os-release/.test(playbook),
	'no UBUNTU_CODENAME derivation found'
);
expect(
	'playbook: stores it in a morphit_ubuntu_codename fact',
	/morphit_ubuntu_codename\s*:/.test(playbook),
	''
);
expect(
	'playbook: gates on the noble (24.04) base codename',
	/morphit_ubuntu_codename\s*==\s*"noble"/.test(playbook),
	''
);
expect(
	'playbook: no longer hard-gates on a strict ansible_distribution_version == "24.04" pair',
	!/ansible_distribution_version\s*==\s*"24\.04"/.test(playbook),
	'the strict-version assert is still present — derivatives like Mint will be rejected'
);
expect(
	'playbook: the rejection message names Linux Mint (operator clarity)',
	/Mint/.test(playbook),
	''
);
expect(
	'playbook: safe codename extraction (non-empty list so `first` cannot throw)',
	/regex_findall\('\^UBUNTU_CODENAME=\(\.\*\)\$'/.test(playbook) && /\+\s*\[''\]/.test(playbook),
	''
);

// ─── Docker apt repo (bunkerweb role) ───
expect(
	'bunkerweb: Docker apt repo points at the Ubuntu repo',
	/download\.docker\.com\/linux\/ubuntu/.test(dockerTasks),
	''
);
expect(
	'bunkerweb: Docker repo codename is morphit_ubuntu_codename (the Ubuntu base), not the raw distro codename',
	/download\.docker\.com\/linux\/ubuntu \{\{\s*morphit_ubuntu_codename/.test(dockerTasks),
	'Docker repo still keyed on ansible_distribution_release → 404s on Mint'
);
expect(
	'bunkerweb: Docker repo does NOT use a bare ansible_distribution_release codename',
	!/download\.docker\.com\/linux\/ubuntu \{\{\s*ansible_distribution_release\s*\}\}/.test(dockerTasks),
	''
);

// ─── Trivy apt repo (trivy_monitor role) ───
expect(
	'trivy_monitor: Trivy apt repo codename is morphit_ubuntu_codename (the Ubuntu base)',
	/trivy-repo\/deb \{\{\s*morphit_ubuntu_codename/.test(trivyTasks),
	'Trivy repo still keyed on ansible_distribution_release → 404s on Mint'
);
expect(
	'trivy_monitor: Trivy repo does NOT use a bare ansible_distribution_release codename',
	!/trivy-repo\/deb \{\{\s*ansible_distribution_release\s*\}\}/.test(trivyTasks),
	''
);

const total = pass + fail;
console.log(`\n${pass} passed, ${fail} failed (${total} total)`);
if (fail > 0) {
	console.error('\nansible-os-derivative smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} ansible-os-derivative scenarios passed`);
