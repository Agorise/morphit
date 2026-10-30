/**
 * The script the www heal runs inside BunkerWeb's scheduler (WWW_DB_PY), run
 * here with python3 against a sqlite database with BunkerWeb 1.5.10's tables.
 * BunkerWeb 1.5 (single site) serves exactly the names in bw_services and
 * only ever puts the FIRST name of SERVER_NAME there, so www.<domain> from the
 * settings file was never served (morphit.io, v1.21.17); the run of BunkerWeb's
 * own Database.py that shows a further save keeps the added row is recorded in
 * the audit. Here: list, add (only behind the domain, never twice, after a
 * copy of the database), and taking out Morphit's second copy of the www rule.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WWW_DB_PY, WWW_RULE_FILE } from '../src/lib/bunkerwebWww.ts';

const d = mkdtempSync(join(tmpdir(), 'www-db-'));
afterAll(() => rmSync(d, { recursive: true, force: true }));
const DB = join(d, 'lib', 'db.sqlite3');
const hasPython = spawnSync('python3', ['-c', 'import sqlite3']).status === 0;

function sql(q: string): string {
	const r = spawnSync(
		'python3',
		[
			'-c',
			`import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);r=c.execute(sys.argv[2]).fetchall();c.commit();print(r)`,
			DB,
			q
		],
		{ encoding: 'utf8' }
	);
	return r.stdout.trim();
}
function run(env: Record<string, string>): Record<string, unknown> {
	const r = spawnSync('python3', ['-c', WWW_DB_PY], {
		encoding: 'utf8',
		env: { ...process.env, DATABASE_URI: `sqlite:///${DB}`, ...env }
	});
	return JSON.parse(r.stdout.trim()) as Record<string, unknown>;
}

describe.runIf(hasPython)("BunkerWeb's site list (bw_services)", () => {
	mkdirSync(join(d, 'lib'), { recursive: true });
	sql(
		'CREATE TABLE bw_services (id VARCHAR(64) PRIMARY KEY, method TEXT NOT NULL, is_draft BOOLEAN NOT NULL DEFAULT 0)'
	);
	sql(
		'CREATE TABLE bw_custom_configs (id INTEGER PRIMARY KEY, service_id TEXT, type TEXT, name TEXT, data BLOB, checksum TEXT, method TEXT)'
	);
	sql("INSERT INTO bw_services (id, method, is_draft) VALUES ('morphit.io', 'scheduler', 0)");

	it('lists what BunkerWeb serves: the domain only', () => {
		expect(run({ MODE: 'list' })).toEqual({ db: 'sqlite', ids: ['morphit.io'] });
	});
	it('adds www behind the domain, as the scheduler’s own, after a copy of the database', () => {
		const r = run({ MODE: 'add', ADD: 'www.morphit.io', FIRST: 'morphit.io' });
		expect(r.added).toBe(1);
		expect(existsSync(String(r.backup))).toBe(true);
		expect(run({ MODE: 'list' })).toEqual({ db: 'sqlite', ids: ['morphit.io', 'www.morphit.io'] });
		expect(sql("SELECT method, is_draft FROM bw_services WHERE id = 'www.morphit.io'")).toBe(
			"[('scheduler', 0)]"
		);
	});
	it('never twice, and never when the domain is not first', () => {
		expect(run({ MODE: 'add', ADD: 'www.morphit.io', FIRST: 'morphit.io' })).toEqual({ added: 0 });
		expect(run({ MODE: 'add', ADD: 'www.other.org', FIRST: 'other.org' })).toEqual({ added: 0 });
		expect(run({ MODE: 'list' })).toEqual({ db: 'sqlite', ids: ['morphit.io', 'www.morphit.io'] });
	});
	it('takes out Morphit’s second copy of the www rule (its row and its file), keeps the one from the settings', () => {
		sql(
			"INSERT INTO bw_custom_configs (service_id, type, name, data, method) VALUES (NULL, 'server_http', 'morphit_www_redirect', 'x', 'scheduler')"
		);
		sql(
			`INSERT INTO bw_custom_configs (service_id, type, name, data, method) VALUES (NULL, 'server_http', '${WWW_RULE_FILE}', 'x', 'manual')`
		);
		const conf = join(d, 'configs', 'server-http');
		mkdirSync(conf, { recursive: true });
		writeFileSync(join(conf, `${WWW_RULE_FILE}.conf`), 'x');
		// the script looks in /data/configs and /etc/bunkerweb/configs: point one of them here
		const r = spawnSync(
			'python3',
			[
				'-c',
				WWW_DB_PY.replace(
					'("/data/configs", "/etc/bunkerweb/configs")',
					`(${JSON.stringify(join(d, 'configs'))},)`
				)
			],
			{
				encoding: 'utf8',
				env: {
					...process.env,
					DATABASE_URI: `sqlite:///${DB}`,
					MODE: 'unrule',
					NAME: WWW_RULE_FILE
				}
			}
		);
		expect(JSON.parse(r.stdout)).toMatchObject({ rows: 1, moved: 1 });
		expect(sql('SELECT name FROM bw_custom_configs')).toBe("[('morphit_www_redirect',)]");
		expect(readdirSync(conf)).toEqual([]);
	});
});

/**
 * BunkerWeb 1.6's bw_services also has creation_date and last_update, NOT NULL
 * (its model.py, Services). The INSERT without them failed AFTER the copy of
 * the database was made, so every upgrade left one more copy behind (v1.21.18
 * audit, M5). 1.6 still serves, for a single site, exactly the names of this
 * list (its Database.py: SERVER_NAME = the bw_services ids, non-multisite).
 * The schemas are 1.5.10's and 1.6's as their model.py makes them in sqlite.
 */
