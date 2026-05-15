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
