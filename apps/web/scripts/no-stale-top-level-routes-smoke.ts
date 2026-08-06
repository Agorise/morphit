#!/usr/bin/env tsx
/**
 * Smoke for the post-cp7 routes/ structural invariant (Part 121
 * cp21, 2026-05-15).
 *
 * Background: cp7 (per-locale prerendering, ADR design doc
 * `docs/PER-LOCALE-PRERENDERING-DESIGN.md`) MOVED every page-
 * level route from `apps/web/src/routes/<route>/` to
 * `apps/web/src/routes/[lang]/<route>/`.  The cleanup left only
 * three files at the top-level routes directory — the locale-
 * detection redirect shell — plus the `[lang]/` subtree itself.
 *
 * The bug: delta-tarballs from cp11 onwards (changed/added
 * files only) couldn't communicate the cp7 deletions, so any
 * recipient who applied the cp8+ deltas on top of a pre-cp7
 * working tree accumulated BOTH the old top-level routes AND
 * the new `[lang]/` routes.  Discovered Part 121 cp21
 * (2026-05-15) when a fresh tarball was pulled apart for
 * audit and 23 leaf routes + the dynamic account route were
 * found duplicated.
 *
 * What this smoke locks down: `apps/web/src/routes/` must
 * contain EXACTLY the locale-detection redirect shell plus the
 * `[lang]/` directory.  Any other top-level directory means
 * either (a) the cp7 cleanup never landed, (b) it was
 * partially reverted, or (c) a future restructure introduced
 * fresh top-level routes that have not been mirrored into
 * `[lang]/` — all three are bugs.
 *
 * Why a smoke and not a one-shot fix: SvelteKit doesn't
 * complain when both `apps/web/src/routes/orderbook/` and
 * `apps/web/src/routes/[lang]/orderbook/` exist — both
 * prerender, both ship as static HTML, and the redirect shell
 * still sends fresh visitors into the localized copy.  The
 * stale top-level copy goes unnoticed in build output but
 * silently drifts as the localized copy gets edits.  A smoke
 * is the only failure mode that catches this before tarball.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROUTES_DIR = join(__dirname, '..', 'src', 'routes');
const LANG_DIR = join(ROUTES_DIR, '[lang]');

// The locale-detection redirect shell — these three top-level
// route entries are legitimate and must stay.  Anything else at
// top level is stale debris from before cp7's restructure
// landed (or a future restructure missed the [lang]/ mirror).
const ALLOWED_TOP_LEVEL_FILES: ReadonlySet<string> = new Set([
	'+layout.svelte',
	'+layout.ts',
	'+page.svelte'
]);

const ALLOWED_TOP_LEVEL_DIRS: ReadonlySet<string> = new Set([
	'[lang]',
	// `pair/` is the QR-pairing landing shell — deliberately
	// language-agnostic (a scanned QR code carries no locale), so it
	// lives OUTSIDE [lang]/ alongside the root locale-detection shell.
	// prerender=true + ssr=false + trailingSlash='never'; it bounces
	// client-side off window.location.search. There is no [lang]/pair
	// counterpart, so this is not a stale top-level duplicate.
	'pair'
]);

interface Scenario {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}

function listTopLevel(): { files: string[]; dirs: string[] } {
	const files: string[] = [];
	const dirs: string[] = [];
	const entries = readdirSync(ROUTES_DIR);
	for (const entry of entries) {
		const full = join(ROUTES_DIR, entry);
		const st = statSync(full);
		if (st.isDirectory()) dirs.push(entry);
		else if (st.isFile()) files.push(entry);
	}
	return { files: files.sort(), dirs: dirs.sort() };
}

function readShellContent(): { layout: string; page: string } {
	return {
		layout: readFileSync(join(ROUTES_DIR, '+layout.svelte'), 'utf8'),
		page: readFileSync(join(ROUTES_DIR, '+page.svelte'), 'utf8')
	};
}

console.log('');
console.log('── no-stale-top-level-routes smoke ─────────────────────');
console.log('');

const { files, dirs } = listTopLevel();
const unexpectedFiles = files.filter((f) => !ALLOWED_TOP_LEVEL_FILES.has(f));
const unexpectedDirs = dirs.filter((d) => !ALLOWED_TOP_LEVEL_DIRS.has(d));
const missingFiles = [...ALLOWED_TOP_LEVEL_FILES].filter((f) => !files.includes(f));
const langExists = (() => {
	try {
		return statSync(LANG_DIR).isDirectory();
	} catch {
		return false;
	}
})();
const langChildCount = langExists ? readdirSync(LANG_DIR).length : 0;

let shell: { layout: string; page: string } | null = null;
try {
	shell = readShellContent();
} catch {
	shell = null;
}

const scenarios: Scenario[] = [
	{
		name: 'apps/web/src/routes/ has NO unexpected top-level directories (only [lang]/ allowed)',
		ok: unexpectedDirs.length === 0,
		detail:
			unexpectedDirs.length > 0
				? `unexpected: ${unexpectedDirs.slice(0, 30).join(', ')}${unexpectedDirs.length > 30 ? `, ... ${unexpectedDirs.length - 30} more` : ''}`
				: undefined
	},
	{
		name: 'apps/web/src/routes/ has NO unexpected top-level files (only the redirect shell allowed)',
		ok: unexpectedFiles.length === 0,
		detail: unexpectedFiles.length > 0 ? `unexpected: ${unexpectedFiles.join(', ')}` : undefined
	},
	{
		name: 'apps/web/src/routes/+layout.svelte exists (redirect-shell wrapper)',
		ok: files.includes('+layout.svelte') && !missingFiles.includes('+layout.svelte')
	},
	{
		name: 'apps/web/src/routes/+layout.ts exists (redirect-shell prerender config)',
		ok: files.includes('+layout.ts') && !missingFiles.includes('+layout.ts')
	},
	{
		name: 'apps/web/src/routes/+page.svelte exists (locale-detection redirect)',
		ok: files.includes('+page.svelte') && !missingFiles.includes('+page.svelte')
	},
	{
		name: 'apps/web/src/routes/[lang]/ directory exists',
		ok: langExists
	},
	{
		name: 'apps/web/src/routes/[lang]/ contains the expected localized subtree (≥20 entries)',
		ok: langChildCount >= 20,
		detail: `[lang]/ has ${langChildCount} entries`
	},
	{
		name: 'redirect shell +page.svelte references pickLocaleFromAcceptLanguages (cp7 design)',
		ok: shell !== null && shell.page.includes('pickLocaleFromAcceptLanguages')
	},
	{
		name: 'redirect shell +layout.svelte explains the minimal-chrome rationale',
		ok: shell !== null && shell.layout.includes('redirect shell')
	}
];

// Spot-check that the most commonly drifted leaf routes are
// NOT at top level (post-cleanup invariant).  This is partial-
// overlap with the "no unexpected directories" check above, but
// it gives a more readable failure when this specific
// regression recurs.
const COMMONLY_DRIFTED_LEAVES = [
	'orderbook',
	'post',
	'chat',
	'my',
	'settings',
	'support',
	'login',
	'onboarding',
	'about-this-instance',
	'run-a-node'
];

for (const leaf of COMMONLY_DRIFTED_LEAVES) {
	const present = dirs.includes(leaf);
	scenarios.push({
		name: `no stale top-level /${leaf}/ directory (must live under [lang]/${leaf}/ only)`,
		ok: !present,
		detail: present ? `found at apps/web/src/routes/${leaf}/` : undefined
	});
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
for (const s of scenarios) {
	if (s.ok) {
		passed++;
	} else {
		failed++;
		failures.push(`  ✗ ${s.name}${s.detail ? `\n      ${s.detail}` : ''}`);
	}
}

if (failures.length > 0) {
	console.log(failures.join('\n'));
	console.log('');
}

console.log('────────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} scenarios failed`);
	process.exit(1);
}
