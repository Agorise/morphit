#!/usr/bin/env tsx
/**
 * Smoke: the orderbook Asset filter offers ALL tradable assets.
 *
 * Catches the F-1 regression class from cp136's three-persona
 * walkthrough: the orderbook asset filter once had three hardcoded
 * options (BTC / XMR / BLURT) and was missing the other 13 tradable
 * assets, so users couldn't filter for SOL, ETH, USDT, etc.
 *
 * cp208 ARCHITECTURE CHANGE: a native <select> can't render the
 * per-coin SVG logos Ken wanted, so the orderbook asset filter is now
 * the custom `AssetFilterSelect.svelte` component, which renders one
 * row per `ASSETS` entry with `canBeTraded === true` (from the
 * FRONTEND registry, lib/assets/registry.ts — the source that also
 * carries each coin's displayName + logoSvgPath). The coverage
 * guarantee therefore moved from "{#each ASSET_TICKERS} in the route"
 * to two invariants enforced here:
 *
 *   1. The frontend registry's TRADABLE set (canBeTraded:true) covers
 *      every canonical ASSET_TICKER (packages/asset-registry). If a
 *      new tradable asset is added to the chain-level registry but not
 *      the frontend one, the dropdown would silently omit it.
 *   2. AssetFilterSelect.svelte is registry-DRIVEN: it iterates
 *      `ASSETS` and gates on `canBeTraded` (so a future PR can't
 *      revert it to a hardcoded subset of options).
 *
 * Tamper test: dropping a ticker from the frontend registry (or
 * flipping its canBeTraded to false), or replacing the component's
 * `{#each}` over ASSETS with hardcoded <option>s, fires this smoke.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CANONICAL_REGISTRY = join(REPO_ROOT, 'packages/asset-registry/src/index.ts');
const FRONTEND_REGISTRY = join(REPO_ROOT, 'apps/web/src/lib/assets/registry.ts');
const ASSET_SELECT_COMPONENT = join(REPO_ROOT, 'apps/web/src/lib/components/AssetFilterSelect.svelte');

let passes = 0;
let failures = 0;
function pass(msg: string): void {
	passes += 1;
	console.log(`  ✓ ${msg}`);
}
function fail(msg: string, detail = ''): void {
	failures += 1;
	console.error(`  ✗ ${msg}${detail ? ` — ${detail}` : ''}`);
}

console.log('asset-select-coverage-smoke\n');

// ─── Step 1: canonical ASSET_TICKERS (chain-level registry) ──────
const canonicalSrc = readFileSync(CANONICAL_REGISTRY, 'utf8');
const canonicalMatch = canonicalSrc.match(/export const ASSET_TICKERS\s*=\s*\[([^\]]+)\]/);
if (!canonicalMatch) {
	fail('could not parse ASSET_TICKERS export from packages/asset-registry/src/index.ts');
	console.log(`\n${passes} passed, ${failures} failed`);
	process.exit(1);
}
const tickers = Array.from(canonicalMatch[1].matchAll(/'([A-Z]+)'/g)).map((m) => m[1]);
if (tickers.length === 0) {
	fail('parsed ASSET_TICKERS but the array is empty');
	console.log(`\n${passes} passed, ${failures} failed`);
	process.exit(1);
}
pass(`canonical ASSET_TICKERS resolved (${tickers.length} entries)`);

// ─── Step 2: frontend registry — which displayTickers are tradable
// (canBeTraded:true)?  Pair each displayTicker with the canBeTraded
// flag that follows it inside the same entry object. ─────────────
const feSrc = readFileSync(FRONTEND_REGISTRY, 'utf8');
const dtMatches = Array.from(feSrc.matchAll(/displayTicker:\s*'([A-Z]+)'/g));
if (dtMatches.length === 0) {
	fail('could not parse any displayTicker entries from the frontend registry');
	console.log(`\n${passes} passed, ${failures} failed`);
	process.exit(1);
}
const tradable = new Set<string>();
for (let i = 0; i < dtMatches.length; i++) {
	const m = dtMatches[i];
	const start = m.index ?? 0;
	const end = i + 1 < dtMatches.length ? (dtMatches[i + 1].index ?? feSrc.length) : feSrc.length;
	const entryWindow = feSrc.slice(start, end);
	const cbt = /canBeTraded:\s*(true|false)/.exec(entryWindow);
	if (cbt && cbt[1] === 'true') tradable.add(m[1]);
}
pass(`frontend registry tradable assets resolved (${tradable.size} of ${dtMatches.length} entries canBeTraded)`);

// ─── Step 3: coverage — every canonical ticker must be tradable in
// the frontend registry (so the dropdown renders it). ────────────
const missing = tickers.filter((t) => !tradable.has(t));
if (missing.length === 0) {
	pass(`frontend registry covers all ${tickers.length} canonical tickers as tradable`);
} else {
	fail(
		`frontend registry is missing tradable entries for: ${missing.join(', ')}`,
		'AssetFilterSelect renders one row per ASSETS entry with canBeTraded:true. Add the ' +
			'missing coin(s) to apps/web/src/lib/assets/registry.ts (displayTicker + canBeTraded:true ' +
			'+ displayName + logoSvgPath + an /icons/icon-<ticker>.svg) or the orderbook asset filter ' +
			'will silently omit them (the F-1 regression class).'
	);
}

// ─── Step 4: the component is registry-driven, not hardcoded ─────
let componentSrc = '';
try {
	componentSrc = readFileSync(ASSET_SELECT_COMPONENT, 'utf8');
} catch {
	fail(
		'AssetFilterSelect.svelte not found',
		'The orderbook asset filter was the custom AssetFilterSelect component as of cp208. ' +
			'If it was renamed/replaced, update this smoke to point at the new component and keep ' +
			'enforcing registry-driven coverage.'
	);
	console.log(`\n${passes} passed, ${failures} failed`);
	process.exit(1);
}
const importsRegistry = /import\s*\{[^}]*\bASSETS\b[^}]*\}\s*from\s*'\$lib\/assets\/registry'/.test(
	componentSrc
);
const iteratesRegistry = /\{\s*#each\s+\w+/.test(componentSrc) && /\bASSETS\b/.test(componentSrc);
const gatesOnTradable = /canBeTraded/.test(componentSrc);
if (importsRegistry && iteratesRegistry && gatesOnTradable) {
	pass('AssetFilterSelect is registry-driven (imports ASSETS, iterates with an #each, gates on canBeTraded)');
} else {
	fail(
		'AssetFilterSelect no longer looks registry-driven',
		`importsASSETS=${importsRegistry} iteratesEach=${iteratesRegistry} gatesCanBeTraded=${gatesOnTradable}. ` +
			'The asset dropdown must enumerate ASSETS.filter(canBeTraded) so it auto-tracks the registry ' +
			'rather than a hardcoded subset (the F-1 regression class).'
	);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures === 0) console.log(`✓ all ${passes} scenarios passed`);
process.exit(failures > 0 ? 1 : 0);
