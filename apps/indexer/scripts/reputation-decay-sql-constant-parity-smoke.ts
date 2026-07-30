#!/usr/bin/env tsx
/*
 * reputation-decay-sql-constant-parity — cp175 F-011 guard.
 *
 * The reputation time-decay weight is defined ONCE as a constant +
 * helper in apps/indexer/src/indexer/reputation/decay.ts
 * (REPUTATION_DECAY_HALF_LIFE_DAYS = 365, and reputationDecayWeightSql()).
 * But the SQL formula `POWER(0.5, EXTRACT(EPOCH FROM (NOW() - <col>)) /
 * (365 * 86400.0))` is hand-INLINED in the live query files
 * (api/feedback.ts ×6, api/orderbook.ts, api/orderbookStream.ts) with the
 * 365 as a magic number — and reputationDecayWeightSql() is currently
 * unused (F-011).
 *
 * The risk: the JS implementation (reputationDecayWeight, used by the
 * verifiable-receipt endpoint so readers re-derive scores locally) IS
 * guarded against the constant by reputation-decay-smoke. The SQL path is
 * NOT. If someone changed REPUTATION_DECAY_HALF_LIFE_DAYS, the JS receipt
 * and the SQL rating query would silently diverge — a user would compute a
 * different reputation locally than the server displays.
 *
 * This sentinel asserts every inlined decay half-life literal in the API
 * SQL equals REPUTATION_DECAY_HALF_LIFE_DAYS, so the duplication can't drift.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPUTATION_DECAY_HALF_LIFE_DAYS } from '../src/indexer/reputation/decay';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');

const FILES = ['api/feedback.ts', 'api/orderbook.ts', 'api/orderbookStream.ts'];

// Match the inlined decay denominator: `(<N> * 86400` where N is the
// half-life-in-days literal baked into the SQL.
const DECAY_LITERAL_RE = /\((\d+)\s*\*\s*86400(?:\.0)?\)/g;

let pass = 0;
let fail = 0;
function ok(name: string): void {
	console.log(`  ✓ ${name}`);
	pass++;
}
function bad(name: string, detail: string): void {
	console.log(`  ✗ ${name}: ${detail}`);
	fail++;
}

console.log('\n── reputation-decay-sql-constant-parity (cp175 F-011 guard) ──\n');
console.log(`  (canonical REPUTATION_DECAY_HALF_LIFE_DAYS = ${REPUTATION_DECAY_HALF_LIFE_DAYS})\n`);

let totalLiterals = 0;
let mismatches = 0;
for (const rel of FILES) {
	const src = readFileSync(resolve(SRC, rel), 'utf8');
	const found: string[] = [];
	let m: RegExpExecArray | null;
	DECAY_LITERAL_RE.lastIndex = 0;
	while ((m = DECAY_LITERAL_RE.exec(src)) !== null) {
		found.push(m[1] ?? '');
	}
	if (found.length === 0) {
		// orderbook files may legitimately have 0 if decay isn't used there anymore
		ok(`${rel}: no inlined decay literal (fine)`);
		continue;
	}
	totalLiterals += found.length;
	const wrong = found.filter((n) => Number(n) !== REPUTATION_DECAY_HALF_LIFE_DAYS);
	if (wrong.length === 0) {
		ok(`${rel}: all ${found.length} inlined decay literal(s) = ${REPUTATION_DECAY_HALF_LIFE_DAYS}`);
	} else {
		mismatches += wrong.length;
		bad(
			`${rel}`,
			`${wrong.length} inlined decay literal(s) are ${[...new Set(wrong)].join(',')}, expected ${REPUTATION_DECAY_HALF_LIFE_DAYS} (drift from the constant — see cp175 F-011)`
		);
	}
}

if (totalLiterals < 6) {
	bad('discovery', `expected ≥6 inlined decay literals (feedback.ts alone has 6), found ${totalLiterals}. If the SQL was refactored onto reputationDecayWeightSql(), update/retire this sentinel.`);
} else if (mismatches === 0) {
	ok(`all ${totalLiterals} inlined SQL decay literals across the API match the canonical constant`);
}

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
