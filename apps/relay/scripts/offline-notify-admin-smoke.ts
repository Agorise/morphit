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
 *   - `purge-channel matrix` says how many rooms the bot could not leave yet;
 *   - `send matrix` (the operator's test note) comes in the bot's ONE direct
 *     room with that address, which the bot keeps (a second note comes there
 *     too) and keeps that address as the test address; `purge-channel
 *     matrix` with Matrix set up leaves every room (the test note's too) and
 *     leaves nothing in its mapping or its queue;
 *   - `register xmpp` makes the site's XMPP account: a picture check is asked on
 *     stdout and answered on stdin, in the same stream; `archive-off xmpp`
 *     turns the account's message archive off.
 *
 * Needs TEST_DATABASE_URL (skips without it); the "cannot read" case needs
 * root and setpriv (skipped otherwise).
 */
import { spawn, spawnSync } from 'node:child_process';
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
import { sendMatrix } from '../src/notify/channels/matrix.ts';
import { TEST_CERT, fakeHomeserver, fakeXmpp } from '../test/notifyFakes.ts';
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
/** `run`, without blocking this process (a stand-in server here must answer).
 *  `answer`: the tool asked a question ({"ask":…}); its reply goes on stdin. */
const runAsync = (
	args: string[],
	stdin: Record<string, string>,
	opts: {
		answer?: (q: Record<string, unknown>) => Record<string, string>;
		extraEnv?: NodeJS.ProcessEnv;
	} = {}
): Promise<Record<string, unknown>> =>
	new Promise((resolve) => {
		const child = spawn(TSX, [join(RELAY, 'src/notify/adminCli.ts'), ...args], {
			env: { ...env(), ...opts.extraEnv }
		});
		let stdout = '';
		let scanned = 0;
		child.stdout.on('data', (d: Buffer) => {
			stdout += d.toString('utf8');
			for (let nl = stdout.indexOf('\n', scanned); nl >= 0; nl = stdout.indexOf('\n', scanned)) {
				const line = stdout.slice(scanned, nl);
				scanned = nl + 1;
				try {
					const q = JSON.parse(line) as Record<string, unknown>;
					if ('ask' in q && opts.answer) child.stdin.write(`${JSON.stringify(opts.answer(q))}\n`);
				} catch {
					/* not JSON */
				}
			}
		});
		const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
		child.on('close', () => {
			clearTimeout(timer);
			try {
				resolve(JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>);
			} catch {
				resolve({ unparsed: stdout });
			}
		});
		if (opts.answer) child.stdin.write(`${JSON.stringify(stdin)}\n`);
		else child.stdin.end(JSON.stringify(stdin));
	});
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
	// The row as v1.21.18 left it (its room on the row): moved into the
	// address's room mapping when the tool opens the store, then let go.
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

	// The operator's Matrix test note: it comes in the bot's one room with
	// that address (kept in the relay's database), and the bot stays in it —
	// a second test note comes in the same room; the address is kept as the
	// test address (so nothing users do takes that room). Turning Matrix off
	// leaves every room, users' and the test note's.
	const hs = await fakeHomeserver({ bot: '@notices:hs', autoJoin: ['@operator:hs.org'] });
	const mx = {
		MORPHIT_NOTIFY_MATRIX_HOMESERVER: hs.url,
		MORPHIT_NOTIFY_MATRIX_TOKEN: hs.token,
		MORPHIT_NOTIFY_MATRIX_USER_ID: hs.bot
	};
	const sent = await runAsync(['send', 'matrix'], { ...mx, to: '@operator:hs.org' });
	const again = await runAsync(['send', 'matrix'], { ...mx, to: '@operator:hs.org' });
	const testRoom = [...hs.rooms.keys()][0] ?? '';
	check(
		'Matrix test notes: one room, the bot stays in it, kept for that address',
		sent.ok === true &&
			again.ok === true &&
			hs.made() === 1 &&
			hs.rooms.get(testRoom)?.messages.length === 2 &&
			hs.leavesAndForgets().length === 0 &&
			(await store.matrixRoomBook().get('@operator:hs.org'))?.room === testRoom,
		`${JSON.stringify(sent)} ${JSON.stringify(again)} rooms ${hs.made()} ${hs
			.leavesAndForgets()
			.map((h) => h.path)
			.join(' ')}`
	);
	const cfgMx = { homeserver: hs.url, accessToken: hs.token, userId: hs.bot };
	const b = await store.beginAddress(
		'grandma',
		'matrix',
		'@grandma:hs.org',
		'en',
		'123456',
		'clearnet',
		new Date()
	);
	if (!b.ok) throw new Error('begin');
	await store.verifyCode('grandma', 'matrix', '123456', new Date());
	const herRoom = await sendMatrix(
		cfgMx,
		{ torSocks: '', hiddenOnly: false },
		'@grandma:hs.org',
		'code 123456',
		store.matrixRoomBook()
	);
	const testRows = Number(
		(
			await pool.query(
				`SELECT count(*)::int AS n FROM offline_notify_channels WHERE account = '~operator-test'`
			)
		).rows[0].n
	);
	const off = await runAsync(['purge-channel', 'matrix'], mx);
	check(
		'turning Matrix off (set up): the bot leaves and forgets her room and the test note’s; only users’ addresses are counted',
		testRows === 1 &&
			off.ok === true &&
			off.removed === 1 &&
			off.waiting === 0 &&
			[herRoom, testRoom].every(
				(r) =>
					hs.rooms.get(r)?.members.get(hs.bot) === 'leave' &&
					hs.rooms.get(r)?.forgotten.has(hs.bot) === true
			) &&
			(await store.matrixRoomCount()).rooms === 0,
		`test rows ${testRows} ${JSON.stringify(off)} ${JSON.stringify(await store.matrixRoomCount())}`
	);
	await hs.close();

	// The site's XMPP account, made from morphit-ops: a server that wants a
	// picture check (its form as ejabberd 23.10 sends it).
	const caFile = join(work, 'ca.pem');
	writeFileSync(caFile, TEST_CERT);
	const submitted: string[] = [];
	const xmppServer = await fakeXmpp({
		password: 'Tr4in-Lamp-Stone',
		iq: (iq, authed) => {
			if (/jabber:iq:register/.test(iq) && /type='get'/.test(iq))
				return "<iq type='result' id='reg1'><query xmlns='jabber:iq:register'><x type='form' xmlns='jabber:x:data'><field var='FORM_TYPE' type='hidden'><value>jabber:iq:register</value></field><field var='username' type='text-single'><required/></field><field var='password' type='text-private'><required/></field><field var='captcha-fallback-url' type='text-single'><value>https://xmpp.example/captcha/7/image</value></field><field var='challenge' type='hidden'><value>7</value></field><field var='ocr' type='text-single'><required/></field></x></query></iq>";
			if (/jabber:iq:register/.test(iq)) {
				submitted.push(iq);
				return "<iq type='result' id='reg2'/>";
			}
			if (authed && /<prefs xmlns='urn:xmpp:mam:2' default='never'\/>/.test(iq))
				return "<iq type='result' id='mam1'/>";
			// Reading the setting back, as Prosody and ejabberd answer it.
			if (authed && /type='get' id='mam2'><prefs xmlns='urn:xmpp:mam:2'\/>/.test(iq))
				return "<iq type='result' id='mam2'><prefs default='never' xmlns='urn:xmpp:mam:2'><always/><never/></prefs></iq>";
			return null;
		}
	});
	const xmppSettings = {
		MORPHIT_NOTIFY_XMPP_JID: 'morphitio@localhost',
		MORPHIT_NOTIFY_XMPP_PASSWORD: 'Tr4in-Lamp-Stone',
		MORPHIT_NOTIFY_XMPP_HOST: '127.0.0.1',
		MORPHIT_NOTIFY_XMPP_PORT: String(xmppServer.port),
		MORPHIT_NOTIFY_XMPP_SECURITY: 'starttls'
	};
	const trust = { NODE_EXTRA_CA_CERTS: caFile };
	const form = await runAsync(['register-form', 'xmpp'], xmppSettings, { extraEnv: trust });
	const asked: Array<Record<string, unknown>> = [];
	const made = await runAsync(['register', 'xmpp'], xmppSettings, {
		extraEnv: trust,
		answer: (q) => {
			asked.push(q);
			return { answer: 'K7Q2X' };
		}
	});
	const archived = await runAsync(['archive-off', 'xmpp'], xmppSettings, { extraEnv: trust });
	await xmppServer.close();
	check(
		'XMPP account: the picture check is asked and answered on the same stream; the archive is turned off',
		form.ok === true &&
			form.status === 'captcha' &&
			form.url === 'https://xmpp.example/captcha/7/image' &&
			made.ok === true &&
			JSON.stringify(asked) ===
				JSON.stringify([{ ask: 'captcha', url: 'https://xmpp.example/captcha/7/image' }]) &&
			submitted.length === 1 &&
			submitted[0]!.includes("<field var='ocr'><value>K7Q2X</value></field>") &&
			submitted[0]!.includes("<field var='username'><value>morphitio</value></field>") &&
			archived.ok === true &&
			archived.archive === 'off',
		`${JSON.stringify({ form, made, asked, archived })} ${submitted.join(' ')}`
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
