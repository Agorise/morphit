/**
 * ops-cli install-invariants smoke (cp161 verification).
 *
 * Locks the install contract that an operator depends on for
 * `npx morphit-ops init` / `register` / `edit` / `upgrade` to
 * work on a freshly-provisioned host.  An operator hit
 * "command not found" (cp161); the root cause was a combination
 * of workspace-bin fragility + tsx being a devDependency.  This
 * smoke pins every invariant whose regression would reproduce
 * that failure, so a future package.json / Ansible / shebang
 * edit that breaks the install fails CI here instead of on the
 * operator's box.
 *
 * Invariants checked:
 *   1. tsx is a PRODUCTION dependency of apps/ops-cli (not dev).
 *      The bin runs from TS source via tsx; if tsx were dev-only,
 *      `npm install --omit=dev` / NODE_ENV=production would strip
 *      it and the bin would break.
 *   2. The bin shebang invokes tsx via npx (robust across the
 *      operator's invocation paths — bare shell + npm-managed).
 *   3. The bin field points at the source entry that exists.
 *   4. The Ansible build task does NOT claim to build ops-cli
 *      (it has no build script; the comment must not mislead).
 *   5. The Ansible post-install verify task exists and uses the
 *      genuinely-offline `npm exec --offline --workspace` form
 *      (NOT `npx --no-install`, which still does a registry
 *      lookup and is not a real offline guarantee).
 *   6. The Node engines requirement matches the Node major the
 *      Ansible playbook installs (a mismatch would let install
 *      proceed on a too-old Node and fail mysteriously later).
 *   7. The three operator-facing docs document the
 *      run-from-repo-root + npm-install requirement.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

// repo root is three levels up from apps/ops-cli/scripts/
const REPO = resolve(new URL('../../..', import.meta.url).pathname);

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string) {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

function readJson(rel: string): Record<string, unknown> {
	return JSON.parse(readFileSync(resolve(REPO, rel), 'utf8')) as Record<string, unknown>;
}
function readText(rel: string): string {
	return readFileSync(resolve(REPO, rel), 'utf8');
}

/* ---------------- invariant 1: tsx is a production dependency ---------------- */

const opsPkg = readJson('apps/ops-cli/package.json');
const deps = (opsPkg.dependencies ?? {}) as Record<string, string>;
const devDeps = (opsPkg.devDependencies ?? {}) as Record<string, string>;

if (deps.tsx !== undefined && devDeps.tsx === undefined) {
	pass('tsx is a PRODUCTION dependency of apps/ops-cli (survives --omit=dev / NODE_ENV=production)');
} else if (deps.tsx !== undefined && devDeps.tsx !== undefined) {
	fail(
		'tsx is a PRODUCTION dependency only',
		'tsx appears in BOTH dependencies and devDependencies — remove the devDependencies entry'
	);
} else {
	fail(
		'tsx is a PRODUCTION dependency of apps/ops-cli',
		`tsx not in dependencies (the bin runs from TS source via tsx; as a devDependency it would be stripped by a production install and the operator would get "command not found"). dependencies=${JSON.stringify(Object.keys(deps))}`
	);
}

/* ---------------- invariant 2: bin shebang invokes tsx via npx ---------------- */

const mainSrc = readText('apps/ops-cli/src/main.ts');
const shebang = mainSrc.split('\n')[0] ?? '';

// The npx form is the verified-robust choice: it resolves the
// local tsx across both the operator's bare-shell direct-bin
// invocation AND the npm-managed `npx morphit-ops` path.  A bare
// `tsx` shebang (no npx) fails in a bare shell where tsx isn't on
// PATH (verified cp161-verify), so the npx form must be preserved.
if (/^#!\/usr\/bin\/env -S npx tsx$/.test(shebang)) {
	pass('bin shebang is "#!/usr/bin/env -S npx tsx" (robust across bare-shell + npm invocation)');
} else {
	fail(
		'bin shebang invokes tsx via npx',
		`shebang is ${JSON.stringify(shebang)}; expected "#!/usr/bin/env -S npx tsx". A bare "tsx" shebang fails in a shell where tsx isn't on PATH (the operator's direct-bin fallback path).`
	);
}

/* ---------------- invariant 3: bin field points at an existing source entry ---------------- */

const binField = opsPkg.bin as Record<string, string> | undefined;
if (binField && binField['morphit-ops'] === 'src/main.ts') {
	pass('bin field maps morphit-ops → src/main.ts (matches the tsx-source run model)');
} else {
	fail(
		'bin field maps morphit-ops → src/main.ts',
		`bin is ${JSON.stringify(binField)}. NOTE: if cp162 ships a compiled dist/ build, this invariant changes to dist/main.js + a node shebang — update this smoke in the same change.`
	);
}

/* ---------------- invariant 4: Ansible build task doesn't claim to build ops-cli ---------------- */

const cloneBuild = readText('ops/ansible/roles/morphit/tasks/clone_and_build.yml');

