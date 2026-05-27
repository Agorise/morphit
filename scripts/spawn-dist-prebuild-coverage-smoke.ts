/**
 * spawn-dist-prebuild-coverage smoke
 *
 * cp142 LL #1.  This smoke is the meta-guard that catches the
 * class of bug found in cp141→cp142 audit: a workspace shipped a
 * `bin` field pointing into `dist/`, but the corresponding smoke
 * spawned `node dist/main.js` without any guard for the case
 * where dist/ hadn't been built yet.  Because `dist/` is
 * gitignored, this was an unbounded hang on every fresh checkout
 * (CI included) — only saved by the fact that dev machines kept
 * dist/ on disk between manual runs of `npm run build`.
 *
 * Two invariants enforced here:
 *
 *   1. Every workspace whose `package.json` declares a `bin`
 *      field pointing into `dist/...` MUST also declare a
 *      `scripts.build` entry.  Without `build`, the bin can't
 *      be produced by any automated path, and the install is
 *      broken in a different (worse) way.
 *
 *   2. Every smoke file under `apps/<workspace>/scripts/` or
 *      the repo-root `scripts/` directory that spawns a child
 *      process from a `dist/` path MUST also contain either an
 *      `ensureBuilt(` call OR an `existsSync(` check against
 *      the dist path before the spawn.  Bare `spawn('node',
 *      ['dist/...'])` with no existence guard is the bug we
 *      just fixed; this smoke prevents regression.
 *
 * The cp141 audit grep found only ONE matching smoke in the
 * tree (`apps/mcp-server/scripts/mcp-server-smoke.ts`) and ONE
 * matching bin (`apps/mcp-server/package.json:bin.morphit-mcp`).
 * The smoke runs both lists in parallel so we'll notice any
 * drift on either side as new workspaces are added.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);

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

/* ---------------- workspace bin/build coverage ---------------- */

interface PkgJson {
	name?: string;
	bin?: string | Record<string, string>;
	scripts?: Record<string, string>;
}

function workspaceDirs(): string[] {
	const out: string[] = [];
	for (const group of ['apps', 'packages']) {
		const groupDir = join(REPO_ROOT, group);
		for (const entry of readdirSync(groupDir)) {
			const full = join(groupDir, entry);
			if (!statSync(full).isDirectory()) continue;
			if (readdirSync(full).includes('package.json')) out.push(full);
		}
	}
	return out;
}

