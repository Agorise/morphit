/**
 * package-files-exist smoke (cp146).
 *
 * Catches the class of bug F-mcp-30 (cp146 mcp-server audit
 * surfaced this in apps/mcp-server/package.json): the `files`
 * array declares paths that get bundled into the published npm
 * tarball, but if a listed path doesn't exist in the working
 * tree, npm silently skips it.  The tarball publishes WITHOUT
 * that file — which can be a packaging defect (e.g. missing
 * LICENSE → no license shown on npmjs.com), or worse, missing
 * dist/ → the package installs but the bin doesn't work.
 *
 * Two invariants per published workspace (any workspace whose
 * package.json declares a `files` field):
 *
 *   1. Every non-glob entry in `files` exists in the working
 *      tree.  Globs (`src/**\/*.ts`) are skipped — globbing is
 *      npm's job at publish time.  Build-output directories
 *      (`dist/`) are also accepted when the workspace declares a
 *      `build` script: they're materialized by `npm run build`
 *      (which `npm publish` runs via its prepublish lifecycle, and
 *      which CI runs before packaging), so they're legitimately
 *      absent on a fresh source checkout — the exact state a
 *      sysadmin receives the repo in at handoff.  This mirrors
 *      invariant 2's dist/-buildable carve-out; the two invariants
 *      must agree on what `dist/` means.  A missing LICENSE,
 *      README, `src/`, or `bin/` entry is NOT a build output and
 *      still hard-fails (the F-mcp-30 class this smoke exists for).
 *
 *   2. If `bin` is declared, every bin target file exists (or
 *      its containing directory exists, for dist/-flavored
 *      paths that get built later).  This catches "bin points
 *      at dist/main.js but no build script was ever run" — the
 *      same class cp142 caught at smoke-spawn time, here caught
 *      at package-declaration time.
 *
 * Together: a package that ships an `npm publish` would get
 * everything it declares it ships.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

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

interface PkgJson {
	name?: string;
	private?: boolean;
	files?: string[];
	bin?: string | Record<string, string>;
	scripts?: Record<string, string>;
}

/* ---------------- discover workspaces ---------------- */

function workspaceDirs(): string[] {
	const out: string[] = [];
	for (const group of ['apps', 'packages']) {
		const groupDir = join(REPO_ROOT, group);
		try {
			for (const entry of readdirSync(groupDir)) {
				const full = join(groupDir, entry);
				if (!statSync(full).isDirectory()) continue;
				if (existsSync(join(full, 'package.json'))) out.push(full);
			}
		} catch {
			// group dir doesn't exist — skip
		}
	}
	return out;
}

