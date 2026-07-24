/**
 * upgrade-schema-reminder-smoke (cp217).
 *
 * Two features tie together here: `upgrade` warns when it crosses an indexer
 * schema.sql change, and `doctor` (via the indexer's --check-schema) detects
 * an actual drifted DB. This pins the pure detector schemaBaselineChanged AND
 * the structural wiring across all three files — a regression that silently
 * unwires either half (the reminder, the doctor step, or the indexer mode)
 * would leave an operator upgrading across a schema change with no signal.
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { schemaBaselineChanged, splitSchemaSections } from '../src/commands/upgrade.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const SCHEMA_REL = join('apps', 'indexer', 'src', 'db', 'schema.sql');

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

/** Make a fake install dir; optionally write a schema.sql with given text. */
function mkInstall(schemaText: string | null): string {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-up-'));
	if (schemaText !== null) {
		const p = join(dir, SCHEMA_REL);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, schemaText, 'utf8');
	}
	return dir;
}

const cleanup: string[] = [];
const track = (d: string): string => {
	cleanup.push(d);
	return d;
};

// ── schemaBaselineChanged behaviour ──────────────────────────────────
{
	const a = track(mkInstall('CREATE TABLE x (id INT);\n'));
	const b = track(mkInstall('CREATE TABLE x (id INT);\n'));
	if (schemaBaselineChanged(a, b) === false) ok('identical schema.sql → not changed');
	else bad('identical schema.sql reported as changed');
}
{
	const a = track(mkInstall('CREATE TABLE x (id INT);\n'));
	const b = track(mkInstall('CREATE TABLE x (id INT, name TEXT);\n'));
	if (schemaBaselineChanged(a, b) === true) ok('different schema.sql → changed');
	else bad('different schema.sql NOT detected as changed');
}
{
	const a = track(mkInstall(null)); // no schema.sql in old
	const b = track(mkInstall('CREATE TABLE x (id INT);\n'));
	if (schemaBaselineChanged(a, b) === false) ok('missing old schema.sql → false (do not nag)');
	else bad('missing old schema.sql should be false');
}
{
	const a = track(mkInstall('CREATE TABLE x (id INT);\n'));
	const b = track(mkInstall(null)); // no schema.sql in new
	if (schemaBaselineChanged(a, b) === false) ok('missing new schema.sql → false (do not nag)');
	else bad('missing new schema.sql should be false');
}

