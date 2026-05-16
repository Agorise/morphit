#!/usr/bin/env tsx
/**
 * schema-migration-coverage-smoke — cross-check schema.sql's declared
 * head version against `MIGRATIONS[]` coverage in migrations.ts.
 *
 * Part 122 cp6 F8.  Tighter form of cp2 F5: instead of pinning a
 * brittle literal head-version COMMENT STRING, this smoke PARSES
 * both artifacts and pins the DERIVED NUMERIC values.  An editor
 * who tweaks the prose of the schema head banner (e.g. fixes a
 * typo in "multi-network") no longer breaks the sentinel — only
 * a semantic change (version number drift) does.
 *
 * Background: pre-launch, the indexer schema was collapsed —
 * `MIGRATIONS[]` has exactly ONE entry (version 1) with
 * `subsumesVersions: [2..27]`.  Subsequent schema changes (v28-v32)
 * were added INLINE as DDL appended after the collapsed base, NOT
 * as separate MIGRATIONS entries.  Only the head version (v32) has
 * an explicit `-- v<N>` banner; v28-v31 are unannotated inline DDL.
 *
 * Fresh deploys are fine — they apply schema.sql in full.  The
 * foot-gun is post-launch UPGRADE deploys where a new v33
 * inline-only DDL gets silently dropped because runMigrations()
 * sees v1 applied and has nothing else to do.
 *
 * The invariant this smoke defends:
 *
 *   (a) schema.sql's highest `-- v<N>` banner matches the pinned
 *       SCHEMA_HEAD_VERSION below.  Adding v33 forces a same-turn
 *       decision: bump SCHEMA_HEAD_VERSION here AND decide whether
 *       a MIGRATIONS[33] entry is needed.
 *
 *   (b) MIGRATIONS[]'s coverage (union of `version` + every
 *       `subsumesVersions[]` across entries) matches the pinned
 *       MIGRATIONS_COVERAGE_HIGH below.  Adding a MIGRATIONS[N]
 *       entry forces bumping COVERAGE_HIGH here.
 *
 *   (c) SCHEMA_HEAD_VERSION >= MIGRATIONS_COVERAGE_HIGH (sanity:
 *       MIGRATIONS[] can't claim to cover a version that doesn't
 *       exist in schema.sql).
 *
 * The gap SCHEMA_HEAD_VERSION - MIGRATIONS_COVERAGE_HIGH is the
 * pre-launch inline-only window (currently 5: v28-v32).  After
 * launch this gap closes naturally as new schema changes land as
 * MIGRATIONS[N] entries rather than inline DDL.
 *
 * Scenarios:
 *   1. schema.sql's highest `-- v<N>` banner === SCHEMA_HEAD_VERSION
 *   2. MIGRATIONS[] coverage highest === MIGRATIONS_COVERAGE_HIGH
 *   3. SCHEMA_HEAD_VERSION >= MIGRATIONS_COVERAGE_HIGH (sanity)
 *   4. No schema.sql `-- v<N>` banner above SCHEMA_HEAD_VERSION
 *      (catches the case where a developer adds v33 but forgets
 *      to bump the pin here)
 *
 * Usage:
 *   tsx apps/indexer/scripts/schema-migration-coverage-smoke.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SCHEMA_SQL = join(REPO_ROOT, 'apps', 'indexer', 'src', 'db', 'schema.sql');
const MIGRATIONS_TS = join(REPO_ROOT, 'apps', 'indexer', 'src', 'db', 'migrations.ts');

// ─── Pinned expected values (the contract this smoke defends) ─────
/** Highest `-- v<N>` banner in schema.sql.  Bump in lockstep
 *  with a schema change; the smoke fails until you do, which is
 *  the point. */
const SCHEMA_HEAD_VERSION = 33;
/** Highest version covered by MIGRATIONS[] (max of `version` or any
 *  `subsumesVersions[]` entry).  Bump only when a new MIGRATIONS
 *  entry lands. */
const MIGRATIONS_COVERAGE_HIGH = 27;

interface ScenarioResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: ScenarioResult[] = [];

function readFileOrFail(path: string): string {
	if (!existsSync(path)) {
		throw new Error(`required file missing: ${path}`);
	}
	return readFileSync(path, 'utf-8');
}

/** Parse `-- v<N>` head-section banners in schema.sql.  Only matches
 *  banner-style lines: `-- v<N>` followed by either end-of-line or
 *  ` / Part ...` continuation.  Excludes narrative references like
 *  `-- v5 used to add ...` or `-- v1-v27 stay with treasury IS NULL`
 *  by requiring the banner suffix pattern. */
function parseSchemaHeadBanners(): number[] {
	const src = readFileOrFail(SCHEMA_SQL);
	const found = new Set<number>();
	for (const line of src.split('\n')) {
		const m = /^--\s+v(\d+)(?:\s*$|\s+\/\s+)/.exec(line);
		if (m) {
			found.add(parseInt(m[1]!, 10));
		}
	}
	return [...found].sort((a, b) => a - b);
}

