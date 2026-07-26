#!/usr/bin/env tsx
/**
 * Smoke: the orderbook "I want to see" side filter flips BARTER's direction
 * (Ken, t.txt v1.8.16 #3).
 *
 * The filter options are phrased in CRYPTO terms — "posts wanting to buy crypto"
 * / "…sell crypto". For an ordinary crypto/fiat order, `o.side` already IS the
 * crypto direction. But a BARTER (goods/services) order stores `o.side` as the
 * GOODS direction, which is the INVERSE: selling goods (bananas) = ACQUIRING
 * crypto = buying crypto; buying goods = SPENDING crypto = selling crypto. The
 * old code spliced `o.side = <side>` for every order, so a banana-seller wrongly
 * appeared under "wanting to sell crypto".
 *
 * This pins:
 *   - `cryptoFacingSideWhere` binds the requested side to the non-barter branch
 *     and the OPPOSITE side to the barter branch, both ways;
 *   - the SQL is two index-usable equality branches keyed on `o.asset`;
 *   - BARTER is the SOLE goods asset (so the 'BARTER' literal is exhaustive);
 *   - all THREE orderbook surfaces — snapshot (orderbook.ts), live SSE stream
 *     (orderbookStreamHelpers.ts) and RSS (rssOrderbookHandlers.ts) — call the
 *     shared helper and NONE keeps a raw `o.side = ${p(...)}` clause, so they
 *     can never drift apart on barter.
 *
 * Usage (from apps/indexer): tsx scripts/orderbook-side-barter-flip-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cryptoFacingSideWhere } from '../src/api/shared.ts';
import { ASSET_TICKERS, isGoodsAsset } from '@morphit/asset-registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = join(__dirname, '..', 'src', 'api');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
};
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Positional-param registrar identical in shape to the handlers'. */
function makeP(): { p: (v: unknown) => string; params: unknown[] } {
	const params: unknown[] = [];
	return {
		params,
		p: (v: unknown): string => {
			params.push(v);
			return `$${params.length}`;
		}
	};
}

// --- side = 'buy' → non-barter matches 'buy', barter matches 'sell' ---
{
	const { p, params } = makeP();
	const sql = cryptoFacingSideWhere('buy', p);
	check(
		"buy: non-barter branch binds the SAME side ('buy')",
		sql.includes("(o.asset <> 'BARTER' AND o.side = $1)") && params[0] === 'buy'
	);
	check(
		"buy: barter branch binds the OPPOSITE side ('sell')",
		sql.includes("(o.asset = 'BARTER' AND o.side = $2)") && params[1] === 'sell'
	);
	check('buy: exactly two params bound', params.length === 2);
}

// --- side = 'sell' → non-barter matches 'sell', barter matches 'buy' ---
{
	const { p, params } = makeP();
	const sql = cryptoFacingSideWhere('sell', p);
	check(
		"sell: non-barter branch binds the SAME side ('sell')",
		sql.includes("(o.asset <> 'BARTER' AND o.side = $1)") && params[0] === 'sell'
	);
	check(
		"sell: barter branch binds the OPPOSITE side ('buy')",
		sql.includes("(o.asset = 'BARTER' AND o.side = $2)") && params[1] === 'buy'
	);
	check('sell: exactly two params bound', eq(params, ['sell', 'buy']));
}

// --- structure: two OR'd equality branches keyed on o.asset (index-usable) ---
{
	const { p } = makeP();
	const sql = cryptoFacingSideWhere('buy', p);
	check('two branches OR-combined', / OR /.test(sql) && sql.startsWith('((') && sql.endsWith('))'));
	check('keys on o.asset both ways', sql.includes("o.asset <> 'BARTER'") && sql.includes("o.asset = 'BARTER'"));
	check('no per-row CASE (o.side stays index-usable)', !/CASE/i.test(sql));
}

// --- BARTER is the SOLE goods asset, so the 'BARTER' literal is exhaustive ---
check(
	'BARTER is the only goods asset in the registry',
	eq(ASSET_TICKERS.filter(isGoodsAsset), ['BARTER'])
);
check('isGoodsAsset("BARTER") is true', isGoodsAsset('BARTER'));

// --- all three surfaces call the shared helper; none keeps a raw side clause ---
function strip(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
		.join('\n');
}
for (const file of ['orderbook.ts', 'orderbookStreamHelpers.ts', 'rssOrderbookHandlers.ts']) {
	const code = strip(readFileSync(join(API, file), 'utf8'));
	check(`${file} calls cryptoFacingSideWhere`, /cryptoFacingSideWhere\s*\(/.test(code));
	check(
		`${file} imports it from $api/shared`,
		/import\s*\{[^}]*cryptoFacingSideWhere[^}]*\}\s*from\s*'\$api\/shared'/.test(code)
	);
	check(
		`${file} keeps NO raw \`o.side = \${p(...)}\` clause (can't drift from the flip)`,
		!/o\.side\s*=\s*\$\{\s*p\(/.test(code)
	);
}

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} orderbook-side-barter-flip scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} orderbook-side-barter-flip checks FAILED`);
	process.exit(1);
}
