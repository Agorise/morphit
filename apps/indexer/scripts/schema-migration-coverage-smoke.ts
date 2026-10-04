#!/usr/bin/env tsx
/**
 * schema-migration-coverage-smoke — cross-check schema.sql's declared
 * head version against `MIGRATIONS[]` coverage in migrations.ts.
 *
 * Tighter form: instead of pinning a
 * brittle literal head-version COMMENT STRING, this smoke PARSES
 * both artifacts and pins the DERIVED NUMERIC values.  An editor
 * who tweaks the prose of the schema head banner (e.g. fixes a
 * typo in "multi-network") no longer breaks the sentinel — only
 * a semantic change (version number drift) does.
 *
 * Background: migration v1 is schema.sql, which stands in for the
 * collapsed versions 2..36 (`subsumesVersions`) and also carries a
 * `-- ─── vNN` section for every later version, so a fresh install has
 * the current schema after one file. An EXISTING database never
 * re-runs schema.sql: it gets each version from its own MIGRATIONS[N]
 * entry. The foot-gun is a change added to schema.sql only — fresh
 * installs get it, upgraded nodes silently do not.
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
 * The two are equal today: every schema.sql section has its
 * MIGRATIONS[N] entry. (Whether the two bodies agree is checked by
 * schemaDrift and, for v66, by test/integration/migration-v66-upgrade.)
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
 *  the point.  bumped 33 → 35 after the parser
 *  was widened to recognize the later banner format
 *  `-- ─── v<N>: <description>` (previously only `-- v<N> / ...`
 *  was recognized, silently undercounting v34 and v35). */
// v1.5.0: 43 → 45. v44 = orders.status += 'completed' (the
// morphit_order_complete_v1 op); v45 = user_settings, the ENCRYPTED
// settings-to-chain blob. Both verified present + idempotent in schema.sql
// AND migrations.ts before bumping — this pin attests to that, it is not a
// rubber stamp. The guard caught these: v44/v45 were added in earlier v1.5.0
// turns without the same-turn bump it exists to force.
// v1.18.0: 59 → 60. v60 = push_pending.source_trx_id comment correction (F17b),
// present in BOTH schema.sql (banner at the end) and MIGRATIONS[] — checked.
// v1.18.0: 60 → 61. v61 = accounts.posting_key_reconciled (F37), present in BOTH
// schema.sql (banner at the end) and MIGRATIONS[] — checked.
// v1.20.0: 61 → 62. v62 = accounts unconfirmed-posting-key partial index +
// corrected posting_key_reconciled comment (E1), present in BOTH schema.sql
// (banner at the end) and MIGRATIONS[] — checked.
// v1.20.0: 62 → 63. v63 = orders.fee_rechecked_at + idx_orders_fee_recheck (G3,
// fair persistent BTC/XMR fee re-check), present in BOTH schema.sql (banner at
// the end) and MIGRATIONS[] — checked.
// v1.20.0: 63 → 65. v64 = operator_fee_recipients + fee_reverify_done (G1, P);
// v65 = per-order BTC fee addresses: btc_fee_address_log, orders.btc_fee_*,
// fee_status 'awaiting_payment' (MK-H2, M), orders.xmr_{tx_key,payment_id,fee_address},
// fee_status 'proof_unsupported' (M-X1). Both present in schema.sql (banners
// at the end) and MIGRATIONS[] — checked.
// 65 → 66: chat/account/avatar indexes, one queued dust refill per recipient,
// push_subscriptions and order_views data minimised. Present in both schema.sql
// (banner at the end) and MIGRATIONS[]; the upgrade path is exercised by
// test/integration/migration-v66-upgrade.test.ts.
const SCHEMA_HEAD_VERSION = 66;
/** Highest version covered by MIGRATIONS[] (max of `version` or any
 *  `subsumesVersions[]` entry).  Bump only when a new MIGRATIONS
 *  entry lands.  bumped 27 → 35 when
 *  `subsumesVersions` was extended to match the in-place
 *  v28-v35 sections in schema.sql.  bumped 36 → 37 when the
 *  accepted_assets migration (v37) landed.  bumped 41 → 42
 *  when the chat_folders migration (v42) landed. */
// v1.5.0: 43 → 45, in lockstep with SCHEMA_HEAD_VERSION above.
// v1.18.0: 59 → 60, in lockstep with SCHEMA_HEAD_VERSION above.
// v1.18.0: 60 → 61, in lockstep with SCHEMA_HEAD_VERSION above.
// v1.20.0: 61 → 62, in lockstep with SCHEMA_HEAD_VERSION above.
// v1.20.0: 62 → 63 (G3), in lockstep with SCHEMA_HEAD_VERSION above.
// v1.20.0: 63 → 65 (G1 v64, MK-H2 v65), in lockstep with SCHEMA_HEAD_VERSION above.
// 65 → 66, in lockstep with SCHEMA_HEAD_VERSION above.
const MIGRATIONS_COVERAGE_HIGH = 66;

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
 *  Format A (used through v33):
 *      `-- v<N>` followed by end-of-line OR ` / Part ...` continuation
 *  Format B (used for v34 and v35):
 *      `-- ─── v<N>:` (box-decorator prefix + colon separator)
 *
 *  older the regex only recognized Format A,
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
		// characters appear in later schema sections.  We don't
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