function freshDb(schema: string, rows: string[]): { dir: string; uri: string } {
	const dir = mkdtempSync(join(d, 'v-'));
	const db = join(dir, 'db.sqlite3');
	const r = spawnSync(
		'python3',
		[
			'-c',
			'import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);[c.execute(q) for q in json.loads(sys.argv[2])];c.commit()',
			db,
			JSON.stringify([
				schema,
				'CREATE TABLE bw_custom_configs (id INTEGER PRIMARY KEY, service_id TEXT, type TEXT, name TEXT, data BLOB, checksum TEXT, method TEXT)',
				...rows
			])
		],
		{ encoding: 'utf8' }
	);
	expect(r.status, r.stderr).toBe(0);
	return { dir, uri: `sqlite:///${db}` };
}
function runAt(uri: string, env: Record<string, string>): Record<string, unknown> {
	const r = spawnSync('python3', ['-c', WWW_DB_PY], {
		encoding: 'utf8',
		env: { ...process.env, DATABASE_URI: uri, ...env }
	});
	expect(r.status, r.stderr).toBe(0);
	return JSON.parse(r.stdout.trim()) as Record<string, unknown>;
}
const copies = (dir: string): string[] =>
	readdirSync(dir).filter((n) => n.startsWith('db.pre-morphit-'));
function rowsOf(uri: string, q: string): string {
	return spawnSync(
		'python3',
		[
			'-c',
			'import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchall())',
			uri.replace('sqlite:///', ''),
			q
		],
		{ encoding: 'utf8' }
	).stdout.trim();
}
const V16 =
	'CREATE TABLE bw_services (id VARCHAR(256) NOT NULL, method VARCHAR(9) NOT NULL, is_draft BOOLEAN NOT NULL, creation_date DATETIME NOT NULL, last_update DATETIME NOT NULL, PRIMARY KEY (id))';
const V15 =
	'CREATE TABLE bw_services (id VARCHAR(64) NOT NULL, method VARCHAR(9) NOT NULL, is_draft BOOLEAN NOT NULL, PRIMARY KEY (id))';

describe.runIf(hasPython)('BunkerWeb 1.6 and a failed add (M5)', () => {
	it('1.6: www is added with its dates, as BunkerWeb writes them; one copy of the database', () => {
		const v = freshDb(V16, [
			"INSERT INTO bw_services VALUES ('example.org', 'scheduler', 0, '2026-01-01 10:00:00.000000', '2026-01-01 10:00:00.000000')"
		]);
		const r = runAt(v.uri, { MODE: 'add', ADD: 'www.example.org', FIRST: 'example.org' });
		expect(r.added).toBe(1);
		expect(copies(v.dir)).toHaveLength(1);
		expect(runAt(v.uri, { MODE: 'list' })).toEqual({
			db: 'sqlite',
			ids: ['example.org', 'www.example.org']
		});
		// SQLAlchemy's sqlite DateTime format (YYYY-MM-DD HH:MM:SS.ffffff).
		expect(
			rowsOf(
				v.uri,
				"SELECT method, is_draft, creation_date, last_update FROM bw_services WHERE id = 'www.example.org'"
			)
		).toMatch(/^\[\('scheduler', 0, '(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6})', '\1'\)\]$/);
	});
	it('1.5: as before, without dates', () => {
		const v = freshDb(V15, ["INSERT INTO bw_services VALUES ('example.org', 'scheduler', 0)"]);
		expect(runAt(v.uri, { MODE: 'add', ADD: 'www.example.org', FIRST: 'example.org' }).added).toBe(
			1
		);
		expect(rowsOf(v.uri, 'SELECT id FROM bw_services')).toBe(
			"[('example.org',), ('www.example.org',)]"
		);
	});
	it('a table it cannot fill (another NOT NULL column): nothing changed, and no copy left behind', () => {
		const v = freshDb(
			'CREATE TABLE bw_services (id VARCHAR(256) NOT NULL, method VARCHAR(9) NOT NULL, is_draft BOOLEAN NOT NULL, owner TEXT NOT NULL, PRIMARY KEY (id))',
			["INSERT INTO bw_services VALUES ('example.org', 'scheduler', 0, 'x')"]
		);
		for (let k = 0; k < 3; k++) {
			const r = runAt(v.uri, { MODE: 'add', ADD: 'www.example.org', FIRST: 'example.org' });
			expect(r.added).toBe(0);
			expect(String(r.error)).toMatch(/NOT NULL/);
		}
		expect(copies(v.dir)).toEqual([]);
		expect(rowsOf(v.uri, 'SELECT id FROM bw_services')).toBe("[('example.org',)]");
	});
});

describe.runIf(hasPython)('taking out the second copy of the www rule (L2)', () => {
	it('nothing to take out: no copy of the database is made', () => {
		const v = freshDb(V15, ["INSERT INTO bw_services VALUES ('example.org', 'scheduler', 0)"]);
		const r = runAt(v.uri, { MODE: 'unrule', NAME: WWW_RULE_FILE });
		expect(r).toMatchObject({ rows: 0, moved: 0, backup: null });
		expect(copies(v.dir)).toEqual([]);
	});
});
