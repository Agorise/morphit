/**
 * indexer-state-columns-smoke (beta5).
 *
 * Regression guard for a real bug found this session: `morphit-ops
 * status` queried `indexer_state.last_block_num` / `last_block_at` /
 * `updated_at` — none of which exist. The actual columns are
 * `last_applied_block`, `last_applied_at`, `chain_id` (+ `id`). The
 * command crashed at runtime with `column "last_block_num" does not
 * exist`, and TypeScript can't catch it (SQL is a string).
 *
 * This smoke parses the indexer schema's `indexer_state` column set
 * and then checks every `SELECT … FROM indexer_state` query in the
 * ops-cli command sources references ONLY columns that exist. It also
 * asserts the columns the poller + ops-cli depend on are present, so a
 * future schema rename can't silently break the resume cursor.
 *
 * Pure static analysis — no DB required, runs in CI.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const SCHEMA = join(REPO, 'apps', 'indexer', 'src', 'db', 'schema.sql');
const CMD_DIR = join(REPO, 'apps', 'ops-cli', 'src', 'commands');

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

/** Extract the column names declared in a CREATE TABLE block. */
function schemaColumns(sql: string, table: string): Set<string> {
	const re = new RegExp(`CREATE TABLE[^(]*\\b${table}\\b\\s*\\(([\\s\\S]*?)\\n\\)`, 'i');
	const m = re.exec(sql);
	if (!m) throw new Error(`could not find CREATE TABLE for ${table}`);
	const body = m[1]!;
	const cols = new Set<string>();
	for (const rawLine of body.split('\n')) {
		const line = rawLine.trim();
		if (line === '') continue;
		// Skip table-level constraints.
		if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
		const id = /^([a-z_][a-z0-9_]*)/i.exec(line);
		if (id) cols.add(id[1]!.toLowerCase());
	}
	return cols;
}

/** Pull the column identifiers out of every `SELECT … FROM indexer_state`
 *  in a source file. Handles `col`, `col::text`, multi-line lists. */
function selectedColumns(src: string): string[] {
	const out: string[] = [];
	const re = /SELECT([\s\S]*?)\bFROM\s+indexer_state\b/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) {
		const list = m[1]!;
		for (let item of list.split(',')) {
			item = item.trim();
			if (item === '' || item === '*') continue;
			// strip ::cast
			item = item.split('::')[0]!.trim();
			// strip alias / function wrappers — keep a bare identifier only
			const id = /^([a-z_][a-z0-9_]*)$/i.exec(item);
			if (id) out.push(id[1]!.toLowerCase());
			else out.push(item.toLowerCase()); // non-bare (e.g. COUNT(*)) — flag below
		}
	}
	return out;
}

try {
	const schemaSql = readFileSync(SCHEMA, 'utf8');
	const cols = schemaColumns(schemaSql, 'indexer_state');

	// ── Scenario 1: schema has the columns the poller + status rely on ──
	for (const required of ['id', 'last_applied_block', 'last_applied_at', 'chain_id']) {
		if (cols.has(required)) ok(`schema indexer_state has column "${required}"`);
		else bad(`schema indexer_state is MISSING expected column "${required}"`, `found: ${[...cols].join(', ')}`);
	}

	// ── Scenario 2: the known-bad columns are NOT what ops-cli queries ──
	// ── Scenario 3: every indexer_state SELECT in ops-cli is valid ──────
	const files = readdirSync(CMD_DIR).filter((f) => f.endsWith('.ts'));
	let queriedAnywhere = 0;
	for (const f of files) {
		const src = readFileSync(join(CMD_DIR, f), 'utf8');
		if (!/FROM\s+indexer_state\b/i.test(src)) continue;
		const selected = selectedColumns(src);
		queriedAnywhere += selected.length;
		for (const c of selected) {
			if (!/^[a-z_][a-z0-9_]*$/.test(c)) {
				// non-bare expression (e.g. COUNT(*)) — skip, not a plain column
				continue;
			}
			if (cols.has(c)) {
				ok(`${f}: indexer_state query column "${c}" exists in schema`);
			} else {
				bad(
					`${f}: indexer_state query references NON-EXISTENT column "${c}"`,
					`schema columns: ${[...cols].join(', ')}`
				);
			}
		}
	}
	if (queriedAnywhere === 0) {
		bad('no indexer_state SELECT found in ops-cli — smoke would not catch the bug it guards');
	}
} catch (err) {
	bad('smoke threw', err instanceof Error ? err.message : String(err));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 indexer-state-columns smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} indexer-state-columns scenarios passed`);
