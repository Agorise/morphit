/**
 * v1.21.1 review (D-1): a country list saved through BunkerWeb's web UI lives
 * in BunkerWeb's database with method "ui", and BunkerWeb 1.5.10 never lets
 * the env file's value replace it (Database.save_config only updates a row
 * whose method is the caller's). The heal removes such rows with
 * COUNTRY_DB_PY, run inside the scheduler (its image ships python3 and
 * sqlite3). This runs that very script against a database with BunkerWeb
 * 1.5.10's own table definitions (as SQLAlchemy creates them from its
 * model.py) and checks what it reads, what it removes, what it keeps, the
 * backup, and the flag that makes the running scheduler rebuild its config.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	COUNTRY_DB_PY,
	countryKeyOf,
	parseCountryDb,
	parseCountryRemoval,
	type CountryRow
} from '../src/lib/bunkerwebPrivacy.ts';

// BunkerWeb 1.5.10's tables, as `Base.metadata.create_all` writes them on sqlite.
const DDL = `
CREATE TABLE bw_plugins (id VARCHAR(64) NOT NULL, name VARCHAR(128) NOT NULL, description VARCHAR(256) NOT NULL, version VARCHAR(32) NOT NULL, stream VARCHAR(7) NOT NULL, type VARCHAR(8) NOT NULL, method VARCHAR(9) NOT NULL, data BLOB, checksum VARCHAR(128), config_changed BOOLEAN, last_config_change DATETIME, PRIMARY KEY (id));
CREATE TABLE bw_services (id VARCHAR(64) NOT NULL, method VARCHAR(9) NOT NULL, is_draft BOOLEAN NOT NULL, PRIMARY KEY (id));
CREATE TABLE bw_settings (id VARCHAR(256) NOT NULL, name VARCHAR(256) NOT NULL, plugin_id VARCHAR(64) NOT NULL, context VARCHAR(9) NOT NULL, "default" VARCHAR(4096), help VARCHAR(512) NOT NULL, label VARCHAR(256), regex VARCHAR(1024) NOT NULL, type VARCHAR(8) NOT NULL, multiple VARCHAR(128), "order" INTEGER NOT NULL, PRIMARY KEY (id, name), UNIQUE (id), FOREIGN KEY(plugin_id) REFERENCES bw_plugins (id) ON DELETE cascade ON UPDATE cascade);
CREATE TABLE bw_global_values (setting_id VARCHAR(256) NOT NULL, value TEXT NOT NULL, suffix INTEGER, method VARCHAR(9) NOT NULL, PRIMARY KEY (setting_id, suffix), FOREIGN KEY(setting_id) REFERENCES bw_settings (id) ON DELETE cascade ON UPDATE cascade);
CREATE TABLE bw_services_settings (service_id VARCHAR(64) NOT NULL, setting_id VARCHAR(256) NOT NULL, value TEXT NOT NULL, suffix INTEGER, method VARCHAR(9) NOT NULL, PRIMARY KEY (service_id, setting_id, suffix), FOREIGN KEY(service_id) REFERENCES bw_services (id) ON DELETE cascade ON UPDATE cascade, FOREIGN KEY(setting_id) REFERENCES bw_settings (id) ON DELETE cascade ON UPDATE cascade);
INSERT INTO bw_plugins VALUES ('country','Country','','1.0','no','core','manual',NULL,NULL,0,NULL);
INSERT INTO bw_plugins VALUES ('misc','Miscellaneous','','1.0','no','core','manual',NULL,NULL,0,NULL);
INSERT INTO bw_settings VALUES ('BLACKLIST_COUNTRY','Country blacklist','country','multisite','','','','^$','text',NULL,0);
INSERT INTO bw_settings VALUES ('WHITELIST_COUNTRY','Country whitelist','country','multisite','','','','^$','text',NULL,0);
INSERT INTO bw_settings VALUES ('SERVER_NAME','Server name','misc','multisite','www.example.com','','','^$','text',NULL,0);
INSERT INTO bw_services VALUES ('shop.example.org','scheduler',0);
INSERT INTO bw_services VALUES ('app.example.org','autoconf',0);
INSERT INTO bw_global_values VALUES ('BLACKLIST_COUNTRY','CN IR',0,'ui');
INSERT INTO bw_global_values VALUES ('WHITELIST_COUNTRY','FR',0,'scheduler');
INSERT INTO bw_global_values VALUES ('SERVER_NAME','shop.example.org',0,'ui');
INSERT INTO bw_services_settings VALUES ('shop.example.org','WHITELIST_COUNTRY','US',0,'ui');
INSERT INTO bw_services_settings VALUES ('app.example.org','BLACKLIST_COUNTRY','RU',0,'autoconf');
`;

const py = spawnSync('python3', ['-c', 'import sqlite3'], { encoding: 'utf8' }).status === 0;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function box(): { db: string; sql: (q: string) => unknown[][] } {
	const dir = mkdtempSync(join(tmpdir(), 'bwdb-'));
	dirs.push(dir);
	const db = join(dir, 'db.sqlite3');
	const r = spawnSync(
		'python3',
		[
			'-c',
			'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.stdin.read()); c.commit()',
			db
		],
		{ input: DDL, encoding: 'utf8' }
	);
	expect(r.status, r.stderr).toBe(0);
	return {
		db,
		sql: (q) => {
			const o = spawnSync(
				'python3',
				[
					'-c',
					'import json,sqlite3,sys; print(json.dumps(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchall()))',
					db,
					q
				],
				{ encoding: 'utf8' }
			);
			expect(o.status, o.stderr).toBe(0);
			return JSON.parse(o.stdout) as unknown[][];
		}
	};
}

/** The script as the heal runs it (`docker exec -i -e MODE=… <scheduler> python3 -c …`). */
function run(env: Record<string, string>, stdin = ''): { status: number | null; out: string } {
	const r = spawnSync('python3', ['-c', COUNTRY_DB_PY], {
		input: stdin,
		encoding: 'utf8',
		env: { PATH: process.env.PATH ?? '', ...env }
	});
	return { status: r.status, out: (r.stdout ?? '').trim() };
}

