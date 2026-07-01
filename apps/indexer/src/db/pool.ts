/**
 * Morphit indexer — Postgres connection pool.
 *
 * One pool per process. Transactions are opened via withTx() which
 * handles BEGIN/COMMIT/ROLLBACK consistently and never leaks
 * connections.
 *
 * Pool sizing: up to 10 connections. The indexer has two concurrent
 * consumers — the poller (one block at a time) and the HTTP API
 * (parallel reads) — so 10 is generous without being wasteful on a
 * small VPS.
 */

import pg from 'pg';
import type { Config } from '$config';
import { logger } from '$log';

const log = logger('pg-pool');

export interface Database {
	/** Run a callback inside a transaction. Committed if the callback
	 *  resolves; rolled back if it throws. The callback receives a
	 *  PoolClient usable for parameterised queries. */
	withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
	/** Run a single read query outside of a transaction. Useful for
	 *  the HTTP API, which never writes. */
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<pg.QueryResult<R>>;
	/** Close the pool. Idempotent. */
	close(): Promise<void>;
}

export function createDatabase(config: Config): Database {
	const pool = new pg.Pool({
		connectionString: config.databaseUrl,
		// Operator knob: MORPHIT_INDEXER_DB_POOL_MAX (default 10).
		// Bound by Postgres server's max_connections; raise both
		// in lockstep for high-traffic instances.
		max: config.databasePoolMax,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 5_000
	});

	// Surface connection errors early. Without this, a dropped backend
	// connection silently propagates through the pool.
	pool.on('error', (err) => {
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
					// If ROLLBACK itself fails the connection is probably
					// already dead. Release it to the pool anyway so we
					// don't leak a slot.
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
			// pg types take a mutable `any[]`; our caller passes
			// readonly, which is safer. Cast only at the boundary.
			return pool.query<R>(text, params as unknown[] | undefined);
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			await pool.end();
		}
	};
}
