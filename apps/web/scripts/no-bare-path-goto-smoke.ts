#!/usr/bin/env tsx
/*
 * no-bare-path-goto — cp200 guard.
 *
 * Every Morphit route lives under `[lang]`, so an imperative navigation
 * MUST carry a locale prefix. A bare `goto('/orderbook')` resolves
 * `[lang]` = 'orderbook' and 404s with "Unknown locale" — the exact bug
 * a sysadmin hit on /post's "Create an account" link, and which a sweep
 * (cp200) found in ~30 call sites across the frontend. The fix is the
 * shared `gotoLocale()` helper (`$i18n/navigate`), which prefixes the
 * current locale via `localePath`, mirroring how the `lp()`-wrapped
 * `<a href>` links work.
 *
 * This sentinel forbids any LITERAL bare-path goto() in the frontend so
 * that regression can't creep back. It flags `goto('/…')` / `goto(`/…`)`
 * (a quote or backtick immediately followed by '/'). It does NOT flag:
 *   - gotoLocale(…)            — the helper (goto isn't followed by '(')
 *   - goto(someVariable)       — dynamic; the locale can't be proven
 *                                statically (e.g. preserving a captured
 *                                destination URL that's already prefixed)
 *   - goto(localePath(…))      — the helper's own internal call
 * Comment lines are skipped so prose mentioning `goto('/x')` is ignored.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..'); // apps/web
const srcRoot = join(webRoot, 'src');

let pass = 0;
let fail = 0;
function ok(msg: string): void {
	pass++;
	console.log(`  ✓ ${msg}`);
}
function bad(label: string, msg: string): void {
	fail++;
	console.log(`  ✗ ${label}: ${msg}`);
}

// Files allowed to call goto() with a path literal: the helper itself.
// (Its call is goto(localePath(...)), which doesn't match the pattern
// below anyway — listed for clarity.)
const ALLOW = new Set([join(srcRoot, 'lib', 'i18n', 'navigate.ts')]);

// goto( + optional whitespace + a quote/backtick immediately followed by
// '/'. `gotoLocale(` is NOT matched (goto must be immediately followed
// by '('); neither is goto(variable) nor goto(localePath(...)).
const BARE_GOTO = /\bgoto\(\s*['"`]\//;

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry.startsWith('.')) continue;
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (/\.(svelte|ts)$/.test(entry)) out.push(p);
	}
	return out;
}

const files = walk(srcRoot);
ok(`scanned ${files.length} .svelte/.ts file(s) under apps/web/src`);

const offenders: { file: string; line: number; text: string }[] = [];
for (const f of files) {
	if (ALLOW.has(f)) continue;
	const lines = readFileSync(f, 'utf8').split('\n');
	let inBlockComment = false;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]!.trim();
		if (inBlockComment) {
			if (trimmed.includes('*/')) inBlockComment = false;
			continue;
		}
		if (trimmed.startsWith('/*')) {
			if (!trimmed.includes('*/')) inBlockComment = true;
			continue;
		}
		if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
		if (BARE_GOTO.test(lines[i]!)) {
			offenders.push({ file: relative(webRoot, f), line: i + 1, text: trimmed });
		}
	}
}

if (offenders.length === 0) {
	ok('no bare-path goto() — every imperative navigation uses gotoLocale()');
} else {
	for (const o of offenders) {
		bad(`${o.file}:${o.line}`, `bare-path goto() — use gotoLocale(): ${o.text}`);
	}
}

// Sanity: the helper exists and is actually used somewhere.
const navPath = join(srcRoot, 'lib', 'i18n', 'navigate.ts');
let helperPresent = false;
try {
	helperPresent = /export function gotoLocale\(/.test(readFileSync(navPath, 'utf8'));
} catch {
	helperPresent = false;
}
if (helperPresent) ok('gotoLocale helper exists in $i18n/navigate');
else bad('$i18n/navigate', 'gotoLocale helper missing — sentinel target gone');

const usedSomewhere = files.some(
	(f) => !ALLOW.has(f) && /\bgotoLocale\(/.test(readFileSync(f, 'utf8'))
);
if (usedSomewhere) ok('gotoLocale is in use across the frontend');
else bad('gotoLocale', 'helper never used — dead code? (expected in use after the cp200 sweep)');

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
