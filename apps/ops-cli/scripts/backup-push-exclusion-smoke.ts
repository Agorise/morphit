/**
 * backup-push-exclusion-smoke.
 *
 * A node's backup must not carry the Web Push rows: a push_subscriptions row
 * ties an account to a browser's push endpoint (a device), and backups get
 * copied off the box and kept for weeks. Runs the REAL ops/backup/morphit-backup.sh
 * against a scratch database on TEST_DATABASE_URL holding push rows and an
 * ordinary table, then reads the dump: both push tables are there (a restore
 * recreates them) with no rows; the ordinary rows are all there.
 * Without TEST_DATABASE_URL, pg_dump or psql it says so and skips.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { REPO } from './ansible-template-render.ts';

const SCRIPT = process.env.MORPHIT_BACKUP_SCRIPT ?? join(REPO, 'ops/backup/morphit-backup.sh');
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};
const finish = (): never => {
	console.log('');
	if (fail === 0) {
		console.log(`✓ all ${pass} backup-push-exclusion checks passed`);
		process.exit(0);
	}
	console.log(`✗ ${fail} of ${pass + fail} backup-push-exclusion checks failed`);
	process.exit(1);
};

const url = process.env.TEST_DATABASE_URL;
const has = (b: string): boolean => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0;
if (!url || !has('pg_dump') || !has('psql')) {
	check('skipped: needs TEST_DATABASE_URL, pg_dump and psql', true);
	finish();
}
const u = new URL(url!);
const db = `fix_e_backup_${process.pid}`;
const env = {
	...process.env,
	PGHOST: u.hostname,
	PGPORT: u.port || '5432',
	PGUSER: decodeURIComponent(u.username),
	PGPASSWORD: decodeURIComponent(u.password)
};
const psql = (d: string, sql: string) =>
	spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', d, '-c', sql], {
		encoding: 'utf8',
		env
	});
const work = mkdtempSync(join(tmpdir(), 'bkpush-'));
psql(u.pathname.slice(1), `DROP DATABASE IF EXISTS ${db}`);
const created = psql(u.pathname.slice(1), `CREATE DATABASE ${db}`);
try {
	check('a scratch database could be made', created.status === 0, created.stderr);
	psql(
		db,
		`CREATE TABLE push_subscriptions (account text, endpoint text);
		 INSERT INTO push_subscriptions VALUES ('alice', 'https://push.example/device-SECRET-1');
		 CREATE TABLE push_pending (id int, account text, body text);
		 INSERT INTO push_pending VALUES (1, 'alice', 'PENDING-NOTE');
		 CREATE TABLE orders (permlink text);
		 INSERT INTO orders VALUES ('order-KEEP-ME');`
	);
	writeFileSync(
		join(work, 'backup.env'),
		`BACKUP_DIR=${join(work, 'out')}\nDB_NAME=${db}\nDB_USER=${env.PGUSER}\nDB_HOST=${env.PGHOST}\nDB_PORT=${env.PGPORT}\nDB_PASSWORD=${env.PGPASSWORD}\nRETAIN_DAYS=30\n`
	);
	const r = spawnSync('sh', [SCRIPT], {
		encoding: 'utf8',
		env: { ...env, BACKUP_ENV: join(work, 'backup.env') },
		timeout: 120_000
	});
	let dump = '';
	try {
		const f = readdirSync(join(work, 'out')).find((n) => n.endsWith('.sql.gz'));
		if (f) dump = gunzipSync(readFileSync(join(work, 'out', f))).toString('utf8');
	} catch {
		/* no output */
	}
	check(
		'the backup ran and wrote a dump',
		r.status === 0 && dump.length > 0,
		`${r.status} ${(r.stderr ?? '').trim().split('\n').pop()}`
	);
	check(
		'both push tables are in it (a restore recreates them)',
		/CREATE TABLE public\.push_subscriptions/.test(dump) &&
			/CREATE TABLE public\.push_pending/.test(dump)
	);
	check(
		'no push subscription row (no account ↔ device mapping)',
		!dump.includes('device-SECRET-1')
	);
	check('no pending push row', !dump.includes('PENDING-NOTE'));
	check('the ordinary rows are all there', dump.includes('order-KEEP-ME'));
} finally {
	psql(u.pathname.slice(1), `DROP DATABASE IF EXISTS ${db}`);
	rmSync(work, { recursive: true, force: true });
}
finish();
