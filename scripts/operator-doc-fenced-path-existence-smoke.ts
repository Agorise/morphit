#!/usr/bin/env tsx
/**
 * scripts/operator-doc-fenced-path-existence-smoke.ts
 *
 * Structural Defense #31 — operator-doc fenced-path existence
 * (cp82-O29 candidate, deferred from cp82, shipped cp84).
 *
 * Verifies that every script-path referenced in operator-facing
 * documentation resolves to a real file on disk.  Catches the
 * drift class that cp82-A6 fixed manually: `scripts/encrypt-
 * active-key.ts` was referenced in 6 places across OPERATIONS.md
 * and RUN-A-MORPHIT-NODE.md, but the actual script lived at
 * `apps/relay/scripts/encrypt-active-key.ts`.  An operator
 * following the documented command would hit file-not-found.
 *
 * Patterns matched (case-sensitive, must look like a path):
 *
 *   - `bash X.sh` / `bash X` where X starts with `scripts/`,
 *     `apps/<ws>/scripts/`, `ops/scripts/`, or `ops/ansible/`
 *   - `tsx X.ts` / `node X.mjs` / `python3 X.py` with same prefix
 *   - Inline backtick-quoted `<prefix>/<name>.<ext>` paths
 *   - Code-fenced lines containing such paths (no leading
 *     command word required)
 *
 * Path roots we verify against:
 *
 *   - `scripts/...`              → repo-root scripts/
 *   - `apps/<workspace>/scripts/...` → workspace scripts/
 *   - `apps/<ws>/<subpath>`      → workspace subpath (for cp82-A6 class)
 *   - `ops/scripts/...`          → ops scripts
 *   - `ops/ansible/...`          → ansible material
 *   - `packages/<pkg>/scripts/...` → package scripts
 *
 * False-positive avoidance:
 *
 *   1. Generic prose like "the relay's `scripts/` directory" —
 *      we require a file extension before flagging.
 *   2. `node_modules/...` paths — excluded (third-party).
 *   3. URLs (https://github.com/.../scripts/...) — excluded
 *      via a leading-scheme check.
 *   4. Glob patterns containing `*` — excluded.
 *
 * Doc scope: every operator-facing markdown file under docs/
 * plus README.md.  ADRs are excluded — they encode historical
 * decisions and may legitimately reference paths that have
 * since been renamed (annotation-pattern-not-rewrite rule).
 * The audit log and REVISIT-LIST.md are excluded as historical
 * journals.  TARBALL.md is excluded — its purpose is exactly
 * to record past states, including superseded paths.
 *
 * Each (doc, line, path) tuple counts as one scenario.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// Doc files in scope.  Each operator-facing surface; excludes
// ADRs (historical), audit (frozen), REVISIT-LIST (journal),
// TARBALL (state log), PHASE-* (planning), DESIGN docs (RFCs).
const OPERATOR_DOCS = [
	'README.md',
	'docs/start-here/README.md',
	'docs/RUN-A-MORPHIT-NODE.md',
	'docs/OPERATIONS.md',
	'docs/PRE-LAUNCH-CHECKLIST.md',
	'docs/LAUNCH-DAY.md',
	'docs/POST-LAUNCH-WEEK-ONE.md',
	'docs/UPGRADING.md',
	'docs/MIGRATE-TO-RELEASE-TRACK.md',
	'docs/BETA-INCIDENT-RUNBOOK.md',
	'docs/SECURITY.md',
	'docs/ADDING-A-COIN.md',
	'docs/API.md',
	'docs/ARCHITECTURE.md',
	'docs/FORGEJO-RUNNER-STANDUP.md',
	'docs/CONTRIBUTING-TRANSLATIONS.md'
];

// Path prefixes that are allowed root anchors.  A path-like
// token whose first segment matches one of these is checked
// against the filesystem.
const VALID_ROOTS = [
	'scripts/',
	'apps/',
	'ops/',
	'packages/',
	'docs/'
];

// File extensions that suggest "this is a file the operator
// would invoke or read", not a directory or glob.
const VALID_EXTENSIONS = new Set([
	'sh',
	'ts',
	'tsx',
	'js',
	'mjs',
	'cjs',
	'py',
	'sql',
	'yml',
	'yaml',
	'json',
	'md',
	'service',
	'timer',
	'conf',
	'env',
	'example'
]);

// Pattern: a path of the form
//   <root>/<intermediate-dirs>/<filename>.<ext>
// Captured groups not used; we use the full match.
const PATH_RE =
	/(?:^|[\s`"'(\[])((?:scripts|apps|ops|packages|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g;

interface Hit {
	doc: string;
	line: number;
	path: string;
	cdContext: string | null;
}

const hits: Hit[] = [];
const failures: string[] = [];

function isExcludedPath(p: string): boolean {
	// Glob / wildcard
	if (p.includes('*')) return true;
	// URLs (http://x/scripts/y) — caught only if some prefix
	// got stripped; safer to reject any path with `://`.
	if (p.includes('://')) return true;
	// node_modules
	if (p.includes('node_modules/')) return true;
	// Trailing punctuation that snuck into the path token
	if (p.endsWith('.') || p.endsWith(',') || p.endsWith(':') || p.endsWith(';')) {
		return true;
	}
	// Bracketed asset templates like apps/web/.../[lang]/[asset]
	if (p.includes('[') || p.includes(']')) return true;
	// Must have a valid root
	if (!VALID_ROOTS.some((r) => p.startsWith(r))) return true;
	// Must end in a known file extension (filter out
	// "the scripts/ dir" false positives)
	const lastDot = p.lastIndexOf('.');
	if (lastDot === -1) return true;
	const ext = p.slice(lastDot + 1).toLowerCase();
	if (!VALID_EXTENSIONS.has(ext)) return true;
	return false;
}

// Operator-managed runtime files: never in the repo, created by
// the operator at install time or by the ops-cli wizard.  The
// repo carries templates (`.example`) and documentation; the
// real files materialize on the operator's box.  Excluded from
// the existence check.
//
// Detection strategy is deliberately data-driven, not hardcoded:
//
//   - `X.env` paths are excluded iff `X.env.example` exists in
//     the repo (signals "operator copies the template").
//   - `*/keystore.json` / `*/keystore.wif` paths are excluded
//     unconditionally (encrypted-key files are by definition
//     operator-managed).
//   - paths under `ops/backup/` matching `*.env` follow the
//     same `.example` rule.
//
// This auto-handles future operator-managed-file additions:
// add a `.env.example` template to the repo and the smoke
// stops flagging the corresponding `.env` reference.
function isOperatorManagedRuntimeFile(p: string, repoRoot: string): boolean {
	if (p.endsWith('/keystore.json') || p.endsWith('/keystore.wif')) {
		return true;
	}
	// Build-generated outputs written by apps/web/scripts/build-manifest.mjs:
	// the reproducible-build fingerprint (`build-manifest.sha256`) and the
	// SRI on-chain release manifest (`build-manifest.release.json`).  They
	// materialize only after `npm run build` / `build:manifest`; never
	// committed (see apps/web/.gitignore).  Operator docs reference them as
	// the release-op manifest source (PRE-LAUNCH-CHECKLIST §B/§E, OPERATIONS
	// §40.6), so the existence check must skip them.
	if (
		p.endsWith('/build-manifest.sha256') ||
		p.endsWith('/build-manifest.release.json')
	) {
		return true;
	}
	if (p.endsWith('.env')) {
		const examplePath = join(repoRoot, p + '.example');
		if (existsSync(examplePath)) return true;
	}
	return false;
}

// "Update history" / "Changelog" boundary: docs commonly carry
// a trailing change-log table that paraphrases past commands
// for historical traceability.  Such tables MUST be allowed to
// hold stale path references — that's the annotation-pattern-
// not-rewrite rule applied to operator-doc history.  When the
// smoke sees one of these headings, it stops scanning the rest
// of the file.
const HISTORY_BOUNDARY_RE =
	/^##\s+(Update history|Changelog|Change log|Revision history|History)\s*$/i;

// CD-context resolution: inside a fenced code block, a bare
// `scripts/foo.ts` after a preceding `cd apps/relay` (in the
// SAME fence) refers to `apps/relay/scripts/foo.ts`.  Track
// the most recent `cd` target per fence and resolve bare
// `scripts/...` paths against it when the literal path doesn't
// exist at repo root.
//
// Recognized `cd` forms:
//
//   cd /opt/morphit/apps/indexer
//   cd apps/web
//   cd ./apps/relay
//
// We strip `/opt/morphit/` (the documented deploy path) and
// any leading `./` to map deployment-style cd into a repo-
// relative directory.
const CD_RE = /\bcd\s+(?:\.\/)?(?:\/opt\/morphit\/)?([A-Za-z0-9_./-]+)/;

interface ResolvedHit extends Hit {
	resolved: string;
}

function resolveWithCdContext(
	rawPath: string,
	cdTarget: string | null,
	repoRoot: string
): string {
	if (existsSync(join(repoRoot, rawPath))) {
		return rawPath; // already valid at repo root
	}
	if (cdTarget && rawPath.startsWith('scripts/')) {
		const candidate = `${cdTarget}/${rawPath}`;
		if (existsSync(join(repoRoot, candidate))) {
			return candidate;
		}
	}
	return rawPath; // unresolved — will fail existence check
}

console.log('\n── operator-doc fenced-path existence smoke ────────────\n');

for (const docRel of OPERATOR_DOCS) {
	const docPath = join(REPO, docRel);
	if (!existsSync(docPath)) {
		// Doc list itself is wrong — that's a real bug.
		failures.push(`doc-list references nonexistent ${docRel}`);
		continue;
	}
	const text = readFileSync(docPath, 'utf8');
	const lines = text.split('\n');
	let inFence = false;
	let cdInFence: string | null = null;
	let pastHistoryBoundary = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Stop scanning once we cross an Update-history boundary.
		if (HISTORY_BOUNDARY_RE.test(line)) {
			pastHistoryBoundary = true;
			continue;
		}
		if (pastHistoryBoundary) continue;
		// Track fenced code blocks.  Each ``` toggles fence state
		// and resets cd-context (a new fence starts in repo-root).
		// Match indented fences too — Markdown allows fenced blocks
		// inside list items, and those carry leading whitespace.
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			cdInFence = null;
			continue;
		}
		// Inside a fence, harvest `cd <dir>` to set cd-context.
		if (inFence) {
			const cdMatch = line.match(CD_RE);
			if (cdMatch) {
				cdInFence = cdMatch[1]!;
			}
		}
		// HTML-comment-stripped scan: paths inside <!-- ... -->
		// may be intentionally archival.  We strip those out.
		const visible = line.replace(/<!--.*?-->/g, '');
		PATH_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = PATH_RE.exec(visible)) !== null) {
			const candidate = m[1]!;
			if (isExcludedPath(candidate)) continue;
			// Dedupe within the same line (a path mentioned
			// multiple times on one line still counts as one
			// scenario, since one fix would close all of them).
			const already = hits.some(
				(h) => h.doc === docRel && h.line === i + 1 && h.path === candidate
			);
			if (!already) {
				hits.push({
					doc: docRel,
					line: i + 1,
					path: candidate,
					cdContext: inFence ? cdInFence : null
				});
			}
		}
	}
}

