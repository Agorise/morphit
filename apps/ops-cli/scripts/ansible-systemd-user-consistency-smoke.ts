#!/usr/bin/env tsx
/**
 * ansible-systemd-user-consistency-smoke — verify that every `User=`
 * referenced in a shipped systemd unit (`ops/systemd/*.service`)
 * either:
 *
 *   (a) is a well-known system user that doesn't need creation
 *       (root, nobody, www-data, systemd-* services), OR
 *   (b) is created by an Ansible task in `ops/ansible/roles/`.
 *
 * Pre-Part-122-cp5 the playbook never created the `morphit-relay`
 * user even though `morphit-relay.service` ships with
 * `User=morphit-relay`, breaking every fresh Ansible deploy.
 * F12 fixed that one instance; this smoke prevents the class
 * from recurring as new units are added.
 *
 * Conversely, this smoke does NOT flag a created-but-unreferenced
 * Ansible user — those are fine (the user may be created for
 * directory ownership, for example, without running a service).
 *
 * Scenarios:
 *   1. For every shipped `*.service` unit with `User=X`:
 *      either X is in the system-user allowlist OR an
 *      `ansible.builtin.user: name: X` task exists in
 *      `ops/ansible/`.
 *   2. Sanity meta-check: at least one unit was scanned (catches
 *      a future repo restructure that moves units out of
 *      ops/systemd/).
 *
 * Usage:
 *   tsx apps/ops-cli/scripts/ansible-systemd-user-consistency-smoke.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SYSTEMD_DIR = join(REPO_ROOT, 'ops', 'systemd');
const ANSIBLE_ROLES_DIR = join(REPO_ROOT, 'ops', 'ansible', 'roles');

/** System users that pre-exist on a standard Ubuntu 24.04 box
 *  and don't need Ansible-side creation. */
const SYSTEM_USER_ALLOWLIST = new Set([
	'root',
	'nobody',
	'www-data',
	'postgres',
	'systemd-network',
	'systemd-resolve',
	'systemd-timesync',
	'daemon'
]);

interface ScenarioResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: ScenarioResult[] = [];

/** Walk a directory tree and yield all *.yml files. */
function walkYamlFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, ent.name);
			if (ent.isDirectory()) {
				stack.push(full);
			} else if (ent.isFile() && ent.name.endsWith('.yml')) {
				out.push(full);
			}
		}
	}
	return out;
}

/** Collect every user name an Ansible task creates via
 *  `ansible.builtin.user: name: X`.  Handles both quoted and
 *  unquoted names. */
function collectAnsibleCreatedUsers(): Set<string> {
	const created = new Set<string>();
	for (const file of walkYamlFiles(ANSIBLE_ROLES_DIR)) {
		const src = readFileSync(file, 'utf-8');
		// Find every `ansible.builtin.user:` block (or shorthand
		// `user:` — but we accept only the FQCN form here to avoid
		// false matches on `user: morphit` as a group-vars-style
		// key-value somewhere else).
		const blockRe = /ansible\.builtin\.user:\s*\n((?:[ \t]+[^\n]*\n)+)/g;
		for (const m of src.matchAll(blockRe)) {
			const block = m[1]!;
			// Extract the `name:` value from the block.  Strip
			// quotes if present.  Handles Jinja-templated names
			// like `name: "{{ morphit_service_user }}"` by also
			// resolving the variable against group_vars/all.yml.
			const nameMatch = /^[ \t]+name:\s*(.+?)\s*$/m.exec(block);
			if (!nameMatch) continue;
			let nameVal = nameMatch[1]!.trim();
			// Strip outer quotes.
			if (
				(nameVal.startsWith('"') && nameVal.endsWith('"')) ||
				(nameVal.startsWith("'") && nameVal.endsWith("'"))
			) {
				nameVal = nameVal.slice(1, -1);
			}
			// Jinja-template resolution: `{{ var_name }}` →
			// look up var_name in group_vars/all.yml.
			const jinjaMatch = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(nameVal);
			if (jinjaMatch) {
				const varName = jinjaMatch[1]!;
				const resolved = resolveGroupVar(varName);
				if (resolved !== null) {
					created.add(resolved);
					continue;
				}
				// Unresolved template — record the template form
				// so we don't silently drop it.
				created.add(`{{${varName}}}`);
				continue;
			}
			created.add(nameVal);
		}
	}
	return created;
}