/** Parse MIGRATIONS[]: union of `version` + every `subsumesVersions[]`
 *  entry across all entries. */
function parseMigrationsCoverage(): number[] {
	const src = readFileOrFail(MIGRATIONS_TS);
	const covered = new Set<number>();
	for (const m of src.matchAll(/^\s*version:\s*(\d+),/gm)) {
		covered.add(parseInt(m[1]!, 10));
	}
	for (const block of src.matchAll(/subsumesVersions:\s*\[\s*([\d\s,\n]+?)\s*\]/g)) {
		const numbersInBlock = block[1]!.match(/\d+/g) ?? [];
		for (const n of numbersInBlock) {
			covered.add(parseInt(n, 10));
		}
	}
	return [...covered].sort((a, b) => a - b);
}

// ─── Run ──
const schemaBanners = parseSchemaHeadBanners();
const migrationsCoverage = parseMigrationsCoverage();
const schemaMax = schemaBanners.length > 0 ? Math.max(...schemaBanners) : 0;
const migrationsMax = migrationsCoverage.length > 0 ? Math.max(...migrationsCoverage) : 0;

results.push({
	name: `schema.sql highest -- v<N> banner === SCHEMA_HEAD_VERSION (${SCHEMA_HEAD_VERSION})`,
	ok: schemaMax === SCHEMA_HEAD_VERSION,
	detail:
		schemaMax === SCHEMA_HEAD_VERSION
			? undefined
			: `schema.sql highest banner: v${schemaMax}. Pinned SCHEMA_HEAD_VERSION: ${SCHEMA_HEAD_VERSION}.  ` +
			  `If you just added a schema change, bump SCHEMA_HEAD_VERSION in this smoke in lockstep, ` +
			  `AND decide whether the new version needs a MIGRATIONS[] entry (it does if upgrade-deploys need ` +
			  `the new DDL — pre-launch all deploys are fresh so the inline-only pattern is safe; post-launch this is a foot-gun).`
});

results.push({
	name: `MIGRATIONS[] coverage highest === MIGRATIONS_COVERAGE_HIGH (${MIGRATIONS_COVERAGE_HIGH})`,
	ok: migrationsMax === MIGRATIONS_COVERAGE_HIGH,
	detail:
		migrationsMax === MIGRATIONS_COVERAGE_HIGH
			? undefined
			: `MIGRATIONS[] highest version (union of version + subsumesVersions): v${migrationsMax}. ` +
			  `Pinned MIGRATIONS_COVERAGE_HIGH: ${MIGRATIONS_COVERAGE_HIGH}.  ` +
			  `If you added a MIGRATIONS[N] entry, bump MIGRATIONS_COVERAGE_HIGH here.`
});

results.push({
	name: `SCHEMA_HEAD_VERSION (${SCHEMA_HEAD_VERSION}) >= MIGRATIONS_COVERAGE_HIGH (${MIGRATIONS_COVERAGE_HIGH}) — sanity`,
	ok: SCHEMA_HEAD_VERSION >= MIGRATIONS_COVERAGE_HIGH,
	detail:
		SCHEMA_HEAD_VERSION >= MIGRATIONS_COVERAGE_HIGH
			? undefined
			: `MIGRATIONS[] claims to cover up to v${MIGRATIONS_COVERAGE_HIGH} but schema.sql tops out at v${SCHEMA_HEAD_VERSION}.  ` +
			  `MIGRATIONS[] can't cover a version that doesn't exist in the schema.`
});

const aboveHead = schemaBanners.filter((v) => v > SCHEMA_HEAD_VERSION);
results.push({
	name: `no schema.sql -- v<N> banner above pinned head`,
	ok: aboveHead.length === 0,
	detail:
		aboveHead.length === 0
			? undefined
			: `schema.sql has banners [${aboveHead.join(', ')}] above pinned SCHEMA_HEAD_VERSION=${SCHEMA_HEAD_VERSION}. Bump the pin.`
});

console.log(
	`schema-migration coverage smoke: ${results.length} scenarios ` +
		`(schema.sql banners=[${schemaBanners.join(',')}], ` +
		`MIGRATIONS[] coverage=[${migrationsCoverage.join(',')}], ` +
		`inline gap = v${migrationsMax + 1}..v${schemaMax} = ${schemaMax - migrationsMax} versions)\n`
);
let failed = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`  ✓ ${r.name}`);
	} else {
		console.log(`  ✗ ${r.name}`);
		if (r.detail) {
			for (const line of r.detail.split('\n')) {
				console.log(`      ${line}`);
			}
		}
		failed++;
	}
}
console.log('');
if (failed === 0) {
	console.log(`✓ all ${results.length} schema-migration coverage checks hold`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} failed, ${results.length - failed} passed`);
	process.exit(1);
}