// Verify each hit against the filesystem.
let operatorManagedSkipped = 0;
for (const h of hits) {
	if (isOperatorManagedRuntimeFile(h.path, REPO)) {
		operatorManagedSkipped++;
		continue;
	}
	const resolved = resolveWithCdContext(h.path, h.cdContext, REPO);
	const abs = join(REPO, resolved);
	if (!existsSync(abs)) {
		const suffix =
			h.cdContext && h.cdContext !== resolved
				? ` (also tried via cd-context \`${h.cdContext}\`)`
				: '';
		failures.push(
			`${h.doc}:${h.line} references nonexistent path \`${h.path}\`${suffix}`
		);
	}
}

console.log(`  scanned ${OPERATOR_DOCS.length} operator-facing docs`);
console.log(`  path references found: ${hits.length}`);
console.log(`  operator-managed runtime files skipped: ${operatorManagedSkipped}`);
const checked = hits.length - operatorManagedSkipped;

if (failures.length > 0) {
	console.log(`\n  ✗ ${failures.length} path(s) do not exist on disk:`);
	for (const f of failures) console.log(`    - ${f}`);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${failures.length}/${checked} scenarios failed`);
	process.exit(1);
}

// Sanity: if no path references were found at all, the regex
// is broken or the doc list is empty.  Either way, fail loudly
// rather than silently passing zero.
if (checked === 0) {
	console.log('\n  ✗ no verifiable path references found — pattern is broken');
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ 1/1 scenarios failed`);
	process.exit(1);
}

console.log(`  ✓ all ${checked} verifiable path references resolve to real files`);
console.log('\n──────────────────────────────────────────────────────');
console.log(`✓ all ${checked} scenarios passed`);
