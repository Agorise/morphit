#!/usr/bin/env tsx
/**
 * scripts/handler-push-click-path-route-smoke.ts
 *
 * Structural Defense #32 — handler push click_path route
 * verifier (cp82-B3 candidate, deferred from cp82, shipped cp84).
 *
 * Verifies that every `click_path` value INSERTed into the
 * `push_pending` table by indexer handlers maps to a real
 * SvelteKit route in `apps/web/src/routes/[lang]/`.
 *
 * Closes the bug class cp82-B1 (chat handler) + cp82-B2
 * (feedback handler) surfaced manually: handlers emitted
 * click_paths pointing at routes that didn't exist, so push-
 * notification taps would land on 404 pages.
 *
 * Detection strategy:
 *
 *   1. Scan handler files (`apps/indexer/src/indexer/handlers/*.ts`)
 *      for `INSERT INTO push_pending` statements and the
 *      surrounding ±25-line window.
 *   2. Extract every string / template literal that begins with
 *      `/` from that window — those are click_path candidates.
 *   3. For each candidate, normalize to a shape pattern:
 *      - `${...}` interpolations  → `*` (one path segment)
 *      - `#anchor` suffix          → stripped (browser-side)
 *      - trailing `/`              → stripped
 *   4. Cross-check the shape against the canonical route registry
 *      at `apps/web/src/lib/seo/routes.ts`.  SvelteKit dynamic
 *      route patterns like `/[x+40][account=account]` normalize
 *      to `/*` for shape comparison.
 *
 * Each (handler, line, click_path-template) tuple counts as one
 * scenario.
 *
 * NB: cp470 — this smoke now DOES verify the i18n locale prefix.
 * Every app route lives under `[lang]`, so a valid click_path must be
 * `/${locale}/<route>` (with `@{account}` for the account route). Route
 * shapes are locale-prefixed and `[x+40]` is decoded to `@`, so a
 * locale-less or @-less path — the cp82-B1/B2 and cp470 (kentest3) 404
 * bug class — no longer matches anything and fails loudly. The service-
 * worker sanitizeClickPath gate (cp81-D22b) still handles the orthogonal
 * cross-origin / malformed-path failure mode.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const HANDLER_DIR = join(REPO, 'apps/indexer/src/indexer/handlers');
const ROUTES_TS = join(REPO, 'apps/web/src/lib/seo/routes.ts');
const ROUTES_DIR = join(REPO, 'apps/web/src/routes/[lang]');

console.log('\n── handler push click_path route smoke ─────────────────\n');

// ─── 1. Build the canonical route shape set ──────────────────────
//
// Two sources of truth, both used:
//   (a) routes.ts — the explicit registry of indexable / non-
//       indexable routes
//   (b) apps/web/src/routes/[lang]/**/+page.svelte — the actual
//       SvelteKit filesystem routes
//
// Either is sufficient for a click_path match, but using both
// guards against drift in either direction.

function pathShape(path: string): string {
	// Normalize a path to its `*`-pattern shape.
	//   `/chat`                                  → '/chat'
	//   `/my/orders`                             → '/my/orders'
	//   `/[x+40][account=account]`               → '/*'
	//   `/[x+40][account=account]/[permlink=permlink]` → '/*/*'
	//   `/explorer/tx/[trx=trxid]`               → '/explorer/tx/*'
	// Anchors and trailing slashes are caller's responsibility.
	const segs = path.split('/').filter(Boolean);
	const out = segs.map((s) => {
		// SvelteKit bracketed segment. cp470: decode [x+HH] literal-char
		// encodings FIRST (e.g. [x+40] → '@', so the account route
		// `[x+40][account=account]` becomes the URL shape `@*`), THEN collapse
		// any remaining [param] brackets to `*`. The `@` matters: an account
		// page is `/@{account}`, not `/{account}`, and conflating them is
		// exactly the locale-less/@-less 404 bug this smoke exists to catch.
		if (s.includes('[')) {
			return s
				.replace(/\[x\+([0-9a-fA-F]{2})\]/g, (_, hh) => String.fromCharCode(parseInt(hh, 16)))
				.replace(/\[[^\]]*\]/g, '*');
		}
		return s;
	});
	return '/' + out.join('/');
}

