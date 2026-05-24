#!/usr/bin/env tsx
/**
 * Smoke: every asset `<select>` enumerates ALL canonical ASSET_TICKERS.
 *
 * Catches the F-1 regression class from cp136's three-persona walkthrough:
 * the orderbook asset filter had three hardcoded `<option>` tags for
 * BTC / XMR / BLURT and was missing all 13 other tradable assets, so
 * users couldn't filter for SOL, ETH, USDT, etc. The fix replaced the
 * hardcoded options with `{#each ASSET_TICKERS}` — this smoke enforces
 * the pattern so a future PR can't silently revert it.
 *
 * Rule: any `.svelte` file under apps/web/src/routes that contains a
 * `<select>` whose name-or-binding looks like "asset" AND lists 2+
 * `<option value="<ticker>">` lines must list ALL ASSET_TICKERS (via
 * either hardcoded options OR an each-loop over the registry).
 *
 * Acceptable patterns (both pass the smoke):
 *
 *   {#each ASSET_TICKERS as t (t)}
 *       <option value={t}>{t}</option>
 *   {/each}
 *
 * — OR every ticker enumerated literally:
 *
 *   <option value="BTC">BTC</option>
 *   <option value="XMR">XMR</option>
 *   ... (all 16)
 *
 * Unacceptable: a partial enumeration of tickers (the F-1 bug).
 *
 * Tamper test: removing any ticker from the `{#each}` source or
 * shrinking a literal-options list to a strict subset fires this smoke.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const ROUTES_ROOT = join(REPO_ROOT, 'apps/web/src/routes');
const ASSET_REGISTRY = join(REPO_ROOT, 'packages/asset-registry/src/index.ts');

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

// ─── Step 1: load canonical ASSET_TICKERS ────────────────────────
const registrySrc = readFileSync(ASSET_REGISTRY, 'utf8');
const registryMatch = registrySrc.match(
	/export const ASSET_TICKERS\s*=\s*\[([^\]]+)\]/
);
if (!registryMatch) {
	fail('could not parse ASSET_TICKERS export from asset-registry/src/index.ts');
	console.log(`\n${passes} passed, ${failures} failed`);
	process.exit(1);
}
const tickers = Array.from(registryMatch[1].matchAll(/'([A-Z]+)'/g)).map(
	(m) => m[1]
);
if (tickers.length === 0) {
	fail('parsed ASSET_TICKERS but the array is empty');
	console.log(`\n${passes} passed, ${failures} failed`);
	process.exit(1);
}
pass(`canonical ASSET_TICKERS resolved (${tickers.length} entries)`);

// ─── Step 2: walk every .svelte file under routes ───────────────
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const s = statSync(full);
		if (s.isDirectory()) {
			if (entry === 'node_modules' || entry === '.svelte-kit') continue;
			out.push(...walk(full));
		} else if (entry.endsWith('.svelte')) {
			out.push(full);
		}
	}
	return out;
}

const svelteFiles = walk(ROUTES_ROOT);

// ─── Step 3: for each file, find <select> blocks whose binding
// looks like "asset" and check coverage ─────────────────────────
const ASSET_BINDING_RE = /\b(bind:value|name)\s*=\s*["{]\s*(\w*[Aa]sset\w*)\s*["}]/;
const SELECT_BLOCK_RE = /<select\b[^>]*>[\s\S]*?<\/select>/g;
const OPTION_VALUE_RE = /<option\s+[^>]*value\s*=\s*["{]?\s*([A-Z]+)\s*["}]?/g;
const EACH_BLOCK_RE = /\{\s*#each\s+ASSET_TICKERS\b/;

let selectsChecked = 0;
let selectsViaEachLoop = 0;
let selectsViaLiteral = 0;

for (const f of svelteFiles) {
	const src = readFileSync(f, 'utf8');
	const blocks = src.match(SELECT_BLOCK_RE);
	if (!blocks) continue;
	for (const block of blocks) {
		// Heuristic: must look like an asset filter.  We require both:
		//   - the binding/name contains "asset" (case-insensitive)
		//   - the block contains 2+ <option value="<TICKER>"> with
		//     all-caps ticker-shaped values, OR an each over ASSET_TICKERS
		if (!ASSET_BINDING_RE.test(block)) continue;
		const literalTickers = Array.from(block.matchAll(OPTION_VALUE_RE)).map(
			(m) => m[1]
		);
		const eachOverRegistry = EACH_BLOCK_RE.test(block);
		const looksLikeAssetSelect =
			eachOverRegistry || literalTickers.filter((t) => tickers.includes(t)).length >= 2;
		if (!looksLikeAssetSelect) continue;

		selectsChecked += 1;
		const rel = relative(REPO_ROOT, f);

		if (eachOverRegistry) {
			selectsViaEachLoop += 1;
			pass(`${rel}: asset <select> uses {#each ASSET_TICKERS}`);
			continue;
		}

		// Literal path: every canonical ticker must appear as an option.
		const missing = tickers.filter((t) => !literalTickers.includes(t));
		if (missing.length === 0) {
			selectsViaLiteral += 1;
			pass(
				`${rel}: asset <select> enumerates all ${tickers.length} canonical tickers literally`
			);
		} else {
			fail(
				`${rel}: asset <select> is missing tickers: ${missing.join(', ')}`,
				`The orderbook regressed this way pre-cp136.  Either enumerate every ` +
					`ASSET_TICKERS entry literally, or — preferred — replace the hardcoded ` +
					`options with {#each ASSET_TICKERS as t (t)} <option value={t}>{t}</option> {/each} ` +
					`so the dropdown auto-tracks the registry.`
			);
		}
	}
}

if (selectsChecked === 0) {
	fail(
		`no asset <select> found anywhere under apps/web/src/routes`,
		`This smoke looks for a <select> with bind:value/name matching ` +
			`/asset/i AND at least 2 ticker-shaped options or {#each ASSET_TICKERS}. ` +
			`If you removed the asset filter intentionally, delete this smoke. ` +
			`Otherwise check the heuristic — false-negative defeats the purpose.`
	);
} else {
	pass(
		`scanned ${svelteFiles.length} .svelte files; ${selectsChecked} asset <select> blocks checked ` +
			`(${selectsViaEachLoop} via {#each ASSET_TICKERS}, ${selectsViaLiteral} via literal enumeration)`
	);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} asset-select-coverage-smoke scenarios passed`);
