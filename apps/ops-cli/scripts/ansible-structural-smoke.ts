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
	'vendor',
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

// ─── Scenario 11: first-online deferred-completion subsystem is fully wired ──
// The offline appliance depends on this: the install finishes offline, then the
// network-dependent tail (real TLS cert, Blurt RPC connect, opt-in on-chain
// registration) is completed by morphit-first-online the moment the box first
// sees the internet.  Verify the script + units exist AND are actually deployed
// + enabled by the morphit role (a shipped-but-unwired unit would silently never
// run — exactly the class of gap that has bitten this install before).
{
	const fo: string[] = [];
	const script = join(REPO_ROOT, 'ops', 'first-online', 'morphit-first-online.sh');
	const svc = join(REPO_ROOT, 'ops', 'systemd', 'morphit-first-online.service');
	const tmr = join(REPO_ROOT, 'ops', 'systemd', 'morphit-first-online.timer');
	if (!existsSync(script)) fo.push('ops/first-online/morphit-first-online.sh missing');
	if (!existsSync(svc)) fo.push('morphit-first-online.service missing');
	if (!existsSync(tmr)) fo.push('morphit-first-online.timer missing');
	const morphitTasks = existsSync(join(ROLES_DIR, 'morphit', 'tasks', 'main.yml'))
		? readFileSync(join(ROLES_DIR, 'morphit', 'tasks', 'main.yml'), 'utf-8')
		: '';
	if (!/morphit-first-online\.service/.test(morphitTasks) || !/morphit-first-online\.timer/.test(morphitTasks))
		fo.push('first-online units not in the morphit role systemd install loop');
	if (!/morphit-first-online\.sh/.test(morphitTasks)) fo.push('first-online script not deployed by the morphit role');
	if (!/first-online\.env/.test(morphitTasks)) fo.push('first-online.env not deployed by the morphit role');
	if (!/morphit-first-online\.timer/.test(morphitTasks) || !/state:\s*started/.test(morphitTasks))
		fo.push('first-online timer not enabled+started');
	const envTmpl = join(ROLES_DIR, 'morphit', 'templates', 'first-online.env.j2');
	if (!existsSync(envTmpl)) fo.push('first-online.env.j2 template missing');
	else if (!/MORPHIT_AUTO_REGISTER/.test(readFileSync(envTmpl, 'utf-8'))) fo.push('first-online.env.j2 missing MORPHIT_AUTO_REGISTER');
	// The service must be triggered by the network coming up.
	if (existsSync(svc) && !/WantedBy=network-online\.target/.test(readFileSync(svc, 'utf-8')))
		fo.push('first-online.service not WantedBy=network-online.target');
	results.push({
		name: 'first-online deferred-completion subsystem is wired (script + units deployed + enabled by the morphit role)',
		ok: fo.length === 0,
		detail: fo.length === 0 ? undefined : fo.join(' | ')
	});
}