// ops-cli has no build script; the build task uses --if-present
// which correctly skips it.  The task NAME must not list ops-cli
// among what it builds (the original misleading comment did).
const buildTaskNameLine = cloneBuild
	.split('\n')
	.find((l) => l.includes('name:') && l.toLowerCase().includes('build workspaces'));
if (buildTaskNameLine && /ops-cli/.test(buildTaskNameLine)) {
	fail(
		'Ansible build task name does not falsely list ops-cli',
		`the build task claims to build ops-cli, but ops-cli has no build script (it runs from source via tsx). Misleading line: ${buildTaskNameLine.trim()}`
	);
} else {
	pass('Ansible build task name does not falsely claim to build ops-cli');
}

/* ---------------- invariant 5: Ansible verify task uses the offline npm exec form ---------------- */

const hasVerifyTask = /morphit-ops CLI is runnable/.test(cloneBuild);
const usesOfflineExec = /npm exec --offline --workspace apps\/ops-cli morphit-ops/.test(cloneBuild);
const usesWeakNoInstall = /npx --no-install morphit-ops/.test(cloneBuild);

if (hasVerifyTask && usesOfflineExec && !usesWeakNoInstall) {
	pass('Ansible post-install verify task exists and uses the genuinely-offline `npm exec --offline --workspace` form');
} else if (!hasVerifyTask) {
	fail(
		'Ansible has a morphit-ops post-install verify task',
		'no "morphit-ops CLI is runnable" verify task found in clone_and_build.yml — a broken install would surface on the operator box, not in the play'
	);
} else if (usesWeakNoInstall) {
	fail(
		'Ansible verify task uses the offline npm exec form, not npx --no-install',
		'`npx --no-install` still performs a registry lookup before erroring (verified cp161-verify), so it is not a reliable offline guarantee. Use `npm exec --offline --workspace apps/ops-cli morphit-ops -- --help`.'
	);
} else {
	fail(
		'Ansible verify task uses `npm exec --offline --workspace`',
		'verify task present but does not use the expected offline-exec command shape'
	);
}

/* ---------------- invariant 6: engines Node major matches Ansible-installed Node ---------------- */

const engines = (opsPkg.engines ?? {}) as Record<string, string>;
const engineNode = engines.node ?? '';
const engineMajorMatch = engineNode.match(/(\d+)/);
const engineMajor = engineMajorMatch ? engineMajorMatch[1] : null;

const allVars = readText('ops/ansible/group_vars/all.yml');
const nodeVarMatch = allVars.match(/morphit_node_version:\s*["']?(\d+)["']?/);
const ansibleNodeMajor = nodeVarMatch ? nodeVarMatch[1] : null;

if (engineMajor !== null && ansibleNodeMajor !== null && engineMajor === ansibleNodeMajor) {
	pass(`engines.node (>=${engineMajor}) matches Ansible morphit_node_version (${ansibleNodeMajor})`);
} else {
	fail(
		'engines.node major matches the Node the Ansible playbook installs',
		`engines.node=${JSON.stringify(engineNode)} (major ${engineMajor}) vs ansible morphit_node_version=${ansibleNodeMajor}. A mismatch lets install proceed on the wrong Node and fail later.`
	);
}

/* ---------------- invariant 7: docs document the run-from-repo + npm-install requirement ---------------- */

interface DocCheck {
	file: string;
	mustContain: string[];
}
const docChecks: DocCheck[] = [
	{
		file: 'docs/OPERATIONS.md',
		mustContain: ['command not found', 'npm install', 'inside the Morphit repo']
	},
	{
		file: 'docs/RUN-A-MORPHIT-NODE.md',
		mustContain: ['command not found', 'npm install', 'inside the Morphit directory']
	},
	{
		file: 'ops/ansible/morphit-sysadmin-handoff.txt',
		mustContain: ['command not found', 'npm install', 'npm exec --offline']
	}
];

let docFails = 0;
const docMissing: string[] = [];
for (const dc of docChecks) {
	const txt = readText(dc.file);
	for (const needle of dc.mustContain) {
		if (!txt.includes(needle)) {
			docFails++;
			docMissing.push(`${dc.file}: missing ${JSON.stringify(needle)}`);
		}
	}
}
if (docFails === 0) {
	pass('all three operator-entry docs document the command-not-found fix (repo-dir + npm install)');
} else {
	fail(
		'all three operator-entry docs document the command-not-found fix',
		docMissing.join('\n      ')
	);
}

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log('  ' + ANSI_GREEN + '✓' + ANSI_RESET + ' ' + r.name);
	} else {
		console.log('  ' + ANSI_RED + '✗' + ANSI_RESET + ' ' + r.name);
		if (r.detail) console.log('      ' + r.detail);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log('✗ ' + failed + ' of ' + results.length + ' scenarios failed');
	process.exit(1);
} else {
	console.log('✓ all ' + results.length + ' scenarios passed');
}
