#!/usr/bin/env tsx
/**
 * operators-query-column-parity-smoke.ts (v1.15.7)
 *
 * The bug this catches: federationProbe.ts did `LEFT JOIN operators o` and
 * SELECTed `o.last_action_block_num` — a column that was never added to the
 * `operators` table. Against a real Postgres this throws "column
 * o.last_action_block_num does not exist" on EVERY probe scan, so the probe
 * never runs and the federation directory's cached name/tagline go stale. The
 * existing federation-probe smoke MOCKS the DB, so the raw SQL is never run
 * against a real schema and the missing column sailed through CI.
 *
 * This is the cheap, no-Postgres guard: statically reconcile every
 * operators-aliased column the probe references against the ACTUAL operators
 * column set (CREATE TABLE operators in schema.sql + every `ALTER TABLE
 * operators ADD COLUMN` in migrations.ts). If the probe SELECTs a column the
 * schema doesn't have, this fails — loudly, in CI, before a deploy crashes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

let pass = 0;
const fails: string[] = [];
const ok = (m: string): void => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string): void => {
	fails.push(m);
	console.log(`  \u2717 ${m}`);
};

// ── 1. the authoritative operators column set ──────────────────────
const schema = read('db/schema.sql');
const migrations = read('db/migrations.ts');
const cols = new Set<string>();

// CREATE TABLE ... operators ( ... );
const create = schema.match(/CREATE TABLE (?:IF NOT EXISTS )?operators\s*\(([\s\S]*?)\n\s*\);/i);
if (!create) {
	bad('could not locate CREATE TABLE operators in schema.sql');
} else {
	for (const rawLine of create[1]!.split('\n')) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('--')) continue;
		// Skip table-level constraints, not columns.
		if (/^(UNIQUE|PRIMARY|FOREIGN|CHECK|CONSTRAINT|EXCLUDE)\b/i.test(line)) continue;
		const m = line.match(/^([a-z_][a-z0-9_]*)\b/i);
		if (m) cols.add(m[1]!.toLowerCase());
	}
}
// every ALTER TABLE operators ADD COLUMN [IF NOT EXISTS] <col> — in migrations.ts
// AND in schema.sql itself (v1.18.0 deep-deep, M4: `operators.origin` is added
// by an ALTER in schema.sql, which this scan used to miss, so the probe's new
// read of `o2.origin` was reported as a missing column although it exists).
for (const m of (schema + '\n' + migrations).matchAll(/ALTER TABLE operators\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
	cols.add(m[1]!.toLowerCase());
}
if (cols.size >= 6) ok(`operators column set resolved (${cols.size} columns incl. ${[...cols].slice(0, 3).join(', ')}…)`);
else bad(`operators column set looks too small (${cols.size}) — extraction likely broke`);

// The regression sentinel: the column whose absence caused the crash MUST be
// in the set now (added by migration v58).
if (cols.has('last_action_block_num')) ok('operators.last_action_block_num exists (the column the probe crashed on)');
else bad('operators.last_action_block_num is MISSING from the schema — the federation probe will crash on every scan');

// ── 2. every operators-aliased column the probe references ─────────
const probe = read('indexer/federationProbe.ts');
// Aliases bound to the operators table: `... operators <alias>` / `... operators AS <alias>`.
const aliases = new Set<string>();
for (const m of probe.matchAll(/\b(?:JOIN|FROM)\s+operators\s+(?:AS\s+)?([a-z][a-z0-9_]*)\b/gi)) {
	aliases.add(m[1]!.toLowerCase());
}
if (aliases.size > 0) ok(`probe binds operators alias(es): ${[...aliases].join(', ')}`);
else bad('could not find an operators alias in federationProbe.ts (join pattern changed?)');

let referenced = 0;
for (const alias of aliases) {
	const re = new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'gi');
	for (const m of probe.matchAll(re)) {
		const col = m[1]!.toLowerCase();
		referenced++;
		if (cols.has(col)) ok(`probe reads ${alias}.${col} → exists in operators`);
		else bad(`probe reads ${alias}.${col} → NO SUCH COLUMN in operators (would crash the scan)`);
	}
}
if (referenced === 0) bad('found no <alias>.<col> operators references in the probe — sanity check failed');

console.log('');
if (fails.length > 0) {
	console.log(`\u2717 ${fails.length} of ${pass + fails.length} operators-query-column-parity checks FAILED`);
	for (const f of fails) console.log(`    - ${f}`);
	process.exit(1);
}
console.log(`\u2713 all ${pass} operators-query-column-parity scenarios passed`);
