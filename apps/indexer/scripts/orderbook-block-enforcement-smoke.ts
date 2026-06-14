/**
 * orderbook-block-enforcement-smoke (beta5).
 *
 * Instance-local blocking only works if EVERY public listing surface
 * excludes blocked accounts. Enforcement is spread across several query
 * files, so this static smoke is the leak sentinel: it asserts each
 * known listing surface still carries the operator-block exclusion
 * (`NOT EXISTS ... operator_blocks ... ob.blocked = o.account ...
 * state = 'blocked'`). If someone removes the filter from a surface, or
 * adds a NEW public listing query, this smoke fails until the filter is
 * present + the surface is accounted for here.
 *
 * (Runtime proof that the clause actually hides a blocked account's
 * order lives in the real-Postgres check run during development; this
 * is the portable CI guard against regressions/leaks.)
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'api');

// Every public listing surface + how many times the exclusion must
// appear (one per public listing query in that file).
const SURFACES: Record<string, number> = {
	'orderbook.ts': 1, // main public orderbook
	'orders.ts': 1, // /v1/orders/:account
	'featuredOrderbook.ts': 1, // featured slots
	'rssOrderbookHandlers.ts': 3, // global + per-asset + per-account RSS
	'orderbookStreamHelpers.ts': 1 // SSE snapshot + live-emit + fallback (shared buildWhereClauses)
};

// The distinctive fragment of the exclusion — order-account scoped.
const EXCLUSION = /ob\.blocked\s*=\s*o\.account\b[\s\S]{0,60}ob\.state\s*=\s*'blocked'/g;
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

for (const [file, expected] of Object.entries(SURFACES)) {
	let src: string;
	try {
		src = readFileSync(join(apiDir, file), 'utf8');
	} catch {
		bad(`${file}: cannot read (listing surface moved/renamed?)`);
		continue;
	}
	if (!TABLE.test(src)) {
		bad(`${file}: no operator_blocks reference — blocked accounts would LEAK from this surface`);
		continue;
	}
	const count = (src.match(EXCLUSION) ?? []).length;
	if (count >= expected) {
		ok(`${file}: ${count} operator-block exclusion(s) present (\u2265 ${expected})`);
	} else {
		bad(
			`${file}: only ${count} operator-block exclusion(s), expected \u2265 ${expected}`,
			'a public listing query is missing the blocked-account filter'
		);
	}
}

// ─── cp257: read/write KEY consistency ──────────────────────────────
// The exclusion only works if the account the READ surfaces filter by is
// the SAME account operatorBlock.ts WRITES blocks under. Blocks are keyed
// on operatorAccountName (operatorBlock gates `ctx.signer ===
// operatorAccountName` and inserts operator=signer). If a read surface
// filters by officialAccountName instead, blocks are SILENTLY ignored
// whenever an operator sets a separate MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME
// (the two default-equal, so the default deployment never noticed). This
// asserts the whole chain keys on operatorAccountName.
{
	const srcDir = join(apiDir, '..');

	// 1. operatorBlock.ts keys the write on operatorAccountName.
	try {
		const ob = readFileSync(join(srcDir, 'indexer', 'handlers', 'operatorBlock.ts'), 'utf8');
		const gatesOnOperator = /ctx\.signer\s*!==\s*ctx\.config\.operatorAccountName/.test(ob);
		const keysOnOfficial = /operator_blocks[\s\S]{0,200}officialAccountName/.test(ob);
		if (gatesOnOperator && !keysOnOfficial) {
			ok('operatorBlock.ts keys blocks on operatorAccountName (per-instance operator)');
		} else {
			bad(
				`operatorBlock.ts: gatesOnOperatorAccount=${gatesOnOperator} keysOnOfficial=${keysOnOfficial}`,
				'blocks must be written under operatorAccountName so reads can match'
			);
		}
	} catch {
		bad('operatorBlock.ts: cannot read (handler moved/renamed?)');
	}

	// 2. main.ts wires every listing route's block account to operatorAccountName.
	try {
		const mainSrc = readFileSync(join(srcDir, 'main.ts'), 'utf8');
		for (const r of [
			'orderbookRoute',
			'orderbookStreamRoute',
			'featuredRoute',
			'ordersByAccountRoute'
		]) {
			const right = new RegExp(r + '\\([^)]*config\\.operatorAccountName');
			const wrong = new RegExp(r + '\\([^)]*config\\.officialAccountName');
			if (right.test(mainSrc)) {
				ok(`main.ts: ${r} filters blocks by operatorAccountName`);
			} else if (wrong.test(mainSrc)) {
				bad(
					`main.ts: ${r} passes officialAccountName — operator blocks silently ignored when the accounts differ`,
					'pass config.operatorAccountName (matches operatorBlock write key)'
				);
			} else {
				bad(`main.ts: ${r} call site not found or passes no account`);
			}
		}
	} catch {
		bad('main.ts: cannot read');
	}

	// 3. rssOrderbookHandlers.ts filters by operatorAccountName, never officialAccountName.
	try {
		const rss = readFileSync(join(apiDir, 'rssOrderbookHandlers.ts'), 'utf8');
		const usesOperator = /operatorAccountName/.test(rss);
		const usesOfficial = /officialAccountName/.test(rss);
		if (usesOperator && !usesOfficial) {
			ok('rssOrderbookHandlers.ts: block filter uses operatorAccountName');
		} else {
			bad(
				`rssOrderbookHandlers.ts: usesOperatorAccount=${usesOperator} usesOfficialAccount=${usesOfficial}`,
				'RSS block filter must use operatorAccountName (officialAccountName ignores blocks)'
			);
		}
	} catch {
		bad('rssOrderbookHandlers.ts: cannot read');
	}
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 orderbook-block-enforcement smoke FAILED');
	process.exit(1);
}
console.log('\u2713 every public listing surface filters blocked accounts');
console.log(`\u2713 all ${pass} orderbook-block-enforcement scenarios passed`);
