#!/usr/bin/env tsx
/**
 * Smoke: no bare `href="/"` inside the [lang] route subtree. Anchor cp295.
 *
 * THE BUG THIS GUARDS AGAINST. A logged-in user who clicked the top-left
 * logo got signed out. The logo's link was a bare `href="/"`. The bare `/`
 * route is the root detection-redirect SHELL, which redirects via
 * `window.location.replace(...)` — a FULL PAGE RELOAD. A "Remember me"
 * keystore is encrypted-at-rest, so a hard reload drops the in-memory
 * session and lands the user locked (perceived as a logout). Locale-prefixed
 * links (e.g. `/en/orderbook`) stay inside [lang] and navigate client-side,
 * preserving the session — which is exactly why fast-clicking the nav links
 * kept the user logged in but the logo did not.
 *
 * RULE: every internal link rendered inside `apps/web/src/routes/[lang]/`
 * must be locale-prefixed (`lp('/...')` / `localePath('/...')`), never a bare
 * `href="/"` or `href={'/'}`. This smoke fails on any bare-root href so the
 * regression cannot return.
 *
 * Allowed and NOT flagged: `href="#..."` (in-page anchors), `href={lp('/')}`
 * (the correct locale-home form), external `https://` links, and `href="/"`
 * appearing only inside a comment.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Add `<a href="/">` to any [lang] page → fails.
 *   - Add `href={'/'}` → fails.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const LANG_ROOT = join(REPO_ROOT, 'apps/web/src/routes/[lang]');

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (name.endsWith('.svelte')) out.push(full);
	}
	return out;
}

/** Strip HTML comments so a `href="/"` mentioned in a comment doesn't trip us. */
function stripComments(src: string): string {
	return src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// Bare-root href in either attribute form. Matches href="/" and href={'/'} /
// href={`/`} / href={"/"}, but NOT href="/en" or href={lp('/')}.
const BARE_ROOT = /href\s*=\s*(?:"\/"|'\/'|\{\s*["'`]\/["'`]\s*\})/;

let scanned = 0;
let failures = 0;
const offenders: string[] = [];

for (const file of walk(LANG_ROOT)) {
	scanned++;
	const src = stripComments(readFileSync(file, 'utf-8'));
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (BARE_ROOT.test(lines[i])) {
			offenders.push(`${relative(REPO_ROOT, file)}:${i + 1}  ${lines[i].trim()}`);
			failures++;
		}
	}
}

if (offenders.length > 0) {
	console.error('  ✗ bare href="/" found inside the [lang] subtree:');
	for (const o of offenders) console.error(`      ${o}`);
	console.error('    Use lp(\'/\') / localePath(\'/\', lang) so the link stays a client-side nav');
	console.error('    and does not full-reload through the root redirect shell (which drops the session).');
} else {
	console.log(`  ✓ no bare href="/" in any of ${scanned} [lang] .svelte files`);
}

console.log(`\n${scanned - failures} ok, ${failures} offending lines`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${scanned} scenarios passed`);
