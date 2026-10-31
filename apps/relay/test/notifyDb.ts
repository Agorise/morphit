/**
 * Offline notices: the production tables (the indexer's schema.sql, from the
 * v69 section on: v69 offline_notify_*, v70, v71 offline_notify_matrix_rooms)
 * in a private schema of a real Postgres (TEST_DATABASE_URL), for tests that
 * must run the real store. `DB_TESTS` is false without TEST_DATABASE_URL: such
 * tests skip (the smoke suite runs them with Postgres).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { Database } from '../src/db/pool.ts';
import { openSealedStore } from '../src/notify/store.ts';

export const DB_URL = process.env.TEST_DATABASE_URL ?? '';
export const DB_TESTS = DB_URL !== '';

/** The schema.sql text from the given section banner on. */
export function schemaFrom(version: number): string {
	const sql = readFileSync(join(import.meta.dirname, '../../indexer/src/db/schema.sql'), 'utf8');
	const at = sql.indexOf(`-- ─── v${version}:`);
	if (at < 0) throw new Error(`schema.sql has no v${version} section`);
	return sql.slice(at);
}

/** The text of one section only (to build an older database). */
export function schemaSection(version: number): string {
	const from = schemaFrom(version);
	const next = from.indexOf('\n-- ─── v', 10);
	return next < 0 ? from : from.slice(0, next + 1);
}

export async function notifyDb(opts: { sql?: string } = {}) {
	const name = `notify_t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
	const admin = new pg.Client({ connectionString: DB_URL });
	await admin.connect();
	await admin.query(`CREATE SCHEMA ${name}; SET search_path = ${name}`);
	await admin.query(opts.sql ?? schemaFrom(69));
	// Every connection to this schema says so (application_name): a test can
	// tell its own waiting backends from other tests' on the same database.
	const options = `-c search_path=${name} -c application_name=${name}`;
	const url = `${DB_URL}${DB_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(options)}`;
	const pool = new pg.Pool({ connectionString: DB_URL, max: 8, options });
	const db: Database = {
		async withTx(fn) {
			const c = await pool.connect();
			try {
				await c.query('BEGIN');
				const r = await fn(c);
				await c.query('COMMIT');
				return r;
			} catch (e) {
				await c.query('ROLLBACK').catch(() => {});
				throw e;
			} finally {
				c.release();
			}
		},
		query: (t, p) => pool.query(t, p as unknown[] | undefined) as never,
		connect: () => pool.connect(),
		close: () => pool.end()
	};
	const dataDir = mkdtempSync(join(tmpdir(), 'notify-db-'));
	return {
		name,
		/** A connection URL that lands in this schema (for a child process). */
		url,
		pool,
		db,
		dataDir,
		admin,
		open: async () => (await openSealedStore(db, dataDir)).store,
		count: async (sql: string, params: unknown[] = []): Promise<number> =>
			Number((await pool.query(sql, params)).rows[0]?.n ?? 0),
		async close(): Promise<void> {
			await pool.end().catch(() => undefined);
			await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => undefined);
			await admin.end().catch(() => undefined);
			rmSync(dataDir, { recursive: true, force: true });
		}
	};
}
export type NotifyDb = Awaited<ReturnType<typeof notifyDb>>;
