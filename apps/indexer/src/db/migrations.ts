/**
 * Morphit indexer — database migrations.
 *
 * Simplest possible migration story: a numbered list of SQL files (or
 * inline SQL strings) each wrapped in a transaction, applied in
 * order, tracked in `schema_migrations`. No ORM, no framework. Works
 * the way `psql -f schema.sql` would, but idempotent and traceable.
 *
 * Run modes:
 *   - default: apply any migrations not yet recorded
 *   - --rebuild-materialized: drop and re-derive materialised tables
 *     from the event log, for class-2 migrations per ADR-0008.
 *
 * Called both from main.ts on boot (ensures DB is current before the
 * poller starts) and from the CLI via `npm run migrate`.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type pg from 'pg';
import { loadConfig } from '$config';
import { createDatabase, type Database } from '$db/pool';
import { logger } from '$log';

const log = logger('migrate');

const HERE = dirname(fileURLToPath(import.meta.url));

/** A migration is an (integer) version and the SQL that implements it.
 *  Versions must be strictly increasing and gap-free starting at 1.
 *
 *  `subsumesVersions`: if set, the runner records this list of
 *  additional versions in `schema_migrations` along with the migration's
 *  own version.  Used by the v1 collapsed schema to mark v2-v27 as
 *  applied (they were merged into v1 during the May 2026 audit).
 *  Without this, downstream code that checks "is v15 applied?" would
 *  break on a fresh deploy. */
interface Migration {
	readonly version: number;
	readonly description: string;
	readonly sqlPath?: string;
	readonly sql?: string;
	readonly subsumesVersions?: readonly number[];
}

const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		description: 'collapsed canonical schema (v1-v36 merged in-place; pre-launch baseline)',
		sqlPath: resolve(HERE, 'schema.sql'),
		// On a fresh DB, mark all the historical versions as applied
		// so any downstream check "is v15 applied?" sees true.  The
		// collapsed schema produces byte-for-byte the same end state
		// as applying v1-v36 incrementally; this list preserves the
		// version-tracking semantics.  The original per-version files
		// are archived under apps/indexer/src/db/historical/ for
		// archaeology.
		//
		// cp131 DEEP-002 — list extended 2..27 → 2..35 to match the
		// actual section markers in schema.sql (v28, v33.1/v33.2,
		// v34, v35 sections were added in-place during cp82+ work
		// rather than as separate migration entries, contrary to the
		// original cp82 "future migrations land here at v28" framing).
		// cp404 — extended 2..35 → 2..36 for the v36 accounts.posting_pubkey
		// section, likewise added in-place. A fresh DB gets the column from
		// this baseline schema.sql; an existing beta DB (already recorded at
		// v1, so the baseline won't re-run) gets it from the idempotent
		// ADD COLUMN in postingKeyBackfill.ts at boot.
		// The v1 collapsed schema is the pre-launch baseline; the
		// first separate additive migration will be assigned an
		// integer version at launch.
		subsumesVersions: [
			2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
			18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
			32, 33, 34, 35, 36
		]
	}
	// Future migrations land here.  The v1 collapsed schema is the
	// pre-launch baseline; the first separate additive migration to
	// be assigned an integer version will land here at launch.  From
	// that point forward, every new schema change is its own
	// additive migration with its own version number.  No further
	// collapse should happen until well after 1.0.0 ships.
];

/** Validate the MIGRATIONS array at load time:
 *    - versions strictly increasing
 *    - gap-free starting at 1
 *    - matching schema-vN.sql files exist (when sqlPath used)
 *    - subsumesVersions are gap-free and don't overlap with declared
 *      versions
 *
 *  G1 audit fix: a missing version (v24 was skipped between v23 and
 *  v25) caused the corresponding schema file to silently never be
 *  applied.  This check turns a silent gap into a loud boot-time
 *  error so the same kind of regression can't slip in again.
 *
 *  Throws on any violation.  Called once at module scope below. */
