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
 *   expected = (inline columns in each CREATE TABLE), then every TOP-LEVEL
 *   `ALTER TABLE … ADD COLUMN …` and `… DROP COLUMN …` applied in file order.
 *   A fresh build of schema.sql runs every top-level statement, so this still
 *   guarantees `expected ⊆ (a DB freshly built from this same schema.sql)`,
 *   and on a matching DB the diff is always empty — drift only fires when a
 *   structure is genuinely absent. Statements inside DO blocks (conditional)
 *   are NOT counted. There are no DROP TABLE statements in the baseline, so
 *   the table set has no removals to track.
 *
 *   v1.18.0 deep-deep (rv2-10): ALTER-added columns used to be skipped
 *   entirely, and the two trust columns the chat fast path depends on —
 *   `accounts.posting_pubkey` and `accounts.posting_key_reconciled` — are
 *   added exactly that way. A database missing `posting_key_reconciled`
 *   while `schema_migrations` recorded v61 was reported healthy, and the
 *   dispatcher's UPDATE then failed on every account_update block.
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

	// Top-level ALTER TABLE … ADD COLUMN / DROP COLUMN, in file order (rv2-10).
	// A column added and later dropped is not expected; one added is.
	const alterRe =
		/^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+([\s\S]*)$/i;
	const addRe = /^\s*ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i;
	const dropColRe = /^\s*DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i;
	for (const stmt of topLevelStatements(sql)) {
		const a = alterRe.exec(stmt);
		if (!a) continue;
		const cols = tables.get(a[1]!.toLowerCase());
		if (cols === undefined) continue;
		for (const clause of splitTopLevel(a[2]!)) {
			const add = addRe.exec(clause);
			if (add) {
				cols.add(add[1]!.toLowerCase());
				continue;
			}
			const drop = dropColRe.exec(clause);
			if (drop) cols.delete(drop[1]!.toLowerCase());
		}
	}

	return tables;
}

/**
 * The top-level statements of a SQL file, in order, with comments removed and
 * the bodies of dollar-quoted blocks (DO $$ … $$, function bodies) blanked —
 * what runs inside them is conditional, so it is never "expected". PURE.
 */
export function topLevelStatements(sql: string): string[] {
	const out: string[] = [];
	let cur = '';
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i]!;
		if (ch === '-' && sql[i + 1] === '-') {
			const nl = sql.indexOf('\n', i);
			i = nl === -1 ? sql.length : nl;
			continue;
		}
		if (ch === "'") {
			const start = i;
			i++;
			while (i < sql.length) {
				if (sql[i] === "'") {
					if (sql[i + 1] === "'") i += 2;
					else break;
				} else i++;
			}
			cur += sql.slice(start, i + 1);
			i++;
			continue;
		}
		if (ch === '$') {
			const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
			if (tag) {
				const end = sql.indexOf(tag[0], i + tag[0].length);
				i = end === -1 ? sql.length : end + tag[0].length;
				cur += ' $$ ';
				continue;
			}
		}
		if (ch === ';') {
			out.push(cur);
			cur = '';
			i++;
			continue;
		}
		cur += ch;
		i++;
	}
	if (cur.trim() !== '') out.push(cur);
	return out;
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

/**
 * Index names schema.sql creates. PURE.
 *
 * Same conservative rule the column parser follows: only forms a FRESH build
 * of this same file would certainly create, so `expected ⊆ actual` holds on a
 * matching database and drift can only fire on a genuine absence. All 54
 * index statements in the baseline are plain top-level `CREATE [UNIQUE] INDEX
 * [IF NOT EXISTS] name ON ...`; anything created conditionally inside a DO
 * block is deliberately not matched.
 */
