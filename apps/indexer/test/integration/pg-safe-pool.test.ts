/**
 * v1.20.0 (V3-11) — the production connection pool's backstop.
 *
 * The block path canonicalises its own input; every OTHER writer (peer
 * responses in the federation directory, RPC answers, the treasury, anything
 * a future change adds) goes through createDatabase's pool, whose client makes
 * every query parameter storable. Real Postgres: each of these used to throw.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/db/pool';
import { INTEGRATION_ENABLED, TEST_DATABASE_URL } from './harness';

describe.skipIf(!INTEGRATION_ENABLED)(
	'createDatabase: text Postgres cannot store never throws',
	() => {
		let db: Database;
		const schema = `pgsafe_${process.pid}_${Date.now()}`;
		const t = `"${schema}".t`;
		beforeAll(async () => {
			db = createDatabase({ databaseUrl: TEST_DATABASE_URL!, databasePoolMax: 2 } as never);
			await db.query(`CREATE SCHEMA "${schema}"`);
			await db.query(`CREATE TABLE ${t} (id int PRIMARY KEY, s text, j jsonb, a text[])`);
		});
		afterAll(async () => {
			await db?.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
			await db?.close();
		});

		const row = async (id: number) =>
			(await db.query(`SELECT s, j, a FROM ${t} WHERE id = $1`, [id])).rows[0];

		it('a NUL in a TEXT parameter is stored as U+FFFD', async () => {
			await db.query(`INSERT INTO ${t} (id, s) VALUES ($1, $2)`, [1, 'peer\u0000name']);
			expect((await row(1))?.s).toBe('peer\uFFFDname');
		});

		it('a \\u0000 / lone-surrogate escape bound to $n::jsonb is re-serialised without it', async () => {
			await db.query(`INSERT INTO ${t} (id, j) VALUES ($1, $2::jsonb)`, [
				2,
				'{"name":"x\\u0000","k\\u0000":["\\ud800"],"ok":"\\ud83d\\ude00"}'
			]);
			expect((await row(2))?.j).toEqual({ name: 'x\uFFFD', 'k\uFFFD': ['\uFFFD'], ok: '😀' });
		});

		it('an object parameter (pg serialises it) and a text[] parameter are canonicalised deeply', async () => {
			await db.query(`INSERT INTO ${t} (id, j, a) VALUES ($1, $2, $3)`, [
				3,
				{ tor: 'a\u0000.onion', nested: ['\uDC00'] },
				['ok', 'b\u0000']
			]);
			const r = await row(3);
			expect(r?.j).toEqual({ tor: 'a\uFFFD.onion', nested: ['\uFFFD'] });
			expect(r?.a).toEqual(['ok', 'b\uFFFD']);
		});

		it('inside a transaction too, and the config-object call shape', async () => {
			await db.withTx(async (c) => {
				await c.query({ text: `INSERT INTO ${t} (id, s) VALUES ($1, $2)`, values: [4, '\u0000'] });
			});
			expect((await row(4))?.s).toBe('\uFFFD');
		});

		it('changes nothing Postgres accepted before: a literal "\\u0000" in TEXT stays as written', async () => {
			await db.query(`INSERT INTO ${t} (id, s) VALUES ($1, $2)`, [5, 'type \\u0000 here']);
			expect((await row(5))?.s).toBe('type \\u0000 here');
		});
	}
);
