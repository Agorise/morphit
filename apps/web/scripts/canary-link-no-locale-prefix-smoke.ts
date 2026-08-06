#!/usr/bin/env tsx
/**
 * Smoke: the Canary footer link (and every root static file) must NEVER get a
 * locale prefix. Anchor 2026-07-08.
 *
 * THE BUG THIS GUARDS AGAINST (regressed twice). Clicking the footer "Canary"
 * link redirected to `/en/canary.txt` → 404. Two independent halves both have
 * to hold, so this smoke pins both:
 *
 *   1. FOOTER LINK. The `/canary.txt` link must be a RAW root href with
 *      `data-sveltekit-reload` (full navigation → nginx serves the static
 *      file). If it's ever wrapped in the locale-path helper (`lp(...)` /
 *      `localePath(...)`) it becomes `/en/canary.txt`, which is not a real
 *      route.
 *
 *   2. DETECTION-REDIRECT SHELL. `[lang]/+layout.ts` redirects bare paths
 *      (e.g. `/faq` → `/en/faq`) via the SPA fallback. A root static file
 *      that reaches that fallback (because it's transiently absent — every
 *      `morphit-ops upgrade` wipes the freshly-signed `build/canary.txt` until
 *      it's re-uploaded) was getting the SAME treatment: `/canary.txt` →
 *      `/en/canary.txt` → 404. The shell MUST short-circuit file-extension
 *      paths to a clean 404 at the real path BEFORE the locale redirect, so
 *      the link works the instant the file is restored.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Wrap the canary href in lp()/localePath → fails.
 *   - Drop `data-sveltekit-reload` from the canary link → fails.
 *   - Remove the file-extension → error(404) guard from the shell → fails.
 *   - Move the extension guard AFTER the redirect → fails (order matters).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

const layoutSvelte = readFileSync(
	join(WEB_ROOT, 'src', 'routes', '[lang]', '+layout.svelte'),
	'utf8'
);
const layoutTs = readFileSync(join(WEB_ROOT, 'src', 'routes', '[lang]', '+layout.ts'), 'utf8');

// ── 1. Footer link ──────────────────────────────────────────────────────────
// The exact canary anchor: raw /canary.txt href + data-sveltekit-reload.
const canaryAnchor = /<a\b[^>]*href=["']\/canary\.txt["'][^>]*>/s.exec(
	// normalize whitespace so attribute-per-line markup still matches
	layoutSvelte.replace(/\s+/g, ' ')
);
check('footer has a raw href="/canary.txt" anchor (not lp()/localePath)', canaryAnchor !== null);
check(
	'the canary anchor carries data-sveltekit-reload (full nav → nginx serves the file)',
	canaryAnchor !== null && /data-sveltekit-reload/.test(canaryAnchor[0])
);
check(
	'the canary href is NEVER locale-wrapped (no lp("/canary.txt") / localePath("/canary.txt"))',
	!/(?:lp|localePath)\(\s*["']\/canary\.txt["']/.test(layoutSvelte)
);

// ── 2. Detection-redirect shell ─────────────────────────────────────────────
const extGuard = /\/\\\.\[a-z0-9\]\+\$\/i\.test\(lastSegment\)[\s\S]{0,80}?throw error\(404/;
check('shell short-circuits file-extension paths to error(404)', extGuard.test(layoutTs));
check("shell imports `error` from '@sveltejs/kit'", /import\s*\{[^}]*\berror\b[^}]*\}\s*from\s*['"]@sveltejs\/kit['"]/.test(layoutTs));

// The extension → 404 guard MUST come BEFORE the locale redirect, else the
// static path is redirected first and the guard never runs.
const guardIdx = layoutTs.search(/throw error\(404/);
const redirectIdx = layoutTs.search(/throw redirect\(307/);
check(
	'the file-extension 404 guard precedes the locale redirect (order matters)',
	guardIdx !== -1 && redirectIdx !== -1 && guardIdx < redirectIdx
);

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} canary-link-no-locale-prefix scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} canary-link-no-locale-prefix checks FAILED`);
	process.exit(1);
}
