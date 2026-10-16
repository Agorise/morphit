/**
 * offline-notify-admin-smoke — the relay's admin tool for `sudo morphit-ops
 * offline-notify`, run for real (a child process, the relay's own settings,
 * the indexer's schema.sql v69 tables in a private schema):
 *
 *   - `status` tells "the key file is gone or is another key" (the only cases
 *     where the operator may start over and delete every user's address)
 *     apart from "this process may not read it" and "the database is down" —
 *     which must never be mistaken for a lost key;
 *   - `reset` deletes the saved addresses AND the key file, so the relay's
 *     next start really makes a new key;
 *   - `purge-channel matrix` says how many rooms the bot could not leave yet.
 *
 * Needs TEST_DATABASE_URL (skips without it); the "cannot read" case needs
 * root and setpriv (skipped otherwise).
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	chownSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PrivateKey } from '@beblurt/dblurt';
import { openSealedStore } from '../src/notify/store.ts';
import { VAULT_KEY_FILE } from '../src/notify/vault.ts';

let n = 0;
let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
	n++;
	if (!ok) failures++;
	console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
};

const url = process.env.TEST_DATABASE_URL;
if (!url) {
	console.log('offline-notify-admin-smoke: skipped — TEST_DATABASE_URL is not set');
	process.exit(0);
}

const HERE = import.meta.dirname;
const RELAY = join(HERE, '..');
const TSX = join(RELAY, '..', '..', 'node_modules', '.bin', 'tsx');
const SCHEMA = `offline_notify_admin_${process.pid}`;
const schemaSql = readFileSync(join(RELAY, '../indexer/src/db/schema.sql'), 'utf8');
const v69 = schemaSql.slice(schemaSql.indexOf('-- ─── v69:'));
if (!v69.startsWith('-- ─── v69:')) throw new Error('schema.sql has no v69 section');

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(
	`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path = ${SCHEMA}`
);
await admin.query(v69);

const work = mkdtempSync(join(tmpdir(), 'notify-admin-'));
const dataDir = join(work, 'state');
const keyFile = join(work, 'active.key');
writeFileSync(keyFile, PrivateKey.fromSeed(`admin-smoke-${process.pid}`).toString(), {
	mode: 0o600
});
const withSchema = (u: string): string =>
	`${u}${u.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const env = (dbUrl = withSchema(url)): NodeJS.ProcessEnv => ({
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	MORPHIT_RELAY_ACCOUNT: 'site-relay',
	MORPHIT_RELAY_ACTIVE_KEY_FILE: keyFile,
	MORPHIT_RELAY_DATABASE_URL: dbUrl,
	MORPHIT_RELAY_DATA_DIR: dataDir,
	MORPHIT_INSTANCE_ORIGIN: 'https://site.example'
});
const run = (
	args: string[],
	opts: { dbUrl?: string; prefix?: string[] } = {}
): Record<string, unknown> => {
	const cmd = [...(opts.prefix ?? []), TSX, join(RELAY, 'src/notify/adminCli.ts'), ...args];
	const r = spawnSync(cmd[0]!, cmd.slice(1), {
		env: env(opts.dbUrl),
		input: '',
		encoding: 'utf8',
		timeout: 120_000
	});
	try {
		return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;
	} catch {
		return { unparsed: r.stdout, stderr: r.stderr };
	}
};
const pool = new pg.Pool({ connectionString: withSchema(url), max: 2 });
const db = {
	query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]),
	withTx: async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
		const c = await pool.connect();
		try {
			await c.query('BEGIN');
			const r = await fn(c);
			await c.query('COMMIT');
			return r;
		} catch (e) {
			await c.query('ROLLBACK').catch(() => undefined);
			throw e;
		} finally {
			c.release();
		}
	},
	connect: () => pool.connect(),
	close: () => pool.end()
};

try {
	check(
		'nothing saved yet: key "none"',
		run(['status']).key === 'none',
		JSON.stringify(run(['status']))
	);

	// A user saves an address: the relay makes the key and records it.
	const { store } = await openSealedStore(db as never, dataDir);
	await pool.query(
		`INSERT INTO offline_notify_channels (account, channel, address_sealed, verified_at)
		 VALUES ('grandma', 'email', $1, now())`,
		[store.vault.seal('grandma@example.net', 'grandma', 'email', 'address')]
	);
	const ok = run(['status']);
	check('the right key file: key "ok"', ok.key === 'ok', JSON.stringify(ok));

	// The key file gone.
	const keyPath = join(dataDir, VAULT_KEY_FILE);
	const aside = join(work, 'aside.key');
	renameSync(keyPath, aside);
	const missing = run(['status']);
	check(
		'the key file gone: key "missing" (start over may be offered)',
		missing.key === 'missing',
		JSON.stringify(missing)
	);
	// Another key in its place.
	writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
	const other = run(['status']);
	check(
		'another key file: key "mismatch" (start over may be offered)',
		other.key === 'mismatch',
		JSON.stringify(other)
	);
	renameSync(aside, keyPath);

	// The database down: never "missing".
	const down = run(['status'], { dbUrl: 'postgres://morphit:morphit@127.0.0.1:5999/nothing' });
	check(
		'the database down: key "db_error", not a lost key',
		down.key === 'db_error',
		JSON.stringify(down)
	);

	// A process that may not read the state directory (the relay moved to
	// another user): "unreadable", not "missing".
	const canDropCaps = process.getuid?.() === 0 && spawnSync('setpriv', ['--help']).status === 0;
	if (canDropCaps) {
		chownSync(dataDir, 65534, 65534);
		chmodSync(dataDir, 0o700);
		const noRead = run(['status'], {
			prefix: [
				'setpriv',
				'--inh-caps=-dac_override,-dac_read_search',
				'--bounding-set=-dac_override,-dac_read_search',
				'--'
			]
		});
		chownSync(dataDir, 0, 0);
		check(
			'a key file this process may not read: key "unreadable", not "missing"',
			noRead.key === 'unreadable',
			JSON.stringify(noRead)
		);
	} else {
		check('skipped: "cannot read" needs root and setpriv', true);
	}

	// Matrix rooms the bot could not leave (Matrix not set up here): waiting.
	await pool.query(
		`INSERT INTO offline_notify_channels (account, channel, address_sealed, route_sealed, verified_at)
		 VALUES ('grandma', 'matrix', $1, $2, now())`,
		[
			store.vault.seal('@grandma:hs.org', 'grandma', 'matrix', 'address'),
			store.vault.seal('!room:hs.org', 'grandma', 'matrix', 'route')
		]
	);
	const purged = run(['purge-channel', 'matrix']);
	check(
		'turning Matrix off: its addresses go, and the rooms not left yet are counted',
		purged.ok === true && purged.removed === 1 && purged.waiting === 1,
		JSON.stringify(purged)
	);

	// Start over: addresses and the key file go; the next start makes a new key.
	const reset = run(['reset']);
	const rows = Number(
		(await pool.query(`SELECT count(*)::int AS n FROM offline_notify_channels`)).rows[0].n
	);
	check(
		'start over: every address and the key file are gone',
		reset.ok === true && rows === 0 && !existsSync(keyPath),
		`${JSON.stringify(reset)} rows=${rows} key file ${existsSync(keyPath) ? 'still there' : 'gone'}`
	);
	const fresh = await openSealedStore(db as never, dataDir);
	check('…and the next start makes a new key', fresh.created === true);
} catch (err) {
	check('ran to the end', false, String((err as Error)?.stack ?? err));
} finally {
	await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
	await admin.end();
	await pool.end();
	rmSync(work, { recursive: true, force: true });
}
console.log(
	failures === 0
		? `\n✓ all ${n} offline-notify admin checks passed`
		: `\n✗ ${failures} of ${n} offline-notify admin checks failed`
);
process.exit(failures === 0 ? 0 : 1);
