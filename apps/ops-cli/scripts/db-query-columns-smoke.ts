/**
 * db-query-columns-smoke.
 *
 * Generalizes indexer-state-columns-smoke to EVERY table the ops-cli
 * DB commands query. It exists because two real bugs (`abuse` and
 * `flags` selecting a `reason` column that only exists on
 * `related_accounts`, not on `suspicious_reciprocity`) shipped past
 * tsc, the static menu checks, and dispatch wiring — they only surfaced
 * when the query hit a real Postgres. tsc can't catch a SQL string
 * referencing a column that doesn't exist; this smoke can.
 *
 * What it checks, statically, against apps/indexer/src/db/schema.sql:
 *   1. Every table named in a FROM/JOIN of an ops-cli SELECT exists.
 *   2. For every SINGLE-table SELECT (no JOIN — unqualified columns are
 *      unambiguous there), each BARE column identifier in the select
 *      list is a real column of that table.
 *
 * It is deliberately conservative: anything that isn't a plain bare
 * identifier (expressions, casts, `||`, function calls, `AS` aliases,
 * table-qualified `t.col`, literals) is skipped, so it never
 * false-positives on synthesized columns like
 * `round(avg_rating::numeric,2) AS score`. The phantom `reason` (a
 * bare identifier) is exactly what it flags.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const schemaSql = readFileSync(
	join(repoRoot, 'apps/indexer/src/db/schema.sql'),
	'utf8'
);
const commandsDir = join(repoRoot, 'apps/ops-cli/src/commands');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, detail = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (detail) console.log(`      ${detail}`);
};

// ── Parse all CREATE TABLE column sets from the schema ──────────────
function allSchemaTables(sql: string): Map<string, Set<string>> {
	const tables = new Map<string, Set<string>>();
	const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\)/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(sql)) !== null) {
		const table = m[1]!.toLowerCase();
		const cols = new Set<string>();
		for (const rawLine of m[2]!.split('\n')) {
			const line = rawLine.trim();
			if (line === '') continue;
			if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
			const id = /^([a-z_][a-z0-9_]*)/i.exec(line);
			if (id) cols.add(id[1]!.toLowerCase());
		}
		tables.set(table, cols);
	}
	return tables;
}

// A bare column reference = a plain identifier, optionally ::cast.
// Anything with spaces, parens, quotes, ||, '.', digits-leading, or an
// AS alias is an expression/literal and is intentionally NOT checked.
function bareColumn(rawItem: string): string | null {
	let item = rawItem.trim();
	if (item === '' || item === '*') return null;
	// strip a trailing ::cast (but not if there's other structure)
	item = item.split('::')[0]!.trim();
	if (!/^[a-z_][a-z0-9_]*$/i.test(item)) return null; // expression / alias / qualified / literal
	const lower = item.toLowerCase();
	// SQL literals that can appear bare in a select list
	if (lower === 'null' || lower === 'true' || lower === 'false') return null;
	return lower;
}

const tables = allSchemaTables(schemaSql);
console.log(`  (parsed ${tables.size} tables from schema.sql)`);

let tableChecks = 0;
let columnChecks = 0;
let skippedJoinBlocks = 0;

for (const file of readdirSync(commandsDir).filter((f) => f.endsWith('.ts'))) {
	const src = readFileSync(join(commandsDir, file), 'utf8');
	// Every backtick-delimited query string that starts with SELECT.
	const qRe = /`(\s*SELECT[\s\S]*?)`/gi;
	let qm: RegExpExecArray | null;
	while ((qm = qRe.exec(src)) !== null) {
		const query = qm[1]!;

		// 1) Every FROM/JOIN table must exist.
		const tableRe = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
		let tm: RegExpExecArray | null;
		const referenced: string[] = [];
		while ((tm = tableRe.exec(query)) !== null) referenced.push(tm[1]!.toLowerCase());
		for (const t of referenced) {
			tableChecks++;
			if (!tables.has(t)) bad(`${file}: query references unknown table "${t}"`, query.trim().slice(0, 80));
		}

		// 2) Single-table SELECT (no JOIN): check bare columns.
		if (/\bJOIN\b/i.test(query)) {
			skippedJoinBlocks++;
			continue;
		}
		const fromMatch = /\bFROM\s+([a-z_][a-z0-9_]*)/i.exec(query);
		const selMatch = /SELECT([\s\S]*?)\bFROM\b/i.exec(query);
		if (!fromMatch || !selMatch) continue;
		const table = fromMatch[1]!.toLowerCase();
		const cols = tables.get(table);
		if (!cols) continue; // already flagged as unknown table above
		for (const item of selMatch[1]!.split(',')) {
			const col = bareColumn(item);
			if (col === null) continue; // expression / alias — skip
			columnChecks++;
			if (!cols.has(col)) {
				bad(
					`${file}: SELECT references column "${col}" not present on table "${table}"`,
					`real columns: ${[...cols].join(', ')}`
				);
			}
		}
	}
}

if (fail === 0) {
	ok(`all bare columns valid (${columnChecks} column refs, ${tableChecks} table refs checked; ${skippedJoinBlocks} JOIN blocks skipped for column-check)`);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 db-query-columns smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} db-query-columns scenarios passed`);
