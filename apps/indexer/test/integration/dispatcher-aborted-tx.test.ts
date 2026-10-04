/**
 * The dispatcher survives ANY handler that swallows a database error.
 *
 * A handler that catches a failed statement without a savepoint of its own
 * leaves the block transaction aborted ("current transaction is aborted,
 * commands ignored until end of transaction block"). If it then returns
 * `{ ok: true }`, the op's writes cannot be kept: the dispatcher rolls back to
 * the op's savepoint, records the op as rejected `handler_aborted_tx`, and the
 * rest of the block applies. It used to issue RELEASE SAVEPOINT on the aborted
 * transaction, which failed and halted the indexer at that block for good.
 *
 * The settings handler is replaced here by one that does exactly that, so the
 * guard does not depend on which real handler happens to have the bug.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

vi.mock('../../src/indexer/handlers/settings', () => ({
	default: async (ctx: { payload: unknown }, client: pg.PoolClient) => {
		const p = ctx.payload as { mode?: string };
		if (p.mode === 'swallow') {
			// A write that lands, then a failing statement whose error is swallowed.
			await client.query(
				`INSERT INTO profiles (account, display_name, json_metadata, source_block_num, source_trx_id, updated_at)
				 VALUES ('ghost', 'ghost', '{}', 7, 't', now())`
			);
			try {
				await client.query('SELECT 1/0');
			} catch {
				// swallowed: the transaction is now aborted
			}
			return { ok: true };
		}
		if (p.mode === 'swallow-reject') {
			try {
				await client.query('SELECT 1/0');
			} catch {
				// swallowed
			}
			return { ok: false, reason: 'swallowed_then_rejected' };
		}
		return { ok: true };
	}
}));

const { applyBlock } = await import('../../src/indexer/dispatcher');

type Op = [string, unknown];
const cj = (signer: string, id: string, json: unknown): Op => [
	'custom_json',
	{ required_auths: [], required_posting_auths: [signer], id, json: JSON.stringify(json) }
];

describe.skipIf(!INTEGRATION_ENABLED)('dispatcher: a handler that swallows a DB error', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it('is rejected handler_aborted_tx, its writes are discarded, and the rest of the block applies', async () => {
		const ops: Op[] = [
			cj('alice', 'morphit_settings_v1', { mode: 'swallow' }),
			cj('bob', 'morphit_settings_v1', { mode: 'swallow-reject' }),
			cj('carol', 'morphit_profile_v1', { display_name: 'Carol' }),
			cj('dave', 'morphit_settings_v1', { mode: 'plain' })
		];
		const b = {
			timestamp: '2026-10-01T00:00:00',
			transaction_ids: ops.map((_, i) => `t${i}`.padEnd(40, '0')),
			transactions: ops.map((op) => ({ operations: [op] }))
		};
		const c = await fx.pool.connect();
		let threw: unknown = null;
		try {
			await c.query(`SET search_path TO "${fx.schema}"`);
			await c.query('BEGIN');
			await applyBlock(
				c,
				7,
				b as never,
				mockBlurt({}),
				fakeConfig({}),
				{},
				{},
				(() => null) as never
			);
			await c.query('COMMIT');
		} catch (e) {
			threw = e;
			await c.query('ROLLBACK').catch(() => {});
		} finally {
			c.release();
		}
		expect(threw, 'the block was rolled back').toBeNull();
		const rows = await fx.db.query<{ signer: string; status: string; reason: string | null }>(
			`SELECT signer, status, reject_reason AS reason FROM ops WHERE block_num = 7 ORDER BY trx_in_block`
		);
		expect(rows.rows).toEqual([
			{ signer: 'alice', status: 'rejected', reason: 'handler_aborted_tx' },
			{ signer: 'bob', status: 'rejected', reason: 'swallowed_then_rejected' },
			{ signer: 'carol', status: 'applied', reason: null },
			{ signer: 'dave', status: 'applied', reason: null }
		]);
		const ghost = await fx.db.query(`SELECT 1 FROM profiles WHERE account = 'ghost'`);
		expect(ghost.rowCount, 'a write from the aborted op survived').toBe(0);
		const carol = await fx.db.query(`SELECT display_name FROM profiles WHERE account = 'carol'`);
		expect(carol.rows).toEqual([{ display_name: 'Carol' }]);
	});
});
