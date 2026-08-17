/**
 * ddns-role-smoke.ts (cp600) — guards the `ddns` Ansible role that wires the
 * cp596 dynamic-DNS mechanism into the full install for HOME nodes (the one
 * home-specific ADDITION to the otherwise-identical VPS stack; a VPS leaves
 * enable_ddns off).  Can't run Ansible in CI, so this pins the role's shape +
 * that every YAML file actually parses.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

const playbook = R('ops/ansible/playbook.yml');
const groupvars = R('ops/ansible/group_vars/all.yml');
const defaults = R('ops/ansible/roles/ddns/defaults/main.yml');
const tasks = R('ops/ansible/roles/ddns/tasks/main.yml');
const envtpl = R('ops/ansible/roles/ddns/templates/ddns.env.j2');
const svctpl = R('ops/ansible/roles/ddns/templates/morphit-ddns.service.j2');
const timertpl = R('ops/ansible/roles/ddns/templates/morphit-ddns.timer.j2');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

console.log('\u2500\u2500 ddns-role smoke (cp600) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

// ── Playbook wiring ───────────────────────────────────────────────
check('playbook applies the ddns role, gated by enable_ddns', /- role: ddns[\s\S]{0,240}enable_ddns \| default\(false\)/.test(playbook));
// v1.12.5 — a tor-only node has no clearnet domain, so the ddns role must ALSO be
// gated off for tor-only (even if enable_ddns were left on from a home profile).
check(
	'ddns role is ALSO gated off in tor-only mode',
	/- role: ddns[\s\S]{0,400}not \(morphit_tor_only \| default\(false\)\)/.test(playbook)
);
check('ddns runs BEFORE tls (so certbot can validate once DNS is current)', playbook.indexOf('- role: ddns') < playbook.indexOf('- role: tls') && playbook.indexOf('- role: ddns') > playbook.indexOf('- role: hardening'));

// ── group_vars contract ───────────────────────────────────────────
check('group_vars defaults enable_ddns to false (VPS-safe)', /enable_ddns:\s*false/.test(groupvars));
check('group_vars carries a DUMMY morphit_ddns_update_url with {ip} examples', /morphit_ddns_update_url:\s*""/.test(groupvars) && /\{ip\}/.test(groupvars));

// ── defaults ──────────────────────────────────────────────────────
check('defaults define lib + env + state + update_url + ip_url + on_calendar', /morphit_ddns_lib:/.test(defaults) && /morphit_ddns_env_file:/.test(defaults) && /morphit_ddns_state_file:/.test(defaults) && /morphit_ddns_update_url:/.test(defaults) && /morphit_ddns_ip_url:/.test(defaults) && /morphit_ddns_on_calendar:/.test(defaults));

// ── env template (matches the cp596 updater's contract) ───────────
check('env template writes MORPHIT_DDNS_UPDATE_URL + STATE_FILE (IP_URL optional)', /MORPHIT_DDNS_UPDATE_URL=\{\{ morphit_ddns_update_url \}\}/.test(envtpl) && /MORPHIT_DDNS_STATE_FILE=/.test(envtpl) && /\{% if morphit_ddns_ip_url/.test(envtpl));

// ── service unit (mirrors cp596 hardened service) ─────────────────
check('service is oneshot, reads the env file, retries transient (SuccessExitStatus=0 1)', /Type=oneshot/.test(svctpl) && /EnvironmentFile=-\{\{ morphit_ddns_env_file \}\}/.test(svctpl) && /SuccessExitStatus=0 1/.test(svctpl));
check('service is hardened (ProtectSystem=strict, NoNewPrivileges, ReadWritePaths=state dir)', /ProtectSystem=strict/.test(svctpl) && /NoNewPrivileges=true/.test(svctpl) && /ReadWritePaths=\{\{ morphit_ddns_state_file \| dirname \}\}/.test(svctpl));

// ── timer unit ────────────────────────────────────────────────────
check('timer fires on boot + on OnCalendar, persistently, WantedBy timers.target', /OnBootSec=/.test(timertpl) && /OnCalendar=\{\{ morphit_ddns_on_calendar \}\}/.test(timertpl) && /Persistent=true/.test(timertpl) && /WantedBy=timers\.target/.test(timertpl));

// ── tasks ─────────────────────────────────────────────────────────
check('tasks ASSERT the update URL is set when enabled', /ansible\.builtin\.assert[\s\S]{0,200}morphit_ddns_update_url \| length > 0/.test(tasks));
check('tasks install the cp596 updater (single source: ops/ddns/)', /src:\s*"?\{\{ morphit_source_dir \}\}\/ops\/ddns\/morphit-ddns-update\.sh/.test(tasks));
check('tasks write the env file 0600 (secret in the URL)', /template:[\s\S]{0,120}ddns\.env\.j2[\s\S]{0,120}mode: "0600"/.test(tasks));
check('tasks install both units + enable the timer', /morphit-ddns\.service\.j2/.test(tasks) && /morphit-ddns\.timer\.j2/.test(tasks) && /name: morphit-ddns\.timer[\s\S]{0,80}enabled: true[\s\S]{0,40}state: started/.test(tasks));

// ── YAML validity (real parse) ────────────────────────────────────
function yamlValid(relPath: string): boolean {
	const r = spawnSync(
		'python3',
		['-c', 'import yaml,sys; yaml.safe_load(open(sys.argv[1])); print("ok")', join(ROOT, relPath)],
		{ encoding: 'utf-8' }
	);
	return r.status === 0 && /ok/.test(r.stdout || '');
}
for (const f of [
	'ops/ansible/playbook.yml',
	'ops/ansible/group_vars/all.yml',
	'ops/ansible/roles/ddns/defaults/main.yml',
	'ops/ansible/roles/ddns/tasks/main.yml',
	'ops/ansible/roles/ddns/handlers/main.yml'
]) {
	check(`valid YAML: ${f.replace('ops/ansible/', '')}`, yamlValid(f));
}

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} ddns-role checks passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failed} of ${passed + failed} ddns-role checks failed`);
	process.exit(1);
}
