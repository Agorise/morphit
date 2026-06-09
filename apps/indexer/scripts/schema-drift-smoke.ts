/**
 * schema-drift-smoke (cp217).
 *
 * The drift detector's correctness boundary is its PURE parser + diff: a
 * false "drift" would tell an operator to wipe a healthy DB, and a missed
 * structure would let the indexer boot against a schema it can't use. This
 * pins parseExpectedSchema against the REAL schema.sql (the parser must agree
 * with the file it ships beside), the false-positive guards (ALTER-added and
 * DROP COLUMN'd columns must NOT be expected, constraint lines must not be
 * read as columns), and the diff/report logic on hand-built inputs.
 *
 * The live-DB query (information_schema) needs Postgres and is exercised in
 * production, not here; only the pure logic is unit-tested.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	parseExpectedSchema,
	actualSchemaFromRows,
	diffSchema,
	formatDriftReport
} from '../src/db/schemaDrift.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(__dirname, '..', 'src', 'db', 'schema.sql');

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

const m2 = (o: Record<string, string[]>): Map<string, Set<string>> =>
	new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

// ── parseExpectedSchema against the real schema.sql ──────────────────
const sql = readFileSync(SCHEMA, 'utf8');
const expected = parseExpectedSchema(sql);

// Sane table count (catches a parser that collapses to nothing). The schema
// has 38 real tables today; assert a floor so legitimate additions don't
// break the smoke, but a broken parser (0–few tables) is caught.
if (expected.size >= 30) ok(`parses a healthy table count (${expected.size})`);
else bad('parseExpectedSchema table count too low', `got ${expected.size}, expected >= 30`);

// Known tables are present.
for (const t of [
	'schema_migrations',
	'orders',
	'ops',
	'profiles',
	'feedback',
	'accounts',
	'known_instances',
	'push_pending'
]) {
	if (expected.has(t)) ok(`table present: ${t}`);
	else bad(`expected table missing from parse: ${t}`);
}

// Known inline columns of `orders` are captured.
const orders = expected.get('orders') ?? new Set<string>();
for (const col of ['account', 'permlink', 'side', 'asset', 'fiat_currency', 'status']) {
	if (orders.has(col)) ok(`orders inline column captured: ${col}`);
	else bad(`orders inline column missing: ${col}`);
}

// FALSE-POSITIVE GUARDS — these must NOT be expected (else doctor would tell a
// healthy DB it has drift):
//   fee_status            → added via ALTER ADD COLUMN (not inline)
//   syndicate_opt_in      → added via ALTER then DROP COLUMN'd
//   amount_usd_equivalent → DROP COLUMN'd
if (!orders.has('fee_status')) ok('guard: orders.fee_status (ALTER-added) NOT expected');
else bad('orders.fee_status wrongly treated as inline → would false-positive');
if (!orders.has('syndicate_opt_in')) ok('guard: orders.syndicate_opt_in (dropped) NOT expected');
else bad('orders.syndicate_opt_in wrongly expected → would false-positive');
if (!orders.has('amount_usd_equivalent'))
	ok('guard: orders.amount_usd_equivalent (dropped) NOT expected');
else bad('orders.amount_usd_equivalent wrongly expected → would false-positive');
const pushPending = expected.get('push_pending') ?? new Set<string>();
if (!pushPending.has('attempts')) ok('guard: push_pending.attempts (dropped) NOT expected');
else bad('push_pending.attempts wrongly expected → would false-positive');

// No table-level constraint keyword leaked in as a "column".
const constraintWords = ['primary', 'foreign', 'unique', 'check', 'constraint', 'exclude', 'like'];
let leaked = '';
for (const [t, cols] of expected) {
	for (const c of cols) {
		if (constraintWords.includes(c)) {
			leaked = `${t}.${c}`;
			break;
		}
	}
	if (leaked) break;
}
if (!leaked) ok('no constraint keyword misread as a column');
else bad('constraint keyword read as a column', leaked);

// ── A standalone parse sanity check (constraint line + comment) ──────
const mini = `
CREATE TABLE IF NOT EXISTS t1 (
    id INT PRIMARY KEY,           -- inline comment, not a column
    name TEXT NOT NULL,
    kind TEXT CHECK (kind IN ('a', 'b')),
    PRIMARY KEY (id, name),
    CONSTRAINT t1_uq UNIQUE (name)
);
ALTER TABLE t1 DROP COLUMN IF EXISTS kind;
`;
const mp = parseExpectedSchema(mini);
const t1 = mp.get('t1') ?? new Set<string>();
if (t1.has('id') && t1.has('name')) ok('mini: real columns id, name captured');
else bad('mini: missed a real column', [...t1].join(','));
if (!t1.has('kind')) ok('mini: DROP COLUMN kind correctly removed from expected');
else bad('mini: dropped column kind still expected → would false-positive');
if (!t1.has('primary') && !t1.has('constraint') && !t1.has('check'))
	ok('mini: PRIMARY KEY / CONSTRAINT / CHECK lines not read as columns');
else bad('mini: a constraint line was read as a column', [...t1].join(','));

// ── diffSchema logic ─────────────────────────────────────────────────
{
	const exp = m2({ orders: ['a', 'b', 'c'], peers: ['x'] });
	const act = m2({ orders: ['a', 'b', 'c'], peers: ['x'] });
	const d = diffSchema(exp, act);
	if (d.missingTables.length === 0 && d.missingColumns.length === 0)
		ok('diff: identical schemas → no drift');
	else bad('diff: identical schemas reported drift', JSON.stringify(d));
}
{
	const exp = m2({ orders: ['a', 'b', 'c'], newtbl: ['x'] });
	const act = m2({ orders: ['a', 'b'] }); // missing newtbl entirely + orders.c
	const d = diffSchema(exp, act);
	const tablesOk = d.missingTables.length === 1 && d.missingTables[0] === 'newtbl';
	const colsOk =
		d.missingColumns.length === 1 &&
		d.missingColumns[0]!.table === 'orders' &&
		d.missingColumns[0]!.column === 'c';
	if (tablesOk && colsOk) ok('diff: detects missing table + missing column');
	else bad('diff: wrong missing set', JSON.stringify(d));
}
{
	// Actual having EXTRA columns the schema doesn't list is NOT drift (the
	// ALTER-added case): expected ⊆ actual → clean.
	const exp = m2({ orders: ['a'] });
	const act = m2({ orders: ['a', 'extra_added_via_alter'] });
	const d = diffSchema(exp, act);
	if (d.missingTables.length === 0 && d.missingColumns.length === 0)
		ok('diff: extra actual columns are not drift');
	else bad('diff: extra actual column wrongly flagged', JSON.stringify(d));
}
{
	const d = diffSchema(new Map(), new Map());
	if (d.missingTables.length === 0 && d.missingColumns.length === 0)
		ok('diff: empty vs empty → no drift');
	else bad('diff: empty inputs produced drift', JSON.stringify(d));
}

// ── actualSchemaFromRows ─────────────────────────────────────────────
{
	const rows = [
		{ table_name: 'Orders', column_name: 'Account' },
		{ table_name: 'orders', column_name: 'permlink' },
		{ table_name: 'ops', column_name: 'op_id' }
	];
	const a = actualSchemaFromRows(rows);
	if (a.get('orders')?.has('account') && a.get('orders')?.has('permlink') && a.get('ops')?.has('op_id'))
		ok('actualSchemaFromRows: lowercases + groups by table');
	else bad('actualSchemaFromRows wrong', JSON.stringify([...a]));
}

// ── formatDriftReport ────────────────────────────────────────────────
{
	const report = formatDriftReport({
		missingTables: ['peers'],
		missingColumns: [{ table: 'orders', column: 'c' }]
	});
	if (report.includes('peers') && report.includes('orders.c')) ok('formatDriftReport names the gaps');
	else bad('formatDriftReport missing detail', report);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 schema-drift smoke FAILED');
	process.exit(1);
}
console.log('\u2713 parser agrees with schema.sql; false-positive guards hold; diff/report correct');
console.log(`\u2713 all ${pass} schema-drift scenarios passed`);
