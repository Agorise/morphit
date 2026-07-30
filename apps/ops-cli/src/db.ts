/**
 * Morphit ops CLI — Postgres connection.
 *
 * Thin pg.Pool wrapper.  Read-only by intent: the CLI doesn't
 * write to the indexer/relay shared database — those mutations
 * are owned by the indexer and relay processes, which are the
 * sources of truth for chain replay state and queue progress.
 *
 * Pool size deliberately tiny (max=2): a CLI invocation does
 * a handful of queries and exits.  Holding more connections
 * open just adds load to the operator's Postgres.
 *
 * The pg import is lazy so subcommands that don't need a DB
 * (notably `init`, the setup wizard) can run on a fresh
 * checkout where `npm install` hasn't happened yet.
 */

import type pgType from 'pg';
import type { Config } from './config.ts';

export interface Database {
	/** Run a parameterized read query.  Returns rows. */
	query<R extends pgType.QueryResultRow = pgType.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<pgType.QueryResult<R>>;
	/** Close the pool.  Called from main on graceful exit. */
	close(): Promise<void>;
}

export async function createDatabase(config: Config): Promise<Database> {
	// Lazy import so the CLI's `init` subcommand (which doesn't
	// touch the DB) works on a fresh checkout where pg hasn't
	// been installed yet.
	const pgModule = (await import('pg')) as { default: typeof pgType } | typeof pgType;
	const pg: typeof pgType = 'default' in pgModule ? pgModule.default : pgModule;

	const pool = new pg.Pool({
		connectionString: config.databaseUrl,
		max: 2,
		idleTimeoutMillis: 5_000,
		connectionTimeoutMillis: 5_000
	});

	pool.on('error', (err: Error) => {
		// Surface dropped-connection errors but don't exit — the
		// CLI's main loop catches the eventual query failure and
		// prints a clean error.  Crashing here would skip the
		// per-command error formatting.
		process.stderr.write(`pg pool error: ${err.message}\n`);
	});

	return {
		async query<R extends pgType.QueryResultRow = pgType.QueryResultRow>(
			text: string,
			params?: readonly unknown[]
		): Promise<pgType.QueryResult<R>> {
			return pool.query<R>(text, params as unknown[] | undefined);
		},
		async close(): Promise<void> {
			await pool.end();
		}
	};
}
