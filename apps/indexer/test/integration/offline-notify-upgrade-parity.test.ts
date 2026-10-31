/**
 * Offline notifications (schema v69): a node UPGRADED to v69 must end up with
 * exactly the tables a FRESH install has.
 *
 * A fresh install builds them from schema.sql (migration v1 runs the whole
 * file, v69 section included; the v69 migration is then a no-op). A node that
 * was at v68 runs only the v69 migration's own SQL in migrations.ts. The two
 * texts are kept identical by hand, and nothing else compares them — so here
 * both paths are built and every column, default, index, constraint and
 * comment of the seven tables is compared — and of the one v71 adds
 * (offline_notify_matrix_rooms, and offline_notify_leave.address_mac): a node
 * at v68 upgrades through both. Neither path may create database
 * code (a function or trigger): the snapshot checks refuse it, and the older
 * indexer's rollback heal drops it and holds payouts.
 *
 * Skips without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';

const TABLES = `offline\\_notify\\_%`;

async function shape(fx: IntegrationFixture): Promise<Record<string, unknown>> {
	const q = async (sql: string): Promise<unknown[]> =>
		(await fx.pool.query(sql, [fx.schema, TABLES])).rows;
	return {
		tables: await q(`SELECT table_name FROM information_schema.tables
			WHERE table_schema = $1 AND table_name LIKE $2 ORDER BY 1`),
		columns: await q(`SELECT table_name, column_name, data_type, is_nullable, column_default,
			       col_description(format('%I.%I', table_schema, table_name)::regclass, ordinal_position) AS comment
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
		triggers: await q(`SELECT c.relname, t.tgname FROM pg_trigger t
			  JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE n.nspname = $1 AND c.relname LIKE $2 AND NOT t.tgisinternal ORDER BY 1, 2`),
		functions:
			await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			 WHERE n.nspname = $1 AND $2::text IS NOT NULL ORDER BY 1`)
	};
}

describe.skipIf(!INTEGRATION_ENABLED)('offline notifications: upgraded = fresh (v69)', () => {
	let fresh: IntegrationFixture;
	let upgraded: IntegrationFixture;

	beforeAll(async () => {
		fresh = await setupWithMigrations();
		// A node at v68: no v69 tables, v69 not recorded. Then the upgrade,
		// which runs only the v69 migration's own SQL.
		upgraded = await setupWithMigrations();
		const t = (
			await upgraded.pool.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE $2`,
				[upgraded.schema, TABLES]
			)
		).rows.map((r) => `"${upgraded.schema}"."${r.table_name as string}"`);
		expect(t).toHaveLength(8);
		await upgraded.pool.query(`DROP TABLE ${t.join(', ')} CASCADE`);
		await upgraded.pool.query(
			`DELETE FROM "${upgraded.schema}".schema_migrations WHERE version IN (69, 71)`
		);
		const { runMigrations } = await import('../../src/db/migrations');
		const r = await runMigrations(upgraded.db);
		expect(r.applied).toEqual([69, 71]);
	}, 120_000);

	afterAll(async () => {
		await fresh?.teardown();
		await upgraded?.teardown();
	});

	it('the same eight tables, columns, defaults, indexes, constraints and comments', async () => {
		const a = await shape(fresh);
		const b = await shape(upgraded);
		expect((a.tables as unknown[]).length).toBe(8);
		expect(b).toEqual(a);
	});

	it('no database code on either path', async () => {
		for (const fx of [fresh, upgraded]) {
			const s = await shape(fx);
			expect(s.triggers).toEqual([]);
			expect(s.functions).toEqual([]);
		}
	});
});