describe.skipIf(!py)("a country list in BunkerWeb's own database (D-1)", () => {
	it('lists every saved country list with where it came from (method), global and per site', () => {
		const b = box();
		const r = run({ MODE: 'list', DATABASE_URI: `sqlite:///${b.db}` });
		expect(r.status).toBe(0);
		const db = parseCountryDb(r.out)!;
		expect(db.db).toBe('sqlite');
		const seen = db.rows.map((x) => `${countryKeyOf(x)}=${x.value} (${x.method})`).sort();
		expect(seen).toEqual([
			'BLACKLIST_COUNTRY=CN IR (ui)',
			'WHITELIST_COUNTRY=FR (scheduler)',
			'app.example.org_BLACKLIST_COUNTRY=RU (autoconf)',
			'shop.example.org_WHITELIST_COUNTRY=US (ui)'
		]);
	});
	it('removes exactly the web-UI rows it is given, after a backup, and makes the running scheduler rebuild', () => {
		const b = box();
		const ui = parseCountryDb(
			run({ MODE: 'list', DATABASE_URI: `sqlite:///${b.db}` }).out
		)!.rows.filter((x) => x.method === 'ui');
		const r = run({ MODE: 'remove', DATABASE_URI: `sqlite:///${b.db}` }, JSON.stringify(ui));
		expect(r.status).toBe(0);
		const res = parseCountryRemoval(r.out)!;
		expect(res.removed).toBe(2);
		expect(existsSync(res.backup)).toBe(true);
		// the backup is the database as it was
		const bk = spawnSync(
			'python3',
			[
				'-c',
				'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT value FROM bw_global_values WHERE setting_id=\'BLACKLIST_COUNTRY\'").fetchone()[0])',
				res.backup
			],
			{ encoding: 'utf8' }
		);
		expect(bk.stdout.trim()).toBe('CN IR');
		// gone: the two web-UI lists; kept: everything else, the UI's SERVER_NAME included
		expect(
			b.sql('SELECT setting_id, value, method FROM bw_global_values ORDER BY setting_id')
		).toEqual([
			['SERVER_NAME', 'shop.example.org', 'ui'],
			['WHITELIST_COUNTRY', 'FR', 'scheduler']
		]);
		expect(b.sql('SELECT service_id, setting_id, value, method FROM bw_services_settings')).toEqual(
			[['app.example.org', 'BLACKLIST_COUNTRY', 'RU', 'autoconf']]
		);
		// BunkerWeb's scheduler polls this flag (Database.check_changes) and rebuilds
		const flags = b.sql(
			'SELECT id, config_changed, last_config_change IS NOT NULL FROM bw_plugins ORDER BY id'
		);
		expect(flags).toEqual([
			['country', 1, 1],
			['misc', 0, 0]
		]);
	});
	it('a row that is not (or no longer) a web-UI row is never removed: all or nothing', () => {
		const b = box();
		const rows = parseCountryDb(run({ MODE: 'list', DATABASE_URI: `sqlite:///${b.db}` }).out)!.rows;
		const wrong: CountryRow[] = rows.filter((x) => x.method !== 'scheduler');
		const r = run({ MODE: 'remove', DATABASE_URI: `sqlite:///${b.db}` }, JSON.stringify(wrong));
		expect(parseCountryRemoval(r.out)).toBeNull();
		expect(
			b.sql("SELECT COUNT(*) FROM bw_global_values WHERE setting_id='BLACKLIST_COUNTRY'")
		).toEqual([[1]]);
		expect(b.sql('SELECT COUNT(*) FROM bw_services_settings')).toEqual([[2]]);
		expect(b.sql("SELECT config_changed FROM bw_plugins WHERE id='country'")).toEqual([[0]]);
	});
	it('BunkerWeb on MariaDB/PostgreSQL, or no database yet: said so, nothing touched', () => {
		expect(
			parseCountryDb(run({ MODE: 'list', DATABASE_URI: 'mariadb+pymysql://bw:x@db/bw' }).out)?.db
		).toBe('other');
		expect(
			parseCountryDb(run({ MODE: 'list', DATABASE_URI: 'sqlite:////nonexistent/db.sqlite3' }).out)
				?.db
		).toBe('missing');
	});
	it("with no DATABASE_URI it reads BunkerWeb's default database path", () => {
		const r = run({ MODE: 'where' });
		expect(r.out).toBe('/var/lib/bunkerweb/db.sqlite3');
	});
});
