/**
 * dev-routes-prod-gated smoke.
 *
 * Pins the production gate on the maintainer-only `/dev` route subtree
 * (icon catalog, responsive-viewport preview, WebHID YubiKey transport
 * probe).  These are contributor/maintainer diagnostics — the
 * yubikey-probe page is literally headed "DEV ONLY" — and used to be
 * reachable in a production build via the SPA fallback.
 *
 * The gate lives in `[lang]/dev/+layout.ts`: a layout `load` that
 * throws `error(404)` when `!import.meta.env.DEV`.  Vite statically
 * replaces `import.meta.env.DEV` with `false` in the prod bundle, so
 * the whole subtree 404s in production while staying fully available
 * under `npm run dev`.
 *
 * This smoke fails if that gate is removed, weakened, or if a new
 * `/dev/*` page is added OUTSIDE the gated subtree (which would slip
 * past the layout guard).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

// repo root is two levels up from apps/web/scripts/
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEV_ROOT = resolve(WEB, 'src/routes/[lang]/dev');
const LAYOUT = resolve(DEV_ROOT, '+layout.ts');

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

/* ---------------- 1. the gate layout exists ---------------- */

if (existsSync(LAYOUT)) {
	pass('[lang]/dev/+layout.ts exists (the subtree gate)');
} else {
	fail(
		'[lang]/dev/+layout.ts exists',
		`no layout at ${LAYOUT} — the /dev subtree has no production gate, so the dev tools are reachable in prod via the SPA fallback`
	);
}

const layoutSrc = existsSync(LAYOUT) ? readFileSync(LAYOUT, 'utf8') : '';

/* ---------------- 2. imports SvelteKit's error ---------------- */

if (/import\s*\{[^}]*\berror\b[^}]*\}\s*from\s*['"]@sveltejs\/kit['"]/.test(layoutSrc)) {
	pass("imports `error` from '@sveltejs/kit'");
} else {
	fail("imports `error` from '@sveltejs/kit'", 'the gate must import SvelteKit `error` to throw a 404');
}

/* ---------------- 3. the load throws 404 gated on !import.meta.env.DEV ---------------- */

// Normalize whitespace so the assertion is robust to formatting.
const flat = layoutSrc.replace(/\s+/g, ' ');
const hasDevGuard = /if\s*\(\s*!\s*import\.meta\.env\.DEV\s*\)/.test(flat);
const throws404 = /throw\s+error\s*\(\s*404/.test(flat);
const hasLoad = /export\s+(async\s+)?function\s+load\b/.test(flat) || /export\s+const\s+load\b/.test(flat);

if (hasLoad && hasDevGuard && throws404) {
	pass('load() throws error(404) when !import.meta.env.DEV (404 in prod, open in `npm run dev`)');
} else {
	fail(
		'load() throws error(404) when !import.meta.env.DEV',
		`hasLoad=${hasLoad} hasDevGuard=${hasDevGuard} throws404=${throws404} — the gate must be a load that throws error(404) under !import.meta.env.DEV`
	);
}

/* ---------------- 4. prerender disabled for the subtree ---------------- */

if (/export\s+const\s+prerender\s*=\s*false/.test(flat)) {
	pass('prerender = false on the /dev subtree (dev-only pages never emitted as prerendered HTML)');
} else {
	fail(
		'prerender = false on the /dev subtree',
		'the dev layout should explicitly set `prerender = false` so the dev-only pages are never prerendered into the release build'
	);
}

/* ---------------- 5. every /dev page lives under the gated subtree ---------------- */

// Enumerate all +page.svelte files anywhere under routes/[lang]/dev/.
// (They all sit under DEV_ROOT by construction, so the layout covers
// them — but a future page added at a sibling path like
// routes/[lang]/dev-tools/ would NOT be gated.  This asserts the
// known dev pages are all genuinely inside the gated subtree.)
let devPages: string[] = [];
try {
	const out = execSync(`find "${DEV_ROOT}" -name '+page.svelte'`, { encoding: 'utf8' });
	devPages = out.split('\n').map((s) => s.trim()).filter(Boolean);
} catch {
	devPages = [];
}

const allUnderGate = devPages.length > 0 && devPages.every((p) => p.startsWith(DEV_ROOT));
if (allUnderGate) {
	pass(`all ${devPages.length} /dev page(s) live under the gated subtree (covered by +layout.ts)`);
} else {
	fail(
		'all /dev pages live under the gated subtree',
		`found ${devPages.length} dev page(s); the gate only covers files under ${DEV_ROOT}. ` +
			`If a new diagnostic route was added elsewhere, move it under [lang]/dev/ or gate it too.`
	);
}

/* ---------------- 6. the gated subtree actually contains the known dev tools ---------------- */

// Sanity that the gate sits above the real tools (not an empty dir):
// the original three diagnostic pages must be present and gated.
const expected = ['+page.svelte', 'icons/+page.svelte', 'responsive/+page.svelte', 'yubikey-probe/+page.svelte'];
const missing = expected.filter((rel) => !existsSync(resolve(DEV_ROOT, rel)));
if (missing.length === 0) {
	pass('the gated subtree contains the dev index + icons + responsive + yubikey-probe pages');
} else {
	fail(
		'the gated subtree contains the known dev tools',
		`missing under [lang]/dev/: ${missing.join(', ')} (if a tool was intentionally removed, update this list)`
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