function validateMigrationsContract(): void {
	for (let i = 0; i < MIGRATIONS.length; i++) {
		const expected = i + 1;
		const actual = MIGRATIONS[i]!.version;
		if (actual !== expected) {
			throw new Error(
				`migrations contract violated: MIGRATIONS[${i}] has version=${actual}, ` +
					`expected ${expected}.  Versions must be strictly increasing and gap-free ` +
					`starting at 1.  If schema-v${expected}.sql exists but isn't in the list, ` +
					`the runner will silently never apply it.`
			);
		}
	}
	// Validate subsumesVersions across the array: each subsumed
	// version must be unique globally (no two migrations claim the
	// same historical version), must be > the migration's own
	// version, and the overall set (declared + subsumed) must be
	// gap-free starting at 1.  This guards against future collapse
	// operations introducing silent gaps.
	const declaredVersions = new Set(MIGRATIONS.map((m) => m.version));
	const subsumedSeen = new Map<number, number>(); // version → migration that subsumed it
	for (const m of MIGRATIONS) {
		for (const v of m.subsumesVersions ?? []) {
			if (declaredVersions.has(v)) {
				throw new Error(
					`migrations contract violated: version ${v} is both declared and ` +
						`listed in subsumesVersions of migration ${m.version}.  Pick one.`
				);
			}
			if (subsumedSeen.has(v)) {
				throw new Error(
					`migrations contract violated: version ${v} is subsumed by both ` +
						`migration ${subsumedSeen.get(v)} and migration ${m.version}.`
				);
			}
			if (v <= m.version) {
				throw new Error(
					`migrations contract violated: subsumesVersions of migration ` +
						`${m.version} contains ${v}, but subsumed versions must be > the ` +
						`migration's own version.`
				);
			}
			subsumedSeen.set(v, m.version);
		}
	}
	// Combined coverage: every integer from 1 to max(declared ∪ subsumed)
	// must be present as either declared or subsumed.
	const all = new Set<number>([...declaredVersions, ...subsumedSeen.keys()]);
	const maxVersion = Math.max(...all);
	for (let v = 1; v <= maxVersion; v++) {
		if (!all.has(v)) {
			throw new Error(
				`migrations contract violated: version ${v} is neither declared ` +
					`nor subsumed.  This would create a silent gap in schema_migrations.`
			);
		}
	}
}
validateMigrationsContract();

async function loadSql(migration: Migration): Promise<string> {
	if (migration.sql) return migration.sql;
	if (migration.sqlPath) return readFile(migration.sqlPath, 'utf8');
	throw new Error(`migration ${migration.version} has neither sql nor sqlPath`);
}

/** Check which migration versions are already applied. */
async function appliedVersions(db: Database): Promise<Set<number>> {
	// Create the tracking table if it's the first run. We do this
	// outside the migration transaction loop because the schema_migrations
	// table must exist before we can query it.
	await db.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			description TEXT NOT NULL
		)
	`);
	const res = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
	return new Set(res.rows.map((r) => r.version));
}

/** Apply every migration not yet recorded. Each migration runs in its
 *  own transaction — one failing migration doesn't partially commit
 *  subsequent ones. */
export async function runMigrations(db: Database): Promise<{
	applied: number[];
	skipped: number[];
}> {
	const already = await appliedVersions(db);
	const applied: number[] = [];
	const skipped: number[] = [];

	for (const m of MIGRATIONS) {
		if (already.has(m.version)) {
			skipped.push(m.version);
			continue;
		}
		const sql = await loadSql(m);
		await db.withTx(async (client: pg.PoolClient) => {
			await client.query(sql);
			await client.query(
				'INSERT INTO schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
				[m.version, m.description]
			);
			// Record any subsumed versions in the same transaction.
			// On a fresh DB this lets the v1 collapsed schema mark
			// v2-v27 as applied so downstream code "is v15 applied?"
			// still returns true.  On a DB that's already past the
			// collapse boundary, subsumed versions are unreachable
			// (they'd already be in schema_migrations).
			for (const v of m.subsumesVersions ?? []) {
				await client.query(
					'INSERT INTO schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
					[v, `subsumed by v${m.version} (${m.description})`]
				);
			}
		});
		applied.push(m.version);
	}

	return { applied, skipped };
}

/** Drop all materialised tables and re-derive their state by
 *  replaying the `ops` event log. Only the event log is sacred; any
 *  column we can compute from it can be dropped and rebuilt.
 *
 *  Called explicitly via `npm run migrate:rebuild`. Does NOT run on
 *  normal boot — this can take minutes on a fully-synced indexer. */
export async function rebuildMaterialized(db: Database): Promise<void> {
	// Empty in v1 — there are no class-2 migrations yet. This
	// placeholder lets future versions add rebuild logic without
	// renaming the CLI surface.
	await db.query('SELECT 1');
}

/** CLI entry point. Usage:
 *    tsx src/db/migrations.ts              → apply pending migrations
 *    tsx src/db/migrations.ts --rebuild-materialized
 */
async function main(): Promise<void> {
	const config = loadConfig();
	const db = createDatabase(config);
	try {
		if (process.argv.includes('--rebuild-materialized')) {
			log.info('rebuild_started');
			await rebuildMaterialized(db);
			log.info('rebuild_complete');
			return;
		}
		const { applied, skipped } = await runMigrations(db);
		if (applied.length > 0) {
			log.info('applied', { versions: applied });
		}
		if (skipped.length > 0) {
			log.info('already_applied', { versions: skipped });
		}
	} finally {
		await db.close();
	}
}

// Only run when invoked directly (not when imported by main.ts).
const invokedDirectly =
	process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
	main().catch((err) => {
		log.error('failed', {}, err);
		process.exit(1);
	});
}
