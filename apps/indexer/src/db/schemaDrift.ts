/**
 * Schema-drift detector (cp217).
 *
 * The PRE-LAUNCH reality: the schema is a single collapsed `v1` baseline
 * (schema.sql) that is edited IN PLACE rather than via new numbered
 * migrations. An existing DB already has v1 recorded in `schema_migrations`,
 * so when schema.sql gains a table/column in a later build, restarting the
 * upgraded indexer does NOT re-run schema.sql on that DB — the new structures
 * never land, and the new code may query columns the DB doesn't have.
 *
 * This module detects exactly that: it parses schema.sql for what the
 * INSTALLED version expects, queries the live DB's actual structure, and
 * reports anything the DB is MISSING. Surfaced by the indexer's
 * `--check-schema` mode (and thus by `morphit-ops doctor`).
 *
 * FALSE-POSITIVE SAFETY (the parser is deliberately conservative):
 *   expected = (inline columns in each CREATE TABLE) MINUS (any column named
 *   in an `ALTER TABLE … DROP COLUMN …`). Columns ADDED via `ALTER TABLE …
 *   ADD COLUMN …` are intentionally NOT counted as expected. This guarantees
 *   `expected ⊆ (a DB freshly built from this same schema.sql)`, so on a
 *   matching DB the diff is always empty — drift only fires when a structure
 *   is genuinely absent. The cost is that a column added purely via ALTER ADD
 *   (rare) won't be checked — a false NEGATIVE, which degrades safely to the
 *   prior behaviour (rely on release notes). There are no DROP TABLE
 *   statements in the baseline, so the table set has no removals to track.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { Database } from '$db/pool';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Column-segment leading words that mark a TABLE CONSTRAINT, not a column. */
const CONSTRAINT_WORDS = new Set([
	'primary',
	'foreign',
	'unique',
	'check',
	'constraint',
	'exclude',
	'like'
]);

/** Find the index of the `)` matching the `(` at `openIdx`, skipping over
 *  single-quoted strings and `--` line comments. Returns -1 if unbalanced. */
