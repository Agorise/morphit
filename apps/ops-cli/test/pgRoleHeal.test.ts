/**
 * The indexer-role heal. With TEST_DATABASE_URL it runs for real: a fresh
 * login role (created and dropped here) starts with Postgres' defaults (JIT
 * on, no idle-transaction cap); the heal, connecting as that role through the
 * URL an env file gives, must leave a NEW session showing jit = off and
 * idle_in_transaction_session_timeout = 5min. The fallback and failure paths
 * run against a simulated runtime.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	alterStatements,
	databaseUrlIn,
	healPgRole,
	type PgRoleRuntime
} from '../src/lib/pgRoleHeal.ts';

const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };
const ADMIN = process.env.TEST_DATABASE_URL;

describe.skipIf(!ADMIN)(
	'the indexer role gets JIT off and an idle-transaction cap (real Postgres)',
	() => {
		const role = `fix_e_pgrole_${process.pid}`;
		let root = '';
		let url = '';
		const admin = (): pg.Client => new pg.Client({ connectionString: ADMIN });
		const showAs = async (): Promise<[string, string]> => {
			const c = new pg.Client({ connectionString: url });
			await c.connect();
			try {
				const r = await c.query<{ jit: string; idle: string }>(
					"SELECT current_setting('jit') AS jit, current_setting('idle_in_transaction_session_timeout') AS idle"
				);
				return [r.rows[0]!.jit, r.rows[0]!.idle];
			} finally {
				await c.end();
			}
		};
		beforeAll(async () => {
			const c = admin();
			await c.connect();
			await c.query(`DROP ROLE IF EXISTS ${role}`);
			await c.query(
				`CREATE ROLE ${role} LOGIN PASSWORD 'fix-e-test' NOSUPERUSER NOCREATEROLE NOCREATEDB`
			);
			await c.end();
			const u = new URL(ADMIN!);
			u.username = role;
			u.password = 'fix-e-test';
			url = u.toString();
			root = mkdtempSync(join(tmpdir(), 'pgrole-'));
			mkdirSync(join(root, 'etc/morphit'), { recursive: true });
			writeFileSync(join(root, 'etc/morphit/indexer.env'), `MORPHIT_INDEXER_DATABASE_URL=${url}\n`);
		});
		afterAll(async () => {
			const c = admin();
			await c.connect();
			await c.query(`DROP ROLE IF EXISTS ${role}`);
			await c.end();
			rmSync(root, { recursive: true, force: true });
		});

		it('as created, a session of the role has JIT on and no cap — the case the heal is for', async () => {
			expect(await showAs()).toEqual(['on', '0']);
		});

		it('the heal sets both as the role itself and sees them in a new session; a second run has nothing to do', async () => {
			const out = await healPgRole(ctx, { root });
			expect(out).toMatchObject({ strategy: 'as-role', verified: true });
			expect(await showAs()).toEqual(['off', '5min']);
			expect((await healPgRole(ctx, { root })).strategy).toBe('already');
		});
	}
);

describe('the indexer-role heal, simulated', () => {
	class Box {
		url = 'postgresql://morphit_indexer:pw@localhost:5432/morphit_indexer';
		settings = new Map([
			['jit', 'on'],
			['idle_in_transaction_session_timeout', '0']
		]);
		roleMayAlter = true;
		superuser = true;
		reachable = true;
		readonly rt: PgRoleRuntime = {
			readFile: (p) =>
				p.endsWith('/etc/morphit/indexer.env')
					? `MORPHIT_INDEXER_DATABASE_URL="${this.url}"\n`
					: null,
			asRole: async (_u, sql) => {
				if (!this.reachable) return { ok: false, error: 'connect ECONNREFUSED' };
				if (/^ALTER ROLE/.test(sql[0]!)) {
					if (!this.roleMayAlter) return { ok: false, error: 'permission denied to set parameter' };
					this.apply(sql);
					return { ok: true, rows: [] };
				}
				return {
					ok: true,
					rows: [
						[
							'morphit_indexer',
							this.settings.get('jit')!,
							this.settings.get('idle_in_transaction_session_timeout')!
						]
					]
				};
			},
			asSuperuser: (sql) => {
				if (!this.superuser) return { ok: false, error: 'runuser: user postgres does not exist' };
				this.apply(sql);
				return { ok: true, error: '' };
			}
		};
		apply(sql: readonly string[]): void {
			for (const s of sql) {
				const m = /SET (\w+) = '([^']*)'/.exec(s)!;
				this.settings.set(m[1]!, m[2] === '300s' ? '5min' : m[2]!);
			}
		}
		run() {
			return healPgRole(ctx, { runtime: this.rt });
		}
	}

	it('the role may not set its own defaults: done as the postgres superuser, verified', async () => {
		const b = new Box();
		b.roleMayAlter = false;
		expect(await b.run()).toMatchObject({ strategy: 'as-superuser', verified: true });
	});

	it('neither works: not reported as done, the SQL for this server given', async () => {
		const b = new Box();
		b.roleMayAlter = false;
		b.superuser = false;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.detail).toContain(`ALTER ROLE "morphit_indexer" SET jit = 'off'`);
	});

	it('the database is not reachable now: nothing changed, said calmly', async () => {
		const b = new Box();
		b.reachable = false;
		expect(await b.run()).toMatchObject({ strategy: 'deferred', verified: false });
		expect(b.settings.get('jit')).toBe('on');
	});

	it('reads the URL the way the unit does (last file wins, quotes removed)', () => {
		expect(
			databaseUrlIn(['MORPHIT_INDEXER_DATABASE_URL=a\n', 'X=1\nMORPHIT_INDEXER_DATABASE_URL="b"\n'])
		).toBe('b');
		expect(databaseUrlIn(['MORPHIT_INDEXER_DATABASE_URL=\n'])).toBeNull();
		expect(alterStatements('we"ird')[0]).toBe(`ALTER ROLE "we""ird" SET jit = 'off'`);
	});
});
