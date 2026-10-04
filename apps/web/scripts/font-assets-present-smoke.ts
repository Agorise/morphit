/**
 * font-assets-present-smoke.
 *
 * The repo now SHIPS the Comfortaa woff2 subsets (previously the folder was
 * empty and operators converted the fonts at build time). This guards that
 * promise: every `/fonts/*.woff2` the CSS + preload reference actually exists
 * in `apps/web/static/fonts/` and is a real woff2 — otherwise a deleted or
 * renamed font would silently fall the whole site back to `system-ui` with no
 * test failure. Also asserts the SIL OFL license ships alongside the binaries
 * (the OFL requires the license to travel with redistributed fonts).
 *
 * It does NOT pin sizes or weights (regenerating from a new Comfortaa release is
 * expected) — only existence + woff2 validity + the @font-face/reference
 * count staying in sync.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const WEB = join(REPO_ROOT, 'apps', 'web');
const FONTS_DIR = join(WEB, 'static', 'fonts');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};

/** A real woff2 file begins with the signature bytes 'wOF2'. */
function isWoff2(path: string): boolean {
	if (!existsSync(path)) return false;
	const fd = readFileSync(path);
	return fd.length > 4 && fd.toString('latin1', 0, 4) === 'wOF2';
}

const css = readFileSync(join(WEB, 'src', 'app.css'), 'utf8');

// FONT-1: @font-face count matches the distinct /fonts/*.woff2 references.
const faceCount = (css.match(/@font-face/g) ?? []).length;
const cssRefs = [...css.matchAll(/url\(['"]?\/fonts\/([A-Za-z0-9._-]+\.woff2)/g)].map((m) => m[1]!);
const distinctRefs = [...new Set(cssRefs)];
// v1.20.2 (PageSpeed): the 800 face IS Comfortaa 700 (see fonts/README.md), so
// it points at the 700 file. Two URLs for the same bytes made every visitor
// download that font twice (the browser caches by URL, not by content).
if (faceCount === 4 && distinctRefs.length === 3) {
	ok(`FONT-1 app.css declares 4 @font-face blocks over 3 distinct woff2 (${distinctRefs.join(', ')})`);
} else {
	bad('FONT-1', `@font-face=${faceCount}, distinct woff2 refs=${distinctRefs.length} [${distinctRefs.join(', ')}] (want 4 faces over 3 files)`);
}
{
	const byContent = new Map<string, string>();
	const dupes: string[] = [];
	for (const name of distinctRefs) {
		const p = join(FONTS_DIR, name);
		if (!existsSync(p)) continue;
		const key = readFileSync(p).toString('base64');
		const prev = byContent.get(key);
		if (prev !== undefined) dupes.push(`${prev} = ${name}`);
		else byContent.set(key, name);
	}
	if (dupes.length === 0) {
		ok('FONT-1b no two font URLs in app.css serve the same bytes (no double download)');
	} else {
		bad('FONT-1b', `identical files under two URLs: ${dupes.join('; ')}`);
	}
}

// FONT-2: every woff2 the CSS references exists in static/fonts/ and is a real woff2.
for (const name of distinctRefs) {
	const p = join(FONTS_DIR, name);
	if (isWoff2(p)) {
		ok(`FONT-2 ${name} is present and a valid woff2`);
	} else {
		bad(`FONT-2 ${name}`, existsSync(p) ? 'present but not a woff2 (bad magic bytes)' : `missing at ${p}`);
	}
}

// FONT-3: the SIL OFL license ships alongside the binaries.
const ofl = join(FONTS_DIR, 'OFL.txt');
if (existsSync(ofl) && /SIL Open Font License/i.test(readFileSync(ofl, 'utf8'))) {
	ok('FONT-3 OFL.txt ships in the fonts folder (license travels with the binaries)');
} else {
	bad('FONT-3', existsSync(ofl) ? "OFL.txt present but doesn't look like the SIL OFL" : 'OFL.txt missing');
}

// FONT-4: every font preloaded in app.html resolves to a present woff2.
const html = readFileSync(join(WEB, 'src', 'app.html'), 'utf8');
const preloads = [...html.matchAll(/\/fonts\/([A-Za-z0-9._-]+\.woff2)/g)].map((m) => m[1]!);
const distinctPreloads = [...new Set(preloads)];
const missingPreload = distinctPreloads.filter((n) => !isWoff2(join(FONTS_DIR, n)));
if (distinctPreloads.length > 0 && missingPreload.length === 0) {
	ok(`FONT-4 all ${distinctPreloads.length} app.html font preload(s) resolve to present woff2 (${distinctPreloads.join(', ')})`);
} else if (distinctPreloads.length === 0) {
	bad('FONT-4', 'expected at least one font preload in app.html, found none');
} else {
	bad('FONT-4', `preloaded but missing/invalid: ${missingPreload.join(', ')}`);
}

// v1.20.2 (PageSpeed "network dependency tree"): a font the CSS names but the
// page does not preload is only discovered after the stylesheet arrives — one
// more round trip before the text can show in its real face. Every face the
// app uses (body 400, buttons 600, headings 700/800) is on the first screen.
{
	const notPreloaded = distinctRefs.filter((n) => !distinctPreloads.includes(n));
	const preloadedUnused = distinctPreloads.filter((n) => !distinctRefs.includes(n));
	if (notPreloaded.length === 0 && preloadedUnused.length === 0) {
		ok(`FONT-5 app.html preloads exactly the ${distinctRefs.length} files app.css uses`);
	} else {
		bad(
			'FONT-5',
			`not preloaded: [${notPreloaded.join(', ')}]; preloaded but unused: [${preloadedUnused.join(', ')}]`
		);
	}
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 font-assets-present smoke FAILED');
	process.exit(1);
}
console.log('\u2713 Comfortaa woff2 subsets + OFL ship in apps/web/static/fonts and match app.css/app.html');
console.log(`\u2713 all ${pass} font-assets-present scenarios passed`);
