#!/usr/bin/env tsx
/**
 * handler-test-stand-in-meta-assertion-smoke.
 *
 * Part 122 cp49 STRUCTURAL DEFENSE (LL #53 / O-2).  Closes the
 * cp47-A1 recurring class permanently for vitest unit-test files
 * (the cp48-O1 closure covered only standalone smoke scripts;
 * the vitest test path was an unprotected sibling).
 *
 * Recurring class history:
 *   cp33 — handler tests used 'DOGE' as the "unknown asset"
 *          stand-in; cp33 added DOGE; tests silently passed because
 *          they ran before the asset list was rechecked.
 *   cp39 — same pattern with 'ZEC'.
 *   cp47 — same pattern with 'ETH'.  Vitest tests SILENTLY BROKE
 *          (handler returned ok:true; expectation was
 *          asset_invalid) but the unit-test path was NOT part of
 *          run-smokes.sh, so the breakage went undetected for
 *          2 checkpoints (cp47, cp48).
 *   cp49 — surfaced via deep-deep A-2 grep; fixed inline AND
 *          structural defense added here.
 *
 * Defense: any time a vitest test file contains a hardcoded
 * asset ticker literal in a "rejects unknown asset" or
 * "asset_invalid" context, that literal must NOT be in the
 * canonical ASSET_TICKERS set.  Synthetic non-ticker like
 * '__UNKNOWN__' (or any value with chars outside the canonical
 * ticker regex /^[A-Z]+$/) is acceptable.
 *
 * Mutation-test verification: M-111 in cp49 deep-deep.  Swapping
 * '__UNKNOWN__' back to a real ticker like 'XRP' fires:
 *   "handler-test-stand-in-meta-assertion FAILED:
 *    apps/indexer/test/handlers/order.test.ts uses 'XRP' as
 *    asset_invalid stand-in — XRP is a real ticker.  Pick a
 *    synthetic non-ticker like '__UNKNOWN__'."
 *
 * Also pins cp48-O1's UNKNOWN_STANDIN constant in
 * asset-registry-smoke.ts — confirms that defense is still
 * intact at cp49.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ASSET_TICKERS } from '../../../packages/asset-registry/src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ASSET_TICKERS_SET = new Set(ASSET_TICKERS as readonly string[]);

let failed = 0;
let passed = 0;

function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── handler-test-stand-in meta-assertion smoke (cp49 LL #53) ─\n');

// ── Walk vitest test files recursively ──
function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (entry !== 'node_modules' && entry !== 'dist' && entry !== '.svelte-kit') {
				walk(full, out);
			}
		} else if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) {
			out.push(full);
		}
	}
	return out;
}

const ROOTS = [
	join(__dirname, '..', '..', '..', 'apps', 'indexer', 'test'),
	join(__dirname, '..', '..', '..', 'apps', 'relay', 'test'),
	join(__dirname, '..', '..', '..', 'apps', 'web', 'test'),
	join(__dirname, '..', '..', '..', 'packages', 'asset-registry', 'test')
];

const files: string[] = [];
for (const r of ROOTS) {
	try { walk(r, files); } catch { /* dir missing OK */ }
}
console.log(`Scanned ${files.length} vitest test files\n`);

// Find any hardcoded literal `asset: 'XXX'` or `asset: "XXX"` near
// `asset_invalid` or `unknown asset`.
const ASSET_LITERAL_RE = /asset:\s*['"]([A-Z_]{2,16})['"]/g;
const REJECTION_CONTEXT_RE = /asset_invalid|unknown asset|invalid asset/i;

const violations: Array<{ file: string; line: number; ticker: string; context: string }> = [];

for (const f of files) {
	const content = readFileSync(f, 'utf-8');
	const lines = content.split('\n');
	// For each occurrence, check if there's a rejection-context
	// match within ±5 lines.
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		ASSET_LITERAL_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = ASSET_LITERAL_RE.exec(line)) !== null) {
			const ticker = m[1] ?? '';
			if (!ASSET_TICKERS_SET.has(ticker)) continue; // synthetic OK
			// Look in nearby context for rejection
			const start = Math.max(0, i - 5);
			const end = Math.min(lines.length - 1, i + 5);
			const context = lines.slice(start, end + 1).join('\n');
			if (REJECTION_CONTEXT_RE.test(context)) {
				violations.push({ file: f, line: i + 1, ticker, context: lines[i] ?? '' });
			}
		}
	}
}

if (violations.length === 0) {
	pass(`no vitest test file uses a real ticker as 'asset_invalid' stand-in (${files.length} files scanned)`);
} else {
	for (const v of violations) {
		fail(
			`stand-in violation in ${v.file.split('/morphit-cp49/')[1] ?? v.file}:${v.line}`,
			`uses '${v.ticker}' as asset_invalid stand-in — '${v.ticker}' is a real ticker. ` +
			`Pick a synthetic non-ticker like '__UNKNOWN__'. Context: ${v.context.trim()}`
		);
	}
}

// ── Also pin cp48-O1's UNKNOWN_STANDIN integrity ──
const indexerSmokePath = join(__dirname, '..', '..', '..', 'apps', 'indexer', 'scripts', 'asset-registry-smoke.ts');
try {
	const c = readFileSync(indexerSmokePath, 'utf-8');
	const m = /const UNKNOWN_STANDIN = '([^']+)';/.exec(c);
	if (!m) {
		fail("cp48-O1's UNKNOWN_STANDIN constant intact", "no `const UNKNOWN_STANDIN = '...'` found in asset-registry-smoke.ts");
	} else {
		const v = m[1] ?? '';
		if (ASSET_TICKERS_SET.has(v.toUpperCase())) {
			fail("cp48-O1's UNKNOWN_STANDIN intact", `UNKNOWN_STANDIN '${v}' is now a real ticker`);
		} else {
			pass(`cp48-O1's UNKNOWN_STANDIN ('${v}') intact and remains non-ticker`);
		}
	}
} catch (e) {
	fail('cp48-O1 inspection', `could not read asset-registry-smoke.ts: ${e}`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nhandler-test-stand-in meta-assertion smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} stand-in scenarios passed`);
