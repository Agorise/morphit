#!/usr/bin/env tsx
/*
 * indexer-url-composition — cp202 guard (routing-topology fix).
 *
 * The frontend reaches the indexer at `<origin>/v1/...` (REST + SSE)
 * and `<origin>/rss/...` (feeds). The ONLY correct way to build those
 * URLs is:
 *
 *     new URL('/v1/...', resolveOrigin(MORPHIT_INDEXER_ORIGIN))
 *
 * A root-absolute first arg makes `new URL()` discard whatever path the
 * configured origin carries, so the request always lands on
 * `<origin>/v1/...` regardless of the constant's value — correct for
 * both the colocated single-host topology (same origin) and a split
 * deployment (absolute override).
 *
 * STRING-CONCATENATING the origin with a path is the bug this guards
 * against. `${MORPHIT_INDEXER_ORIGIN}/v1/...` or
 * `${resolveOrigin(MORPHIT_INDEXER_ORIGIN)}/v1/...` (or via a local var)
 * RETAIN the origin's path, so the historic `'/api/indexer'` default
 * produced `/api/indexer/v1/...` — a path the colocated nginx never
 * proxies, silently breaking live SSE (orderbook/chat/instances), the
 * order viewcount endpoints, and the RSS feeds on every single-host
 * deploy. (The REST client always used new URL, which is why it slipped
 * past: only the concat builders were wrong.)
 *
 * NOTE: the RELAY is different — it is intentionally reached at
 * `<origin>/relay/v1/...` via `${resolveOrigin(MORPHIT_RELAY_ORIGIN)}/v1/...`
 * (the `/relay` prefix is real and nginx strips it). So this sentinel
 * only forbids concatenation onto the INDEXER origin, never the relay's.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..'); // apps/web
const srcRoot = join(webRoot, 'src');
const configPath = join(srcRoot, 'lib', 'net', 'config.ts');

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

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry.startsWith('.')) continue;
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(p);
	}
	return out;
}

const files = walk(srcRoot);
const rel = (f: string) => relative(webRoot, f);

// ── Scenario 1: the constant carries no path ──────────────────────
// '' (same origin) or an absolute URL with no path are fine; a path
// like '/api/indexer' or even '/v1' is the trap (it'd be retained by
// any future concat builder and misleads operators + nginx config).
try {
	const cfg = readFileSync(configPath, 'utf8');
	const m = cfg.match(/export const MORPHIT_INDEXER_ORIGIN\s*=\s*'([^']*)'/);
	if (!m) {
		bad('config.ts', 'could not find the MORPHIT_INDEXER_ORIGIN declaration');
	} else {
		const val = m[1];
		if (val.startsWith('/')) {
			bad(
				'config.ts',
				`MORPHIT_INDEXER_ORIGIN = '${val}' carries a path — must be '' (same origin) or a bare absolute URL; a path prefix breaks /v1 + /rss routing`
			);
		} else {
			ok(`MORPHIT_INDEXER_ORIGIN = '${val}' carries no path prefix`);
		}
	}
} catch (e) {
	bad('config.ts', `unreadable: ${(e as Error).message}`);
}

// ── Scenarios 2-4: no concatenation of the indexer origin + a path ─
const rawConcat: { file: string; text: string }[] = [];
const inlineResolveConcat: { file: string; text: string }[] = [];
const varConcat: { file: string; text: string }[] = [];

// `${MORPHIT_INDEXER_ORIGIN}/...`  (raw const, Style 3)
const RAW = /\$\{\s*MORPHIT_INDEXER_ORIGIN\s*\}\//;
// `${resolveOrigin(MORPHIT_INDEXER_ORIGIN)}/...`  (inline, Style 2 one-liner)
const INLINE = /\$\{\s*resolveOrigin\(\s*MORPHIT_INDEXER_ORIGIN\s*\)\s*\}\//;
// const X = resolveOrigin(MORPHIT_INDEXER_ORIGIN)  → then `${X}/...`  (Style 2 via var)
const ASSIGN = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*resolveOrigin\(\s*MORPHIT_INDEXER_ORIGIN\s*\)/g;

for (const f of files) {
	const src = readFileSync(f, 'utf8');

	if (RAW.test(src)) {
		const line = src.split('\n').find((l) => RAW.test(l)) ?? '';
		rawConcat.push({ file: rel(f), text: line.trim() });
	}
	if (INLINE.test(src)) {
		const line = src.split('\n').find((l) => INLINE.test(l)) ?? '';
		inlineResolveConcat.push({ file: rel(f), text: line.trim() });
	}

	// Collect local vars that hold the resolved indexer origin, then
	// forbid `${thatVar}/` (concatenation) anywhere in the same file.
	const names = new Set<string>();
	for (const mm of src.matchAll(ASSIGN)) names.add(mm[1]);
	for (const name of names) {
		const concat = new RegExp('\\$\\{\\s*' + name + '\\s*\\}\\/');
		if (concat.test(src)) {
			const line = src.split('\n').find((l) => concat.test(l)) ?? '';
			varConcat.push({ file: rel(f), text: line.trim() });
		}
	}
}

if (rawConcat.length === 0) ok('no `${MORPHIT_INDEXER_ORIGIN}/…` raw-const concatenation');
else for (const o of rawConcat) bad(o.file, `raw indexer-origin concat — use new URL(): ${o.text}`);

if (inlineResolveConcat.length === 0)
	ok('no `${resolveOrigin(MORPHIT_INDEXER_ORIGIN)}/…` inline concatenation');
else for (const o of inlineResolveConcat) bad(o.file, `inline resolveOrigin concat — use new URL(): ${o.text}`);

if (varConcat.length === 0) ok('no resolved-indexer-origin variable is string-concatenated with a path');
else for (const o of varConcat) bad(o.file, `resolveOrigin var concat — use new URL(): ${o.text}`);

// ── Scenarios 5-8: the SSE/view builders use new URL + resolveOrigin ─
// These four files build indexer URLs that previously concatenated.
// Anchor them so a regression can't quietly revert to string concat
// (which would also trip the checks above once the prefix returns).
const builders = [
	join(srcRoot, 'lib', 'orders', 'views.ts'),
	join(srcRoot, 'lib', 'chat', 'stream.ts'),
	join(srcRoot, 'lib', 'orderbook', 'stream.ts'),
	join(srcRoot, 'routes', '[lang]', 'instances', '+page.svelte')
];
for (const b of builders) {
	let src = '';
	try {
		src = readFileSync(b, 'utf8');
	} catch {
		bad(rel(b), 'builder file missing — sentinel target gone');
		continue;
	}
	const usesNewUrl = /new URL\(/.test(src);
	const usesResolve = /resolveOrigin\(\s*MORPHIT_INDEXER_ORIGIN\s*\)/.test(src);
	const hasV1 = /\/v1\//.test(src);
	if (usesNewUrl && usesResolve && hasV1)
		ok(`${rel(b)} builds indexer URLs via new URL(+resolveOrigin)`);
	else
		bad(
			rel(b),
			`indexer URL builder must use new URL('/v1/…', resolveOrigin(MORPHIT_INDEXER_ORIGIN)) [newURL=${usesNewUrl} resolve=${usesResolve} v1=${hasV1}]`
		);
}

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
