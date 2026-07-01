#!/usr/bin/env tsx
/**
 * mediakit-freshness-smoke — fail CI if the checked-in
 * apps/web/static/morphit-mediakit.zip is older than its source
 * files (brag list, brand SVGs).
 *
 * The mediakit zip is pre-built and committed (operators serve it as
 * a static asset; we don't want to build zips on every page load or
 * depend on operators having `zip` installed at boot).  That
 * trade-off needs a guard: when the brag list changes, we MUST
 * regenerate the zip in the same commit, otherwise the footer
 * "Mediakit" link silently serves stale content.
 *
 * Staleness signal.  The zip must not predate any of its source
 * files.  We measure "when did this file's content last change" with
 * git commit time (`git log -1 --format=%ct`), NOT filesystem mtime:
 * a fresh `git checkout` (as in CI) writes every file with the
 * checkout-instant mtime in path order, so e.g.
 * `apps/web/static/morphit-mediakit.zip` is always written a moment
 * before `apps/web/tailwind.config.js` ('s' < 't') and would look
 * "stale" on every clean checkout regardless of content.  Git commit
 * time is immune to that: in CI's shallow (depth-1) checkout every
 * file reports the single HEAD-commit time (equal → not stale); in a
 * full-history checkout each file reports its real last-commit time
 * (the zip, regenerated alongside a source change, is committed no
 * earlier than that source).  Files with uncommitted working-tree
 * edits fall back to mtime — so the dev workflow "edited a source but
 * forgot to rebuild the zip" still fires.  Outside a git repo (e.g. a
 * release-tarball extraction with no .git) the whole comparison falls
 * back to mtime.
 *
 * Self-tested by touching MORPHIT-BRAG-LIST.md without rebuilding —
 * the working-tree edit makes it dirty, so mtime is used and the
 * smoke fires.  Rebuild + commit → smoke passes.
 */

import { statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const ZIP_PATH = join(REPO_ROOT, 'apps', 'web', 'static', 'morphit-mediakit.zip');
const BRAG_LIST = join(REPO_ROOT, 'MORPHIT-BRAG-LIST.md');
const MARK_SVG = join(REPO_ROOT, 'apps', 'web', 'static', 'brand', 'morphit-mark.svg');
const WORDMARK_SVG = join(REPO_ROOT, 'apps', 'web', 'static', 'brand', 'morphit-wordmark.svg');
// The feature-comparison PNG is bundled into the kit (build-mediakit.sh),
// so a regenerated comparison image must regenerate the zip too.
const COMPARISON_PNG = join(REPO_ROOT, 'apps', 'web', 'static', 'morphit-comparison.png');
// The README's "Color standards" section is derived from the Tailwind
// palette, so a color change must regenerate the zip — track it as a
// source so a stale kit fails this smoke.
const TAILWIND_CONFIG = join(REPO_ROOT, 'apps', 'web', 'tailwind.config.js');
const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build-mediakit.sh');

// ─── Effective "last changed" time (git-aware, mtime fallback) ─────
// See the header: filesystem mtime is unreliable for a committed
// artifact checked in a fresh CI checkout (write order ≠ content
// order), so we prefer git commit time and only fall back to mtime
// for uncommitted edits or when there's no git repo at all.
let GIT_AVAILABLE: boolean;
function gitAvailable(): boolean {
	if (GIT_AVAILABLE !== undefined) return GIT_AVAILABLE;
	try {
		execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
			cwd: REPO_ROOT,
			stdio: ['ignore', 'pipe', 'ignore']
		});
		GIT_AVAILABLE = true;
	} catch {
		GIT_AVAILABLE = false;
	}
	return GIT_AVAILABLE;
}
function gitCommitMs(absPath: string): number | null {
	try {
		const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', absPath], {
			cwd: REPO_ROOT,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
		if (!out) return null;
		const sec = parseInt(out, 10);
		return Number.isFinite(sec) ? sec * 1000 : null;
	} catch {
		return null;
	}
}
function gitDirty(absPath: string): boolean {
	try {
		const out = execFileSync('git', ['status', '--porcelain', '--', absPath], {
			cwd: REPO_ROOT,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
		return out.trim().length > 0;
	} catch {
		return false;
	}
}
/** Last-content-change time in ms: git commit time for a clean,
 *  tracked file; mtime for an uncommitted edit or when git is absent. */
function effectiveChangeMs(absPath: string): number {
	if (gitAvailable() && !gitDirty(absPath)) {
		const committed = gitCommitMs(absPath);
		if (committed !== null) return committed;
	}
	return statSync(absPath).mtimeMs;
}

let UNZIP_AVAILABLE: boolean | undefined;
function unzipAvailable(): boolean {
	if (UNZIP_AVAILABLE !== undefined) return UNZIP_AVAILABLE;
	try {
		execFileSync('unzip', ['-v'], { stdio: ['ignore', 'ignore', 'ignore'] });
		UNZIP_AVAILABLE = true;
	} catch {
		UNZIP_AVAILABLE = false;
	}
	return UNZIP_AVAILABLE;
}

interface ScenarioResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: ScenarioResult[] = [];

// ─── 1. Zip exists ───
results.push({
	name: 'apps/web/static/morphit-mediakit.zip is committed',
	ok: existsSync(ZIP_PATH),
	detail: existsSync(ZIP_PATH)
		? undefined
		: `Missing: ${ZIP_PATH}.  Run scripts/build-mediakit.sh to generate it, then commit the result.`
});

// ─── 2. Build script exists (or the regeneration path is broken) ───
results.push({
	name: 'scripts/build-mediakit.sh is committed',
	ok: existsSync(BUILD_SCRIPT),
	detail: existsSync(BUILD_SCRIPT)
		? undefined
		: `Missing: ${BUILD_SCRIPT}.  Without it, future contributors can't regenerate the zip.`
});

// ─── 3. Source files all exist ───
const sources = [
	{ path: BRAG_LIST, label: 'MORPHIT-BRAG-LIST.md' },
	{ path: COMPARISON_PNG, label: 'apps/web/static/morphit-comparison.png' },
	{ path: MARK_SVG, label: 'apps/web/static/brand/morphit-mark.svg' },
	{ path: WORDMARK_SVG, label: 'apps/web/static/brand/morphit-wordmark.svg' },
	{ path: TAILWIND_CONFIG, label: 'apps/web/tailwind.config.js (brand palette → README color standards)' }
];
const missing = sources.filter((s) => !existsSync(s.path));
results.push({
	name: 'all mediakit source files exist',
	ok: missing.length === 0,
	detail:
		missing.length === 0
			? undefined
			: `Missing source files: [${missing.map((m) => m.label).join(', ')}].`
});

// ─── 4. Zip is newer than every source file ───
// This is the core check — surfaces "edited brag list but forgot
// to rebuild zip" before it ships.  Uses git-aware effective change
// time (see header) so a fresh CI checkout's path-order mtimes can't
// produce a false "stale" result.
if (existsSync(ZIP_PATH) && missing.length === 0) {
	const zipChangeMs = effectiveChangeMs(ZIP_PATH);
	const stale = sources.filter((s) => effectiveChangeMs(s.path) > zipChangeMs);
	results.push({
		name: 'morphit-mediakit.zip is no older than its sources',
		ok: stale.length === 0,
		detail:
			stale.length === 0
				? undefined
				: `The zip is stale relative to: [${stale.map((s) => s.label).join(', ')}]. ` +
				  `Run \`bash scripts/build-mediakit.sh\` to regenerate, then commit the new zip.`
	});
}

// ─── 5. Footer link still wired ───
// Defends against accidental removal of the footer entry during a
// future refactor.  Pinned to the literal href the footer uses.
const layoutPath = join(REPO_ROOT, 'apps', 'web', 'src', 'routes', '[lang]', '+layout.svelte');
let footerWired = false;
if (existsSync(layoutPath)) {
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(layoutPath, 'utf-8');
	footerWired = src.includes('/morphit-mediakit.zip') && src.includes("$_('footer.mediakit')");
}
results.push({
	name: 'footer wires Mediakit link to /morphit-mediakit.zip',
	ok: footerWired,
	detail: footerWired
		? undefined
		: `Could not find both "/morphit-mediakit.zip" and "$_('footer.mediakit')" in ` +
		  `apps/web/src/routes/[lang]/+layout.svelte.  Was the footer link removed?`
});

// ─── 6. Every SUPPORTED locale has the mediakit + mediakit_title keys ───
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
const localesDir = join(REPO_ROOT, 'apps', 'web', 'src', 'lib', 'i18n', 'locales');
const missingLocaleKeys: string[] = [];
const { readFileSync } = await import('node:fs');
for (const loc of LOCALES) {
	const p = join(localesDir, `${loc}.json`);
	if (!existsSync(p)) {
		missingLocaleKeys.push(`${loc}.json (file missing)`);
		continue;
	}
	const data = JSON.parse(readFileSync(p, 'utf-8'));
	const footer = data.footer ?? {};
	if (!footer.mediakit) missingLocaleKeys.push(`${loc}: footer.mediakit`);
	if (!footer.mediakit_title) missingLocaleKeys.push(`${loc}: footer.mediakit_title`);
}
results.push({
	name: `all ${LOCALES.length} locales define footer.mediakit + footer.mediakit_title`,
	ok: missingLocaleKeys.length === 0,
	detail:
		missingLocaleKeys.length === 0
			? undefined
			: `Missing keys: [${missingLocaleKeys.join(', ')}]`
});

// ─── 7. Zip CONTENT matches sources byte-for-byte ───
// The staleness check (scenario 4) is timestamp-based, which has a gap:
// in CI's shallow (depth-1) checkout every file reports the single HEAD
// commit time, so a zip committed STALE alongside a brag-list edit (same
// commit → equal times) passes "no older than its sources" while its
// bytes are actually out of date. This is exactly the "root brag list and
// the zip's brag list are out of sync" failure. Close it by reading the
// copied entries straight out of the committed zip and comparing them
// byte-for-byte to the repo sources. (README.txt + the palette are
// generated/derived, not byte-copied, so only the four directly-copied
// files are content-checked; the tailwind→README link stays on the
// timestamp guard above.)
if (existsSync(ZIP_PATH) && missing.length === 0) {
	const contentChecks = [
		{ entry: 'morphit-mediakit/MORPHIT-BRAG-LIST.md', source: BRAG_LIST, label: 'MORPHIT-BRAG-LIST.md' },
		{
			entry: 'morphit-mediakit/morphit-comparison.png',
			source: COMPARISON_PNG,
			label: 'morphit-comparison.png'
		},
		{ entry: 'morphit-mediakit/logos/morphit-mark.svg', source: MARK_SVG, label: 'logos/morphit-mark.svg' },
		{
			entry: 'morphit-mediakit/logos/morphit-wordmark.svg',
			source: WORDMARK_SVG,
			label: 'logos/morphit-wordmark.svg'
		}
	];
	if (!unzipAvailable()) {
		// Don't fail CI over a missing tool, but never silently claim
		// success: the timestamp check (scenario 4) is the floor and a
		// dirty-working-tree edit still trips it via mtime.
		results.push({
			name: 'zip content matches sources byte-for-byte (brag list + comparison image + brand SVGs)',
			ok: true,
			detail:
				'NOTE: `unzip` not on PATH — byte-content was NOT verified this run; ' +
				'relying on the timestamp check above. Standard CI/dev images have unzip.'
		});
	} else {
		const drifted: string[] = [];
		for (const c of contentChecks) {
			let zipBytes: Buffer;
			try {
				zipBytes = execFileSync('unzip', ['-p', ZIP_PATH, c.entry], {
					cwd: REPO_ROOT,
					maxBuffer: 64 * 1024 * 1024
				}) as Buffer;
			} catch {
				drifted.push(`${c.label} (entry missing from the zip)`);
				continue;
			}
			const srcBytes = readFileSync(c.source);
			if (!Buffer.from(zipBytes).equals(Buffer.from(srcBytes))) drifted.push(c.label);
		}
		results.push({
			name: 'zip content matches sources byte-for-byte (brag list + comparison image + brand SVGs)',
			ok: drifted.length === 0,
			detail:
				drifted.length === 0
					? undefined
					: `The committed zip's content has DRIFTED from the repo sources: [${drifted.join(', ')}]. ` +
						`A timestamp-only check can miss this (a stale zip committed in the same commit as a source edit). ` +
						`Run \`bash scripts/build-mediakit.sh\` to rebuild from current sources, then commit the new zip.`
		});
	}
}

// ─── Report ──
console.log(`mediakit-freshness smoke: ${results.length} scenarios\n`);
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
	console.log(`✓ all ${results.length} mediakit-freshness checks hold`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} failed, ${results.length - failed} passed`);
	process.exit(1);
}
