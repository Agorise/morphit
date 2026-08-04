#!/usr/bin/env tsx
/**
 * ansible-structural-smoke — verify the Ansible playbook at
 * ops/ansible/ is internally consistent.
 *
 * Scenarios:
 *   1. every role declared in playbook.yml exists on disk with
 *      a non-empty tasks/main.yml
 *   2. every optional-sidecar role (matrix_bot, host_monitor,
 *      smartctl_monitor, fail2ban_monitor, mdadm_monitor) is
 *      gated on its enable_* flag in group_vars/all.yml so it
 *      defaults to OFF
 *   3. the standard role set (base, hardening, tls, postgres,
 *      morphit, bunkerweb) is all present in playbook.yml —
 *      catches a careless removal
 *   4. each optional sidecar role's handlers/main.yml uses
 *      capitalized handler names (matches ansible-lint
 *      name[casing] expectations)
 *   5. collections/requirements.yml declares the three
 *      collections that the playbook actually uses
 *      (community.general, community.postgresql, community.docker)
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const ANSIBLE_ROOT = join(REPO_ROOT, 'ops', 'ansible');
const PLAYBOOK = join(ANSIBLE_ROOT, 'playbook.yml');
const GROUP_VARS = join(ANSIBLE_ROOT, 'group_vars', 'all.yml');
const COLLECTIONS_REQ = join(ANSIBLE_ROOT, 'collections', 'requirements.yml');
const ROLES_DIR = join(ANSIBLE_ROOT, 'roles');

const REQUIRED_BASE_ROLES = [
	'base',
	'hardening',
	'tls',
	'postgres',
	'morphit',
	'bunkerweb'
];
const OPTIONAL_SIDECAR_ROLES = [
	'matrix_bot',
	'host_monitor',
	'smartctl_monitor',
	'fail2ban_monitor',
	'mdadm_monitor',
	'dmesg_monitor',
	'trivy_monitor',
	'postfix_monitor',
	'certbot_monitor',
	'apt_monitor',
	'compose_monitor',
	'systemd_monitor',
	'journald_monitor'
];
const REQUIRED_COLLECTIONS = [
	'community.general',
	'community.postgresql',
	'community.docker'
];

function readFile(path: string): string {
	if (!existsSync(path)) {
		throw new Error(`required file missing: ${path}`);
	}
	return readFileSync(path, 'utf-8');
}

interface ScenarioResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}

const results: ScenarioResult[] = [];

// ─── Scenario 1: every declared role exists with tasks/main.yml ──
function collectDeclaredRoles(): string[] {
	const src = readFile(PLAYBOOK);
	const re = /^\s*-\s*role:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/gm;
	const names: string[] = [];
	for (const m of src.matchAll(re)) {
		names.push(m[1]);
	}
	return names;
}

const declaredRoles = collectDeclaredRoles();
for (const role of declaredRoles) {
	const dir = join(ROLES_DIR, role);
	const tasksMain = join(dir, 'tasks', 'main.yml');
	let ok = false;
	let detail: string | undefined;
	if (!existsSync(dir) || !statSync(dir).isDirectory()) {
		detail = `directory not found at roles/${role}/`;
	} else if (!existsSync(tasksMain) || !statSync(tasksMain).isFile()) {
		detail = `roles/${role}/tasks/main.yml is missing`;
	} else if (statSync(tasksMain).size === 0) {
		detail = `roles/${role}/tasks/main.yml is empty`;
	} else {
		ok = true;
	}
	results.push({
		name: `declared role "${role}" exists with non-empty tasks/main.yml`,
		ok,
		detail
	});
}

// ─── Scenario 2: every optional sidecar gated on enable_* default false ──
const allYaml = readFile(GROUP_VARS);
for (const role of OPTIONAL_SIDECAR_ROLES) {
	const flag = `enable_${role}`;
	// Look for `enable_<role>: false` line (or true — we tolerate;
	// the test is presence-of-the-flag, not the default value,
	// since operators can change all.yml).
	const presentInAll = new RegExp(`^${flag}:\\s*(true|false)`, 'm').test(allYaml);
	const gatedInPlaybook = readFile(PLAYBOOK).includes(
		`when: ${flag} | default(false)`
	);
	results.push({
		name: `optional role "${role}" has enable_${role} in group_vars/all.yml`,
		ok: presentInAll,
		detail: presentInAll ? undefined : `${flag} not found in group_vars/all.yml`
	});
	results.push({
		name: `optional role "${role}" is gated on enable_${role} | default(false) in playbook.yml`,
		ok: gatedInPlaybook,
		detail: gatedInPlaybook
			? undefined
			: `playbook.yml does not gate "${role}" on "${flag} | default(false)"`
	});
}

// ─── Scenario 3: standard role set is present ──
for (const role of REQUIRED_BASE_ROLES) {
	const present = declaredRoles.includes(role);
	results.push({
		name: `standard role "${role}" is declared in playbook.yml`,
		ok: present,
		detail: present ? undefined : `"${role}" missing from playbook.yml`
	});
}

// ─── Scenario 4: handler-name capitalization in sidecar roles ──
for (const role of OPTIONAL_SIDECAR_ROLES) {
	const handlersPath = join(ROLES_DIR, role, 'handlers', 'main.yml');
	if (!existsSync(handlersPath)) {
		// mdadm_monitor's role has no env file so might have only
		// the Reload-systemd handler; that still requires a handlers/main.yml.
		results.push({
			name: `role "${role}" has handlers/main.yml`,
			ok: false,
			detail: `${handlersPath} missing`
		});
		continue;
	}
	const handlers = readFileSync(handlersPath, 'utf-8');
	// Find `- name: …` lines under handlers/.  Each name's first
	// content-word must be capitalized.
	const lowerCaseFinds: string[] = [];
	for (const m of handlers.matchAll(/^\s*-\s*name:\s*([a-z])/gm)) {
		lowerCaseFinds.push(m[0].trim());
	}
	results.push({
		name: `role "${role}" handler names start with uppercase`,
		ok: lowerCaseFinds.length === 0,
		detail: lowerCaseFinds.length === 0
			? undefined
			: `lowercase handler name(s): ${lowerCaseFinds.join('; ')}`
	});
}

// ─── Scenario 5: collections/requirements.yml declares needed colls ──
let collReqSrc = '';
let collReqExists = existsSync(COLLECTIONS_REQ);
if (collReqExists) {
	collReqSrc = readFileSync(COLLECTIONS_REQ, 'utf-8');
}
results.push({
	name: `collections/requirements.yml exists`,
	ok: collReqExists,
	detail: collReqExists ? undefined : `missing at ${COLLECTIONS_REQ}`
});
for (const coll of REQUIRED_COLLECTIONS) {
	const present = collReqSrc.includes(`name: ${coll}`);
	results.push({
		name: `collections/requirements.yml declares "${coll}"`,
		ok: present,
		detail: present ? undefined : `"${coll}" not found in requirements.yml`
	});
}

// ─── Scenario 6: no orphaned role directories ──
// (roles on disk that aren't declared in playbook.yml — could be
// stale leftovers).
const onDiskRoles = readdirSync(ROLES_DIR, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name);
const declaredSet = new Set(declaredRoles);
const orphans = onDiskRoles.filter((r) => !declaredSet.has(r));
results.push({
	name: 'no orphan role directories on disk',
	ok: orphans.length === 0,
	detail:
		orphans.length === 0
			? undefined
			: `orphan role dirs: ${orphans.join(', ')}`
});

// ─── Scenario 7: every system user's LITERAL primary group is created ──
// A `ansible.builtin.user` task with `group: <literal>` fails at RUNTIME with
// "Group <name> does not exist" unless a `ansible.builtin.group` task creates
// it first.  cp634: morphit-mcp had the user but not the group — the sandbox
// can't catch this class of bug because it never creates real system accounts,
// so this static pairing check stands in for it.
const baseTasksSrc = readFileSync(join(ROLES_DIR, 'base', 'tasks', 'main.yml'), 'utf-8');
const baseBlocks = baseTasksSrc.split(/\n- /);
const strip = (s: string): string => s.trim().replace(/^["']|["']$/g, '');
const createdGroups = new Set<string>();
for (const b of baseBlocks) {
	if (!/ansible\.builtin\.group:/.test(b)) continue;
	const m = b.match(/\n\s*name:\s*(.+)/);
	if (m) createdGroups.add(strip(m[1]));
}
const literalUserGroups: string[] = [];
for (const b of baseBlocks) {
	if (!/ansible\.builtin\.user:/.test(b)) continue;
	const m = b.match(/\n\s*group:\s*(.+)/); // primary group (not the plural `groups:`)
	if (m) {
		const g = strip(m[1]);
		if (!g.includes('{')) literalUserGroups.push(g); // skip {{ var }} groups
	}
}
const uncreatedGroups = literalUserGroups.filter((g) => !createdGroups.has(g));
results.push({
	name: 'every system user\'s literal primary group is created by a group task (no runtime "Group X does not exist")',
	ok: uncreatedGroups.length === 0,
	detail: uncreatedGroups.length === 0 ? undefined : `user primary group(s) never created: ${uncreatedGroups.join(', ')}`
});

// ─── Scenario 8: no BARE connection-var interpolation in any role file ──
// `{{ ansible_user }}` (and other connection vars) are UNDEFINED on a local
// install and crash the render — even inside a `#`-commented line, because
// Jinja still evaluates `{{ }}` regardless of config-comment syntax.  cp633
// hit this in the connection-safety assert; cp635 hit it in the hardening sshd
// template (a scan of only when:/assert: missed it).  Every interpolation of a
// connection var in a role's tasks/templates/handlers/vars must be
// `| default(...)`-guarded.
const connVarRe = /\{\{[^}]*\b(ansible_user|ansible_host|ansible_port|ansible_ssh_host|ansible_ssh_user|ansible_ssh_port)\b[^}]*\}\}/g;
const allRoleFiles = readdirSync(ROLES_DIR, { recursive: true })
	.filter((f): f is string => typeof f === 'string' && (f.endsWith('.yml') || f.endsWith('.j2')))
	.map((f) => join(ROLES_DIR, f));
const bareConnVars: string[] = [];
for (const f of allRoleFiles) {
	const fsrc = readFileSync(f, 'utf-8');
	for (const m of fsrc.matchAll(connVarRe)) {
		if (!/\|\s*default/.test(m[0])) bareConnVars.push(`${f.replace(REPO_ROOT + '/', '')} → ${m[0]}`);
	}
}
results.push({
	name: 'no bare (unguarded) connection-var interpolation in roles — templates included (undefined on local install)',
	ok: bareConnVars.length === 0,
	detail: bareConnVars.length === 0 ? undefined : `bare: ${bareConnVars.join(' | ')}`
});

// ─── Scenario 9: SSH hardening is gated on an SSH server being present ──
// openssh-server owns /etc/ssh/sshd_config.d + /etc/ssh/sshd_config + the `sshd`
// validate binary.  A home desktop node the operator runs and administers
// locally often has NO SSH server, so writing the hardening there crashed
// ("Destination directory /etc/ssh/sshd_config.d does not exist").  Fixed by
// probing /etc/ssh/sshd_config (which exists iff openssh-server is installed)
// and gating every SSH task on it — we deliberately do NOT force-install an SSH
// server.  Guard: the probe must exist AND every task in ssh.yml that writes
// under /etc/ssh must be `when: <probe>.stat.exists`-gated so this cannot regress.
{
	const sshSrc = readFileSync(join(ROLES_DIR, 'hardening', 'tasks', 'ssh.yml'), 'utf-8');
	const hasProbe =
		/ansible\.builtin\.stat:[\s\S]{0,160}?path:\s*\/etc\/ssh\/sshd_config\b[\s\S]{0,160}?register:\s*\w+/.test(sshSrc);
	const ungated: string[] = [];
	for (const blk of sshSrc.split(/\n(?=- name:)/)) {
		// The presence probe itself READS /etc/ssh/sshd_config (via stat) — it is
		// the thing the gate depends on, so it must not be treated as a write.
		const isProbe = /ansible\.builtin\.stat:/.test(blk);
		const writesToSsh = !isProbe && /(dest|path):\s*\/etc\/ssh\/sshd_config/.test(blk);
		if (writesToSsh && !/when:[^\n]*stat\.exists/.test(blk)) {
			const nameM = /- name:\s*(.+)/.exec(blk);
			ungated.push(nameM ? nameM[1].trim() : '(unnamed task)');
		}
	}
	results.push({
		name: 'hardening SSH tasks are gated on openssh-server presence (no crash on a node without SSH)',
		ok: hasProbe && ungated.length === 0,
		detail: !hasProbe
			? 'ssh.yml is missing the /etc/ssh/sshd_config stat presence-probe'
			: ungated.length > 0
				? `ungated /etc/ssh write task(s): ${ungated.join(', ')}`
				: undefined
	});
}

// ─── Scenario 10: every drop-in write into a package .d/ dir ensures the dir ──
// TWO separate releases were lost to this exact class — a hardening drop-in
// written into a package-owned .d/ directory the package did NOT create
// (openssh-server's /etc/ssh/sshd_config.d; libpam-pwquality's
// /etc/security/pwquality.conf.d).  We do NOT trust a package to have made its
// own drop-in dir: every write into an `/etc/**/*.d/` directory must have a
// matching `file: state=directory` ensure somewhere in the role set, or be one
// of a tiny allowlist of always-present OS drop-in dirs.  Sandbox playbook runs
// can't catch this (they stub the dirs) — only this static guard can.
{
	// Every dir any role explicitly ensures (literal /etc paths only).
	const ensuredDirs = new Set<string>();
	for (const f of allRoleFiles) {
		if (f.endsWith('.j2')) continue;
		const src = readFileSync(f, 'utf-8');
		for (const blk of src.split(/\n(?=\s*- )/)) {
			if (!/state:\s*directory/.test(blk)) continue;
			const m = /\bpath:\s*['"]?(\/etc\/[^\s'"]+)/.exec(blk);
			if (m) ensuredDirs.add(m[1].replace(/\/$/, ''));
		}
	}
	// Always-present OS drop-in dirs no package/role needs to create.
	const alwaysPresent = new Set(['/etc/apt/apt.conf.d', '/etc/sysctl.d', '/etc/systemd/system']);
	const unEnsuredDropins: string[] = [];
	for (const f of allRoleFiles) {
		if (f.endsWith('.j2')) continue;
		const src = readFileSync(f, 'utf-8');
		for (const m of src.matchAll(/\b(?:dest|path):\s*['"]?(\/etc\/[^\s'"]+)/g)) {
			const dest = m[1].replace(/['"]$/, '');
			if (dest.includes('{{')) continue; // templated — skip
			const parent = dest.replace(/\/[^/]+$/, '');
			if (!/\.d$/.test(parent)) continue; // only *.d drop-in dirs
			if (alwaysPresent.has(parent) || ensuredDirs.has(parent)) continue;
			unEnsuredDropins.push(`${f.replace(REPO_ROOT + '/', '')} → ${dest} (dir ${parent} not ensured)`);
		}
	}
	results.push({
		name: 'every drop-in write into an /etc/**/*.d dir has a state=directory ensure (no "directory does not exist" on install)',
		ok: unEnsuredDropins.length === 0,
		detail: unEnsuredDropins.length === 0 ? undefined : unEnsuredDropins.join(' | ')
	});
}

// ─── Report ──
console.log(`ansible structural smoke: ${results.length} scenarios\n`);
let failed = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`  ✓ ${r.name}`);
	} else {
		console.log(`  ✗ ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}
console.log('');
if (failed === 0) {
	console.log(`✓ all ${results.length} structural checks hold`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} failed, ${results.length - failed} passed`);
	process.exit(1);
}
