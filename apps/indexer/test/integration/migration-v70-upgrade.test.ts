/**
 * Waiver-trade evidence (schema v70): a node UPGRADED to v70 must end up with
 * exactly the tables a FRESH install has.
 *
 * A fresh install builds them from schema.sql (migration v1 runs the whole
 * file, v70 section included; the v70 migration then re-runs the same
 * idempotent SQL). A node at v69 runs only the v70 migration's own SQL in
 * migrations.ts. The two texts are kept identical by hand, so both paths are
 * built here and every column, default, index, constraint and comment is
 * compared, and the partial index v70 adds to ops. Neither may create
 * database code (a snapshot refuses it). And v70 run again — what happens after
 * an older snapshot is restored over a database that has the table — empties
 * it: the rows left were this node's own. The two columns v70 adds
 * (orders.completed_at, indexer_state.waiver_evidence_through_block) are
 * compared too, and the upgrade fills completed_at for orders completed before
 * it: the block time of the order's first applied completion op.
 *
 * Skips without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';

const TABLES = `waiver\\_trade\\_transfers`;

async function shape(fx: IntegrationFixture): Promise<Record<string, unknown>> {
	const q = async (sql: string): Promise<unknown[]> =>
		(await fx.pool.query(sql, [fx.schema, TABLES])).rows;
	return {
		tables: await q(`SELECT table_name FROM information_schema.tables
			WHERE table_schema = $1 AND table_name LIKE $2 ORDER BY 1`),
		columns: await q(`SELECT table_name, column_name, data_type, numeric_precision, numeric_scale,
			       is_nullable, column_default
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
		opsIndex: (
			await fx.pool.query(
				`SELECT replace(indexdef, $1 || '.', '') AS def FROM pg_indexes
				  WHERE schemaname = $1 AND indexname = 'ops_feedback_status_idx'`,
				[fx.schema]
			)
		).rows,
		addedColumns: (
			await fx.pool.query(
				`SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default,
				        col_description(format('%I.%I', c.table_schema, c.table_name)::regclass,
				                        c.ordinal_position::int) AS comment
				   FROM information_schema.columns c
				  WHERE c.table_schema = $1
				    AND (c.table_name, c.column_name) IN
				        (('orders', 'completed_at'), ('indexer_state', 'waiver_evidence_through_block'))
				  ORDER BY 1, 2`,
				[fx.schema]
			)
		).rows,
		triggers: await q(`SELECT c.relname, t.tgname FROM pg_trigger t
			  JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE n.nspname = $1 AND c.relname LIKE $2 AND NOT t.tgisinternal ORDER BY 1, 2`)
	};
}

describe.skipIf(!INTEGRATION_ENABLED)('waiver-trade evidence: upgraded = fresh (v70)', () => {
	let fresh: IntegrationFixture;
	let upgraded: IntegrationFixture;

	beforeAll(async () => {
		fresh = await setupWithMigrations();
		// A node at v69: no v70 tables, v70 not recorded. Then the upgrade.
		upgraded = await setupWithMigrations();
		await upgraded.pool.query(`DROP TABLE "${upgraded.schema}".waiver_trade_transfers`);
		await upgraded.pool.query(`DROP INDEX "${upgraded.schema}".ops_feedback_status_idx`);
		await upgraded.pool.query(`ALTER TABLE "${upgraded.schema}".orders DROP COLUMN completed_at`);
		await upgraded.pool.query(
			`ALTER TABLE "${upgraded.schema}".indexer_state DROP COLUMN waiver_evidence_through_block`
		);
		await upgraded.pool.query(
			`DELETE FROM "${upgraded.schema}".schema_migrations WHERE version = 70`
		);
		// Orders completed before v70: one completed by an op (rejected once
		// before, the partner named by a later op, a fee re-check after that),
		// one with no completion op on record, one still live.
		const order = (account: string, permlink: string, status: string, updated: string) =>
			upgraded.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status)
				 VALUES ($1, $2, 'buy', 'BLURT', 'EUR', '{"kind":"spread","spread":0}'::jsonb, ARRAY['pay_xmr'],
				         $3, '2026-09-01T00:00:00Z', $4, 'verified')`,
				[account, permlink, status, updated]
			);
		await order('gina', 'order-g1', 'completed', '2026-10-25T09:00:00Z');
		await order('gina', 'order-g2', 'completed', '2026-10-20T00:00:00Z');
		await order('gina', 'order-g3', 'live', '2026-10-21T00:00:00Z');
		const op = (block: number, time: string, permlink: string, status: string) =>
			upgraded.db.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
				 VALUES ($1, 0, 0, $2, $3, 'gina', 'morphit_order_complete_v1', $4::jsonb, $5)`,
				[block, time, String(block).padStart(40, '0'), JSON.stringify({ permlink }), status]
			);
		await op(70000100, '2026-10-10T00:00:00Z', 'order-g1', 'rejected');
		await op(70000200, '2026-10-12T08:30:00Z', 'order-g1', 'applied');
		await op(70000300, '2026-10-18T00:00:00Z', 'order-g1', 'applied');
		const { runMigrations } = await import('../../src/db/migrations');
		const r = await runMigrations(upgraded.db);
		expect(r.applied).toEqual([70]);
	}, 120_000);

	afterAll(async () => {
		await fresh?.teardown();
		await upgraded?.teardown();
	});

	it('the same table, columns, indexes, constraints and comment, and the same ops index', async () => {
		const a = await shape(fresh);
		const b = await shape(upgraded);
		expect((a.tables as unknown[]).length).toBe(1);
		expect((a.opsIndex as unknown[]).length).toBe(1);
		expect(b).toEqual(a);
		expect(a.triggers).toEqual([]);
	});

	it('the upgrade fills the completion time of orders completed before it', async () => {
		const r = await upgraded.db.query<{ permlink: string; completed_at: Date | null }>(
			`SELECT permlink, completed_at FROM orders WHERE account = 'gina' ORDER BY permlink`
		);
		expect(r.rows.map((x) => [x.permlink, x.completed_at?.toISOString() ?? null])).toEqual([
			// the first applied completion op — not the rejected one, not the
			// later partner naming, not the re-check
			['order-g1', '2026-10-12T08:30:00.000Z'],
			// no completion op on record: its last change
			['order-g2', '2026-10-20T00:00:00.000Z'],
			['order-g3', null]
		]);
	});

	it('run again over a database that has rows (an older snapshot restored), v70 empties the table', async () => {
		await fresh.db.query(
			`INSERT INTO waiver_trade_transfers
			   (recipient, sender, block_num, trx_in_block, op_in_trx, block_time, trx_id, amount_blurt)
			 VALUES ('erin', 'dave', 70000000, 0, 0, '2026-11-02T00:00:00Z', 'x', 2.000)`
		);
		await fresh.db.query(`DELETE FROM schema_migrations WHERE version = 70`);
		const { runMigrations } = await import('../../src/db/migrations');
		expect((await runMigrations(fresh.db)).applied).toEqual([70]);
		expect((await fresh.db.query(`SELECT 1 FROM waiver_trade_transfers`)).rowCount).toBe(0);
	});
});
