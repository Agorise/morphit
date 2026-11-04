/**
 * The HTTP routes' pool cannot run a statement unbounded, and neither pool
 * JIT-compiles, on real Postgres.
 *
 * One pool of 10 served the poller and every HTTP route with no statement
 * timeout: a dozen slow orderbook requests held every connection and the next
 * block waited behind them. Postgres JIT, on by default, fired on the
 * reputation joins' inflated estimates and spent far longer compiling than the
 * queries took to run.
 *
 * A connection that died while its client was checked out (between two
 * statements of a transaction, the code waiting on something else) emitted
 * 'error' with no listener (pg-pool listens on idle clients only), and Node
 * ended the indexer (v1.22.1).
 */
import net from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, TEST_DATABASE_URL } from './harness';
import { fakeConfig } from '../testutils/context';
import { createDatabase, type Database } from '../../src/db/pool';

/**
 * A proxy to the test Postgres that, on its first connection, holds the
 * server's last startup chunk (ending in ReadyForQuery), terminates that
 * backend, and delivers ReadyForQuery together with the backend's FATAL in one
 * chunk: what a client sees when its process was busy for the moment between
 * the two (a Postgres restart, a session ended just as it became ready).
 */
async function readyThenFatalProxy(url: string): Promise<{
	url: string;
	delivered: Promise<void>;
	closed: Promise<void>;
	close: () => Promise<void>;
}> {
	const killer = new pg.Client({ connectionString: url });
	await killer.connect();
	const target = new URL(url);
	const RFQ = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]); // ReadyForQuery, idle
	let first = true;
	let markDelivered = (): void => {};
	const delivered = new Promise<void>((r) => (markDelivered = r));
	let markClosed = (): void => {};
	const closed = new Promise<void>((r) => (markClosed = r));
	const sockets: net.Socket[] = [];
	const proxy = net.createServer((c) => {
		const s = net.connect(Number(target.port), target.hostname);
		sockets.push(c, s);
		c.on('error', () => undefined);
		s.on('error', () => undefined);
		c.on('data', (d) => s.write(d));
		const intercept = first;
		first = false;
		if (intercept) c.on('close', () => markClosed());
		let pid = 0;
		let held: Buffer[] | null = null;
		const forward = (d: Buffer): void => {
			if (c.writable) c.write(d);
		};
		s.on('data', (d: Buffer) => {
			if (held !== null) return void held.push(d);
			const k = d.indexOf(Buffer.from([0x4b, 0, 0, 0, 12])); // BackendKeyData
			if (k >= 0) pid = d.readInt32BE(k + 5);
			if (!intercept || !d.subarray(-6).equals(RFQ)) return forward(d);
			// Hold ReadyForQuery until the backend has sent its FATAL and
			// closed (the server's 'end' below), then deliver both at once.
			held = [d];
			void killer.query('SELECT pg_terminate_backend($1)', [pid]);
		});
		s.on('end', () => {
			if (held !== null) {
				forward(Buffer.concat(held));
				markDelivered();
			}
			c.end();
		});
	});
	await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
	const via = new URL(url);
	via.hostname = '127.0.0.1';
	via.port = String((proxy.address() as net.AddressInfo).port);
	return {
		url: via.toString(),
		delivered,
		closed,
		close: async () => {
			for (const x of sockets) x.destroy();
			await new Promise<void>((r) => proxy.close(() => r()));
			await killer.end();
		}
	};
}

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

	it('a connection killed while its client is checked out fails that transaction; the process and the pool carry on', async () => {
		const killer = new pg.Client({ connectionString: TEST_DATABASE_URL! });
		await killer.connect();
		try {
			for (const db of [core, api]) {
				const outcome = await db
					.withTx(async (c) => {
						const pid = (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
						// Killed while no statement of ours runs: the client
						// itself emits 'error', then 'end'.
						const ended = new Promise((r) => c.once('end', r));
						await killer.query('SELECT pg_terminate_backend($1)', [pid]);
						await ended;
						await c.query('SELECT 1');
						return 'committed';
					})
					.then(
						(v) => v,
						(e: Error) => `failed: ${e.message} / cause: ${(e.cause as Error | undefined)?.message}`
					);
				// The caller is told why: the connection's own error is the cause.
				expect(outcome).toMatch(
					/^failed: .* \/ cause: terminating connection due to administrator command$/
				);
				// The dead client was dropped, not pooled: every later
				// transaction works, more of them than the pool holds.
				for (let i = 0; i < 3; i++) {
					const row = await db.withTx(async (c) => {
						// One listener while out: none left behind by an
						// earlier checkout of the same client.
						expect(c.listenerCount('error')).toBe(1);
						return (await c.query('SELECT 7 AS n')).rows[0];
					});
					expect(row).toEqual({ n: 7 });
				}
			}
		} finally {
			await killer.end();
		}
	}, 15_000);

	it('a client that reported an error while checked out is never pooled again, even if it still looks usable', async () => {
		for (const db of [core, api]) {
			const pid = await db.withTx(async (c) => {
				const p = (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
				// An error report on a connection pg has not marked dead.
				c.emit('error', new Error('reported while checked out'));
				return p;
			});
			// The pool hands out its most recently returned client first, so a
			// pooled one would come straight back.
			const next = await db.withTx(
				async (c) => (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p
			);
			expect(next).not.toBe(pid);
		}
	});

	it('a connection that dies the moment it is handed out (ready and FATAL in one read) fails that transaction only', async () => {
		for (const role of ['core', 'api'] as const) {
			const px = await readyThenFatalProxy(TEST_DATABASE_URL!);
			const db = createDatabase(fakeConfig({ databaseUrl: px.url, databasePoolMax: 2 }), role);
			try {
				const outcome = await db
					.withTx(async (c) => (await c.query('SELECT 1')).rowCount)
					.then(
						(v) => `committed ${v}`,
						(e: Error) => `failed: ${e.message}`
					);
				await px.delivered;
				expect(outcome).toMatch(/^failed: /);
				// Anything the closing socket reports comes after the answer:
				// wait until it has closed.
				await px.closed;
				expect(await db.withTx(async (c) => (await c.query('SELECT 7 AS n')).rows[0])).toEqual({
					n: 7
				});
			} finally {
				await db.close();
				await px.close();
			}
		}
	}, 20_000);
});