for (const d of cleanup) {
	try {
		rmSync(d, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

// ── Structural wiring across the three files ─────────────────────────
const upgradeSrc = readFileSync(join(REPO, 'apps', 'ops-cli', 'src', 'commands', 'upgrade.ts'), 'utf8');
const doctorSrc = readFileSync(join(REPO, 'apps', 'ops-cli', 'src', 'commands', 'doctor.ts'), 'utf8');
const indexerMain = readFileSync(join(REPO, 'apps', 'indexer', 'src', 'main.ts'), 'utf8');

// upgrade.ts: exports + calls the detector, and prints a reminder that points
// the operator at doctor + OPERATIONS §23.
if (/export function schemaBaselineChanged/.test(upgradeSrc)) ok('upgrade.ts exports schemaBaselineChanged');
else bad('upgrade.ts no longer exports schemaBaselineChanged');
// v1.8.12 (Ken) — this used to require `schemaBaselineChanged(backupDir,
// installDir)` directly, which is a WEAKER condition than the warning needs.
// That function only diffs schema.sql; it says nothing about whether a
// numbered migration carries the change to existing databases. So ANY schema
// edit fired the "changed IN PLACE — not via a numbered migration" reminder,
// even when a migration existed and had already been applied at indexer
// start-up. Ken hit that upgrading to v1.8.12 (which ships MIGRATION 51): his
// DB was correctly updated and the upgrade told him it was not, pointing him
// at a reset + re-sync. A false alarm that recommends rebuilding a database
// costs more than no alarm.
// The requirement is now the STRONGER one — BOTH conditions.
if (/schemaChangedWithoutMigration\(backupDir, installDir\)/.test(upgradeSrc))
	ok('upgrade.ts gates the reminder on schema-change AND no-new-migration');
else bad('upgrade.ts must use schemaChangedWithoutMigration, not the bare schema diff');
if (/export function schemaChangedWithoutMigration/.test(upgradeSrc))
	ok('upgrade.ts exports schemaChangedWithoutMigration');
else bad('upgrade.ts no longer exports schemaChangedWithoutMigration');
if (/export function highestMigrationVersion/.test(upgradeSrc))
	ok('upgrade.ts can read the tree\'s highest migration version');
else bad('upgrade.ts cannot determine whether a new migration shipped');
if (/if \(schemaChanged\)/.test(upgradeSrc)) ok('upgrade.ts gates the reminder on schemaChanged');
else bad('upgrade.ts reminder not gated on schemaChanged');
if (/database schema changed/i.test(upgradeSrc) && /doctor/.test(upgradeSrc) && /\u00a746/.test(upgradeSrc))
	ok('upgrade.ts reminder points to doctor + OPERATIONS §46');
else bad('upgrade.ts reminder text missing doctor / §46 pointer');

// doctor.ts: runs the indexer --check-schema, has the --no-db skip, emits the
// schema JSON field, and prints a "Database schema" advisory.
if (/'--check-schema'/.test(doctorSrc)) ok('doctor.ts runs the indexer --check-schema');
else bad('doctor.ts no longer runs --check-schema');
if (/'no-db'/.test(doctorSrc)) ok('doctor.ts honours --no-db');
else bad('doctor.ts --no-db flag missing');
if (/schema:/.test(doctorSrc) && /drift: !schema\.ok/.test(doctorSrc))
	ok('doctor.ts emits the schema field in JSON');
else bad('doctor.ts schema JSON field missing');
if (/Database schema/.test(doctorSrc)) ok('doctor.ts prints a Database schema advisory line');
else bad('doctor.ts Database schema human report missing');
// checkService must be parameterised (not hardcoded --check-config).
if (/checkFlag: '--check-config' \| '--check-schema'/.test(doctorSrc))
	ok('doctor.ts checkService is parameterised by check flag');
else bad('doctor.ts checkService not parameterised for --check-schema');

// indexer main.ts: the --check-schema branch + the drift check import.
if (/process\.argv\.includes\('--check-schema'\)/.test(indexerMain))
	ok('indexer main.ts has the --check-schema branch');
else bad('indexer main.ts --check-schema branch missing');
if (/checkSchemaDrift/.test(indexerMain) && /formatDriftReport/.test(indexerMain))
	ok('indexer main.ts imports + uses the drift check');
else bad('indexer main.ts drift check not wired');
if (/\[check-schema\]/.test(indexerMain)) ok('indexer main.ts emits [check-schema] lines doctor parses');
else bad('indexer main.ts [check-schema] output missing');

// ─── cp447: additive migrations must NOT tell operators to reset the DB ──────
//
// This misfired for real on the v1.3.0 → v1.3.5 upgrade (migration 39, chat
// read-state threading). The detector was a byte-diff of schema.sql, so it told
// the operator their database "may need a reset" for a migration the indexer
// applies by itself at start-up. Resetting a chain-derived DB that did not need
// it is hours of re-sync for nothing — and it teaches operators to ignore the
// warning that will one day be real.
console.log('\n── cp447: additive section vs in-place edit ──');

const BASE = [
	'-- preamble',
	'CREATE TABLE t (a TEXT);',
	'',
	'-- \u2500\u2500\u2500 v1 (initial schema) \u2500\u2500\u2500',
	'CREATE TABLE u (b TEXT);',
	''
].join('\n');

const PLUS_SECTION =
	BASE + ['-- \u2500\u2500\u2500 v2 \u2500\u2500\u2500', 'ALTER TABLE u ADD COLUMN c TEXT;', ''].join('\n');

// cp466 — the real-world append: a blank line is placed BEFORE the new marker
// (the schema.sql convention), which lands in the formerly-last section's body.
// That is boundary whitespace, not a schema change, and must NOT warn.
const PLUS_SECTION_BLANK_BEFORE_MARKER =
	BASE + ['', '-- \u2500\u2500\u2500 v2 \u2500\u2500\u2500', 'ALTER TABLE u ADD COLUMN c TEXT;', ''].join('\n');

const cases: [string, string, boolean][] = [
	['an APPENDED v<N> section is a numbered migration — no reset warning', PLUS_SECTION, false],
	['a later append adding a boundary blank line to the previous section does NOT warn (cp466)', PLUS_SECTION_BLANK_BEFORE_MARKER, false],
	['an IN-PLACE edit to an existing section still warns', BASE.replace('CREATE TABLE u (b TEXT);', 'CREATE TABLE u (b TEXT, c TEXT);'), true],
	['an edit to the collapsed preamble still warns', BASE.replace('CREATE TABLE t (a TEXT);', 'CREATE TABLE t (a TEXT, z TEXT);'), true],
	['a REMOVED section warns — the DB holds structures the code forgot', BASE.split('-- \u2500\u2500\u2500 v1')[0], true],
	['an identical schema.sql never warns', BASE, false]
];

const oldInstall = mkInstall(BASE);
for (const [name, newSql, expected] of cases) {
	const got = schemaBaselineChanged(oldInstall, mkInstall(newSql));
	if (got === expected) ok(name);
	else bad(name, `expected ${expected}, got ${got}`);
}

// The real thing: this repo's schema.sql with its NEWEST section removed is what
// the previous release shipped. Upgrading across it must be silent.
{
	const realSql = readFileSync(join(REPO, SCHEMA_REL), 'utf8');
	const sections = splitSchemaSections(realSql);
	const newest = Math.max(...[...sections.keys()]);
	const previousSql = [...sections.entries()]
		.filter(([v]) => v !== newest)
		.sort((a, b) => a[0] - b[0])
		.map(([, body]) => body)
		.join('');
	const got = schemaBaselineChanged(mkInstall(previousSql), mkInstall(realSql));
	if (got === false) ok(`this repo\u2019s newest section (v${newest}) is additive — no warning`);
	else bad(`this repo\u2019s newest section (v${newest}) must not warn`, `got ${got}`);

	// …and the same file compared against a doctored copy whose v1 body was
	// rewritten MUST warn, so the guard cannot be satisfied by always returning false.
	const tampered = realSql.replace('CREATE TABLE IF NOT EXISTS chat_read_state (', 'CREATE TABLE IF NOT EXISTS chat_read_state ( -- tampered\n');
	const got2 = schemaBaselineChanged(mkInstall(realSql), mkInstall(tampered));
	if (got2 === true) ok('a rewritten baseline table body in the REAL schema still warns');
	else bad('a rewritten baseline table body must warn', `got ${got2}`);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 upgrade-schema-reminder smoke FAILED');
	process.exit(1);
}
console.log('\u2713 schemaBaselineChanged correct; upgrade reminder + doctor check + indexer mode all wired');
console.log(`\u2713 all ${pass} upgrade-schema-reminder scenarios passed`);