function loadPkg(dir: string): PkgJson {
	return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

function binPaths(pkg: PkgJson): string[] {
	if (!pkg.bin) return [];
	if (typeof pkg.bin === 'string') return [pkg.bin];
	return Object.values(pkg.bin);
}

const distBinFindings: { workspace: string; binPath: string; hasBuild: boolean }[] = [];
for (const dir of workspaceDirs()) {
	const pkg = loadPkg(dir);
	const rel = relative(REPO_ROOT, dir);
	for (const bp of binPaths(pkg)) {
		if (!bp.startsWith('dist/') && !bp.includes('/dist/')) continue;
		distBinFindings.push({
			workspace: rel,
			binPath: bp,
			hasBuild: !!pkg.scripts?.build
		});
	}
}

const missingBuild = distBinFindings.filter((f) => !f.hasBuild);
if (missingBuild.length === 0) {
	pass(
		`every dist-bin workspace declares a build script (${distBinFindings.length} dist-bins checked)`
	);
} else {
	fail(
		'workspaces with dist-bins missing scripts.build',
		missingBuild.map((f) => `${f.workspace} → bin=${f.binPath}`).join('; ')
	);
}

/* ---------------- smoke-spawn guard coverage ---------------- */

function listSmokeFiles(): string[] {
	const out: string[] = [];
	// apps/*/scripts/*.ts
	for (const app of readdirSync(join(REPO_ROOT, 'apps'))) {
		const scriptsDir = join(REPO_ROOT, 'apps', app, 'scripts');
		try {
			for (const f of readdirSync(scriptsDir)) {
				if (f.endsWith('.ts')) out.push(join(scriptsDir, f));
			}
		} catch {
			// no scripts/ in this app — fine
		}
	}
	// repo-root scripts/*.ts (excluding canary subdir's compiled noise)
	for (const f of readdirSync(join(REPO_ROOT, 'scripts'))) {
		if (f.endsWith('.ts')) out.push(join(REPO_ROOT, 'scripts', f));
	}
	return out;
}

interface SmokeFinding {
	file: string;
	spawnsDist: boolean;
	hasGuard: boolean;
}

// Match `spawn('node', ['dist/...']` or `spawn("node", ["dist/...]"`
// across whitespace and newlines.  Tight enough to skip prose
// mentions in comments-as-strings (we only flag actual call
// expressions).
const SPAWN_DIST_PATTERN = /\bspawn(?:Sync)?\s*\(\s*['"]node['"]\s*,\s*\[\s*['"][^'"]*dist\//;

// Either a self-build helper invocation (the cp142 pattern) or
// an explicit fs existence check is acceptable.  We test this
// against a COMMENT-STRIPPED copy of the source; otherwise a
// stale "// See ensureBuilt() above" comment that survived a
// partial revert would falsely count as a guard.
const GUARD_PATTERN = /\b(ensureBuilt\s*\(|existsSync\s*\(\s*[^)]*dist)/;

// Quick-and-correct comment stripping for the GUARD scan.
// Removes `// …` to end-of-line and `/* … */` blocks.  Does
// NOT account for `//` inside string literals; that would
// require a real tokenizer, but the GUARD identifiers
// (`ensureBuilt`, `existsSync`) are vanishingly unlikely to
// appear inside string literals in a smoke script.  The
// SPAWN_DIST scan deliberately runs against the UNSTRIPPED
// text so docblock examples and regex literals still count
// the file as "spawns from dist/" — we want to over-match the
// flagging side so under-stripping doesn't hide bugs.
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Skip the meta-smoke itself — its illustrative docblock and
// regex source contain the literal pattern that would otherwise
// cause it to flag itself.
const SELF_PATH = relative(REPO_ROOT, new URL(import.meta.url).pathname);

const smokeFindings: SmokeFinding[] = [];
for (const path of listSmokeFiles()) {
	const rel = relative(REPO_ROOT, path);
	if (rel === SELF_PATH) continue;
	const text = readFileSync(path, 'utf8');
	const spawnsDist = SPAWN_DIST_PATTERN.test(text);
	if (!spawnsDist) continue;
	smokeFindings.push({
		file: rel,
		spawnsDist: true,
		hasGuard: GUARD_PATTERN.test(stripComments(text))
	});
}

const ungarded = smokeFindings.filter((f) => !f.hasGuard);
if (ungarded.length === 0) {
	pass(
		`every smoke that spawns from dist/ has a build/existence guard (${smokeFindings.length} matched)`
	);
} else {
	fail(
		'smokes spawning from dist/ without ensureBuilt() or existsSync() guard',
		ungarded.map((f) => f.file).join('; ')
	);
}

/* ---------------- bin-vs-smoke coverage cross-check ---------------- */

// Optional invariant: at least one smoke should exist per
// dist-bin workspace.  Catches "someone added a dist-bin but
// never wrote a smoke for it" — a different bug class than
// the two above, but in the same neighborhood.
const distBinWorkspaces = new Set(distBinFindings.map((f) => f.workspace));
const smokeWorkspaces = new Set(
	smokeFindings.map((f) => f.file.split('/').slice(0, 2).join('/'))
);
const missingSmoke = [...distBinWorkspaces].filter((w) => !smokeWorkspaces.has(w));
if (missingSmoke.length === 0) {
	pass(
		`every dist-bin workspace has at least one dist-spawning smoke (${distBinWorkspaces.size} workspaces)`
	);
} else {
	fail(
		'dist-bin workspaces with no dist-spawning smoke',
		missingSmoke.join('; ')
	);
}

/* ---------------- report ---------------- */

let failed = 0;
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
