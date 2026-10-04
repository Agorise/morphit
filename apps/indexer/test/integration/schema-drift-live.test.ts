/**
 * The drift detector, against a REAL database — including indexes.
 *
 * WHY THIS ONE NEEDS POSTGRES. `schema-drift-smoke` tests the parser and the
 * diff, which are pure and comprehensively covered. What it cannot test is the
 * only claim an operator cares about: **run this against a database built from
 * our own schema.sql and it says "clean"**. That is a statement about two
 * things agreeing — a regex over a file, and what PostgreSQL actually created
 * from that same file — and no amount of testing either half establishes it.
 *
 * It is also the half that has been wrong. The index check was added in
 * v1.18.0 and the very first run against a live database reported drift on a
 * perfectly healthy one: schema.sql creates `orders_verified_live_idx` and
 * DROPs it a thousand lines later, so a fresh build legitimately lacks it. The
 * regex looked right. The pure smoke agreed it was right. Only a real database
 * disagreed.
 *
 * A false positive here is worse than no check at all, because
 * `morphit-ops doctor` would tell every operator their schema was broken and
 * train them to scroll past the next real one.
 *
 * Skips without TEST_DATABASE_URL, like every other integration suite here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { checkSchemaDrift } from '../../src/db/schemaDrift';

/** The index F16 is about: the chat and feedback push enqueues both use
 *  `ON CONFLICT (account, source_trx_id)`, which REQUIRES it to exist. */
const DEDUP_INDEX = 'push_pending_account_source_trx_uidx';

