/**
 * Morphit relay — Postgres connection pool.
 *
 * The relay shares the indexer's database so it can drain the
 * relay_pending_transfers queue (ADR-0011 §8) without any
 * indexer-relay coordination beyond the shared table. Users: the
 * queue drainer (welcome bonus, dust, low-balance refill, loyalty
 * BP) and Web Push (push_subscriptions, push_pending).
 *
 * Kept intentionally thin: withTx for transactional writes,
 * query for one-shot reads, close for graceful shutdown.
 * Mirrors apps/indexer/src/db/pool.ts structurally so anyone
 * who reads one can read the other without context-switching.
 */

import pg from 'pg';
import type { Config } from '$config';
import { logger } from '$log';

const log = logger('relay-pg');

export interface Database {
	/** Run a callback inside a transaction. COMMIT if the callback
	 *  resolves; ROLLBACK if it throws. The callback receives a
	 *  PoolClient for parameterized queries. */
	withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
	/** One-shot read query outside a transaction. */
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<pg.QueryResult<R>>;
	/** Acquire a pooled client for fine-grained transaction control
	 *  (BEGIN / SAVEPOINT / COMMIT issued by the caller).  No relay code
	 *  path uses it today (the drainer runs single `query` statements,
	 *  the push store one `withTx`); the queue smokes use it to drive a
	 *  real pool.  Caller
	 *  MUST call `client.release()` in a finally block. */
	connect(): Promise<pg.PoolClient>;
	/** Close the pool. Idempotent. */
	close(): Promise<void>;
}

export function createDatabase(config: Config): Database {
	const pool = new pg.Pool({
		connectionString: config.databaseUrl,
		// Smaller pool than the indexer's — the relay's DB users are
		// the queue drainer (which serializes its writes), the push
		// sender / janitor and the push subscribe API: a handful of
		// short statements at a time.
		max: 5,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 5_000
	});

	pool.on('error', (err) => {
		// Surface dropped-connection errors at the process level so
		// an operator sees them in the relay's journal. Without this,
		// a silently broken idle connection just sits in the pool
		// and gets reused by the next caller.
		log.error('idle_client_error', {}, err);
	});

	let closed = false;

	return {
		async withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
			const client = await pool.connect();
			try {
				await client.query('BEGIN');
				const result = await fn(client);
				await client.query('COMMIT');
				return result;
			} catch (err) {
				try {
					await client.query('ROLLBACK');
				} catch {
					// Ignore — connection is already dead; releasing it
					// below still prevents a pool-slot leak.
				}
				throw err;
			} finally {
				client.release();
			}
		},

		async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
			text: string,
			params?: readonly unknown[]
		): Promise<pg.QueryResult<R>> {
			return pool.query<R>(text, params as unknown[] | undefined);
		},

		async connect(): Promise<pg.PoolClient> {
			return pool.connect();
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			await pool.end();
		}
	};
}