export function parseExpectedIndexes(sql: string): Set<string> {
	const out = new Set<string>();
	const re =
		/^[ \t]*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ON\s/gim;
	let m: RegExpExecArray | null;
	while ((m = re.exec(sql)) !== null) out.add(m[1]!.toLowerCase());

	// SUBTRACT anything the same file later drops — the exact counterpart of
	// the column parser's DROP COLUMN rule, and not a hypothetical: the
	// baseline creates `orders_verified_live_idx` and drops it a thousand lines
	// later in favour of a differently-named one. Without this, a perfectly
	// healthy database is reported as drifted, which is worse than not checking
	// at all: `morphit-ops doctor` would tell every operator their schema is
	// broken and the next real drift would be read as more of the same noise.
	// Caught by running the checker against a live database rather than by
	// reading the regex.
	const dropRe = /^[ \t]*DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([^;]+);/gim;
	while ((m = dropRe.exec(sql)) !== null) {
		for (const raw of m[1]!.split(',')) {
			const name = raw.trim().replace(/^"|"$/g, '').split('.').pop();
			if (name !== undefined) out.delete(name.toLowerCase());
		}
	}
	return out;
}

/**
 * The subset of {@link parseExpectedIndexes} declared UNIQUE. PURE.
 *
 * Kept separately because a unique index is load-bearing in a way an ordinary
 * one is not: `INSERT … ON CONFLICT` requires it, and a same-named index that
 * is not unique satisfies a name check while giving Postgres nothing to
 * arbitrate with (42P10, exactly as if it were absent).
 */
export function parseExpectedUniqueIndexes(sql: string): Set<string> {
	const all = parseExpectedIndexes(sql);
	const out = new Set<string>();
	const re =
		/^[ \t]*CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ON\s/gim;
	let m: RegExpExecArray | null;
	while ((m = re.exec(sql)) !== null) {
		const name = m[1]!.toLowerCase();
		if (all.has(name)) out.add(name);
	}
	return out;
}

/** One live index as the catalogue describes it. */
export interface LiveIndex {
	readonly name: string;
	/** Postgres will use it: built completely (`indisvalid`) and maintained
	 *  (`indisready`). */
	readonly usable: boolean;
	readonly unique: boolean;
}

/**
 * Which live indexes count as PRESENT for the drift check. PURE.
 *
 * NAME IS NOT ENOUGH (v1.18.0 review, D3). A `CREATE UNIQUE INDEX
 * CONCURRENTLY` that fails — on a duplicate, which is exactly when an operator
 * is running it to repair the push index — leaves an index of that NAME behind,
 * marked invalid. `pg_indexes` lists it; Postgres ignores it for
 * `ON CONFLICT`; `IF NOT EXISTS` then skips re-creating it. Checked by name,
 * doctor called that database healthy while every chat and feedback push was
 * being dropped. An index counts only if Postgres would use it, and an index
 * schema.sql declares UNIQUE counts only if it is unique.
 */
export function presentIndexes(
	live: readonly LiveIndex[],
	expectedUnique: ReadonlySet<string>
): Set<string> {
	const out = new Set<string>();
	for (const ix of live) {
		const name = ix.name.toLowerCase();
		if (!ix.usable) continue;
		if (expectedUnique.has(name) && !ix.unique) continue;
		out.add(name);
	}
	return out;
}

export interface SchemaDiff {
	readonly missingTables: string[];
	readonly missingColumns: Array<{ table: string; column: string }>;
	/**
	 * Indexes schema.sql creates that the live DB does not have.
	 *
	 * ADDED AFTER A NEAR-MISS. A missing index reads like a performance
	 * problem, so it is tempting to leave out of a boot-readiness check. It is
	 * not always one: an `INSERT ... ON CONFLICT (cols) WHERE pred` requires a
	 * matching unique index, and without it Postgres does not fall back — it
	 * raises 42P10. The chat and feedback push enqueues do exactly that and
	 * catch their own errors, so a missing
	 * `push_pending_account_source_trx_uidx` means every chat and feedback
	 * notification is silently dropped: no rows, no duplicates, no
	 * notifications, one log line per message. (The outbid notification in
	 * handlers/featureBid.ts has no ON CONFLICT and keeps working, which makes
	 * the symptom harder to read, not easier.) This checker existed precisely
	 * to catch "your database is missing structures this version expects" and
	 * compared only tables and columns, so it would have called that database
	 * a match.
	 */
	readonly missingIndexes: string[];
}

