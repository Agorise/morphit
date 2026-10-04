/**
 * The HTTP routes' pool cannot run a statement unbounded, and neither pool
 * JIT-compiles, on real Postgres.
 *
 * One pool of 10 served the poller and every HTTP route with no statement
 * timeout: a dozen slow orderbook requests held every connection and the next
 * block waited behind them. Postgres JIT, on by default, fired on the
 * reputation joins' inflated estimates and spent far longer compiling than the
 * queries took to run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, TEST_DATABASE_URL } from './harness';
import { fakeConfig } from '../testutils/context';
import { createDatabase, type Database } from '../../src/db/pool';

describe.skipIf(!INTEGRATION_ENABLED)('database pools', () => {
	let core: Database;
	let api: Database;

	beforeAll(() => {
		const config = fakeConfig({ databaseUrl: TEST_DATABASE_URL!, databasePoolMax: 2 });
		core = createDatabase(config);
		api = createDatabase(config, 'api');
	});
	afterAll(async () => {
		await Promise.all([core?.close(), api?.close()]);
	});

	it('neither pool JIT-compiles', async () => {
		for (const db of [core, api]) {
			const r = await db.query<{ jit: string }>('SHOW jit');
			expect(r.rows[0]!.jit).toBe('off');
		}
	});

	it('a slow statement on the HTTP pool is cancelled; block processing commits meanwhile', async () => {
		const started = Date.now();
		const slow = [1, 2].map(() =>
			api.query('SELECT pg_sleep(8)').then(
				() => 'finished',
				(e: { code?: string }) => e.code
			)
		);
		// Block processing, on the core pool, while the HTTP pool is full.
		const committedAfter = await core.withTx(async (c) => {
			await c.query('SELECT txid_current()');
			return Date.now() - started;
		});
		expect(committedAfter).toBeLessThan(1_000);
		expect(await Promise.all(slow), 'statement_timeout cancels (57014)').toEqual([
			'57014',
			'57014'
		]);
		expect(Date.now() - started).toBeLessThan(7_500);
	}, 15_000);

	it('the core pool has no statement cap (a block or a signal scan runs as long as it needs)', async () => {
		const r = await core.query<{ statement_timeout: string }>('SHOW statement_timeout');
		expect(r.rows[0]!.statement_timeout).toBe('0');
	});
});
