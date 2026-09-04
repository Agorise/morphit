#!/usr/bin/env tsx
/**
 * frontend-local-only-smoke.ts (v1.15.x stage 3)
 *
 * A hidden-only instance's page must AUTO-LOAD nothing from the clearnet — no
 * CDN fonts, no external scripts/styles, no analytics, no remote images/preconnect.
 * (User-*clicked* `<a href>` links are fine — that's the user's own browser
 * choice, and over Tor Browser it rides Tor anyway.) adapter-static bundles JS/CSS
 * locally and assets are self-hosted, so this should hold; the smoke fails loudly
 * if a future edit introduces an auto-loaded external origin — one of the legs the
 * `clearnet_eliminated` gate depends on.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(WEB, 'src');
const STATIC = join(WEB, 'static');

let pass = 0;
const fails: string[] = [];
const ok = (m: string, cond: boolean): void => {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${m}`);
	} else {
		fails.push(m);
		console.log(`  \u2717 ${m}`);
	}
};

function walk(dir: string, exts: Set<string>): string[] {
	let out: string[] = [];
	let entries: string[] = [];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) out = out.concat(walk(p, exts));
		else if (exts.has(extname(p))) out.push(p);
	}
	return out;
}

// AUTO-LOAD patterns only: things the browser fetches without a click.
// Deliberately NOT matching `<a ... href=...>` (user nav) or JS/TS string
// literals (config values, deep-links).
const AUTOLOAD_PATTERNS: Array<{ label: string; re: RegExp }> = [
	{ label: '<link href="http…">', re: /<link\b[^>]*\bhref\s*=\s*["']https?:\/\/[a-z0-9.-]+/gi },
	{ label: '<script src="http…">', re: /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/[a-z0-9.-]+/gi },
	{ label: '<img src="http…">', re: /<img\b[^>]*\bsrc\s*=\s*["']https?:\/\/[a-z0-9.-]+/gi },
	{ label: 'preconnect/dns-prefetch http', re: /rel\s*=\s*["'](?:preconnect|dns-prefetch|preload)["'][^>]*https?:\/\//gi },
	{ label: 'CSS @import http', re: /@import\b[^;]*https?:\/\//gi },
	{ label: 'CSS url(http…)', re: /url\(\s*["']?https?:\/\/[a-z0-9.-]+/gi }
];

const files = [
	...walk(SRC, new Set(['.svelte', '.html', '.css', '.pcss', '.scss'])),
	...walk(STATIC, new Set(['.html', '.css', '.webmanifest', '.json']))
];
ok(`scanned frontend files (${files.length})`, files.length > 0);

const offenders: string[] = [];
for (const f of files) {
	const text = readFileSync(f, 'utf8');
	for (const { label, re } of AUTOLOAD_PATTERNS) {
		const m = text.match(re);
		if (m) {
			for (const hit of m) offenders.push(`${label} in ${f.replace(WEB, 'apps/web')}: ${hit.slice(0, 80)}`);
		}
	}
}

ok('no auto-loaded external clearnet resource in the frontend', offenders.length === 0);
if (offenders.length > 0) {
	console.log('    offenders:');
	for (const o of offenders.slice(0, 20)) console.log(`      - ${o}`);
}

// Sanity: the app shell exists and references only sveltekit-local assets.
{
	const shell = readFileSync(join(SRC, 'app.html'), 'utf8');
	const externalInShell = /(?:href|src)\s*=\s*["']https?:\/\//i.test(shell);
	ok('app.html shell auto-loads only local (%sveltekit.assets%) resources', !externalInShell);
}

console.log('');
if (fails.length > 0) {
	console.log(`\u2717 ${fails.length} of ${pass + fails.length} frontend-local-only checks FAILED`);
	for (const f of fails) console.log(`    - ${f}`);
	process.exit(1);
}
console.log(`\u2713 all ${pass} frontend-local-only scenarios passed`);
