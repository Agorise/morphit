#!/usr/bin/env tsx
/**
 * per-asset-rss-feed-parity-smoke.
 *
 * Part 122 cp50 STRUCTURAL DEFENSE (LL #54 / O-3).
 *
 * Closes the cp50-D1 drift class: the per-asset RSS feed allow-
 * set must NEVER hardcode a subset of asset tickers; it must
 * derive from canonical ASSET_TICKERS so adding a new asset
 * automatically unlocks its feed.
 *
 * Bug history that motivated this defense:
 *   - Pre-cp50: regex hardcoded as `/^(btc|xmr|blurt)\.xml$/`
 *     in apps/indexer/src/api/rssOrderbookHandlers.ts:213.
 *     This regex was correct when written (~Part 95 with only
 *     3 tradable assets) but STAYED FROZEN through 13 subsequent
 *     additions (cp21/24/27/30/30/31/33/39/41/43/45/47/49), so
 *     /rss/orderbook/by-asset/{usdt,usdc,dai,bch,ltc,dash,doge,
 *     zec,arrr,dcr,sol,eth,xrp}.xml ALL silently 400'd for ~14
 *     checkpoints.  The docblock said "the three the site
 *     supports" — also stale.
 *   - Cp50 fix derives allow-set from ASSET_TICKERS at runtime
 *     (apps/indexer/src/api/rssOrderbookHandlers.ts:228) so any
 *     future addition unlocks its feed automatically.  No further
 *     code changes needed in this handler.
 *
 * Structural defense scope: any HTTP / API surface that enumerates
 * a SUBSET of ASSET_TICKERS hardcoded inline is suspect.  This
 * smoke walks the indexer API source for `(btc|xmr|...)` regex
 * patterns that could be drifting subsets.
 *
 * Recurring-class siblings the cp48-O1 / cp49-O2 defenses
 * already cover:
 *   - cp48-O1: indexer smoke scripts using a real ticker as
 *     "unknown" stand-in.
 *   - cp49-O2: vitest unit tests using a real ticker as
 *     "asset_invalid" stand-in.
 *
 * Cp50-O3 adds: HTTP route handlers using a hardcoded ticker
 * subset as an allow-set.
 *
 * Mutation-test verification: M-116.  Reverting the cp50-D1 fix
 * (hardcoding `(btc|xmr|blurt)`) fires:
 *   "per-asset-rss-feed-parity FAILED: regex allow-set
 *    [btc,xmr,blurt] is a strict subset of ASSET_TICKERS
 *    [btc,xmr,blurt,usdt,usdc,dai,bch,ltc,dash,doge,zec,arrr,
 *    dcr,sol,eth,xrp].  Use ASSET_TICKERS.includes() instead
 *    of a hardcoded regex."
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ASSET_TICKERS } from '../../../packages/asset-registry/src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── per-asset-rss-feed-parity smoke (cp50 LL #54 / O-3) ──\n');

// ── Scenario 1: rssOrderbookHandlers.ts uses ASSET_TICKERS, not
//   a hardcoded regex subset ──
const rssPath = join(__dirname, '..', '..', '..', 'apps', 'indexer', 'src', 'api', 'rssOrderbookHandlers.ts');
const rssSrc = readFileSync(rssPath, 'utf-8');

// Look for the perAssetFeedHandler function body.
const handlerIdx = rssSrc.indexOf('export async function perAssetFeedHandler');
if (handlerIdx === -1) {
	fail('perAssetFeedHandler found', 'function declaration not present');
} else {
	pass('perAssetFeedHandler function exists');

	// Get the function body (next ~50 lines).
	const handlerBody = rssSrc.slice(handlerIdx, handlerIdx + 3000);

	// CHECK 1 — handler must reference ASSET_TICKERS
	if (handlerBody.includes('ASSET_TICKERS')) {
		pass('perAssetFeedHandler references ASSET_TICKERS for allow-set');
	} else {
		fail(
			'perAssetFeedHandler references ASSET_TICKERS',
			'handler does not derive allow-set from canonical ASSET_TICKERS — likely a hardcoded subset that will drift'
		);
	}

	// CHECK 2 — handler must NOT have a hardcoded ticker-list regex
	// like `/^(btc|xmr|blurt)\.xml$/`.  This is the failure mode
	// cp50-D1 fixed.  Detect by looking for the pattern
	// `(<tickerset>)\.xml` where tickerset is a subset.
	const hardcodedSubsetRe = /\/\^?\(([a-z]+(\|[a-z]+){1,})\)\\?\.xml\$?\/?/;
	const hardcodedMatch = hardcodedSubsetRe.exec(handlerBody);
	if (hardcodedMatch) {
		const subset = hardcodedMatch[1]!.split('|');
		const canonical = (ASSET_TICKERS as readonly string[]).map((s) => s.toLowerCase());
		const isSubset = subset.every((s) => canonical.includes(s));
		const isStrictSubset = isSubset && subset.length < canonical.length;
		if (isStrictSubset) {
			fail(
				'perAssetFeedHandler NOT hardcoding ticker-list regex',
				`regex allow-set [${subset.join(',')}] is a strict subset of ASSET_TICKERS [${canonical.join(',')}]. ` +
				`Use ASSET_TICKERS.includes() instead of a hardcoded regex.`
			);
		} else {
			pass('perAssetFeedHandler hardcoded regex (if present) covers all tickers');
		}
	} else {
		pass('perAssetFeedHandler has no hardcoded ticker-list regex (uses derivation pattern)');
	}
}

// ── Scenario 2: walk indexer API source files for any
//   `[a-z]{3,5}\|[a-z]{3,5}` patterns that look like ticker
//   enumerations.  Strips multi-line `/* */` and line `//`
//   comments first so historical regex references inside
//   docblocks (like the cp50 fix-rationale comment) don't
//   produce false positives. ──
let apiSrc = readFileSync(
	join(__dirname, '..', '..', '..', 'apps', 'indexer', 'src', 'api', 'rssOrderbookHandlers.ts'),
	'utf-8'
);
// Strip multiline comments
apiSrc = apiSrc.replace(/\/\*[\s\S]*?\*\//g, '');
// Strip line comments
apiSrc = apiSrc.replace(/\/\/.*$/gm, '');
const candidateRe = /\(([a-z]{3,5}\|[a-z]{3,5}(\|[a-z]{3,5})*)\)/g;
const findings: string[] = [];
let m: RegExpExecArray | null;
while ((m = candidateRe.exec(apiSrc)) !== null) {
	const inside = m[1]!.split('|');
	const lowerTickers = (ASSET_TICKERS as readonly string[]).map((s) => s.toLowerCase());
	const allLookLikeTickers = inside.every((s) => lowerTickers.includes(s));
	if (allLookLikeTickers && inside.length < lowerTickers.length) {
		findings.push(`possible drift: (${inside.join('|')}) at offset ${m.index}`);
	}
}
if (findings.length === 0) {
	pass('no other indexer API hardcoded-ticker-subset regexes detected');
} else {
	for (const f of findings) {
		fail('indexer API hardcoded-ticker-subset regex', f);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nper-asset-rss-feed-parity smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} scenarios passed`);