/** Look up a top-level scalar in group_vars/all.yml. */
function resolveGroupVar(varName: string): string | null {
	const path = join(REPO_ROOT, 'ops', 'ansible', 'group_vars', 'all.yml');
	if (!existsSync(path)) return null;
	const src = readFileSync(path, 'utf-8');
	const re = new RegExp(`^${varName}:\\s*(.+?)\\s*$`, 'm');
	const m = re.exec(src);
	if (!m) return null;
	let val = m[1]!.trim();
	if (
		(val.startsWith('"') && val.endsWith('"')) ||
		(val.startsWith("'") && val.endsWith("'"))
	) {
		val = val.slice(1, -1);
	}
	return val;
}

/** Collect every `User=X` reference in shipped systemd units.
 *  Returns a map of `unitName → User=value`. */
function collectSystemdUsers(): Map<string, string> {
	const out = new Map<string, string>();
	if (!existsSync(SYSTEMD_DIR)) return out;
	for (const ent of readdirSync(SYSTEMD_DIR, { withFileTypes: true })) {
		if (!ent.isFile()) continue;
		if (!ent.name.endsWith('.service')) continue;
		const src = readFileSync(join(SYSTEMD_DIR, ent.name), 'utf-8');
		// Look for `User=X` at the start of a line, NOT in a comment.
		// Skip `DynamicUser=yes` units (User= is irrelevant for those).
		const dynamic = /^DynamicUser=yes\s*$/m.test(src);
		if (dynamic) continue;
		const userMatch = /^User=([^\s#]+)\s*$/m.exec(src);
		if (userMatch) {
			out.set(ent.name, userMatch[1]!);
		}
	}
	return out;
}

// ─── Scenario 1: every systemd User= is creatable or pre-existing ──
const createdUsers = collectAnsibleCreatedUsers();
const systemdUsers = collectSystemdUsers();

for (const [unit, user] of systemdUsers) {
	const inAnsible = createdUsers.has(user);
	const inAllowlist = SYSTEM_USER_ALLOWLIST.has(user);
	const ok = inAnsible || inAllowlist;
	let detail: string | undefined;
	if (!ok) {
		detail =
			`${unit} ships with User=${user}, but the Ansible playbook ` +
			`has no \`ansible.builtin.user: name: ${user}\` task creating ` +
			`it AND ${user} is not in the system-default allowlist. ` +
			`Either add the user-creation task to a role in ` +
			`ops/ansible/roles/ (likely base/tasks/main.yml), or — if ` +
			`${user} really is a pre-existing system account — add it ` +
			`to SYSTEM_USER_ALLOWLIST in this smoke.`;
	}
	results.push({
		name: `${unit}: User=${user} is creatable (Ansible) or system-default`,
		ok,
		detail
	});
}

// ─── Scenario 2: at least one unit was scanned ──
results.push({
	name: 'at least one *.service unit scanned (sanity check vs repo restructure)',
	ok: systemdUsers.size > 0,
	detail:
		systemdUsers.size === 0
			? `no *.service files found in ${SYSTEMD_DIR} (did the repo layout change?)`
			: undefined
});

// ─── Report ──
console.log(
	`ansible/systemd user-consistency smoke: ${results.length} scenarios ` +
		`(${systemdUsers.size} units scanned, ${createdUsers.size} Ansible-created users)\n`
);
let failed = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`  ✓ ${r.name}`);
	} else {
		console.log(`  ✗ ${r.name}`);
		if (r.detail) {
			for (const line of r.detail.split('\n')) {
				console.log(`      ${line}`);
			}
		}
		failed++;
	}
}
console.log('');
if (failed === 0) {
	console.log(`✓ all ${results.length} user-consistency checks hold`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} failed, ${results.length - failed} passed`);
	process.exit(1);
}
