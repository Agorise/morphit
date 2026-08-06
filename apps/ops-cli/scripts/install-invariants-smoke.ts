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
	pass('tsx is a PRODUCTION dependency of apps/ops-cli (powers the shim fallback path under --omit=dev)');
} else if (deps.tsx !== undefined && devDeps.tsx !== undefined) {
	fail(
		'tsx is a PRODUCTION dependency only',
		'tsx appears in BOTH dependencies and devDependencies — remove the devDependencies entry'
	);
} else {
	fail(
		'tsx is a PRODUCTION dependency of apps/ops-cli',
		`tsx not in dependencies (the bin shim falls back to running TS source via tsx when dist/ is absent; as a devDependency it would be stripped by a production install and the fallback would break). dependencies=${JSON.stringify(Object.keys(deps))}`
	);
}

/* ---------------- invariant 2: bin launcher shim exists with a node shebang ---------------- */

// cp162: the published bin is a launcher shim (bin/morphit-ops.mjs)
// that runs the compiled dist/main.js under plain node when present,
// and falls back to the tsx source otherwise.  The shim itself is
// plain JS with a node shebang so it always runs under node.
const shimRel = 'apps/ops-cli/bin/morphit-ops.mjs';
let shimSrc = '';
try {
	shimSrc = readText(shimRel);
} catch {
	shimSrc = '';
}
const shimShebang = shimSrc.split('\n')[0] ?? '';
if (shimSrc && /^#!\/usr\/bin\/env node$/.test(shimShebang)) {
	// The shim must implement BOTH paths: compiled dist + tsx fallback.
	const hasDistPath = /dist\/main\.js/.test(shimSrc) && /process\.execPath/.test(shimSrc);
	const hasTsxFallback = /tsx/.test(shimSrc) && /src\/main\.ts/.test(shimSrc);
	if (hasDistPath && hasTsxFallback) {
		pass('bin launcher shim has node shebang + compiled-dist path + tsx-source fallback');
	} else {
		fail(
			'bin launcher shim implements both compiled + fallback paths',
			`hasDistPath=${hasDistPath} hasTsxFallback=${hasTsxFallback} — the shim must run dist/main.js under node when present and fall back to tsx source otherwise`
		);
	}
} else {
	fail(
		'bin launcher shim exists with a node shebang',
		`expected ${shimRel} with "#!/usr/bin/env node"; got shebang ${JSON.stringify(shimShebang)}`
	);
}

/* ---------------- invariant 2b: source main.ts keeps its tsx shebang (dev/fallback path) ---------------- */

const mainSrc = readText('apps/ops-cli/src/main.ts');
const srcShebang = mainSrc.split('\n')[0] ?? '';
// src/main.ts is still run directly by tsx in the dev path (`npm
// start`/`dev`) and the shim's fallback.  Its shebang stays the
// robust npx-tsx form so `tsx src/main.ts` and bare-shell runs work.
if (/^#!\/usr\/bin\/env -S npx tsx$/.test(srcShebang)) {
	pass('src/main.ts keeps its "#!/usr/bin/env -S npx tsx" shebang (dev + fallback path)');
} else {
	fail(
		'src/main.ts keeps its tsx shebang',
		`shebang is ${JSON.stringify(srcShebang)}; expected "#!/usr/bin/env -S npx tsx" for the dev/fallback run path`
	);
}

/* ---------------- invariant 3: bin field points at the shim; build script + files present ---------------- */

const binField = opsPkg.bin as Record<string, string> | undefined;
const scripts = (opsPkg.scripts ?? {}) as Record<string, string>;
const filesField = (opsPkg.files ?? []) as string[];

const binOk = binField?.['morphit-ops'] === 'bin/morphit-ops.mjs';
const buildOk = typeof scripts.build === 'string' && scripts.build.includes('build.mjs');
const filesOk = filesField.includes('dist/') && filesField.includes('bin/') && filesField.includes('src/');

if (binOk && buildOk && filesOk) {
	pass('bin → shim, build script present (esbuild bundle), files includes bin/+dist/+src/');
} else {
	fail(
		'bin → shim + build script + files field',
		`bin=${JSON.stringify(binField)} (want bin/morphit-ops.mjs) · build=${JSON.stringify(scripts.build)} (want node scripts/build.mjs) · files=${JSON.stringify(filesField)} (want bin/ dist/ src/)`
	);
}

/* ---------------- invariant 3b: esbuild is available to the build ---------------- */

const esbuildDep =
	(devDeps as Record<string, string>).esbuild !== undefined ||
	(deps as Record<string, string>).esbuild !== undefined;
if (esbuildDep) {
	pass('esbuild is a declared dependency (the build script needs it)');
} else {
	fail(
		'esbuild is a declared dependency',
		'scripts/build.mjs imports esbuild but it is not in dependencies/devDependencies — the build would fail on a clean install'
	);
}

/* ---------------- invariant 4: Ansible build task builds ops-cli (now has a build script) ---------------- */

const cloneBuild = readText('ops/ansible/roles/morphit/tasks/clone_and_build.yml');

// cp162: ops-cli now HAS a build script, so `--if-present` builds
// it.  The build task must run AFTER the full npm install (dev deps
// incl. esbuild present).  Verify the build command is present and
// uses --if-present (which now picks up ops-cli).
const hasIfPresentBuild = /npm run build --workspaces --if-present/.test(cloneBuild);
if (hasIfPresentBuild) {
	pass('Ansible build task uses `npm run build --workspaces --if-present` (now builds ops-cli dist)');
} else {
	fail(
		'Ansible build task builds ops-cli via --if-present',
		'expected `npm run build --workspaces --if-present` in clone_and_build.yml — ops-cli now has a build script that this picks up'
	);
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
