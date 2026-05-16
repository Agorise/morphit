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
 * This smoke compares mtimes within the working tree.  When the
 * source list or logos are edited but `scripts/build-mediakit.sh`
 * hasn't been re-run, the zip's mtime is older and the smoke
 * fails with a clear "run scripts/build-mediakit.sh" message.
 *
 * Self-tested by touching MORPHIT-BRAG-LIST.md without rebuilding —
 * smoke fires.  Rebuild → smoke passes.
 */

import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const ZIP_PATH = join(REPO_ROOT, 'apps', 'web', 'static', 'morphit-mediakit.zip');
const BRAG_LIST = join(REPO_ROOT, 'MORPHIT-BRAG-LIST.md');
const MARK_SVG = join(REPO_ROOT, 'apps', 'web', 'static', 'brand', 'morphit-mark.svg');
const WORDMARK_SVG = join(REPO_ROOT, 'apps', 'web', 'static', 'brand', 'morphit-wordmark.svg');
const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build-mediakit.sh');

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
	{ path: MARK_SVG, label: 'apps/web/static/brand/morphit-mark.svg' },
	{ path: WORDMARK_SVG, label: 'apps/web/static/brand/morphit-wordmark.svg' }
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
// to rebuild zip" before it ships.
if (existsSync(ZIP_PATH) && missing.length === 0) {
	const zipMtime = statSync(ZIP_PATH).mtimeMs;
	const stale = sources.filter((s) => statSync(s.path).mtimeMs > zipMtime);
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

// ─── 6. All 10 locales have the mediakit + mediakit_title keys ───
const LOCALES = ['en', 'es', 'fr', 'de', 'it', 'pl', 'ru', 'fa', 'zh-CN', 'zh-HK'];
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
	name: 'all 10 locales define footer.mediakit + footer.mediakit_title',
	ok: missingLocaleKeys.length === 0,
	detail:
		missingLocaleKeys.length === 0
			? undefined
			: `Missing keys: [${missingLocaleKeys.join(', ')}]`
});

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
