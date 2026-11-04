/**
 * Morphit indexer — Postgres connection pools.
 *
 * Two pools per process, each up to MORPHIT_INDEXER_DB_POOL_MAX
 * connections (default 10; Postgres' max_connections must allow twice
 * that):
 *   - 'core': the poller, head tailer, background jobs and migrations.
 *     No statement timeout — a block's transaction and an hourly
 *     signal scan run as long as they need.
 *   - 'api': the HTTP routes. Every statement is cancelled after
 *     API_STATEMENT_TIMEOUT_MS.
 * With one shared pool, a dozen slow orderbook requests held every
 * connection and the poller's next block waited behind them.
 *
 * Both pools turn JIT off: the reputation joins' row estimates are
 * inflated enough that Postgres JIT-compiled queries that run in a
 * millisecond, spending tens to thousands of milliseconds of CPU
 * compiling them. And both end a session left idle inside a
 * transaction, so a stuck client cannot hold locks indefinitely.
 *
 * Transactions are opened via withTx() which handles
 * BEGIN/COMMIT/ROLLBACK consistently and never leaks connections.
 */

import pg from 'pg';
import type { Config } from '$config';
import { logger } from '$log';
import { pgSafeParams } from '$db/pgText';

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

/**
 * A pg client whose every query's parameters are made storable first
 * (v1.20.0, V3-11): a NUL or an unpaired surrogate becomes U+FFFD, and a
 * `$n::jsonb` string holding a `\u0000` / surrogate escape is re-serialised
 * without it. See pgSafeParams in db/pgText.ts — nothing Postgres used to
 * accept is changed; only what it would have REFUSED, which used to throw.
 *
 * The block path canonicalises its own input (dispatcher: pgSafeBlock, and an
 * `invalid_text` rejection); this is the backstop for every other writer —
 * peer responses, RPC answers, and whatever a future change forgets.
 */
export class PgSafeClient extends pg.Client {
	// Every call shape pg.Client.query accepts, passed through; only the
	// parameter array is replaced, and only when a parameter needed it.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	override query(config: any, values?: any, callback?: any): any {
		if (typeof config === 'string' && Array.isArray(values)) {
			return super.query(config, pgSafeParams(config, values), callback);
		}
		if (
			config !== null &&
			typeof config === 'object' &&
			typeof config.submit !== 'function' &&
			Array.isArray(config.values)
		) {
			const safe = pgSafeParams(typeof config.text === 'string' ? config.text : '', config.values);
			if (safe !== config.values) return super.query({ ...config, values: safe }, values, callback);
		}
		return super.query(config, values, callback);
	}
}

/** Statement cap on the HTTP routes' pool. */
export const API_STATEMENT_TIMEOUT_MS = 5_000;

export type DatabaseRole = 'core' | 'api';

/** Session settings sent at connect, per role. */
export function sessionOptionsFor(role: DatabaseRole): string {
	const idleInTxMs = role === 'api' ? 10_000 : 300_000;
	const opts = ['-c jit=off', `-c idle_in_transaction_session_timeout=${idleInTxMs}`];
	if (role === 'api') opts.push(`-c statement_timeout=${API_STATEMENT_TIMEOUT_MS}`);
	return opts.join(' ');
}

export function createDatabase(config: Config, role: DatabaseRole = 'core'): Database {
	const pool = new pg.Pool({
		Client: PgSafeClient,
		connectionString: config.databaseUrl,
		options: sessionOptionsFor(role),
		// Operator knob: MORPHIT_INDEXER_DB_POOL_MAX (default 10), per
		// pool. Bound by Postgres server's max_connections; raise both
		// in lockstep for high-traffic instances.
		max: config.databasePoolMax,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 5_000
	});

	// Surface connection errors early. Without this, a dropped backend
	// connection silently propagates through the pool.
	pool.on('error', (err) => {
		log.error('idle_client_error', { pool: role }, err);
	});

	/**
	 * Check a client out with an 'error' listener for as long as it is out.
	 * pg-pool listens for 'error' only on IDLE clients: on a checked-out one
	 * a connection that dies between two statements (Postgres restarted, a
	 * network drop, a session ended while this code waits on something else)
	 * emits 'error' with no listener, and Node ends the process. With the
	 * listener the next statement fails instead ("not queryable"), the
	 * caller's error path runs, and the client is dropped on release.
	 */
	function checkOut(): Promise<{
		client: pg.PoolClient;
		lost: () => Error | undefined;
		done: () => void;
	}> {
		// The callback form: pg-pool calls it in the same tick in which it
		// removed its own listener, while the socket's bytes are still being
		// read. Awaiting pool.connect() would attach ours a tick later, and a
		// FATAL that arrived with the "ready" message would find none.
		return new Promise((resolve, reject) => {
			pool.connect((err, client) => {
				if (err || client === undefined) {
					reject(err ?? new Error('pg-pool returned no client'));
					return;
				}
				let failure: Error | undefined;
				const onError = (e: Error): void => {
					failure ??= e;
					log.warn('checked_out_client_error', { pool: role }, e);
				};
				client.on('error', onError);
				resolve({
					client,
					lost: () => failure,
					done: () => {
						client.removeListener('error', onError);
					}
				});
			});
		});
	}

	let closed = false;

	return {
		async withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
			const { client, lost, done } = await checkOut();
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
				// The statement that failed only says the client is unusable;
				// the connection's own error says why.
				const failure = lost();
				if (
					failure !== undefined &&
					err instanceof Error &&
					err !== failure &&
					err.cause === undefined
				) {
					err.cause = failure;
				}
				throw err;
			} finally {
				done();
				// A client whose connection failed is dropped, not pooled.
				client.release(lost());
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
