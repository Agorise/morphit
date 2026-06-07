/**
 * price-input-block-enforcement-smoke (cp209).
 *
 * Companion to orderbook-block-enforcement-smoke. Instance-local
 * blocking hides a seller's LISTINGS from the orderbook; cp209 extends
 * the same guarantee to the instance's DERIVED price feeds, so a
 * manually-blocked (not merely signal-flagged) seller can't move the
 * morphit_native / depeg price this instance computes from its own
 * orderbook.
 *
 * Enforcement lives in three per-account order-price queries:
 *   - morphitNativeFetcher.ts  tier1 (USD-direct) + tier2 (stablecoin)
 *   - stablecoinDepegDetector.ts  cross-stablecoin ratio query
 * and is fed by `officialAccountName` threaded from the indexer config
 * through two construction sites (factory.ts, priceReceipt.ts).
 *
 * This static smoke is the leak sentinel: it asserts each price-input
 * query still carries the operator-block exclusion (`NOT EXISTS ...
 * operator_blocks ... ob.blocked = o.account ... state = 'blocked'`),
 * that both config types declare `officialAccountName`, and that both
 * construction sites pass it. If someone weakens a query or adds a new
 * per-account price-input read without the filter, this fails.
 *
 * (Runtime proof that the clause actually drops a blocked account's
 * orders from the median is identical in shape to the orderbook clause
 * already proven against real Postgres in development; this is the
 * portable CI guard against regression.)
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const priceDir = join(srcDir, 'indexer', 'price');

// The distinctive fragment of the exclusion — order-account scoped.
// Matches across the multi-line clause (whitespace + the AND between).
const EXCLUSION = /ob\.blocked\s*=\s*o\.account\b[\s\S]{0,80}ob\.state\s*=\s*'blocked'/g;
const TABLE = /operator_blocks/;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};

function read(path: string): string | null {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

function countExclusions(src: string): number {
	if (!TABLE.test(src)) return 0;
	return (src.match(EXCLUSION) ?? []).length;
}

// ── PB-1/PB-2: every per-account price-input query carries the filter ──
// Expected counts = number of distinct per-account order-price SELECTs
// in each file (the `prev`-existence subqueries don't need it — once the
// outer o.account is excluded, the prior-trade check is moot).
const QUERY_SURFACES: Record<string, number> = {
	'morphitNativeFetcher.ts': 2, // tier1 USD-direct + tier2 stablecoin
	'stablecoinDepegDetector.ts': 1 // cross-stablecoin ratio (queryDir2 reuses queryDir1)
};

for (const [file, expected] of Object.entries(QUERY_SURFACES)) {
	const src = read(join(priceDir, file));
	if (src === null) {
		bad(`${file}: cannot read (price fetcher moved/renamed?)`);
		continue;
	}
	const count = countExclusions(src);
	if (count >= expected) {
		ok(`${file}: ${count} operator-block exclusion(s) present (\u2265 ${expected})`);
	} else {
		bad(
			`${file}: only ${count} operator-block exclusion(s), expected \u2265 ${expected}`,
			'a per-account price-input query is missing the blocked-account filter — blocked sellers would influence this instance\u2019s price'
		);
	}
}

// ── PB-3/PB-4: both config types require officialAccountName ──
const CONFIG_DECLS: Record<string, string> = {
	'morphitNativeFetcher.ts': 'MorphitNativeFetcherConfig',
	'stablecoinDepegDetector.ts': 'DepegDetectorConfig'
};
const DECL = /readonly\s+officialAccountName\s*:\s*string\s*;/;

for (const [file, iface] of Object.entries(CONFIG_DECLS)) {
	const src = read(join(priceDir, file));
	if (src === null) {
		bad(`${file}: cannot read for ${iface} check`);
		continue;
	}
	if (!src.includes(iface)) {
		bad(`${file}: ${iface} not found (renamed?)`);
		continue;
	}
	if (DECL.test(src)) {
		ok(`${file}: ${iface} declares a required officialAccountName: string`);
	} else {
		bad(
			`${file}: ${iface} is missing \`readonly officialAccountName: string;\``,
			'without the required field a construction site could silently omit the operator name, making the exclusion inert'
		);
	}
}

// ── PB-5/PB-6: both construction sites pass officialAccountName ──
const CALL_SITES: Array<{ file: string; fn: string }> = [
	{ file: join(srcDir, 'indexer', 'price', 'factory.ts'), fn: 'createMorphitNativeFetcher' },
	{ file: join(srcDir, 'api', 'priceReceipt.ts'), fn: 'deriveMorphitNativePrice' }
];
const PASSES_FIELD = /officialAccountName\s*:\s*config\.officialAccountName/;

for (const { file, fn } of CALL_SITES) {
	const src = read(file);
	const label = file.split('/src/')[1] ?? file;
	if (src === null) {
		bad(`${label}: cannot read for ${fn} call-site check`);
		continue;
	}
	if (!src.includes(fn)) {
		bad(`${label}: does not call ${fn} (moved?)`);
		continue;
	}
	if (PASSES_FIELD.test(src)) {
		ok(`${label}: passes officialAccountName: config.officialAccountName to ${fn}`);
	} else {
		bad(
			`${label}: calls ${fn} but never passes officialAccountName: config.officialAccountName`,
			'the price fetcher would receive no operator name — blocked-account exclusion would be inert'
		);
	}
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 price-input-block-enforcement smoke FAILED');
	process.exit(1);
}
console.log('\u2713 every per-account price-input query filters blocked accounts');
console.log(`\u2713 all ${pass} price-input-block-enforcement scenarios passed`);