// cp470 — every app route lives under `[lang]`, and every handler click_path
// is emitted as `/${locale}/…`. walkRoutes + routes.ts give us [lang]-RELATIVE
// shapes; prefix each with a locale wildcard so a correct click_path
// (`/*/@*/*`, `/*/chat`, …) matches AND a locale-less one (the pre-cp470 bug,
// e.g. `/${recipient}/${permlink}` → `/*/*`) matches nothing and fails.
function localePrefix(shape: string): string {
	return shape === '/' ? '/*' : '/*' + shape;
}

// Source A — routes.ts registry
const routesText = readFileSync(ROUTES_TS, 'utf8');
const routeShapes = new Set<string>();
const ROUTE_PATH_RE = /path:\s*['"]([^'"]+)['"]/g;
let m: RegExpExecArray | null;
while ((m = ROUTE_PATH_RE.exec(routesText)) !== null) {
	routeShapes.add(localePrefix(pathShape(m[1]!)));
}

// Source B — filesystem traversal of routes/[lang]/
function walkRoutes(dir: string, prefix = ''): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir)) {
		const abs = join(dir, entry);
		const st = statSync(abs);
		if (st.isDirectory()) {
			walkRoutes(abs, `${prefix}/${entry}`);
		} else if (entry === '+page.svelte') {
			routeShapes.add(localePrefix(pathShape(prefix || '/')));
		}
	}
}
walkRoutes(ROUTES_DIR);

console.log(`  ROUTE shapes loaded: ${routeShapes.size}`);

// ─── 2. Walk handler files for click_path emissions ──────────────
interface ClickHit {
	handler: string;
	line: number;
	raw: string;
	shape: string;
}

const hits: ClickHit[] = [];
const failures: string[] = [];

function literalToShape(literal: string): string {
	// Input: the textual literal — may be ' '-quoted, "-quoted,
	// or `-quoted (template) — possibly with `${...}`
	// interpolations and a `#anchor`.
	// Output: normalized to its `*`-pattern shape.
	let s = literal.trim();
	// Strip outer quotes / backticks
	if (
		(s.startsWith('`') && s.endsWith('`')) ||
		(s.startsWith("'") && s.endsWith("'")) ||
		(s.startsWith('"') && s.endsWith('"'))
	) {
		s = s.slice(1, -1);
	}
	// Replace `${...}` interpolations with `*` FIRST — so a ternary `?`/`#` or
	// any punctuation INSIDE an interpolation can't confuse the anchor/query
	// strip below.
	s = s.replace(/\$\{[^}]*\}/g, '*');
	// Strip `#anchor` suffix (browser-side, route-irrelevant).
	const hashIdx = s.indexOf('#');
	if (hashIdx >= 0) s = s.slice(0, hashIdx);
	// cp471 — strip `?query` suffix too. A click_path like
	// `/${locale}/chat/${signer}?order=${permlink}` deep-links to the
	// [lang]/chat/[peer] route (shape `/*/chat/*`); the ?order= is a query the
	// route reads, not a path segment, so it must not affect route matching.
	const qIdx = s.indexOf('?');
	if (qIdx >= 0) s = s.slice(0, qIdx);
	// Trailing slash normalize
	if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
	return s;
}

// Look at handler files; for each `INSERT INTO push_pending`
// statement, scan ±25 lines for string/template-literal click_path
// candidates.  We do NOT require the literal to be the 5th
// positional argument because handlers vary (some inline the
// click_path in the values array, others use a pushClickPath
// variable).  Any `/`-prefixed literal within the window counts.
const handlerFiles = readdirSync(HANDLER_DIR)
	.filter((f) => f.endsWith('.ts'))
	.map((f) => join(HANDLER_DIR, f));
