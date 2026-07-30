/**
 * lockfile-sync smoke (cp144).
 *
 * Catches the cp140 → cp143 latent bug: when a new workspace
 * (`apps/mcp-server`) was added to the root `package.json`,
 * `package-lock.json` was not regenerated.  `npm ci` requires
 * the two to be in sync — so every CI run after cp140 failed
 * with EUSAGE at the install step, gating ALL downstream jobs
 * (typecheck, smokes, svelte-check, build).  The repo looked
 * green locally because `npm install` (the dev command) silently
 * heals the lockfile, while `npm ci` (the CI command) refuses
 * to.  The failure mode was invisible until Ken happened to
 * look at the actual Forgejo runner logs.
 *
 * This smoke runs the canonical `npm ci --dry-run` against the
 * working tree and asserts exit-zero.  Three scenarios:
 *
 *   1. `npm ci --dry-run` succeeds → lockfile is in sync.
 *   2. Exit code is non-zero AND stderr mentions lockfile drift
 *      → known class-of-bug.  Smoke names it specifically and
 *      points at `npm install` as the fix.
 *   3. Exit code is non-zero for OTHER reasons (network down,
 *      registry hiccup) → smoke reports the failure verbatim
 *      so the operator can diagnose.
 *
 * Runtime: ~4 seconds when the lockfile IS in sync (npm ci
 * dry-run + tree walk).  Well under the cp143 240s ceiling.
 *
 * To tamper-test: revert any workspace dep in package-lock.json
 * (e.g. delete the "node_modules/morphit-mcp" entry) and re-run.
 * Smoke should fail with the class-of-bug branch.
 *
 * NOTE: this smoke uses `npm` from PATH.  In CI the smokes job
 * has npm available because the setup-node action ensures it.
 * On developer machines anyone running smokes locally also has
 * npm installed (you can't develop Morphit without it).  No
 * fallback needed.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const REPO_ROOT = resolvePath(new URL('..', import.meta.url).pathname);

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

// Markers that the npm ci EUSAGE failure mode uses.  These are
// stable across at least npm 10.x — verified against the 2026-05-27
// cp140-stale-lockfile Forgejo CI log Ken caught.
const STALE_LOCKFILE_MARKERS = [
	'EUSAGE',
	'package.json and package-lock.json',
	'package-lock.json or npm-shrinkwrap.json',
	'lock file',
	'Missing:'
];

console.log('── lockfile-sync smoke (cp144) ─────────────────────────');

const result = spawnSync(
	'npm',
	['ci', '--dry-run', '--no-audit', '--no-fund', '--prefer-offline'],
	{
		cwd: REPO_ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		// Avoid blocking on network in pathological cases.  npm ci
		// with --prefer-offline will use cache when available; if it
		// genuinely needs network the smoke takes longer but won't
		// hang past the runner's 240s ceiling.
		timeout: 120_000
	}
);

const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
const stale = STALE_LOCKFILE_MARKERS.some((m) => combinedOutput.includes(m));

// Scenario 1 — npm ci passed dry-run.
if (result.status === 0) {
	pass('npm ci --dry-run succeeds (lockfile in sync with package.json)');
} else if (stale && result.status !== null) {
	// Scenario 2 — npm ci failed AND the failure mode is the
	// known stale-lockfile EUSAGE.  Class-of-bug message.
	const missing = combinedOutput
		.split('\n')
		.filter((l) => l.includes('Missing:'))
		.slice(0, 6)
		.map((l) => l.replace(/^.*Missing:\s*/, '').trim())
		.filter(Boolean);
	const missingDetail =
		missing.length > 0
			? `missing from lockfile (first ${missing.length}): ${missing.join(', ')}`
			: 'lockfile is stale';
	fail(
		'npm ci --dry-run succeeds (lockfile in sync with package.json)',
		`${missingDetail}.  Fix: run \`npm install --package-lock-only\` from repo root, commit the updated package-lock.json, and push.  This is the cp140 → cp144 class of bug — adding a workspace requires regenerating the lockfile or CI's \`npm ci\` will reject the install before any job (typecheck, smokes, svelte-check) gets a chance to run.`
	);
} else {
	// Scenario 3 — failed for some OTHER reason.  Surface verbatim.
	const head = combinedOutput
		.split('\n')
		.filter((l) => l.trim())
		.slice(0, 8)
		.join('\n      ');
	fail(
		'npm ci --dry-run succeeds (lockfile in sync with package.json)',
		`npm ci exited ${result.status} with non-lockfile error:\n      ${head}`
	);
}