function matchParen(sql: string, openIdx: number): number {
	let depth = 0;
	let inStr = false;
	for (let i = openIdx; i < sql.length; i++) {
		const ch = sql[i];
		if (inStr) {
			if (ch === "'") {
				// '' is an escaped quote inside a string — stay in string.
				if (sql[i + 1] === "'") i++;
				else inStr = false;
			}
			continue;
		}
		if (ch === "'") {
			inStr = true;
			continue;
		}
		if (ch === '-' && sql[i + 1] === '-') {
			// line comment — skip to end of line
			const nl = sql.indexOf('\n', i);
			if (nl === -1) return -1;
			i = nl;
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Split a CREATE TABLE body (text between the outer parens) into top-level
 *  comma-separated segments, respecting nested parens, strings, and line
 *  comments. */
function splitTopLevel(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr = false;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (inStr) {
			if (ch === "'") {
				if (body[i + 1] === "'") i++;
				else inStr = false;
			}
			continue;
		}
		if (ch === "'") {
			inStr = true;
			continue;
		}
		if (ch === '-' && body[i + 1] === '-') {
			const nl = body.indexOf('\n', i);
			if (nl === -1) {
				i = body.length;
			} else {
				i = nl;
			}
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			out.push(body.slice(start, i));
			start = i + 1;
		}
	}
	out.push(body.slice(start));
	return out;
}

/** Strip `--` line comments from a segment, then return the first identifier
 *  token (the column name), lowercased — or null if the segment is a table
 *  constraint, a comment, or empty. */
function columnNameFromSegment(segment: string): string | null {
	// Remove line comments line-by-line.
	const cleaned = segment
		.split('\n')
		.map((line) => {
			const c = line.indexOf('--');
			return c === -1 ? line : line.slice(0, c);
		})
		.join(' ')
		.trim();
	if (cleaned.length === 0) return null;
	const m = /^"?([A-Za-z_][A-Za-z0-9_]*)"?/.exec(cleaned);
	if (!m) return null;
	const word = m[1]!.toLowerCase();
	if (CONSTRAINT_WORDS.has(word)) return null;
	return word;
}

/**
 * Parse schema.sql into the set of tables and columns the installed version
 * expects. PURE. See the FALSE-POSITIVE SAFETY note at the top of the file.
 */
export function parseExpectedSchema(sql: string): Map<string, Set<string>> {
	const tables = new Map<string, Set<string>>();

	const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi;
	let m: RegExpExecArray | null;
	while ((m = createRe.exec(sql)) !== null) {
		const table = m[1]!.toLowerCase();
		const openIdx = sql.indexOf('(', m.index + m[0].length - 1);
		if (openIdx === -1) continue;
		const closeIdx = matchParen(sql, openIdx);
		if (closeIdx === -1) continue;
		const body = sql.slice(openIdx + 1, closeIdx);
		const cols = tables.get(table) ?? new Set<string>();
		for (const seg of splitTopLevel(body)) {
			const col = columnNameFromSegment(seg);
			if (col !== null) cols.add(col);
		}
		tables.set(table, cols);
		createRe.lastIndex = closeIdx;
	}

	// Subtract any DROP COLUMN'd column so we never expect a column the real
	// (matching) DB wouldn't have. \s+ spans newlines (multi-line ALTERs).
	const dropRe =
		/ALTER\s+TABLE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
	while ((m = dropRe.exec(sql)) !== null) {
		const table = m[1]!.toLowerCase();
		const col = m[2]!.toLowerCase();
		tables.get(table)?.delete(col);
	}

	return tables;
}

/** Build the actual (table → columns) map from an information_schema query. */
export function actualSchemaFromRows(
	rows: ReadonlyArray<{ table_name: string; column_name: string }>
): Map<string, Set<string>> {
	const actual = new Map<string, Set<string>>();
	for (const r of rows) {
		const t = r.table_name.toLowerCase();
		const set = actual.get(t) ?? new Set<string>();
		set.add(r.column_name.toLowerCase());
		actual.set(t, set);
	}
	return actual;
}

export interface SchemaDiff {
	readonly missingTables: string[];
	readonly missingColumns: Array<{ table: string; column: string }>;
}

/** Diff expected vs actual. PURE. Reports only what the installed version
 *  expects that the live DB LACKS (the boot-relevant, in-place-edit case). */
export function diffSchema(
	expected: Map<string, Set<string>>,
	actual: Map<string, Set<string>>
): SchemaDiff {
	const missingTables: string[] = [];
	const missingColumns: Array<{ table: string; column: string }> = [];
	for (const [table, cols] of expected) {
		const have = actual.get(table);
		if (have === undefined) {
			missingTables.push(table);
			continue;
		}
		for (const col of cols) {
			if (!have.has(col)) missingColumns.push({ table, column: col });
		}
	}
	missingTables.sort();
	missingColumns.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
	return { missingTables, missingColumns };
}

/** Human-readable drift report. PURE. */
export function formatDriftReport(diff: SchemaDiff): string {
	const parts: string[] = [];
	if (diff.missingTables.length > 0) {
		parts.push(`missing table(s): ${diff.missingTables.join(', ')}`);
	}
	if (diff.missingColumns.length > 0) {
		parts.push(
			`missing column(s): ${diff.missingColumns.map((c) => `${c.table}.${c.column}`).join(', ')}`
		);
	}
	return parts.join('; ');
}

export interface SchemaCheckResult {
	readonly ok: boolean;
	readonly dbReachable: boolean;
	readonly diff: SchemaDiff;
}

/**
 * Read schema.sql, query the live DB's structure, and diff. Read-only (a
 * single SELECT against information_schema). If the DB can't be reached,
 * returns dbReachable:false and ok:true (a transient DB-down during a
 * read-only audit is not a schema problem).
 */
export async function checkSchemaDrift(db: Database): Promise<SchemaCheckResult> {
	const empty: SchemaDiff = { missingTables: [], missingColumns: [] };
	let rows: Array<{ table_name: string; column_name: string }>;
	try {
		const res = await db.query<{ table_name: string; column_name: string }>(
			`SELECT table_name, column_name
			   FROM information_schema.columns
			  WHERE table_schema = 'public'`
		);
		rows = res.rows;
	} catch {
		return { ok: true, dbReachable: false, diff: empty };
	}

	const sql = readFileSync(resolve(HERE, 'schema.sql'), 'utf8');
	const expected = parseExpectedSchema(sql);
	const actual = actualSchemaFromRows(rows);
	const diff = diffSchema(expected, actual);
	const ok = diff.missingTables.length === 0 && diff.missingColumns.length === 0;
	return { ok, dbReachable: true, diff };
}
