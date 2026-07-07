#!/usr/bin/env tsx
/**
 * service-worker-dynamic-data smoke — cp324.
 *
 * Prevents regression of the "footer keeps forgetting the operator
 * name" bug.
 *
 * The bug: the service worker's `isCacheable()` claimed (in its
 * comment) to never cache "dynamic data", but only excluded non-GET
 * requests and the SW file itself. So a same-origin GET to
 * `/v1/instance` — which IS same-origin in the colocated single-host
 * topology (one reverse proxy serves the SPA and proxies `/v1/*` to the
 * loopback indexer) — fell into the CACHE-FIRST branch. The first load
 * cached the response; every later load (including a normal refresh)
 * was served from the SW cache and never hit the network. When an
 * operator changed their instance branding ("morphit.io" → "Morphit
 * NL"), `/v1/instance` returned the new name but the footer kept
 * showing the old one until a hard reload (ctrl+shift+r) bypassed the
 * SW. The instances-page card escaped only because it rides the
 * `/v1/instances` SSE stream, which is never a cacheable GET. Doubly
 * bad for `/verify.json`: the SW matches with `ignoreSearch: true`,
 * which would also have defeated the deployed-version poll's `?cb=`
 * cache-buster.
 *
 * cp324 fix: extracted a pure `isDynamicDataPath()` classifier into
 * $lib/net/dynamicPaths and wired it into `isCacheable()` so the
 * indexer/relay API, feeds, verify.json and canary all fall through to
 * the network (where each caller's own `cache:` directive governs
 * freshness). The activate handler purges old version caches, so the
 * fix self-heals: once the fixed build activates, the stale
 * `/v1/instance` entry is gone and never re-cached.
 *
 * This smoke locks the fix in two ways:
 *   • UNIT — exercises the pure classifier directly: every dynamic
 *     path is non-cacheable, every immutable asset/app path is
 *     cacheable, and look-alike paths (`/v1foo`, `/relayer/x`,
 *     `/verify.json.bak`) are NOT over-matched.
 *   • WIRING — service-worker.ts imports the classifier and calls it
 *     inside `isCacheable`, and the fetch handler still gates on
 *     `isCacheable` so the exclusion actually takes effect.
 *
 * Mutation tests:
 *   M-324a: make `isDynamicDataPath` return false for `/v1/...` →
 *     the dynamic-paths sweep fires.
 *   M-324b: broaden it to `startsWith('/v1')` (drop the slash) →
 *     the look-alike sweep fires on `/v1foo`.
 *   M-324c: remove the `isDynamicDataPath` call from `isCacheable` →
 *     the wiring check fires.
 *   M-324d: delete the `if (!isCacheable(req)) return;` gate →
 *     the gate check fires.
 *
 * Why this matters: instance branding, the warrant canary, and the
 * release-tamper / version-update probe are all user- and
 * security-facing. Silently serving any of them stale until a hard
 * reload is exactly the kind of invisible breakage the hardening
 * campaign exists to prevent.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDynamicDataPath } from '../src/lib/net/dynamicPaths.ts';

interface Result {
	name: string;
	ok: boolean;
	detail?: string;
}
const results: Result[] = [];

// Resolve relative to apps/web (where tsx runs this).
const root = resolve(import.meta.dirname, '..');

// ─── 1. Every dynamic same-origin path is NON-cacheable ──────
{
	// The exact paths the app fetches same-origin (verified against the
	// codebase), plus the bare namespace forms and the two single files.
	const dynamic = [
		'/v1/instance',
		'/v1/instances',
		'/v1/instances/stream',
		'/v1/orderbook/stream',
		'/v1/account/kentest',
		'/v1/chain-fee',
		'/v1/profiles',
		'/v1/login-pairing/abc',
		'/v1',
		'/relay/create',
		'/relay/health',
		'/relay',
		'/rss/blog.xml',
		'/rss',
		'/verify.json',
		'/canary.txt'
	];
	const leaked = dynamic.filter((p) => isDynamicDataPath(p) !== true);
	results.push({
		name: 'every dynamic same-origin path is classified non-cacheable (isDynamicDataPath → true)',
		ok: leaked.length === 0,
		detail:
			leaked.length === 0
				? undefined
				: `these dynamic paths were NOT excluded (would be served stale cache-first): ${leaked.join(', ')}`
	});
}

// ─── 2. Every immutable asset / app path IS cacheable ────────
{
	// Content-addressed bundle chunks, /static/* assets served at root,
	// prerendered routes, and the manifest — all SAFE to cache-first.
	const cacheable = [
		'/',
		'/faq',
		'/orderbook',
		'/onboarding/register-name',
		'/_app/immutable/chunks/BzQ9k2.js',
		'/_app/immutable/assets/app.7f3a.css',
		'/_app/version.json',
		'/favicon.ico',
		'/manifest.webmanifest',
		'/icon-doge.svg',
		'/robots.txt',
		'/morphit-mediakit.zip'
	];
	const blocked = cacheable.filter((p) => isDynamicDataPath(p) !== false);
	results.push({
		name: 'every immutable asset / app / prerendered path stays cacheable (isDynamicDataPath → false)',
		ok: blocked.length === 0,
		detail:
			blocked.length === 0
				? undefined
				: `these cacheable paths were wrongly excluded (would lose offline self-heal): ${blocked.join(', ')}`
	});
}

// ─── 3. Look-alike paths are NOT over-matched ────────────────
{
	// Guards the prefix checks against swallowing similarly-named paths.
	// A bare-prefix match without the trailing slash (`startsWith('/v1')`)
	// would wrongly catch `/v1foo`; an exact-file match must not catch a
	// `.bak`/`.old` sibling.
	const lookAlikes = ['/v1foo', '/v1bar/baz', '/relayer/x', '/rssfeed', '/verify.json.bak', '/canary.txt.old'];
	const overMatched = lookAlikes.filter((p) => isDynamicDataPath(p) !== false);
	results.push({
		name: 'look-alike paths (/v1foo, /relayer/x, /verify.json.bak, …) are NOT over-matched',
		ok: overMatched.length === 0,
		detail:
			overMatched.length === 0
				? undefined
				: `these look-alike paths were wrongly classified dynamic: ${overMatched.join(', ')}`
	});
}

// ─── 4. service-worker.ts imports + uses the classifier ──────
{
	const swPath = resolve(root, 'src/service-worker.ts');
	const swText = readFileSync(swPath, 'utf8');
	// Strip JS comments so the explanatory comment that names the helper
	// isn't mistaken for the actual import/call.
	const stripJs = (s: string): string =>
		s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
	const code = stripJs(swText);
	const importsHelper = /from\s+['"]\$lib\/net\/dynamicPaths['"]/.test(code);
	const callsHelper = /isDynamicDataPath\s*\(/.test(code);
	// The call lives inside isCacheable and short-circuits to false.
	const cacheableIdx = code.indexOf('function isCacheable');
	const nextFnIdx = code.indexOf('\nfunction ', cacheableIdx + 1);
	const body =
		cacheableIdx >= 0
			? code.slice(cacheableIdx, nextFnIdx > cacheableIdx ? nextFnIdx : undefined)
			: '';
	const excludesInCacheable = /isDynamicDataPath\([^)]*\)\s*\)?\s*return false/.test(body);
	const ok = importsHelper && callsHelper && excludesInCacheable;
	results.push({
		name: 'service-worker.ts imports isDynamicDataPath and excludes it inside isCacheable',
		ok,
		detail: ok
			? undefined
			: `imports helper: ${importsHelper}; calls helper: ${callsHelper}; excludes (returns false) inside isCacheable: ${excludesInCacheable}. Without all three, dynamic endpoints fall back into the cache-first branch and serve stale.`
	});
}

// ─── 5. fetch handler still gates cache-first on isCacheable ──
{
	const swPath = resolve(root, 'src/service-worker.ts');
	const swText = readFileSync(swPath, 'utf8');
	const stripJs = (s: string): string =>
		s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
	const code = stripJs(swText);
	// The pass-through gate: non-cacheable requests never reach the
	// cache branches.
	const gated = /if\s*\(\s*!\s*isCacheable\s*\(\s*req\s*\)\s*\)\s*return/.test(code);
	results.push({
		name: 'fetch handler passes non-cacheable requests through to the network (if (!isCacheable(req)) return)',
		ok: gated,
		detail: gated
			? undefined
			: 'The `if (!isCacheable(req)) return;` gate is missing, so the isDynamicDataPath exclusion never takes effect — dynamic data would still be intercepted and cached.'
	});
}

// ─── 6. classifier module exists at the wired path ───────────
{
	const helperPath = resolve(root, 'src/lib/net/dynamicPaths.ts');
	const exists = existsSync(helperPath);
	results.push({
		name: '$lib/net/dynamicPaths.ts exists (the SW import target)',
		ok: exists,
		detail: exists ? undefined : 'src/lib/net/dynamicPaths.ts is missing; the SW import would fail to build.'
	});
}

// ─── Report ──────────────────────────────────────────────────
console.log('\n── service-worker-dynamic-data smoke (cp324) ──\n');
let passed = 0;
let failed = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`  ✓ ${r.name}`);
		passed++;
	} else {
		console.log(`  ✗ ${r.name}`);
		if (r.detail) console.log(`    ${r.detail}`);
		failed++;
	}
}
console.log(`\n${passed} passed, ${failed} failed (${results.length} total)`);
if (failed > 0) {
	console.log(`✗ service-worker-dynamic-data: ${failed} scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${results.length} service-worker-dynamic-data scenarios passed`);