// cp471 — the chat push enqueue moved to a shared module; scan it too so the
// chat click_path stays covered by this route guard.
handlerFiles.push(join(REPO, 'apps/indexer/src/indexer/chatPushEnqueue.ts'));

for (const handlerPath of handlerFiles) {
	const text = readFileSync(handlerPath, 'utf8');
	const lines = text.split('\n');
	const handlerRel = handlerPath.replace(REPO + '/', '');

	// Find every line containing `INSERT INTO push_pending` (case-
	// insensitive, allows whitespace variation).
	const insertLineNumbers: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (/INSERT\s+INTO\s+push_pending/i.test(lines[i]!)) {
			insertLineNumbers.push(i);
		}
	}
	if (insertLineNumbers.length === 0) continue;

	for (const insertLine of insertLineNumbers) {
		const winStart = Math.max(0, insertLine - 25);
		const winEnd = Math.min(lines.length - 1, insertLine + 25);
		// Within this window, find every `/...` literal.
		for (let j = winStart; j <= winEnd; j++) {
			const line = lines[j]!;
			// Skip lines that are pure comments — those are
			// explanatory prose, not runtime click_path values.
			// A historical-reference quote inside a comment (e.g.
			// "the prior `/profile/foo#bar` was broken") should
			// not trip this smoke.
			if (/^\s*(?:\/\/|\*)/.test(line)) continue;
			// Three literal styles to recognize:
			//   1. Backtick template:  `` `/foo/${bar}` ``
			//   2. Single-quoted:      ' /foo' (rare for paths)
			//   3. Double-quoted:      "/foo"
			//
			// We match any of them, anchored by the leading `/`
			// after the opening quote/backtick.
			const LITERAL_RE = /([`'"])(\/[^`'"]+)\1/g;
			LITERAL_RE.lastIndex = 0;
			let mm: RegExpExecArray | null;
			while ((mm = LITERAL_RE.exec(line)) !== null) {
				const lit = mm[2]!;
				// Skip obvious non-paths (SQL fragments, URL params)
				if (lit.includes(' ') || lit.startsWith('//')) continue;
				// Skip paths that look like SQL relations (e.g.,
				// `/* */` doesn't start with /, but defense in depth)
				if (lit.startsWith('/*')) continue;
				const shape = literalToShape(`\`${lit}\``);
				// Dedupe within the same handler at the same line+shape
				const already = hits.some(
					(h) =>
						h.handler === handlerRel && h.line === j + 1 && h.shape === shape
				);
				if (!already) {
					hits.push({
						handler: handlerRel,
						line: j + 1,
						raw: lit,
						shape
					});
				}
			}
		}
	}
}

// ─── 3. Cross-check each click_path candidate ────────────────────
for (const h of hits) {
	if (!routeShapes.has(h.shape)) {
		failures.push(
			`${h.handler}:${h.line} click_path \`${h.raw}\` (shape \`${h.shape}\`) ` +
				`has no matching route in routes.ts or [lang]/+page.svelte tree`
		);
	}
}

console.log(`  handler files scanned: ${handlerFiles.length}`);
console.log(`  click_path candidates: ${hits.length}`);

if (failures.length > 0) {
	console.log(`\n  ✗ ${failures.length} click_path(s) have no matching route:`);
	for (const f of failures) console.log(`    - ${f}`);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${failures.length}/${hits.length} scenarios failed`);
	process.exit(1);
}

// Sanity: a handler subsystem that's been adding push notifications
// for many cps should have at least a few click_paths.  If we find
// zero, the regex is broken or someone moved the inserts.
if (hits.length === 0) {
	console.log('\n  ✗ no click_path candidates found — pattern broken or inserts moved');
	console.log('\n──────────────────────────────────────────────────────');
	console.log('✗ 1/1 scenarios failed');
	process.exit(1);
}

console.log(`  ✓ all ${hits.length} click_path values map to real routes`);
console.log('\n──────────────────────────────────────────────────────');
console.log(`✓ all ${hits.length} scenarios passed`);