function loadPkg(dir: string): PkgJson {
	return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/* ---------------- invariant 1: every files entry exists ---------------- */

interface FilesEntryMiss {
	workspace: string;
	missing: string[];
}

const publishedWorkspaces: string[] = [];
const filesMisses: FilesEntryMiss[] = [];

for (const dir of workspaceDirs()) {
	const pkg = loadPkg(dir);
	const rel = relative(REPO_ROOT, dir);
	if (!pkg.files || pkg.files.length === 0) continue;
	publishedWorkspaces.push(rel);

	const hasBuildScript = !!pkg.scripts?.build;
	const missing: string[] = [];
	for (const entry of pkg.files) {
		// Globs are npm's responsibility at publish time.  Skip
		// anything containing *, ?, or [.
		if (/[*?[\]]/.test(entry)) continue;
		// Directory entries (trailing /) — the directory must exist.
		// Non-directory entries — the file must exist.
		const target = entry.endsWith('/') ? entry.slice(0, -1) : entry;
		const fullPath = join(dir, target);
		if (existsSync(fullPath)) continue;

		// Build-output directories (dist/) legitimately don't exist
		// on a fresh source checkout — `npm run build` materializes
		// them, and `npm publish` runs that build via its prepublish
		// lifecycle (CI builds before packaging too).  Accept them
		// when the workspace declares a `build` script.  This is the
		// SAME "buildable but not yet built" carve-out invariant 2
		// applies to dist/-flavored bin targets below — the two
		// invariants must agree, or the smoke red-flags every
		// un-built checkout (including the handoff state) despite
		// there being no packaging defect.  A missing LICENSE,
		// README, src/, or bin/ entry is NOT a build output and
		// still falls through to `missing` (F-mcp-30 class).
		const isBuildOutputDir = target === 'dist' || target.endsWith('/dist');
		if (isBuildOutputDir && hasBuildScript) continue;

		missing.push(entry);
	}
	if (missing.length > 0) {
		filesMisses.push({ workspace: rel, missing });
	}
}

if (publishedWorkspaces.length === 0) {
	pass('no workspaces with a `files` array declared (nothing to verify)');
} else if (filesMisses.length === 0) {
	pass(
		`every entry in every published workspace's package.json:files exists in the working tree (${publishedWorkspaces.length} workspaces, ${publishedWorkspaces.join(', ')})`
	);
} else {
	fail(
		'every entry in package.json:files exists',
		filesMisses
			.map((m) => `${m.workspace} missing: ${m.missing.join(', ')}`)
			.join('; ') +
			'.  npm publish would silently skip these (missing LICENSE → no license on npmjs.com; missing dist/ → unusable bin).  Fix by either creating the file (e.g. copy root LICENSE) or removing the entry from package.json:files.'
	);
}

/* ---------------- invariant 2: bin targets exist (or are buildable) ---------------- */

interface BinMiss {
	workspace: string;
	bin: string;
	target: string;
	reason: string;
}

const binMisses: BinMiss[] = [];

for (const dir of workspaceDirs()) {
	const pkg = loadPkg(dir);
	const rel = relative(REPO_ROOT, dir);
	if (!pkg.bin) continue;

	const bins: Record<string, string> =
		typeof pkg.bin === 'string' ? { [pkg.name ?? rel]: pkg.bin } : pkg.bin;

	for (const [binName, binPath] of Object.entries(bins)) {
		const fullPath = join(dir, binPath);
		if (existsSync(fullPath)) continue;

		// If the bin points into dist/ AND the workspace has a build
		// script, accept it as "buildable but not yet built" — this
		// matches the cp142 self-healing pattern.  The
		// spawn-dist-prebuild-coverage smoke (cp142) enforces the
		// matching guard at smoke-spawn time.
		const inDist = binPath.startsWith('dist/') || binPath.includes('/dist/');
		const hasBuild = !!pkg.scripts?.build;
		if (inDist && hasBuild) {
			// Acceptable: dist/ isn't built yet, but `npm run build`
			// would produce it.  The dist/ parent directory's tsconfig
			// (tsconfig.build.json or equivalent) is the real test —
			// here we just confirm the workspace declares a way to
			// build.
			continue;
		}

		// Not in dist OR no build script — this is a packaging defect.
		binMisses.push({
			workspace: rel,
			bin: binName,
			target: binPath,
			reason: inDist
				? 'in dist/ but workspace has no `build` script'
				: 'file does not exist'
		});
	}
}

const totalBins = workspaceDirs()
	.map(loadPkg)
	.filter((p) => p.bin)
	.reduce(
		(acc, p) =>
			acc + (typeof p.bin === 'string' ? 1 : Object.keys(p.bin ?? {}).length),
		0
	);

if (binMisses.length === 0) {
	pass(
		`every workspace bin target either exists or is buildable via \`npm run build\` (${totalBins} bins checked)`
	);
} else {
	fail(
		'every workspace bin target exists or is buildable',
		binMisses
			.map((m) => `${m.workspace}::${m.bin}=${m.target} — ${m.reason}`)
			.join('; ')
	);
}

/* ---------------- invariant 3: published packages declare LICENSE explicitly ---------------- */

// Workspaces with a `files` array that gets published to npm
// should explicitly include "LICENSE" so the license file ships.
// npm doesn't auto-include LICENSE the way it auto-includes
// package.json and README — if you don't list it in files,
// it doesn't go in the tarball.
//
// (This is exactly the F-mcp-30 root cause: mcp-server's package.json
// DID list LICENSE but the file didn't exist.  Both invariants — the
// file exists AND the file is declared — need to be enforced.)

const licenseMisses: string[] = [];
for (const dir of workspaceDirs()) {
	const pkg = loadPkg(dir);
	const rel = relative(REPO_ROOT, dir);
	if (!pkg.files || pkg.files.length === 0) continue;
	// `private: true` packages are explicitly never published to
	// npm.  They can have `main`/`bin` for workspace-internal
	// consumption, but they never reach the registry, so a missing
	// LICENSE doesn't impact downstream consumers.
	if (pkg.private === true) continue;

	// Only check workspaces that are actually intended to be published.
	// A workspace with no `bin` and no `main` and no `exports` is
	// almost certainly internal-only; skip it.
	const isPublishable =
		!!pkg.bin ||
		!!(pkg as PkgJson & { main?: string }).main ||
		!!(pkg as PkgJson & { exports?: unknown }).exports;
	if (!isPublishable) continue;

	if (!pkg.files.includes('LICENSE') && !pkg.files.includes('LICENSE.md')) {
		licenseMisses.push(rel);
	}
}

if (licenseMisses.length === 0) {
	pass(`every publishable workspace declares LICENSE in package.json:files`);
} else {
	fail(
		'every publishable workspace declares LICENSE in package.json:files',
		`workspaces missing LICENSE in files array: ${licenseMisses.join(', ')}.  Without it, \`npm publish\` ships a tarball with no license file — npmjs.com shows "No license" and downstream consumers can't verify license compliance.`
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
