/**
 * The relay's pool survives a connection that dies while its client is
 * checked out (v1.22.1): pg-pool listens for 'error' on IDLE clients only, so
 * a checked-out client whose connection dropped between two statements
 * emitted 'error' with no listener and Node ended the relay. Now the next
 * statement fails, the transaction's error path runs, and the dead client is
 * dropped on release. Real Postgres (TEST_DATABASE_URL); skipped without.
 */
import net from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/db/pool.ts';
import { DB_TESTS, DB_URL } from './notifyDb.ts';

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

describe.skipIf(!DB_TESTS)('relay pool: a connection lost while checked out', () => {
	let db: Database;
	let killer: pg.Client;

	beforeAll(async () => {
		db = createDatabase({ databaseUrl: DB_URL } as never);
		killer = new pg.Client({ connectionString: DB_URL });
		await killer.connect();
	});
	afterAll(async () => {
		await killer?.end();
		await db?.close();
	});

	async function pidOf(c: pg.PoolClient): Promise<number> {
		return (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
	}

	it('withTx: the transaction fails, the relay and the pool carry on', async () => {
		const outcome = await db
			.withTx(async (c) => {
				const pid = await pidOf(c);
				// The client emits 'error', then 'end'.
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
		// More transactions than the pool holds (5): the dead client is gone.
		for (let i = 0; i < 7; i++) {
			expect(await db.withTx(async (c) => (await c.query('SELECT 7 AS n')).rows[0])).toEqual({
				n: 7
			});
		}
	}, 15_000);

	it('connect(): the caller sees the statement fail and releases; the client is not handed out again', async () => {
		const c = await db.connect();
		const pid = await pidOf(c);
		const ended = new Promise((r) => c.once('end', r));
		await killer.query('SELECT pg_terminate_backend($1)', [pid]);
		await ended;
		await expect(c.query('SELECT 1')).rejects.toThrow();
		c.release();
		for (let i = 0; i < 7; i++) {
			const again = await db.connect();
			try {
				expect(await pidOf(again)).not.toBe(pid);
			} finally {
				again.release();
			}
		}
	}, 15_000);

	it('a client that reported an error while out is never pooled again; no listener is left behind', async () => {
		// withTx
		const pid = await db.withTx(async (c) => {
			expect(c.listenerCount('error')).toBe(1);
			c.emit('error', new Error('reported while checked out'));
			return pidOf(c);
		});
		// The pool hands out its most recently returned client first.
		expect(await db.withTx(async (c) => pidOf(c))).not.toBe(pid);
		// connect()
		const c = await db.connect();
		expect(c.listenerCount('error')).toBe(1);
		const pid2 = await pidOf(c);
		c.emit('error', new Error('reported while checked out'));
		c.release();
		const again = await db.connect();
		try {
			expect(again.listenerCount('error')).toBe(1);
			expect(await pidOf(again)).not.toBe(pid2);
		} finally {
			again.release();
		}
		// A healthy client comes back with exactly one listener while out.
		for (let i = 0; i < 3; i++) {
			const h = await db.connect();
			try {
				expect(h.listenerCount('error')).toBe(1);
			} finally {
				h.release();
			}
		}
	});

	it('a connection that dies the moment it is handed out (ready and FATAL in one read): withTx and connect() fail, the relay carries on', async () => {
		for (const how of ['withTx', 'connect'] as const) {
			const px = await readyThenFatalProxy(DB_URL);
			const viaProxy = createDatabase({ databaseUrl: px.url } as never);
			try {
				const outcome =
					how === 'withTx'
						? await viaProxy
								.withTx(async (c) => (await c.query('SELECT 1')).rowCount)
								.then(
									(v) => `committed ${v}`,
									(e: Error) => `failed: ${e.message}`
								)
						: await viaProxy.connect().then(
								async (c) => {
									try {
										return `committed ${(await c.query('SELECT 1')).rowCount}`;
									} catch (e) {
										return `failed: ${(e as Error).message}`;
									} finally {
										c.release();
									}
								},
								(e: Error) => `failed: ${e.message}`
							);
				await px.delivered;
				expect(outcome).toMatch(/^failed: /);
				// Anything the closing socket reports comes after the answer:
				// wait until it has closed.
				await px.closed;
				expect(
					await viaProxy.withTx(async (c) => (await c.query('SELECT 7 AS n')).rows[0])
				).toEqual({ n: 7 });
			} finally {
				await viaProxy.close();
				await px.close();
			}
		}
	}, 20_000);
});