// ─── Scenario 12: offline-appliance bundle wiring (dormant online, offline when bundled) ──
// Everything that makes apt / Docker / Kubo / Node install with NO internet when a
// self-contained bundle is present — each gated on the bundle so an ordinary
// online install is untouched.  A gap here means "install completely offline"
// silently doesn't, or (worse) the online path breaks.
{
	const ob: string[] = [];
	const R = (p: string): string => join(ROLES_DIR, p);
	const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
	const vendor = readIf(R('vendor/tasks/main.yml'));
	if (!vendor) ob.push('vendor role missing');
	else {
		if (!/vendor\/apt\/Packages\.gz/.test(vendor)) ob.push('vendor role does not detect vendor/apt');
		if (!/apt\.conf\.d\/99-morphit-offline\.conf/.test(vendor)) ob.push('vendor role does not write the reversible apt override');
		if (!/when:\s*morphit_vendor_apt\.stat\.exists/.test(vendor)) ob.push('vendor role apt override not gated on the bundle');
		// Regression (air-gapped install died at `base: apt update`): the vendor
		// role runs FIRST, before the morphit role copies the tree to
		// morphit_repo_path (/opt/morphit), so it MUST look for the bundle in the
		// extraction dir (morphit_local_source_path) — /opt/morphit is empty then.
		if (!/morphit_local_source_path\s*\}\}\/vendor\/apt/.test(vendor)) ob.push('vendor role must reference the bundle via morphit_local_source_path (the extraction dir, present when vendor runs first)');
		if (/morphit_repo_path\s*\}\}\/vendor\/apt/.test(vendor)) ob.push('vendor role must NOT use morphit_repo_path for the bundle (/opt/morphit is empty until the morphit role copies later)');
	}
	const pb = existsSync(PLAYBOOK) ? readFileSync(PLAYBOOK, 'utf-8') : '';
	if (!/role:\s*vendor/.test(pb)) ob.push('vendor role not wired into the playbook');
	else if (pb.indexOf('role: vendor') > pb.indexOf('role: base')) ob.push('vendor role must run BEFORE base (apt redirected before any install)');
	const bw = readIf(R('bunkerweb/tasks/main.yml'));
	if (!/vendor\/docker/.test(bw) || !/docker load/.test(bw)) ob.push('bunkerweb role does not load bundled Docker images');
	const bobSh = existsSync(join(REPO_ROOT, 'scripts', 'build-offline-bundle.sh')) ? readFileSync(join(REPO_ROOT, 'scripts', 'build-offline-bundle.sh'), 'utf-8') : '';
	const bobCmd = bobSh.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
	// The bundle must save EXACTLY the docker images a guided install needs offline:
	// every `image:` the bunkerweb compose pins (via group_vars) AND the frontend
	// Dockerfile's FROM base (compose builds it with --build).  A wrong tag or a
	// missing image makes `docker compose up` pull from Docker Hub and die offline.
	const compose = readIf(R('bunkerweb/templates/docker-compose.yml.j2'));
	for (const mm of compose.matchAll(/image:\s*\{\{\s*(\w+)\s*\}\}/g))
		if (!new RegExp(`\\^${mm[1]}:`).test(bobCmd)) ob.push(`build-offline-bundle.sh does not read the compose image ${mm[1]} from group_vars to save it — offline docker compose up would pull it`);
	if (/image:\s*\{\{/.test(compose) && /bunkerity\/bunkerweb:latest/.test(bobCmd)) ob.push('build-offline-bundle.sh saves bunkerity/bunkerweb:latest but compose pins a version — tag mismatch forces an offline pull');
	if (existsSync(join(REPO_ROOT, 'ops', 'bunkerweb', 'frontend', 'Dockerfile')) && !/frontend\/Dockerfile/.test(bobCmd)) ob.push('build-offline-bundle.sh does not bundle the frontend Dockerfile FROM base image — docker compose up --build would pull it offline');
	// Offline install must NOT fetch Docker's repo key from the internet — docker-ce
	// and friends are in the bundled apt closure.  The vendor role sets the fact.
	const vend = readIf(R('vendor/tasks/main.yml'));
	if (!/morphit_offline_install:\s*true/.test(vend)) ob.push('vendor role does not set morphit_offline_install when a bundle is present');
	if (/download\.docker\.com/.test(bw) && !/not morphit_offline_install/.test(bw)) ob.push('bunkerweb fetches the Docker repo key unconditionally — must skip on an offline install (docker-ce is bundled)');
	const ipfs = readIf(R('ipfs/tasks/main.yml'));
	if (!/vendor\/kubo/.test(ipfs)) ob.push('ipfs role does not use a bundled Kubo when present');
	// IPFS is release-hosting — a network job like certbot/register, which the
	// appliance defers.  Its daemon must NOT hard-fail an offline Phase-1 install:
	// the start is best-effort (failed_when: false) with the daemon left enabled, and
	// the unit is offline-safe (network.target not network-online; --migrate=false so
	// it never tries to fetch a migration with no network).
	const ipfsHandlers = readIf(R('ipfs/handlers/main.yml'));
	const ipfsHandlersCmd = ipfsHandlers.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
	const ipfsCmd = ipfs.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
	if (!/state:\s*restarted[\s\S]{0,120}failed_when:\s*false/.test(ipfsHandlersCmd)) ob.push('ipfs Restart handler is not best-effort (failed_when: false) — an offline daemon start would fail the whole install');
	if (!/name:\s*ipfs[\s\S]{0,120}state:\s*started[\s\S]{0,120}failed_when:\s*false/.test(ipfsCmd)) ob.push('ipfs "start the daemon" task is not best-effort — an offline Phase-1 box would fail here (the last role)');
	const ipfsUnit = readIf(join(ROLES_DIR, 'ipfs', 'templates', 'ipfs.service.j2'));
	const ipfsUnitCmd = ipfsUnit.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
	if (/(After|Wants)=network-online\.target/.test(ipfsUnitCmd)) ob.push('ipfs.service requires network-online.target — stalls the daemon on an air-gapped box; use network.target');
	if (/--migrate=true/.test(ipfsUnitCmd)) ob.push('ipfs.service uses --migrate=true — a migration can only be fetched over the network; use --migrate=false (pinned single-version Kubo never migrates)');
	const nodejs = readIf(R('morphit/tasks/nodejs.yml'));
	if (!/morphit_node_have/.test(nodejs)) ob.push('nodejs role does not skip NodeSource when Node is already present');
	// Offline install would die at `npm install` unless the prebuilt node_modules
	// is COPIED into place: the tar-pipe excludes node_modules for online installs
	// but must INCLUDE it when the source carries the bundle marker.
	const cb = readIf(R('morphit/tasks/clone_and_build.yml'));
	if (!/morphit_source_bundle_marker/.test(cb)) ob.push('clone_and_build does not detect a bundled node_modules in the SOURCE (offline install would run npm install → hit the registry)');
	if (!/morphit_source_bundle_marker\.stat\.exists[\s\S]*?--exclude=node_modules/.test(cb)) ob.push('clone_and_build unconditionally excludes node_modules — must keep it for an offline bundle');
	// The copy MUST NOT strip node_modules/*/dist (root or nested): GNU tar lets `*`
	// cross `/`, so anchored excludes need --no-wildcards-match-slash and there must
	// be NO bare dist/build exclude (which would match node_modules/vite/dist etc.).
	// Check the COMMAND only — comments here mention the bad pattern as a warning.
	const cbCmd = cb.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
	if (!/--no-wildcards-match-slash/.test(cbCmd)) ob.push('clone_and_build tar lacks --no-wildcards-match-slash — its ./apps/*/dist excludes will also strip node_modules/*/dist (offline build breaks with "Cannot find module …/dist/…")');
	if (/--exclude=dist\b/.test(cbCmd) || /--exclude=build\b/.test(cbCmd)) ob.push('clone_and_build has an UNANCHORED --exclude=dist/build — strips every package dist in node_modules; anchor to ./apps/*/dist + add --no-wildcards-match-slash');
	// The npm build + verify run as the nologin service user; their npm cache must
	// live in the repo (writable, re-created each run), not the service user's
	// $HOME/.npm — that home is not guaranteed writable and broke `npm exec` EACCES.
	if ((cbCmd.match(/npm_config_cache:\s*"\{\{ morphit_repo_path \}\}\/\.npm-cache"/g) || []).length < 2) ob.push('clone_and_build npm build/verify do not pin npm_config_cache into the repo — npm falls back to $HOME/.npm (offline install fails EACCES)');
	// And base must make the service user actually own its home (create_home does not
	// re-chown a pre-existing dir), or $HOME/.npm + Ansible become-temp are unwritable.
	const baseMain = readIf(R('base/tasks/main.yml'));
	if (!(/path:\s*"\{\{ morphit_service_home \}\}"[\s\S]{0,240}recurse:\s*true/.test(baseMain) && /morphit_service_home[\s\S]{0,240}owner:\s*"\{\{ morphit_service_user \}\}"/.test(baseMain))) ob.push('base does not recursively chown the service home to the service user — a root-owned/re-used home fails the offline install (npm exec EACCES)');
	// morphit-mcp is created ONLY by the morphit role (gated on mcp_enabled, isolated —
	// NOT in the service group).  base must NOT also define it: two definitions with
	// different homes force a `usermod` every converge that fails once the service is
	// running ("user morphit-mcp is currently used by process …"), and base's variant
	// wrongly put it in the service group, breaking the MCP's isolation.
	if (/name:\s*morphit-mcp\b/.test(baseMain)) ob.push('base role defines a morphit-mcp user/group — it must be the morphit role ONLY (conflicting homes force a usermod that fails on re-run; service-group membership breaks MCP isolation)');
	const foPath = join(REPO_ROOT, 'ops', 'first-online', 'morphit-first-online.sh');
	const fo = existsSync(foPath) ? readFileSync(foPath, 'utf-8') : '';
	if (!/99-morphit-offline\.conf/.test(fo)) ob.push('first-online does not restore normal apt (remove the offline override) when online');
	if (!existsSync(join(REPO_ROOT, 'scripts', 'build-offline-bundle.sh'))) ob.push('scripts/build-offline-bundle.sh (the bundle recipe) missing');
	// The MCP deploy (on by default) runs `npm install` in a separate tree; offline
	// that must use the bundled npm cache, which the build ships via `npm ci --cache`.
	if (!/npm ci --cache "\$\{VENDOR\}\/npm-cache"/.test(bobSh)) ob.push('build-offline-bundle.sh does not ship an npm cache (npm ci --cache vendor/npm-cache) for the offline MCP deploy');
	if (/--exclude='?\.\/apps\/\*\/dist'?/.test(bobCmd) && !/--no-wildcards-match-slash/.test(bobCmd)) ob.push('build-offline-bundle.sh packaging tar lacks --no-wildcards-match-slash — its ./apps/*/dist exclude also strips nested apps/*/node_modules/*/dist from the bundle');
	const dmSh = existsSync(join(REPO_ROOT, 'ops', 'scripts', 'deploy-mcp.sh')) ? readFileSync(join(REPO_ROOT, 'ops', 'scripts', 'deploy-mcp.sh'), 'utf-8') : '';
	if (/npm install/.test(dmSh) && !/--offline --cache "\$REPO_DIR\/vendor\/npm-cache"/.test(dmSh)) ob.push('deploy-mcp.sh npm install is not offline-safe against the bundled npm cache');
	// npm ci caches tarballs but NOT the packuments a fresh `npm install` needs to
	// resolve the MCP deploy's rewritten package.json — so the build must WARM the
	// cache by running deploy-mcp online once (MORPHIT_MCP_CACHE_WARM=1), and
	// deploy-mcp must honour that override to force its online branch.
	if (!/MORPHIT_MCP_CACHE_WARM=1[\s\S]{0,200}deploy-mcp\.sh/.test(bobCmd)) ob.push('build-offline-bundle.sh does not warm the npm cache for the offline MCP deploy (offline npm install would fail ENOTCACHED on the SDK packument)');
	if (/vendor\/npm-cache/.test(dmSh) && !/MORPHIT_MCP_CACHE_WARM:-/.test(dmSh)) ob.push('deploy-mcp.sh does not honour MORPHIT_MCP_CACHE_WARM — the build cannot warm the cache online');
	results.push({
		name: 'offline-appliance bundle wiring (apt/docker/kubo/node install offline when bundled; dormant online; apt restored when online)',
		ok: ob.length === 0,
		detail: ob.length === 0 ? undefined : ob.join(' | ')
	});
}

// ─── Scenario 13: roles that run BEFORE the morphit copy must read repo files
// from the SOURCE dir, not the not-yet-populated /opt/morphit ──
// Regression: a guided home install died at `ddns: Install the DDNS updater
// script` — it copied from a HARDCODED /opt/morphit/ops/ddns/... that is empty
// until the morphit role (which runs LATER) copies the extracted tree there.
// Same class as the vendor apt bug.  morphit_source_dir resolves to the
// extraction dir on a guided install and /opt/morphit on a manual one, so a
// pre-copy role reads real files either way.
{
	const ob: string[] = [];
	const R = (p: string): string => join(ROLES_DIR, p);
	const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
	const gv = readIf(join(ANSIBLE_ROOT, 'group_vars', 'all.yml'));
	if (!/morphit_source_dir\s*:/.test(gv)) ob.push('morphit_source_dir not defined in group_vars/all.yml');
	const pb = existsSync(PLAYBOOK) ? readFileSync(PLAYBOOK, 'utf-8') : '';
	const idxMorphit = pb.indexOf('role: morphit');
	const before = (role: string): boolean => {
		const i = pb.indexOf(`role: ${role}`);
		return i >= 0 && idxMorphit >= 0 && i < idxMorphit;
	};
	// ddns updater script — no hardcoded /opt/morphit src; must use the source var.
	const ddns = readIf(R('ddns/tasks/main.yml'));
	if (before('ddns') && /src:\s*\/opt\/morphit\//.test(ddns)) ob.push('ddns copies from a HARDCODED /opt/morphit source (empty until the morphit copy) — use morphit_source_dir');
	if (before('ddns') && /morphit-ddns-update\.sh/.test(ddns) && !/morphit_source_dir|morphit_local_source_path/.test(ddns)) ob.push('ddns updater-script src must use morphit_source_dir');
	// postgres init.sql — must read from the source dir, not morphit_repo_path.
	const pg = readIf(R('postgres/tasks/main.yml'));
	if (before('postgres') && /-f \{\{\s*morphit_repo_path\s*\}\}\/ops\/postgres\/init\.sql/.test(pg)) ob.push('postgres reads init.sql from morphit_repo_path (/opt/morphit, empty until the copy) — use morphit_source_dir');
	results.push({
		name: 'pre-copy roles read repo files from the source dir, not the empty /opt/morphit (ddns + postgres)',
		ok: ob.length === 0,
		detail: ob.length === 0 ? undefined : ob.join(' | ')
	});
}

// ─── Scenario 14: the offline bundle's apt closure covers every package the
// default-enabled roles install ──
// Regression: the hand-maintained PKGS list in build-offline-bundle.sh silently
// drifted from the roles (missing postgresql, build-essential, chrony, docker-
// buildx-plugin + 13 more).  On a used test box those happen to be pre-installed
// so the gap hides; a fresh minimal appliance dies at the first apt install with
// no network.  This diffs PKGS against what the roles actually apt-install so the
// list can never silently fall behind again.
{
	const ob: string[] = [];
	const R = (p: string): string => join(ROLES_DIR, p);
	const bundleSh = join(REPO_ROOT, 'scripts', 'build-offline-bundle.sh');
	const shTxt = existsSync(bundleSh) ? readFileSync(bundleSh, 'utf-8') : '';
	const m = shTxt.match(/PKGS="([\s\S]*?)"/);
	const pkgs = new Set(
		(m ? m[1] : '').replace(/\\/g, ' ').split(/\s+/).map((s) => s.trim()).filter(Boolean)
	);
	if (pkgs.size === 0) ob.push('could not parse PKGS from build-offline-bundle.sh');
	// Default-enabled roles for a home appliance (monitors/matrix_bot/trivy are off).
	const enabledRoles = ['base', 'hardening', 'ddns', 'tls', 'postgres', 'bunkerweb', 'tor', 'i2pd'];
	// nodejs comes from vendor/node (nodejs.yml skips NodeSource offline) — intentionally unbundled.
	// software-properties-common is installed ONLY online (to add the purplei2p
	// PPA for a current i2pd); an offline install skips the PPA and uses the
	// vendored i2pd .deb, so it never needs it — intentionally unbundled.
	const notBundled = new Set(['nodejs', 'software-properties-common']);
	const walk = (dir: string): string[] =>
		existsSync(dir)
			? readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
					d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.yml') ? [join(dir, d.name)] : []
			  )
			: [];
	const aptPkgsInRole = (role: string): string[] => {
		const out = new Set<string>();
		for (const f of walk(R(role))) {
			let inApt = false;
			for (const raw of readFileSync(f, 'utf-8').split('\n')) {
				const s = raw.trim();
				if (/ansible\.builtin\.(apt|package)\s*:/.test(s) || /^(apt|package):/.test(s)) { inApt = true; continue; }
				if (!inApt) continue;
				const single = s.match(/^name:\s*["']?([a-z][a-zA-Z0-9.+_-]+)["']?\s*$/);
				if (single) out.add(single[1]);
				const item = s.match(/^-\s+["']?([a-z][a-zA-Z0-9.+_-]+)["']?\s*$/);
				if (item) out.add(item[1]);
				if (/^- name:/.test(s) || (/\S/.test(s) && !s.startsWith('-') && s.includes(':') && !/^(name|state|update_cache|cache_valid_time|install_recommends|autoremove|allow_unauth|force_apt_get|purge|deb):/.test(s) && !s.startsWith('#'))) inApt = false;
			}
		}
		return [...out].filter((p) => !['present', 'latest', 'true', 'false', 'yes', 'no'].includes(p));
	};
	for (const role of enabledRoles)
		for (const p of aptPkgsInRole(role))
			if (!notBundled.has(p) && !pkgs.has(p)) ob.push(`${role} apt-installs "${p}" but it is NOT in the offline bundle PKGS`);
	results.push({
		name: 'offline bundle PKGS covers every enabled-role apt install (fresh minimal box installs with zero network)',
		ok: ob.length === 0,
		detail: ob.length === 0 ? undefined : ob.join(' | ')
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