describe.skipIf(!INTEGRATION_ENABLED)('schema drift, against a real database', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	/**
	 * THE ONE THAT MATTERS. Everything else in this file is a variation on it.
	 * A database built from schema.sql must be reported as matching schema.sql;
	 * if it is not, the check is worse than useless on every healthy node in the
	 * federation.
	 */
	it('a database built from schema.sql reports no drift at all', async () => {
		const res = await checkSchemaDrift(fx.db);
		expect(res.dbReachable, 'the fixture database must be reachable').toBe(true);
		// Each asserted separately so a failure names WHICH kind of false
		// positive, rather than dumping a diff object and leaving the reader to
		// work out whether it was a column or an index.
		expect(res.diff.missingTables, 'no table may be reported missing').toEqual([]);
		expect(res.diff.missingColumns, 'no column may be reported missing').toEqual([]);
		expect(
			res.diff.missingIndexes,
			'no index may be reported missing — an index the schema later DROPS is ' +
				'the false positive this check actually produced on its first live run'
		).toEqual([]);
		expect(res.ok).toBe(true);
	});

	/**
	 * And the counterweight: a check that can only ever say "clean" is not a
	 * check. This is the live half of what the pure smoke asserts on hand-built
	 * inputs — the parser found the index, the query found the index, and
	 * removing it from the database is noticed.
	 */
	it('dropping the push dedup index is reported by name', async () => {
		await fx.db.query(`DROP INDEX "${DEDUP_INDEX}"`);
		try {
			const res = await checkSchemaDrift(fx.db);
			expect(res.ok, 'a database missing a shipped index has drifted').toBe(false);
			expect(res.diff.missingIndexes).toContain(DEDUP_INDEX);
			expect(
				res.diff.missingTables.length + res.diff.missingColumns.length,
				'and nothing else may be dragged in with it'
			).toBe(0);
		} finally {
			// Restore before the next test, whatever happened above.
			await fx.db.query(
				`CREATE UNIQUE INDEX "${DEDUP_INDEX}"
				     ON push_pending (account, source_trx_id)
				  WHERE source_trx_id IS NOT NULL`
			);
		}
	});

	it('restoring it goes clean again', async () => {
		const res = await checkSchemaDrift(fx.db);
		expect(res.ok, 'the previous test must have put the index back').toBe(true);
		expect(res.diff.missingIndexes).toEqual([]);
	});

	/**
	 * v1.18.0 review (D3) — AN INDEX POSTGRES WILL NOT USE IS NOT PRESENT.
	 *
	 * The documented repair is `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS`.
	 * On a database carrying duplicates — the case the same documentation warns
	 * about — that build FAILS and leaves an index of the right name behind,
	 * marked invalid. `pg_indexes` lists it, Postgres ignores it for
	 * `ON CONFLICT`, and `IF NOT EXISTS` then skips re-creating it. Checked by
	 * name, doctor called this database healthy while every chat and feedback
	 * push was being dropped.
	 */
	it('a failed concurrent rebuild — an INVALID index of the right name — is reported', async () => {
		await fx.db.query(`DROP INDEX "${DEDUP_INDEX}"`);
		for (let i = 0; i < 2; i++) {
			await fx.db.query(
				`INSERT INTO push_pending (account, category, title, body, event_at, source_trx_id)
				 VALUES ('dup', 'chat', 't', 'b', now(), 'same-trx')`
			);
		}
		try {
			await expect(
				fx.db.query(
					`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${DEDUP_INDEX}"
					     ON push_pending (account, source_trx_id)
					  WHERE source_trx_id IS NOT NULL`
				),
				'setup: the documented repair must fail on duplicates'
			).rejects.toThrow();
			const valid = await fx.db.query<{ indisvalid: boolean }>(
				`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
				  WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
				[DEDUP_INDEX]
			);
			expect(valid.rows[0]?.indisvalid, 'setup: the failed build left an invalid index').toBe(
				false
			);

			const res = await checkSchemaDrift(fx.db);
			expect(
				res.diff.missingIndexes,
				'an index Postgres will not use for ON CONFLICT was reported as present'
			).toContain(DEDUP_INDEX);
		} finally {
			await fx.db.query(`DELETE FROM push_pending WHERE account = 'dup'`);
			await fx.db.query(`DROP INDEX IF EXISTS "${DEDUP_INDEX}"`);
			await fx.db.query(
				`CREATE UNIQUE INDEX "${DEDUP_INDEX}"
				     ON push_pending (account, source_trx_id)
				  WHERE source_trx_id IS NOT NULL`
			);
		}
	});

	it('a same-named index that is NOT unique is reported', async () => {
		await fx.db.query(`DROP INDEX "${DEDUP_INDEX}"`);
		await fx.db.query(
			`CREATE INDEX "${DEDUP_INDEX}" ON push_pending (account, source_trx_id)
			  WHERE source_trx_id IS NOT NULL`
		);
		try {
			const res = await checkSchemaDrift(fx.db);
			expect(
				res.diff.missingIndexes,
				'a non-unique index satisfies the name and gives ON CONFLICT nothing to arbitrate with'
			).toContain(DEDUP_INDEX);
		} finally {
			await fx.db.query(`DROP INDEX IF EXISTS "${DEDUP_INDEX}"`);
			await fx.db.query(
				`CREATE UNIQUE INDEX "${DEDUP_INDEX}"
				     ON push_pending (account, source_trx_id)
				  WHERE source_trx_id IS NOT NULL`
			);
		}
	});

	it('and after both repairs, clean again', async () => {
		expect((await checkSchemaDrift(fx.db)).ok).toBe(true);
	});

	/**
	 * WHY THE MISSING INDEX IS A NOTIFICATION OUTAGE AND NOT A SLOW QUERY.
	 *
	 * This is the behaviour the whole finding rests on, and it is PostgreSQL's,
	 * not ours — which is exactly why it is asserted here rather than reasoned
	 * about in a comment. `ON CONFLICT (cols) WHERE pred` requires a matching
	 * index; without one Postgres raises 42P10 instead of falling back, and
	 * `enqueueChatPush` catches its own errors so the message still goes
	 * through. The result is silence rather than duplicates.
	 *
	 * If a future PostgreSQL ever started falling back instead, this test would
	 * fail and the reasoning behind the whole check would need revisiting — that
	 * is a feature of pinning it.
	 */
	it('without the index the ON CONFLICT insert RAISES rather than falling back', async () => {
		await fx.db.query(`DROP INDEX "${DEDUP_INDEX}"`);
		try {
			await expect(
				fx.db.query(
					`INSERT INTO push_pending
					   (account, category, title, body, click_path, event_at, source_trx_id)
					 VALUES ('bob', 'chat', 't', 'b', '/c', NOW(), 'deadbeef')
					 ON CONFLICT (account, source_trx_id) WHERE source_trx_id IS NOT NULL DO NOTHING`
				),
				'this raising is WHY a missing index is an outage and not a slowdown'
			).rejects.toThrow();

			const n = await fx.db.query<{ n: string }>('SELECT count(*) AS n FROM push_pending');
			expect(
				Number(n.rows[0]?.n ?? -1),
				'nothing is inserted — so the outage cannot leave duplicates behind ' +
					'for a later CREATE UNIQUE INDEX to trip over'
			).toBe(0);
		} finally {
			await fx.db.query(
				`CREATE UNIQUE INDEX "${DEDUP_INDEX}"
				     ON push_pending (account, source_trx_id)
				  WHERE source_trx_id IS NOT NULL`
			);
		}
	});

	/**
	 * The other half of the same bug class, one level down: a missing COLUMN.
	 * Kept because the index work rewrote `diffSchema`'s signature, and a
	 * regression that silently stopped reporting columns would otherwise be
	 * invisible from a suite that had grown entirely index-shaped.
	 */
	it('a dropped column is still reported', async () => {
		await fx.db.query('ALTER TABLE push_pending DROP COLUMN notification_id');
		try {
			const res = await checkSchemaDrift(fx.db);
			expect(res.ok).toBe(false);
			expect(res.diff.missingColumns).toContainEqual({
				table: 'push_pending',
				column: 'notification_id'
			});
		} finally {
			await fx.db.query('ALTER TABLE push_pending ADD COLUMN notification_id TEXT');
		}
	});

	/**
	 * And a dropped TABLE, which must be reported as one missing table rather
	 * than as every one of its columns — the operator reads this line to decide
	 * whether to reset the database, and a wall of column names for a table that
	 * simply is not there buries the actual answer.
	 */
	it('a missing table is reported as a table, not as a pile of columns', async () => {
		// RENAME rather than DROP, deliberately. `applyMigrations()` cannot put a
		// dropped table back — the runner reads `schema_migrations`, sees the
		// baseline already applied, and does nothing — so a DROP here would leave
		// the fixture quietly broken for whatever test is added after this one. A
		// rename is exactly as invisible to the checker (it looks up the name) and
		// is restored precisely.
		await fx.db.query('ALTER TABLE push_pending RENAME TO push_pending_parked');
		try {
			const res = await checkSchemaDrift(fx.db);
			expect(res.diff.missingTables).toContain('push_pending');
			expect(
				res.diff.missingColumns.filter((c) => c.table === 'push_pending'),
				'its columns must not be listed as well'
			).toEqual([]);
		} finally {
			await fx.db.query('ALTER TABLE push_pending_parked RENAME TO push_pending');
		}
	});

	/** Belt and braces: whatever the tests above did, the fixture they leave
	 *  behind must be the one they found. A suite that corrupts its own fixture
	 *  makes every later addition to it unreliable in a way that looks like a
	 *  product bug. */
	it('leaves the database exactly as it found it', async () => {
		const res = await checkSchemaDrift(fx.db);
		expect(res.ok, 'the restores above must all have worked').toBe(true);
	});
});
