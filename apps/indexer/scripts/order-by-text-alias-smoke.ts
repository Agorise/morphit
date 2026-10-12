#!/usr/bin/env tsx
/**
 * order-by-text-alias-smoke — no query sorts by a number it re-selected as text.
 *
 * In Postgres, a bare name in ORDER BY means an OUTPUT column first. A query
 * that selects `id::text` (output name `id`) or `block_num::text AS block_num`
 * and then says `ORDER BY id` / `ORDER BY block_num` sorts the TEXT: "100"
 * before "99". Keyset paging over such a sort skips rows wherever the numbers
 * change length, because the cursor compares numbers (v1.21.6: the chat
 * history, both review lists and the chat stream's catch-up lost rows inside
 * one block; block-number sorts would have broken at block 100,000,000).
 *
 * The fix is to name the table's column in ORDER BY (`chat_messages.id`,
 * `ops.block_num`). This smoke reads every SQL template literal under
 * apps/indexer/src and fails on an unqualified ORDER BY term that matches a
 * `::text` output name of the same literal (a subquery's ORDER BY too: it is
 * cheaper to qualify one than to tell it apart). A select list built from an
 * interpolated constant (chatStream's ROW_SELECT) is not seen here; its
 * queries are tested on real Postgres in test/integration/one-block-id-order.test.ts.
 *
 * Tamper-tested: reverting any of the qualified ORDER BYs fails this smoke.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...files(p));
		else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
	}
	return out;
}

/** Output names of `expr::text` select items: the alias, or the column name. */
function textOutputNames(sql: string): Set<string> {
	const names = new Set<string>();
	const re = /(?:\b\w+\.)?\b(\w+)::text\b(?:\s+AS\s+(\w+))?/gi;
	for (const m of sql.matchAll(re)) {
		// `x::text AS y` outputs y; `x::text` outputs x — unless it is inside a
		// larger expression, which this pattern does not claim to see.
		names.add((m[2] ?? m[1]!).toLowerCase());
	}
	return names;
}

const failures: string[] = [];
let literals = 0;
for (const f of files(ROOT)) {
	const src = readFileSync(f, 'utf8');
	for (const lit of src.matchAll(/`([^`]*)`/g)) {
		const sql = lit[1]!;
		if (!/\bSELECT\b/i.test(sql) || !/\bORDER\s+BY\b/i.test(sql)) continue;
		literals++;
		const textNames = textOutputNames(sql);
		if (textNames.size === 0) continue;
		for (const ob of sql.matchAll(/\bORDER\s+BY\s+([^`;]*?)(?=\bLIMIT\b|\bOFFSET\b|\)|$)/gis)) {
			for (const term of ob[1]!.split(',')) {
				const name = /^\s*(\w+)\s*(?:ASC|DESC)?\s*(?:NULLS\s+(?:FIRST|LAST))?\s*$/i.exec(term)?.[1];
				if (name && textNames.has(name.toLowerCase())) {
					const line = src.slice(0, lit.index).split('\n').length;
					failures.push(
						`${relative(join(ROOT, '..'), f)}:${line}  ORDER BY ${name} sorts the ::text copy`
					);
				}
			}
		}
	}
}

if (literals < 50) {
	console.error(`✗ only ${literals} SQL literals with ORDER BY found — the scan is broken`);
	process.exit(1);
}
if (failures.length > 0) {
	for (const x of failures) console.error(`✗ ${x}`);
	console.error(`✗ ${failures.length} ORDER BY term(s) sort a number as text`);
	process.exit(1);
}
console.log(`✓ all ${literals} SQL literals with ORDER BY sort numbers as numbers`);