// Scenario 2 (always-run sanity) — root package-lock.json must
// exist and be readable JSON.  This is the precondition for
// scenario 1 even making sense.  Catches accidental deletion or
// JSON corruption.
const lockPath = resolvePath(REPO_ROOT, 'package-lock.json');
if (!existsSync(lockPath)) {
	fail(
		'package-lock.json exists at repo root',
		`expected file at ${lockPath} — required for reproducible CI installs (\`npm ci\` only works against a committed lockfile)`
	);
} else {
	try {
		const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
		if (typeof lock !== 'object' || !lock.lockfileVersion) {
			throw new Error('lockfile JSON is not the expected npm schema');
		}
		pass(
			`package-lock.json exists and parses as valid npm schema (lockfileVersion=${lock.lockfileVersion})`
		);
	} catch (err) {
		fail(
			'package-lock.json exists at repo root',
			`failed to parse: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

// Scenario 3 — every workspace declared in root package.json
// must have a corresponding entry in package-lock.json's
// `packages` map.  This is the FAST offline check that catches
// the cp140 specific bug class even if `npm ci` is somehow
// unavailable.  Authoritative for the workspace-add forgot-the-lockfile
// path; not authoritative for transitive-dep drift (that's what
// scenario 1 covers).
try {
	const root = JSON.parse(
		readFileSync(resolvePath(REPO_ROOT, 'package.json'), 'utf8')
	) as { workspaces?: string[] };
	const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
		packages?: Record<string, unknown>;
	};
	const declared = root.workspaces ?? [];
	const lockKeys = new Set(Object.keys(lock.packages ?? {}));
	const missing = declared.filter((w) => !lockKeys.has(w));
	if (missing.length === 0) {
		pass(
			`every declared workspace (${declared.length}) appears in package-lock.json's packages map`
		);
	} else {
		fail(
			'every declared workspace appears in package-lock.json',
			`workspaces in package.json but not in lockfile: ${missing.join(', ')}.  This is the cp140 specific failure: the workspace was added to package.json but \`npm install\` was never re-run to populate the lockfile.`
		);
	}
} catch (err) {
	fail(
		'every declared workspace appears in package-lock.json',
		`could not cross-check package.json vs package-lock.json: ${err instanceof Error ? err.message : String(err)}`
	);
}

let failed = 0;
// ─── Workspace VERSION parity (cp472) ──────────────────────────────
// This smoke only ever checked that each workspace is PRESENT in the
// lockfile (the cp140 `npm ci` EUSAGE bug). It never checked the version
// each entry reports — so the lockfile silently sat at 1.4.12 through the
// whole of v1.5.0 while every package.json said 1.5.0, and CI stayed green.
// `npm install` heals it locally, which is exactly why nobody noticed.
// Ken: "i do not like anything to go stale, so fix where necessary, always."
//
// Version-only drift doesn't break `npm ci`, but it makes the lockfile lie
// about what the repo is: anything reading it (supply-chain tooling, an
// operator diffing a tarball against a tag, `npm ls`) gets the wrong answer.
// Regenerate with: npm install --package-lock-only
{
	const name = 'lockfile workspace versions match their package.json';
	try {
		const lock = JSON.parse(readFileSync(resolvePath(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
			packages?: Record<string, { version?: string }>;
		};
		const pkgs = lock.packages ?? {};
		const drift: string[] = [];
		// '' is the root workspace entry; the rest are keyed by their path.
		for (const [key, entry] of Object.entries(pkgs)) {
			if (key.startsWith('node_modules/')) continue;
			const manifestPath = resolvePath(REPO_ROOT, key === '' ? 'package.json' : `${key}/package.json`);
			if (!existsSync(manifestPath)) continue;
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
			if (manifest.version === undefined) continue;
			if (entry.version !== manifest.version) {
				drift.push(`${key === '' ? '(root)' : key}: lockfile ${entry.version ?? '<none>'} vs package.json ${manifest.version}`);
			}
		}
		if (drift.length === 0) {
			pass(name);
		} else {
			fail(
				name,
				`${drift.length} stale version(s) — regenerate with \`npm install --package-lock-only\` (version-only; it must not touch resolved/integrity):\n      ${drift.join('\n      ')}`
			);
		}
	} catch (err) {
		fail(name, `could not compare lockfile versions: ${String(err)}`);
	}
}

for (const r of results) {
	if (r.passed) {
		console.log(`  ${ANSI_GREEN}✓${ANSI_RESET} ${r.name}`);
	} else {
		console.log(`  ${ANSI_RED}✗${ANSI_RESET} ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log(`✗ ${failed} of ${results.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(`✓ all ${results.length} scenarios passed`);
}