/** Diff expected vs actual. PURE. Reports only what the installed version
 *  expects that the live DB LACKS (the boot-relevant, in-place-edit case). */
export function diffSchema(
	expected: Map<string, Set<string>>,
	actual: Map<string, Set<string>>,
	expectedIndexes: ReadonlySet<string> = new Set(),
	actualIndexes: ReadonlySet<string> = new Set()
): SchemaDiff {
	const missingTables: string[] = [];
	const missingColumns: Array<{ table: string; column: string }> = [];
	const missingIndexes: string[] = [];
	for (const name of expectedIndexes) if (!actualIndexes.has(name)) missingIndexes.push(name);
	missingIndexes.sort();
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
	return { missingTables, missingColumns, missingIndexes };
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
	// Optional-chained on purpose. This string is printed during
	// `morphit-ops doctor`; a formatter that throws on an older-shaped diff
	// would take the whole report down with it, which is a strictly worse
	// outcome than omitting one line. The field is required by the type — this
	// guards the callers that build a diff literal by hand.
	if ((diff.missingIndexes?.length ?? 0) > 0) {
		parts.push(`missing index(es): ${diff.missingIndexes.join(', ')}`);
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
	const empty: SchemaDiff = { missingTables: [], missingColumns: [], missingIndexes: [] };
	let rows: Array<{ table_name: string; column_name: string }>;
	try {
		// `current_schema()`, NOT a literal 'public'. This must name the schema
		// the indexer's own unqualified queries resolve against, which is that
		// one by definition — and the two halves of this check have to agree with
		// each other, or a database could be audited for its columns in one
		// schema and its indexes in another and reported sound on the strength of
		// neither. In the ordinary deployment (default search_path, no per-role
		// schema) this is 'public' and nothing changes.
		const res = await db.query<{ table_name: string; column_name: string }>(
			`SELECT table_name, column_name
			   FROM information_schema.columns
			  WHERE table_schema = current_schema()`
		);
		rows = res.rows;
	} catch {
		return { ok: true, dbReachable: false, diff: empty };
	}

	// Indexes come from pg_indexes rather than information_schema, which does
	// not model them. A failure here is treated as "no information" rather than
	// "none exist", so a permissions oddity cannot invent drift.
	const sql = readFileSync(resolve(HERE, 'schema.sql'), 'utf8');
	let actualIndexes = new Set<string>();
	let indexesKnown = true;
	try {
		// pg_index, not pg_indexes: the view lists an index Postgres will not use
		// (a failed concurrent build) exactly like a good one. See presentIndexes.
		const ix = await db.query<{ name: string; usable: boolean; unique: boolean }>(
			`SELECT c.relname AS name,
			        (i.indisvalid AND i.indisready) AS usable,
			        i.indisunique AS unique
			   FROM pg_index i
			   JOIN pg_class c ON c.oid = i.indexrelid
			   JOIN pg_namespace n ON n.oid = c.relnamespace
			  WHERE n.nspname = current_schema()`
		);
		actualIndexes = presentIndexes(ix.rows, parseExpectedUniqueIndexes(sql));
	} catch {
		indexesKnown = false;
	}

	const expected = parseExpectedSchema(sql);
	const actual = actualSchemaFromRows(rows);
	const diff = diffSchema(
		expected,
		actual,
		indexesKnown ? parseExpectedIndexes(sql) : new Set(),
		actualIndexes
	);
	const ok =
		diff.missingTables.length === 0 &&
		diff.missingColumns.length === 0 &&
		diff.missingIndexes.length === 0;
	return { ok, dbReachable: true, diff };
}
