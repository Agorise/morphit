/**
 * One Matrix room per address (schema v71): a node UPGRADED to v71 must end up
 * with exactly what a FRESH install has.
 *
 * A fresh install builds it from schema.sql (migration v1 runs the whole file,
 * v71 section included; the v71 migration then re-runs the same idempotent
 * SQL). A node at v70 runs only the v71 migration's own SQL in migrations.ts.
 * The two texts are kept identical by hand, so both paths are built here and
 * the table's columns, defaults, constraints and comment, and the column v71
 * adds to offline_notify_leave, are compared. An existing leave queue (rows
 * from v1.21.18) is kept, its new column empty. Neither path may create
 * database code (a snapshot refuses it).
 *
 * Skips without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';

const TABLES = `offline\\_notify\\_matrix\\_rooms`;

async function shape(fx: IntegrationFixture): Promise<Record<string, unknown>> {
	const q = async (sql: string): Promise<unknown[]> =>
		(await fx.pool.query(sql, [fx.schema, TABLES])).rows;
	return {
		tables: await q(`SELECT table_name FROM information_schema.tables
			WHERE table_schema = $1 AND table_name LIKE $2 ORDER BY 1`),
		columns: await q(`SELECT table_name, column_name, data_type, is_nullable, column_default
			  FROM information_schema.columns
			 WHERE table_schema = $1 AND table_name LIKE $2 ORDER BY 1, 2`),
		indexes: await q(`SELECT tablename, indexname, replace(indexdef, $1 || '.', '') AS def
			  FROM pg_indexes WHERE schemaname = $1 AND tablename LIKE $2 ORDER BY 1, 2`),
		constraints: await q(`SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS def
			  FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
			  JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE n.nspname = $1 AND c.relname LIKE $2 ORDER BY 1, 2`),
		tableComments: await q(`SELECT c.relname, obj_description(c.oid, 'pg_class') AS comment
			  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE n.nspname = $1 AND c.relname LIKE $2 AND c.relkind = 'r' ORDER BY 1`),
		leaveColumn: (
			await fx.pool.query(
				`SELECT column_name, data_type, is_nullable, column_default
				   FROM information_schema.columns
				  WHERE table_schema = $1 AND table_name = 'offline_notify_leave' AND column_name = 'address_mac'`,
				[fx.schema]
			)
		).rows,
		triggers: await q(`SELECT c.relname, t.tgname FROM pg_trigger t
			  JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE n.nspname = $1 AND c.relname LIKE $2 AND NOT t.tgisinternal ORDER BY 1, 2`)
	};
}

describe.skipIf(!INTEGRATION_ENABLED)('one Matrix room per address: upgraded = fresh (v71)', () => {
	let fresh: IntegrationFixture;
	let upgraded: IntegrationFixture;

	beforeAll(async () => {
		fresh = await setupWithMigrations();
		// A node at v70 (v1.21.18): no v71 table or column, v71 not recorded,
		// a room waiting in its leave queue. Then the upgrade.
		upgraded = await setupWithMigrations();
		await upgraded.pool.query(`DROP TABLE "${upgraded.schema}".offline_notify_matrix_rooms`);
		await upgraded.pool.query(
			`ALTER TABLE "${upgraded.schema}".offline_notify_leave DROP COLUMN address_mac`
		);
		await upgraded.pool.query(
			`DELETE FROM "${upgraded.schema}".schema_migrations WHERE version = 71`
		);
		await upgraded.db.query(
			`INSERT INTO offline_notify_leave (route_sealed, account) VALUES ('\\x0102'::bytea, 'alice')`
		);
		const { runMigrations } = await import('../../src/db/migrations');
		const r = await runMigrations(upgraded.db);
		expect(r.applied).toEqual([71]);
	}, 120_000);

	afterAll(async () => {
		await fresh?.teardown();
		await upgraded?.teardown();
	});

	it('the same table, columns, constraints and comment, and the same new queue column', async () => {
		const a = await shape(fresh);
		const b = await shape(upgraded);
		expect((a.tables as unknown[]).length).toBe(1);
		expect((a.leaveColumn as unknown[]).length).toBe(1);
		expect(b).toEqual(a);
		expect(a.triggers).toEqual([]);
	});

	it('the queue v1.21.18 left is kept, its new column empty', async () => {
		const r = await upgraded.db.query<{ account: string; address_mac: Buffer | null }>(
			`SELECT account, address_mac FROM offline_notify_leave`
		);
		expect(r.rows).toEqual([{ account: 'alice', address_mac: null }]);
	});

	it('run again, it changes nothing', async () => {
		await fresh.db.query(
			`INSERT INTO offline_notify_matrix_rooms (address_mac, room_sealed) VALUES ('\\x01'::bytea, '\\x02'::bytea)`
		);
		await fresh.db.query(`DELETE FROM schema_migrations WHERE version = 71`);
		const { runMigrations } = await import('../../src/db/migrations');
		expect((await runMigrations(fresh.db)).applied).toEqual([71]);
		expect((await fresh.db.query(`SELECT 1 FROM offline_notify_matrix_rooms`)).rowCount).toBe(1);
	});
});
