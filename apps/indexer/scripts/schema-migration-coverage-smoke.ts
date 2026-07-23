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
 *  the point.  cp131 DEEP-003 — bumped 33 → 35 after the parser
 *  was widened to recognize the cp123/cp127-era banner format
 *  `-- ─── v<N>: <description>` (previously only `-- v<N> / ...`
 *  was recognized, silently undercounting v34 and v35). */
// v1.5.0 (cp471): 43 → 45. v44 = orders.status += 'completed' (the
// morphit_order_complete_v1 op); v45 = user_settings, the ENCRYPTED
// settings-to-chain blob. Both verified present + idempotent in schema.sql
// AND migrations.ts before bumping — this pin attests to that, it is not a
// rubber stamp. The guard caught these: v44/v45 were added in earlier v1.5.0
// turns without the same-turn bump it exists to force.
const SCHEMA_HEAD_VERSION = 51;
/** Highest version covered by MIGRATIONS[] (max of `version` or any
 *  `subsumesVersions[]` entry).  Bump only when a new MIGRATIONS
 *  entry lands.  cp131 DEEP-002 — bumped 27 → 35 when
 *  `subsumesVersions` was extended to match the in-place
 *  v28-v35 sections in schema.sql.  cp425 — bumped 36 → 37 when the
 *  accepted_assets migration (v37) landed.  cp466 — bumped 41 → 42
 *  when the chat_folders migration (v42, t.txt #5) landed. */
// v1.5.0 (cp471): 43 → 45, in lockstep with SCHEMA_HEAD_VERSION above.
const MIGRATIONS_COVERAGE_HIGH = 51;

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

/** Parse `-- v<N>` head-section banners in schema.sql.  Recognizes
 *  two banner formats that coexist in the codebase:
 *
 *  Format A (cp82-era, used through v33):
 *      `-- v<N>` followed by end-of-line OR ` / Part ...` continuation
 *  Format B (cp123/cp127-era, used for v34 and v35):
 *      `-- ─── v<N>:` (box-decorator prefix + colon separator)
 *
 *  cp131 DEEP-003 — pre-cp131 the regex only recognized Format A,
 *  silently undercounting v34 (review_concentration) and v35
 *  (price_drift_baseline).  Both formats are now accepted.
 *
 *  Excludes narrative references like `-- v5 used to add ...` or
 *  `-- v1-v27 stay with treasury IS NULL` by requiring one of the
 *  two banner suffix patterns. */
function parseSchemaHeadBanners(): number[] {
	const src = readFileOrFail(SCHEMA_SQL);
	const found = new Set<number>();
	for (const line of src.split('\n')) {
		// Format A: -- v<N> at start, optional / continuation
		const mA = /^--\s+v(\d+)(?:\s*$|\s+\/\s+)/.exec(line);
		if (mA) {
			found.add(parseInt(mA[1]!, 10));
			continue;
		}
		// Format B: -- ─── v<N>: <description> ─── (box-decorator
		// frame).  The non-ASCII U+2500/2501-class box-drawing
		// characters appear in cp123+ schema sections.  We don't
		// pin the exact decorator characters — any non-word run
		// between `-- ` and `v<N>` is accepted, since the
		// alternative is to babysit a unicode allowlist that
		// drifts with the editor's mood.
		const mB = /^--\s+\W+\s*v(\d+)\s*:/.exec(line);
		if (mB) {
			found.add(parseInt(mB[1]!, 10));
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
