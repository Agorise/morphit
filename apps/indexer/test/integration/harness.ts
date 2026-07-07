/**
 * Integration test harness — real Postgres.
 *
 * Philosophy: these tests exercise SQL semantics that unit tests
 * can't meaningfully cover (column types, predicate correctness,
 * CTE self-joins, JSON operators, INTERVAL arithmetic). They
 * complement the unit tests, they don't replace them.
 *
 * Running:
 *   TEST_DATABASE_URL=postgres://... npm test
 * Without that env var, the test files that import from this
 * module will describe.skip their suites, so `npm test` still
 * passes on developer machines without a postgres running.
 *
 * Isolation: each suite creates its own Postgres schema, named
 * with a random suffix. Tests in a suite share the schema (so
 * cross-test data can exist if a test suite wants) but different
 * suites never see each other. This matters for parallel CI runs
 * against a single shared database.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import type { Database } from '../../src/db/pool';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC_DB_DIR = resolve(HERE, '../../src/db');

/** URL from env, or null if integration tests should skip. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? null;

/** True if integration tests should run. Guard every
 *  `describe()` so the suite skips cleanly when Postgres isn't
 *  available. */
export const INTEGRATION_ENABLED = TEST_DATABASE_URL !== null;

/** One schema per suite. Use cryptographically-random bytes so
 *  parallel CI runs pointing at the same DB don't collide.
 *  Schemas are lowercase, underscores, no dashes. */
function randomSchemaName(): string {
	return `morphit_test_${randomBytes(6).toString('hex')}`;
}

export interface IntegrationFixture {
	readonly pool: pg.Pool;
	readonly db: Database;
	readonly schema: string;
	/** Apply every registered migration SQL, redirected at the
	 *  fixture's schema. NOT called automatically by setup() — either
	 *  call this yourself after setup(), or use the setupWithMigrations()
	 *  convenience wrapper (which every data-test should). A bare setup()
	 *  leaves an EMPTY schema with no tables. */
	applyMigrations(): Promise<void>;
	/** Destroy the schema and close the pool. Always called from
	 *  teardown() — tests don't need to invoke this directly. */
	teardown(): Promise<void>;
}

/**
 * Set up a fresh Postgres schema for a test suite. Returns a
 * fixture with a Pool and a Database wrapper. Call teardown() in
 * afterAll.
 */
export async function setup(): Promise<IntegrationFixture> {
	if (!TEST_DATABASE_URL) {
		throw new Error(
			'setup() called but TEST_DATABASE_URL is not set — ' +
				'use INTEGRATION_ENABLED to gate your describe()'
		);
	}
	const schema = randomSchemaName();
	const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

	// Create the schema using a client we control end-to-end. We
	// deliberately DO NOT use a pool.on('connect') hook to set
	// search_path per-connection — that hook is async and can
	// race with the first query issued on a freshly checked-out
	// client. Instead, every entry point below acquires a client
	// and sets search_path explicitly before issuing SQL.
	{
		const c = await pool.connect();
		try {
			await c.query(`CREATE SCHEMA "${schema}"`);
		} finally {
			c.release();
		}
	}

	/** Internal helper: check out a client, set its search_path to
	 *  our test schema, and hand it to `fn`. Always releases on
	 *  exit. Callers decide whether to wrap in a transaction. */
	async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
		const client = await pool.connect();
		try {
			await client.query(`SET search_path TO "${schema}"`);
			return await fn(client);
		} finally {
			client.release();
		}
	}

	// A Database adapter that matches the production interface so
	// handlers and detectors see no difference.
	const db: Database = {
		async withTx(fn) {
			return withClient(async (client) => {
				await client.query('BEGIN');
				try {
					const result = await fn(client);
					await client.query('COMMIT');
					return result;
				} catch (err) {
					await client.query('ROLLBACK').catch(() => undefined);
					throw err;
				}
			});
		},
		async query(text, params) {
			return withClient((client) => client.query(text, params as unknown[]));
		},
		async close() {
			await pool.end();
		}
	};

	async function applyMigrations(): Promise<void> {
		// Use the production migration runner — same code path as
		// boot, so a regression in MIGRATIONS or runMigrations()
		// surfaces here, not silently in production.  The runner
		// records to schema_migrations inside our test schema (we
		// have search_path set to that schema before any query).
		//
		// Pre-2026-05 the harness had its own SQL-file applier
		// that bypassed runMigrations.  That divergence allowed
		// production-runner regressions (G1 missing v24 between
		// v23 and v25) to slip past CI.  Unifying the path is the
		// audit fix.
		const { runMigrations } = await import('../../src/db/migrations');
		await runMigrations(db);
	}

	async function teardown(): Promise<void> {
		try {
			// DROP SCHEMA must run in the default search_path (the
			// schema we're about to drop is not on it, since our
			// queries set search_path to the target schema). Use a
			// raw client without the search_path hook.
			const c = await pool.connect();
			try {
				await c.query(`DROP SCHEMA "${schema}" CASCADE`);
			} finally {
				c.release();
			}
		} catch {
			// Best effort — if this throws, the pool.end below still
			// runs.
		}
		await pool.end();
	}

	return { pool, db, schema, applyMigrations, teardown };
}

/**
 * Convenience wrapper: set up, apply migrations, return a ready
 * fixture. Most tests want this one-liner.
 */
export async function setupWithMigrations(): Promise<IntegrationFixture> {
	const fx = await setup();
	await fx.applyMigrations();
	return fx;
}

/** Quick truncation of every Morphit data table — call from
 *  beforeEach for tests that need a clean slate between cases
 *  within a suite. Excludes `indexer_state` and
 *  `schema_migrations`, which are harness/ops concerns rather
 *  than test-visible state; clearing them between cases would
 *  force a re-migration which isn't the point. */
export async function truncateAll(fx: IntegrationFixture): Promise<void> {
	const tables = [
		'account_loyalty',
		'account_loyalty_milestones',
		'accounts',
		'chat_identities',
		'chat_messages',
		'fee_attestations',
		'fee_transfers',
		'feedback_responses',
		'feedback',
		// v31 (Part 113): Signal C pile-on detector storage.
		// Pre-Part-118 this table was missing from truncateAll,
		// meaning cross-test bleed could leave Signal C rows from a
		// prior test polluting the next.  Added in the same work
		// unit as the /feedback suppression flag extension (Part
		// 118) — both touch this table; harness should mirror the
		// schema completeness.
		'one_way_pile_on',
		'orders',
		'ops',
		'profiles',
		'related_accounts',
		'relay_pending_transfers',
		'releases',
		'suspicious_reciprocity',
		'witness_fee_history'
	];
	// Goes through db.query so search_path is set on the client
	// that receives the TRUNCATE.
	await fx.db.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
}
