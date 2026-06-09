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

import { schemaBaselineChanged } from '../src/commands/upgrade.ts';

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
if (/schemaBaselineChanged\(backupDir, installDir\)/.test(upgradeSrc))
	ok('upgrade.ts computes schemaChanged from backup vs new install');
else bad('upgrade.ts no longer computes schemaChanged (backupDir vs installDir)');
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

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 upgrade-schema-reminder smoke FAILED');
	process.exit(1);
}
console.log('\u2713 schemaBaselineChanged correct; upgrade reminder + doctor check + indexer mode all wired');
console.log(`\u2713 all ${pass} upgrade-schema-reminder scenarios passed`);
