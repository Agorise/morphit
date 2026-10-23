#!/usr/bin/env tsx
/**
 * offline-notify-flow-smoke — Settings → Offline Notifications end to end, on
 * a real Postgres (TEST_DATABASE_URL; skipped when unset) with the tables from
 * the indexer's schema.sql (the v69 section), the real relay endpoints, store,
 * vault and worker, and stand-in mail, Matrix and Telegram servers.
 *
 *   1. An address is confirmed by a code sent to it; a wrong code is refused,
 *      five wrong codes end it. Every request is signed with her key, for THIS
 *      site, and each signature works once.
 *   2. Nothing the relay answers, and nothing in its tables, contains an
 *      address — and nothing in the tables can tell two accounts gave the
 *      same one. Sealed values all have one size.
 *   3. Codes: the limits hold when requests arrive all at once, and one
 *      mailbox written several ways counts once.
 *   4. A message she has not seen gets ONE notice per thread on every
 *      confirmed channel: the site's name, never the sender, a link that opens
 *      that conversation — for her account only — and no second notice for
 *      the thread until she has read it. A Tor user's link is the .onion.
 *   5. No notice when she has the site open, has replied, or has read it; a
 *      stranger earns one a day (a retry is not a second one); a daily cap.
 *   6. Telegram linking: a guess sent before the code existed never counts; a
 *      chat that sent five wrong codes is not listened to; only a match is
 *      answered.
 *   7. Removing a Matrix address makes the bot leave and forget its room;
 *      "Delete all" leaves nothing of hers but today's code count; the
 *      operator turning a channel off deletes every address for it.
 *   8. A key file that is missing, or another one, is refused — the rows are
 *      kept, nothing is sent, no new key is made.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Hono } from 'hono';
import { PrivateKey } from '@beblurt/dblurt';
import type { Database } from '../src/db/pool.ts';
import { Limiter } from '../src/middleware/ratelimit.ts';
import { VAULT_KEY_FILE, VaultUnavailableError } from '../src/notify/vault.ts';
import { openSealedStore } from '../src/notify/store.ts';
import {
	NotifySigVerifier,
	notifyCanonical,
	notifyPayload,
	type NotifyAction
} from '../src/notify/sig.ts';
import { OfflineNotifyEndpoints } from '../src/notify/api.ts';
import { OfflineNotifyWorker, Presence } from '../src/notify/worker.ts';
import { notifyConfigFromEnv, type NotifyConfig } from '../src/notify/config.ts';
import { fakeHttp, fakeSmtp, TEST_CERT } from '../test/notifyFakes.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
	console.log('offline-notify-flow-smoke: skipped — TEST_DATABASE_URL is not set');
	process.exit(0);
}

let failures = 0;
let n = 0;
function check(name: string, cond: boolean, detail = ''): void {
	n++;
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

// ── Database: the production tables (schema.sql, v69) in a private schema ──
const schemaSql = readFileSync(
	join(import.meta.dirname, '../../indexer/src/db/schema.sql'),
	'utf8'
);
const v69 = schemaSql.slice(schemaSql.indexOf('-- ─── v69:'));
if (!v69.startsWith('-- ─── v69:')) throw new Error('schema.sql has no v69 section');
const SCHEMA = `offline_notify_smoke_${process.pid}`;
const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(
	`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path = ${SCHEMA}`
);
await admin.query(v69);
// The two chain-derived tables the worker reads (columns it uses).
await admin.query(
	`CREATE TABLE chat_messages (sender TEXT NOT NULL, recipient TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
		order_permlink TEXT)`
);
await admin.query(`CREATE TABLE chat_read_state (reader_account TEXT NOT NULL, peer_account TEXT NOT NULL,
	order_permlink TEXT NOT NULL DEFAULT '', last_read_at TIMESTAMPTZ NOT NULL)`);
await admin.query(
	`CREATE TABLE blocks (blocker TEXT NOT NULL, blocked TEXT NOT NULL, state TEXT NOT NULL)`
);
const pool = new pg.Pool({ connectionString: url, max: 8, options: `-c search_path=${SCHEMA}` });
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

// ── Accounts: a posting key per user, served by a stand-in chain ──
const keys = new Map<string, PrivateKey>();
for (const a of [
	'grandma',
	'mallory',
	'trader-joe',
	'stranger-x',
	'casey',
	'tilly',
	'race1',
	'race2',
	'race3',
	'race4',
	'race5',
	'race6',
	'chloe',
	'max',
	'spammer',
	'rory'
])
	keys.set(a, PrivateKey.fromSeed(`${a}-${process.pid}`));
const chain = {
	async postingKeyAgreed(name: string) {
		const k = keys.get(name);
		return { key: k ? k.createPublic('BLT').toString() : null };
	}
};

// ── Channels: mail, Matrix and Telegram stand-ins that record what arrives ──
// An address at refused.example does not exist: the mail server says 550,
// and a homeserver refuses to invite @unreachable (a failed address change).
let refuseAll = false;
const smtp = await fakeSmtp({ rejectRcpt: (a) => refuseAll || a.endsWith('@refused.example') });
let room = 0;
// @nosend gets a room whose first message fails (the room is left open).
const hs = await fakeHttp((h) =>
	h.path.endsWith('/createRoom')
		? h.body.includes('@unreachable:')
			? { status: 403, body: { errcode: 'M_FORBIDDEN' } }
			: {
					status: 200,
					body: { room_id: h.body.includes('@nosend:') ? '!nosend:hs' : `!room${++room}:hs` }
				}
		: h.path.includes('/send/') && h.path.includes(encodeURIComponent('!nosend:hs'))
			? { status: 500, body: { errcode: 'M_UNKNOWN' } }
			: { status: 200, body: h.path.includes('/send/') ? { event_id: '$e' } : {} }
);
interface TgUpdate {
	update_id: number;
	message: { chat: { id: number; type: string }; text: string; date: number };
}
const tgQueue: TgUpdate[] = [];
const tg = await fakeHttp((h) => {
	if (h.path.endsWith('/getUpdates')) {
		const offset = Number((JSON.parse(h.body) as { offset?: number }).offset ?? 0);
		return {
			status: 200,
			body: { ok: true, result: tgQueue.filter((u) => u.update_id >= offset) }
		};
	}
	return { status: 200, body: { ok: true, result: {} } };
});
const ONION = `${'v'.repeat(56)}.onion`;
const env = {
	MORPHIT_RELAY_ACCOUNT: 'vigilante-relay',
	MORPHIT_INSTANCE_ORIGIN: 'https://vigilante.trading',
	MORPHIT_INSTANCE_TOR_ADDRESS: ONION,
	MORPHIT_INSTANCE_BRAND_NAME: 'Vigilante Trading',
	MORPHIT_NOTIFY_EMAIL_HOST: 'localhost',
	MORPHIT_NOTIFY_EMAIL_PORT: String(smtp.port),
	MORPHIT_NOTIFY_EMAIL_USER: 'ops@example.org',
	MORPHIT_NOTIFY_EMAIL_PASSWORD: 'mailpass',
	MORPHIT_NOTIFY_EMAIL_FROM: 'ops@example.org',
	MORPHIT_NOTIFY_MATRIX_HOMESERVER: `http://127.0.0.1:${hs.port}`,
	MORPHIT_NOTIFY_MATRIX_TOKEN: 'tok',
	MORPHIT_NOTIFY_MATRIX_USER_ID: '@bot:hs.example',
	MORPHIT_NOTIFY_TELEGRAM_TOKEN: '123:' + 'A'.repeat(30),
	MORPHIT_NOTIFY_TELEGRAM_USERNAME: 'VigilanteBot'
};
const base = await notifyConfigFromEnv(env, { torSocks: '', hiddenOnly: false });
const cfg: NotifyConfig = {
	...base,
	email: base.email && { ...base.email, ca: TEST_CERT },
	telegram: base.telegram && { ...base.telegram, apiBase: `http://127.0.0.1:${tg.port}` }
};

const keyDir = mkdtempSync(join(tmpdir(), 'notify-flow-'));
const { store } = await openSealedStore(db, keyDir);
let clock = new Date('2026-10-15T12:00:00Z');
const now = (): Date => clock;
const presence = new Presence(() => clock.getTime());
const worker = new OfflineNotifyWorker(cfg, store, presence, now);
const app = new Hono();
new OfflineNotifyEndpoints(
	cfg,
	store,
	new NotifySigVerifier(chain, cfg.audience, () => clock.getTime()),
	presence,
	{
		ip: new Limiter(10_000, 60_000),
		spent: new Limiter(10_000, 1_000),
		here: new Limiter(10_000, 60_000),
		takeBack: new Limiter(10_000, 60_000),
		account: new Limiter(10_000, 60_000)
	},
	// Answered once the send is done (a smoke has no one to hide timing from).
	{ now, codeAnswerMs: 60_000, waitUntil: async () => undefined }
).register(app);

/** A request as the browser builds it: signed for this site, a fresh nonce. */
function signedBody(
	action: NotifyAction,
	account: string,
	fields: Record<string, string>,
	opts: { signer?: string; audience?: string } = {}
): string {
	const timestamp = Math.floor(clock.getTime() / 1000);
	const nonce = randomBytes(16).toString('hex');
	const digest = createHash('sha256')
		.update(
			notifyCanonical(
				action,
				opts.audience ?? cfg.audience,
				account,
				nonce,
				notifyPayload(action, fields),
				timestamp
			),
			'utf8'
		)
		.digest();
	const signature = keys
		.get(opts.signer ?? account)!
		.sign(digest)
		.toString();
	return JSON.stringify({ ...fields, account, nonce, timestamp, signature });
}
async function post(
	action: NotifyAction,
	body: string
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
	const res = await app.request(`/v1/notify/${action}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body
	});
	const raw = await res.text();
	return { status: res.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
}
const call = (
	action: NotifyAction,
	account: string,
	fields: Record<string, string>,
	opts: { signer?: string; audience?: string } = {}
) => post(action, signedBody(action, account, fields, opts));

const decode = (data: string): string =>
	Buffer.from(
		data
			.replace(/=\r\n/g, '')
			.replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
		'latin1'
	).toString('utf8');
const codeIn = (s: string): string => /\b(\d{6})\b/.exec(s)?.[1] ?? '';
const TABLES = [
	'offline_notify_channels',
	'offline_notify_code_log',
	'offline_notify_address_log',
	'offline_notify_pending',
	'offline_notify_links',
	'offline_notify_key'
];
const allRows = async (): Promise<string> => {
	const parts: string[] = [];
	for (const t of TABLES) {
		const r = await pool.query(`SELECT * FROM ${t}`);
		parts.push(
			JSON.stringify(r.rows, (_k, v) =>
				v && v.type === 'Buffer' ? Buffer.from(v.data).toString('latin1') : v
			)
		);
	}
	return parts.join('\n');
};
const count = async (sql: string, params: unknown[] = []): Promise<number> =>
	Number((await pool.query(sql, params)).rows[0].n);
const ADDRESS = 'grandma.private@example.net';
const MXID = '@grandma:matrix.example';
/** Let background work (the bot leaving a room) finish. */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
	// Then until the homeserver and the leave queue have been quiet for a
	// moment (a loaded machine can take longer than a fixed pause).
	const deadline = Date.now() + 10_000;
	let last = -1;
	for (;;) {
		const now = hs.hits.length + (await count(`SELECT count(*) AS n FROM offline_notify_leave`));
		if (now === last || Date.now() > deadline) break;
		last = now;
		await new Promise((r) => setTimeout(r, 150));
	}
};

try {
	console.log('\n── offline-notify-flow-smoke ──');
	// ── 1. Codes, signatures ────────────────────────────────────────────
	{
		const forged = await call(
			'set',
			'grandma',
			{ channel: 'email', address: ADDRESS, locale: 'es' },
			{ signer: 'mallory' }
		);
		check(
			"a request signed with another account's key is refused",
			forged.status === 401 && smtp.mails.length === 0,
			forged.raw
		);
		const elsewhere = await call(
			'set',
			'grandma',
			{ channel: 'email', address: ADDRESS, locale: 'es' },
			{ audience: 'another-instance-relay' }
		);
		check(
			'a request she signed for another site is refused here',
			elsewhere.status === 401 && smtp.mails.length === 0,
			elsewhere.raw
		);
		const body = signedBody('set', 'grandma', { channel: 'email', address: ADDRESS, locale: 'es' });
		const r = await post('set', body);
		check(
			'saving an address sends a code there',
			r.status === 200 && r.body.status === 'code_sent' && smtp.mails.length === 1,
			r.raw
		);
		const again = await post('set', body);
		check(
			'the same signed request a second time is refused (each signature works once)',
			again.status === 401 && again.body.reason === 'replayed' && smtp.mails.length === 1,
			again.raw
		);
		// The same signature written another way (upper-case hex, another
		// recovery byte, trailing junk, the high-S twin) still verifies — it
		// must not count as a new request.
		const so = JSON.parse(body) as { signature: string };
		const hex = so.signature;
		const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
		const sHigh = (N - BigInt(`0x${hex.slice(66, 130)}`)).toString(16).padStart(64, '0');
		const variants = [
			hex.toUpperCase(),
			`ff${hex.slice(2)}`,
			`${hex}zz`,
			`${hex.slice(0, 66)}${sHigh}`
		];
		const twins: string[] = [];
		for (const v of variants) {
			const t = await post('set', JSON.stringify({ ...JSON.parse(body), signature: v }));
			twins.push(`${t.status}/${String(t.body.reason ?? t.body.status)}`);
		}
		check(
			'the same signature written another way is the same request (refused again)',
			twins.every((t) => t.startsWith('401/replayed') || t.startsWith('401/malformed')) &&
				smtp.mails.length === 1,
			`${twins.join(' ')} mails ${smtp.mails.length}`
		);
		const mail = smtp.mails[0]!;
		check(
			'…in her language, from the site, to her address only',
			mail.to.join() === ADDRESS &&
				/Subject: Tu c=C3=B3digo|Subject: =\?UTF-8\?B\?/.test(mail.data) &&
				mail.data.includes('Vigilante Trading')
		);
		const code = codeIn(decode(mail.data));
		const st = await call('status', 'grandma', {});
		check(
			'before the code, the channel is waiting, not on',
			JSON.stringify(st.body.channels) === JSON.stringify([{ channel: 'email', state: 'pending' }]),
			st.raw
		);
		const wrong = await call('verify', 'grandma', {
			channel: 'email',
			code: code === '000000' ? '111111' : '000000'
		});
		check(
			'a wrong code is refused',
			wrong.status === 400 && wrong.body.status === 'wrong',
			wrong.raw
		);
		const ok = await call('verify', 'grandma', { channel: 'email', code });
		check('the right code turns it on', ok.status === 200 && ok.body.status === 'verified', ok.raw);
		const m = await call('set', 'grandma', { channel: 'matrix', address: MXID, locale: 'es' });
		const mcode = codeIn(JSON.parse(hs.hits.at(-1)!.body).body as string);
		const mok = await call('verify', 'grandma', { channel: 'matrix', code: mcode });
		check(
			'Matrix: the code arrives in a room that invites her; confirmed',
			m.body.status === 'code_sent' &&
				mok.body.status === 'verified' &&
				JSON.parse(hs.hits[0]!.body).invite[0] === MXID
		);
		// She tries a new address that cannot be reached: the one she had keeps
		// working (a failed change must not leave her with no notes at all), and
		// the bot stays in her Matrix room.
		const leavesBefore = hs.hits.filter((h) => /\/(leave|forget)$/.test(h.path)).length;
		const badMail = await call('set', 'grandma', {
			channel: 'email',
			address: 'typo@refused.example',
			locale: 'es'
		});
		const badMx = await call('set', 'grandma', {
			channel: 'matrix',
			address: '@unreachable:matrix.example',
			locale: 'es'
		});
		await settle();
		const kept = await call('status', 'grandma', {});
		check(
			'a change to an address that cannot be reached keeps the one she had, and her Matrix room',
			badMail.body.status === 'send_failed' &&
				badMx.body.status === 'send_failed' &&
				JSON.stringify(kept.body.channels) ===
					JSON.stringify([
						{ channel: 'email', state: 'on' },
						{ channel: 'matrix', state: 'on' }
					]) &&
				hs.hits.filter((h) => /\/(leave|forget)$/.test(h.path)).length === leavesBefore,
			`${badMail.raw} ${badMx.raw} ${kept.raw}`
		);
		await call('set', 'mallory', { channel: 'email', address: 'm@example.org', locale: 'en' });
		let last = '';
		for (let i = 0; i < 5; i++)
			last = String(
				(await call('verify', 'mallory', { channel: 'email', code: '999999' })).body.status
			);
		const after = await call('status', 'mallory', {});
		check(
			'five wrong codes end it',
			last === 'expired' && JSON.stringify(after.body.channels) === '[]',
			`${last} ${after.raw}`
		);
	}
	// ── 1b. Changing an address never leaves her with none ───────────────
	{
		const st = async (a: string): Promise<string> =>
			JSON.stringify((await call('status', a, {})).body.channels);
		const lastCode = (): string => codeIn(decode(smtp.mails.at(-1)!.data));
		// chloe has email on.
		await call('set', 'chloe', { channel: 'email', address: 'chloe@example.net', locale: 'en' });
		await call('verify', 'chloe', { channel: 'email', code: lastCode() });
		const on = JSON.stringify([{ channel: 'email', state: 'on' }]);
		// A change she cancels.
		await call('set', 'chloe', { channel: 'email', address: 'chloe2@example.net', locale: 'en' });
		const during = await st('chloe');
		const cancelled = await call('cancel', 'chloe', { channel: 'email' });
		const afterCancel = await st('chloe');
		// A change whose code she gets wrong five times.
		await call('set', 'chloe', { channel: 'email', address: 'chloe3@example.net', locale: 'en' });
		for (let i = 0; i < 5; i++) await call('verify', 'chloe', { channel: 'email', code: '000001' });
		const afterWrong = await st('chloe');
		// A change whose code she never types.
		await call('set', 'chloe', { channel: 'email', address: 'chloe4@example.net', locale: 'en' });
		await store.purge(new Date(clock.getTime() + 16 * 60_000));
		const afterExpiry = await st('chloe');
		// A change whose code she types too late (before the purge ran).
		await call('set', 'chloe', { channel: 'email', address: 'chloe5@example.net', locale: 'en' });
		const lateCode = lastCode();
		const saved = clock;
		clock = new Date(clock.getTime() + 16 * 60_000);
		const late = await call('verify', 'chloe', { channel: 'email', code: lateCode });
		clock = saved;
		const afterLate = await st('chloe');
		check(
			'a change cancelled, guessed wrong five times, never confirmed or confirmed too late gives back the address she had',
			during.includes('pending') &&
				cancelled.body.status === 'cancelled' &&
				afterCancel === on &&
				afterWrong === on &&
				afterExpiry === on &&
				late.body.status === 'expired' &&
				afterLate === on,
			`${during} ${cancelled.raw} ${afterCancel} ${afterWrong} ${afterExpiry} ${late.raw} ${afterLate}`
		);
		// Matrix: max confirms one address, starts a change and cancels it (the
		// room opened for the change goes, his room stays), then changes again
		// and confirms (now the old room goes, the new one stays).
		const lastMx = (): { room: string; code: string } => {
			const hit = hs.hits.filter((h) => h.path.includes('/send/')).at(-1)!;
			return {
				room: decodeURIComponent(hit.path.split('/rooms/')[1]!.split('/')[0]!),
				code: codeIn(JSON.parse(hit.body).body as string)
			};
		};
		const forgotten = (): string[] =>
			hs.hits
				.filter((h) => h.path.endsWith('/forget'))
				.map((h) => decodeURIComponent(h.path.split('/rooms/')[1]!.split('/')[0]!));
		await call('set', 'max', { channel: 'matrix', address: '@max:matrix.example', locale: 'en' });
		const first = lastMx();
		await call('verify', 'max', { channel: 'matrix', code: first.code });
		await call('set', 'max', { channel: 'matrix', address: '@max2:matrix.example', locale: 'en' });
		const second = lastMx();
		await call('cancel', 'max', { channel: 'matrix' });
		await settle();
		const afterMxCancel = await st('max');
		const goneAfterCancel = forgotten();
		await call('set', 'max', { channel: 'matrix', address: '@max3:matrix.example', locale: 'en' });
		const third = lastMx();
		await call('verify', 'max', { channel: 'matrix', code: third.code });
		await settle();
		const goneAfterConfirm = forgotten();
		check(
			'Matrix: a cancelled change keeps his room and leaves the new one; a confirmed change leaves the old',
			afterMxCancel === JSON.stringify([{ channel: 'matrix', state: 'on' }]) &&
				goneAfterCancel.includes(second.room) &&
				!goneAfterCancel.includes(first.room) &&
				goneAfterConfirm.includes(first.room) &&
				!goneAfterConfirm.includes(third.room),
			`rooms ${first.room} ${second.room} ${third.room}; after cancel ${goneAfterCancel.join(',')}; after confirm ${goneAfterConfirm.join(',')}`
		);
	}
	// ── 2. Nothing back out; nothing readable or linkable in the tables ──
	{
		const st = await call('status', 'grandma', {});
		check(
			'status never contains an address',
			!st.raw.includes('grandma.private') && !st.raw.includes('@grandma:'),
			st.raw
		);
		// Two accounts give the same address.
		for (const a of ['casey', 'tilly'])
			await call('set', a, { channel: 'email', address: 'shared@example.net', locale: 'en' });
		const rows = await allRows();
		check(
			'the tables hold no address in readable form',
			!rows.includes('grandma.private') &&
				!rows.includes('shared@example') &&
				!rows.includes('grandma:matrix'),
			rows.slice(0, 300)
		);
		const shared = await pool.query(
			`SELECT * FROM offline_notify_channels WHERE account IN ('casey', 'tilly') ORDER BY account`
		);
		const [c1, c2] = shared.rows as Array<Record<string, unknown>>;
		const same = Object.keys(c1!).filter(
			(k) =>
				![
					'channel',
					'locale',
					'link_net',
					'code_attempts',
					'sent_count',
					'sent_day',
					'verified_at',
					'route_sealed',
					'created_at',
					'code_expires_at'
				].includes(k) &&
				// Nothing there on either side says nothing.
				!(c1![k] === null && c2![k] === null) &&
				JSON.stringify(c1![k]) === JSON.stringify(c2![k])
		);
		check(
			'two accounts that gave the same address share no value that says so',
			same.length === 0,
			same.join(', ')
		);
		const cols = (
			await pool.query(
				`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'offline_notify_address_log'`,
				[SCHEMA]
			)
		).rows.map((r) => r.column_name as string);
		check(
			'the per-address code count does not say which account asked, nor when beyond the day',
			!cols.includes('account') && !cols.some((c) => c.endsWith('_at')),
			cols.join(',')
		);
		const sizes = await pool.query(
			`SELECT DISTINCT length(address_sealed) AS n FROM offline_notify_channels WHERE address_sealed IS NOT NULL`
		);
		check(
			'every sealed address has the same size (a short one and a long one look alike)',
			sizes.rowCount === 1,
			JSON.stringify(sizes.rows)
		);
	}
	// ── 3. Code limits under fire ─────────────────────────────────────────
	{
		// Six accounts, two requests each, all at once, one victim address:
		// only the per-address lock can hold them to five mails — and every
		// answer is the same, so nobody learns that others used the address.
		let before = smtp.mails.length;
		let answers = await Promise.all(
			[
				'race1',
				'race2',
				'race3',
				'race4',
				'race5',
				'race6',
				'race1',
				'race2',
				'race3',
				'race4',
				'race5',
				'race6'
			].map((a) =>
				call('set', a, { channel: 'email', address: 'victim@example.net', locale: 'en' })
			)
		);
		let sent = answers.filter((a) => a.body.status === 'code_sent').length;
		check(
			'twelve requests at once from six accounts send at most five codes to one address, and all are answered alike',
			sent === 12 && smtp.mails.length - before === 5,
			`${sent} code_sent, ${smtp.mails.length - before} mails`
		);
		// Someone else probes that address now: the answer, and what her card
		// shows, are the same as for an address nobody used — no mail goes.
		before = smtp.mails.length;
		const probe = await call('set', 'trader-joe', {
			channel: 'email',
			address: 'victim@example.net',
			locale: 'en'
		});
		const probeStatus = await call('status', 'trader-joe', {});
		check(
			'an address that had its codes today: the answer says nothing about it (and nothing is sent)',
			probe.status === 200 &&
				probe.body.status === 'code_sent' &&
				JSON.stringify(probeStatus.body.channels) ===
					JSON.stringify([{ channel: 'email', state: 'pending' }]) &&
				smtp.mails.length === before,
			`${probe.status} ${JSON.stringify(probe.body)} ${JSON.stringify(probeStatus.body)} mails +${smtp.mails.length - before}`
		);
		await call('remove', 'trader-joe', { channel: 'all' });
		// One account, twelve addresses, all at once: only the per-account lock
		// can hold it to six.
		before = smtp.mails.length;
		answers = await Promise.all(
			Array.from({ length: 12 }, (_v, i) =>
				call('set', 'stranger-x', {
					channel: 'email',
					address: `target${i}@example.net`,
					locale: 'en'
				})
			)
		);
		sent = answers.filter((a) => a.body.status === 'code_sent').length;
		check(
			'twelve requests at once from one account send at most six codes',
			sent === 6 && smtp.mails.length - before === 6,
			`${sent} code_sent, ${smtp.mails.length - before} mails`
		);
		const variants = [
			'Victim.X@gmail.com',
			'victimx+a@gmail.com',
			'VICTIMX@googlemail.com',
			'v.i.c.t.i.m.x@gmail.com'
		];
		const res: string[] = [];
		for (const address of variants)
			res.push(
				String(
					(await call('set', 'mallory', { channel: 'email', address, locale: 'en' })).body.status
				)
			);
		check(
			'one mailbox written four ways counts as one address',
			JSON.stringify(res) ===
				JSON.stringify(['code_sent', 'code_sent', 'code_sent', 'too_many_codes']),
			res.join(',')
		);
	}
	// ── 4. A notice ───────────────────────────────────────────────────────
	const pend = async (
		sender: string,
		order = '',
		at = clock,
		account = 'grandma'
	): Promise<void> => {
		await pool.query(
			`INSERT INTO offline_notify_pending (account, sender, order_permlink, event_at, due_at) VALUES ($4, $1, $2, $3, $3::timestamptz + interval '10 minutes') ON CONFLICT DO NOTHING`,
			[sender, order, at, account]
		);
		// The message itself, as the chain stores it: a notice is only ever sent
		// for a stored message she has not read or answered (S-L8).
		await pool.query(`INSERT INTO chat_messages VALUES ($1, $2, $3, $4)`, [
			sender,
			account,
			at,
			order === '' ? null : order
		]);
	};
	await pool.query(`INSERT INTO chat_messages VALUES ('grandma', 'trader-joe', $1)`, [
		new Date(clock.getTime() - 86_400_000)
	]);
	const mailsBefore = smtp.mails.length;
	const roomsBefore = hs.hits.length;
	await pend('trader-joe', 'btc-for-mxn-42');
	await pend('trader-joe', 'btc-for-mxn-42'); // a second message in the thread adds nothing
	clock = new Date(clock.getTime() + 5 * 60_000);
	await worker.tick();
	check('nothing before the delay is over', smtp.mails.length === mailsBefore);
	clock = new Date(clock.getTime() + 6 * 60_000);
	await worker.tick();
	const notice = smtp.mails.slice(mailsBefore).filter((m) => m.to.join() === ADDRESS);
	const decoded = notice.map((m) => decode(m.data));
	check(
		'one notice per thread, on each confirmed channel',
		notice.length === 1 && hs.hits.length === roomsBefore + 1,
		`${notice.length} mails, ${hs.hits.length - roomsBefore} matrix`
	);
	check(
		'it names the site and never the sender',
		decoded[0]!.includes('Alguien acaba de enviarte un mensaje de chat en Vigilante Trading') &&
			!decoded[0]!.includes('trader-joe') &&
			!decoded[0]!.includes('btc-for-mxn')
	);
	const link = /https:\/\/vigilante\.trading\/es\/chat\?n=([A-Za-z0-9_-]+)/.exec(decoded[0]!);
	check('with a link to the site', link !== null);
	const token = link?.[1] ?? '';
	const opened = await call('open', 'grandma', { token });
	check(
		'the link opens that conversation, order included',
		opened.body.peer === 'trader-joe' && opened.body.order === 'btc-for-mxn-42',
		opened.raw
	);
	const stolen = await call('open', 'mallory', { token });
	check('…for her account only', stolen.status === 404, stolen.raw);
	{
		const before = smtp.mails.length;
		await pend('trader-joe', 'btc-for-mxn-42');
		clock = new Date(clock.getTime() + 11 * 60_000);
		await worker.tick();
		check(
			'a later message in the thread she has not read: no second notice',
			smtp.mails.length === before
		);
		await pool.query(
			`INSERT INTO chat_read_state VALUES ('grandma', 'trader-joe', 'btc-for-mxn-42', $1)`,
			[new Date(clock.getTime() + 1000)]
		);
		clock = new Date(clock.getTime() + 60_000);
		await pend('trader-joe', 'btc-for-mxn-42');
		clock = new Date(clock.getTime() + 11 * 60_000);
		await worker.tick();
		check(
			'…once she has read it, a new message gets a notice again',
			smtp.mails.length === before + 1
		);
	}
	// ── 5. Reasons not to send ─────────────────────────────────────────────
	const quiet = async (
		label: string,
		setup: () => Promise<void>,
		atCheck: () => Promise<void> = async () => {}
	): Promise<void> => {
		const before = smtp.mails.length;
		await setup();
		await pend('trader-joe');
		clock = new Date(clock.getTime() + 11 * 60_000);
		await atCheck();
		await worker.tick();
		check(label, smtp.mails.length === before, `${smtp.mails.length - before} sent`);
	};
	// The site sends a heartbeat every minute while it is open.
	await quiet(
		'no notice while she has the site open (signed heartbeat)',
		async () => {},
		async () => {
			const h = await call('here', 'grandma', {});
			if (h.status !== 200) throw new Error(h.raw);
		}
	);
	clock = new Date(clock.getTime() + 10 * 60_000); // presence over
	await quiet('no notice once she replied', async () => {
		await pool.query(`INSERT INTO chat_messages VALUES ('grandma', 'trader-joe', $1)`, [
			new Date(clock.getTime() + 60_000)
		]);
	});
	await quiet('no notice once she read the thread', async () => {
		await pool.query(`INSERT INTO chat_read_state VALUES ('grandma', 'trader-joe', '', $1)`, [
			new Date(clock.getTime() + 9 * 60_000)
		]);
	});
	{
		const before = smtp.mails.length;
		await pend('stranger-x');
		clock = new Date(clock.getTime() + 11 * 60_000);
		await worker.tick();
		await pend('stranger-x', 'another-thread');
		clock = new Date(clock.getTime() + 11 * 60_000);
		await worker.tick();
		check(
			'a stranger she never wrote to earns her one notice a day',
			smtp.mails.length === before + 1,
			`${smtp.mails.length - before}`
		);
		// A first try that failed everywhere left a link behind; its retry is the
		// same notice, not a second one from the stranger.
		await store.createLink('grandma', 'stranger-y', '', clock);
		await pool.query(`INSERT INTO chat_messages VALUES ('stranger-y', 'grandma', $1, NULL)`, [
			clock
		]);
		const v = await worker.handle(
			{ account: 'grandma', sender: 'stranger-y', orderPermlink: '', eventAt: clock, attempts: 1 },
			clock
		);
		check('a retry of a stranger’s notice is not counted as a second one', v === 'sent', v);
	}
	// ── 6. Telegram linking ────────────────────────────────────────────────
	{
		const t = await call('set', 'tilly', { channel: 'telegram', locale: 'en' });
		const tcode = String(t.body.code);
		const issued = Math.floor(clock.getTime() / 1000);
		let id = 1;
		const msg = (chat: number, text: string, date: number): TgUpdate => ({
			update_id: id++,
			message: { chat: { id: chat, type: 'private' }, text, date }
		});
		// An early guess of the right code, sent before it existed.
		tgQueue.push(msg(777, tcode, issued - 60));
		// A chat that guesses: five wrong codes, then the right one — too late.
		for (let i = 0; i < 5; i++) tgQueue.push(msg(666, String(10_000_000 + i), issued + 1));
		tgQueue.push(msg(666, tcode, issued + 2));
		// Her own chat.
		tgQueue.push(msg(888, `/start ${tcode}`, issued + 3));
		const repliesBefore = tg.hits.filter((h) => h.path.endsWith('/sendMessage')).length;
		await worker.tick();
		// The bot links her chat, then answers it: wait for both (the answer is
		// a second request, after the link is saved).
		const answered = (): number =>
			tg.hits.filter((h) => h.path.endsWith('/sendMessage')).length - repliesBefore;
		// Wait on the outcome itself, with a deadline generous enough for a
		// loaded machine (a fixed number of short sleeps was flaky under load).
		const deadline = Date.now() + 30_000;
		while (
			Date.now() < deadline &&
			((await call('status', 'tilly', {})).raw.includes('pending') || answered() < 1)
		)
			await new Promise((r) => setTimeout(r, 50));
		const st = await call('status', 'tilly', {});
		const replies = tg.hits.filter((h) => h.path.endsWith('/sendMessage')).slice(repliesBefore);
		check(
			'her chat is linked; the early guess and the guessing chat are not',
			st.raw.includes('"telegram","state":"on"') &&
				replies.length === 1 &&
				JSON.parse(replies[0]!.body).chat_id === '888',
			`${st.raw} replies to ${replies.map((r) => JSON.parse(r.body).chat_id).join(',')}`
		);
		worker.stop();
	}
	// ── 4b. A Tor user's link ─────────────────────────────────────────────
	{
		const w = new OfflineNotifyWorker(cfg, store, new Presence(() => clock.getTime()), now);
		const r = await call('set', 'casey', {
			channel: 'email',
			address: 'casey@example.net',
			locale: 'en',
			net: 'tor'
		});
		const code = codeIn(decode(smtp.mails.at(-1)!.data));
		await call('verify', 'casey', { channel: 'email', code });
		const before = smtp.mails.length;
		await pend('trader-joe', '', clock, 'casey');
		clock = new Date(clock.getTime() + 11 * 60_000);
		await w.tick();
		const got = smtp.mails
			.slice(before)
			.map((m) => decode(m.data))
			.join('\n');
		check(
			'she set it up over Tor: her notice links to the .onion, never the clearnet site',
			r.body.status === 'code_sent' &&
				got.includes(`http://${ONION}/en/chat?n=`) &&
				!got.includes('https://vigilante.trading'),
			got.slice(0, 300)
		);
	}
	// ── 5b. The daily cap ──────────────────────────────────────────────────
	{
		const w = new OfflineNotifyWorker(cfg, store, new Presence(() => clock.getTime()), now);
		const before = smtp.mails.filter((m) => m.to.join() === ADDRESS).length;
		for (let i = 0; i < 25; i++) {
			await pool.query(`INSERT INTO chat_messages VALUES ('grandma', $1, $2)`, [
				`friend${i}`,
				new Date(0)
			]);
			await pend(`friend${i}`);
		}
		clock = new Date(clock.getTime() + 11 * 60_000);
		await w.tick();
		await w.tick();
		const sentToday = await count(
			`SELECT max(sent_count) AS n FROM offline_notify_channels WHERE account = 'grandma'`
		);
		const sent = smtp.mails.filter((m) => m.to.join() === ADDRESS).length - before;
		check(
			'the daily cap holds',
			sentToday === 20 && sent <= 20,
			`${sent} sent, count ${sentToday}`
		);
	}
	// ── 5c. The cap is not reset by an address she gave up on ──────────────
	{
		// dora has Matrix on and is adding an email address (still waiting for
		// its code). Email sorts before Matrix.
		await pool.query(
			`INSERT INTO offline_notify_channels (account, channel, address_sealed, verified_at, code_expires_at, locale)
			 VALUES ('dora', 'matrix', '\\x00'::bytea, $1, NULL, 'en'),
			        ('dora', 'email', '\\x00'::bytea, NULL, $2, 'en')`,
			[clock, new Date(clock.getTime() + 600_000)]
		);
		let ok = 0;
		for (let i = 0; i < 5; i++) if (await store.takeDailySlot('dora', clock)) ok++;
		const first = ok;
		// She gives up on the email address: the waiting row goes.
		await pool.query(
			`DELETE FROM offline_notify_channels WHERE account = 'dora' AND channel = 'email'`
		);
		for (let i = 0; i < 25; i++) if (await store.takeDailySlot('dora', clock)) ok++;
		check(
			'the daily cap counts on, after an address still waiting for its code goes away',
			ok === 20,
			`${first} then ${ok - first} notices allowed`
		);
	}
	// ── 5d. Blocked after queueing; a notice that reached no app ──────────
	{
		const w = new OfflineNotifyWorker(cfg, store, new Presence(() => clock.getTime()), now);
		// chloe blocks mallory after mallory's message was queued: no notice.
		// oscar she blocked once and unblocked again: his notice goes out.
		await pool.query(
			`INSERT INTO chat_messages VALUES ('chloe', 'mallory', $1), ('chloe', 'oscar', $1)`,
			[new Date(0)]
		);
		await pool.query(
			`INSERT INTO blocks VALUES ('chloe', 'mallory', 'blocked'), ('chloe', 'oscar', 'unblocked')`
		);
		// Their messages, stored (a notice is only for a stored message, S-L8).
		await pool.query(
			`INSERT INTO chat_messages VALUES ('mallory', 'chloe', $1, 'blocked-thread'), ('oscar', 'chloe', $1, 'unblocked-thread'),
			   ('pat', 'chloe', $1, 'change-thread'), ('trader-joe', 'chloe', $1, 'failed-thread')`,
			[clock]
		);
		const mailsBefore = smtp.mails.length;
		const toMallory = await w.handle(
			{
				account: 'chloe',
				sender: 'mallory',
				orderPermlink: 'blocked-thread',
				eventAt: clock,
				attempts: 0
			},
			clock
		);
		const mailsAfterBlock = smtp.mails.length;
		const toOscar = await w.handle(
			{
				account: 'chloe',
				sender: 'oscar',
				orderPermlink: 'unblocked-thread',
				eventAt: clock,
				attempts: 0
			},
			clock
		);
		check(
			'no notice for a sender she blocked after the message was queued (one she unblocked gets his)',
			toMallory === 'blocked' &&
				mailsAfterBlock === mailsBefore &&
				toOscar === 'sent' &&
				smtp.mails.length === mailsBefore + 1,
			`${toMallory} ${toOscar} mails +${smtp.mails.length - mailsBefore}`
		);
		// She starts changing her address (a code waits at the new one): a
		// message meanwhile still gets its note — at the address she has.
		const confirmedTo = smtp.mails.at(-1)!.to.join();
		await call('set', 'chloe', {
			channel: 'email',
			address: 'chloe-next@example.net',
			locale: 'en'
		});
		await pool.query(`INSERT INTO chat_messages VALUES ('chloe', 'pat', $1)`, [new Date(0)]);
		const duringBefore = smtp.mails.length;
		const during = await w.handle(
			{
				account: 'chloe',
				sender: 'pat',
				orderPermlink: 'change-thread',
				eventAt: clock,
				attempts: 0
			},
			clock
		);
		const duringTo = smtp.mails.at(-1)!.to.join();
		await call('cancel', 'chloe', { channel: 'email' });
		check(
			'while she changes her address, notes keep going to the one she has',
			during === 'sent' &&
				smtp.mails.length === duringBefore + 1 &&
				duringTo === confirmedTo &&
				duringTo !== 'chloe-next@example.net',
			`${during} to ${duringTo} (confirmed ${confirmedTo})`
		);
		// A retry put back while a newer message in the same thread was queued:
		// one row, measured from the newer message, due at the earlier time,
		// counting the retry.
		{
			const older = new Date(clock.getTime() - 20 * 60_000);
			const newer = new Date(clock.getTime() - 5 * 60_000);
			const newerDue = new Date(clock.getTime() + 30 * 60_000);
			await pool.query(
				`INSERT INTO offline_notify_pending (account, sender, order_permlink, event_at, due_at) VALUES ('chloe', 'peggy', 'merge-thread', $1, $2)`,
				[newer, newerDue]
			);
			const retryDue = new Date(clock.getTime() + 5 * 60_000);
			await store.requeue(
				{
					account: 'chloe',
					sender: 'peggy',
					orderPermlink: 'merge-thread',
					eventAt: older,
					attempts: 2
				},
				retryDue
			);
			const row = (
				await pool.query(
					`SELECT event_at, due_at, attempts FROM offline_notify_pending WHERE account = 'chloe' AND sender = 'peggy'`
				)
			).rows;
			check(
				'a retry meeting a newer message in its thread: one row, from the newer message, due at the earlier time',
				row.length === 1 &&
					+row[0].event_at === +newer &&
					+row[0].due_at === +retryDue &&
					row[0].attempts === 3,
				JSON.stringify(row)
			);
			await pool.query(
				`DELETE FROM offline_notify_pending WHERE account = 'chloe' AND sender = 'peggy'`
			);
			// The other way round (a row put back by a reindex, say, older than the
			// retry): still measured from the later message.
			await pool.query(
				`INSERT INTO offline_notify_pending (account, sender, order_permlink, event_at, due_at) VALUES ('chloe', 'peggy', 'merge-thread', $1, $2)`,
				[older, newerDue]
			);
			await store.requeue(
				{
					account: 'chloe',
					sender: 'peggy',
					orderPermlink: 'merge-thread',
					eventAt: newer,
					attempts: 0
				},
				retryDue
			);
			const back = (
				await pool.query(
					`SELECT event_at FROM offline_notify_pending WHERE account = 'chloe' AND sender = 'peggy'`
				)
			).rows;
			check(
				'…and when the row already there is the older one, the later message time wins',
				back.length === 1 && +back[0].event_at === +newer,
				JSON.stringify(back)
			);
			await pool.query(
				`DELETE FROM offline_notify_pending WHERE account = 'chloe' AND sender = 'peggy'`
			);
		}
		// chloe's mail server refuses everything for a while: the notice reaches
		// no app, so it does not count — the next message in the thread gets one.
		await pool.query(`INSERT INTO chat_messages VALUES ('chloe', 'trader-joe', $1)`, [new Date(0)]);
		const notice = {
			account: 'chloe',
			sender: 'trader-joe',
			orderPermlink: 'failed-thread',
			eventAt: clock,
			attempts: 0
		};
		refuseAll = true;
		const failed = await w.handle(notice, clock);
		refuseAll = false;
		const links = await count(
			`SELECT count(*) AS n FROM offline_notify_links WHERE account = 'chloe' AND order_permlink = 'failed-thread'`
		);
		const next = await w.handle({ ...notice, eventAt: new Date(clock.getTime() + 60_000) }, clock);
		check(
			'a notice that reached no app does not count: the next message in the thread gets one',
			failed === 'retry' && links === 0 && next === 'sent',
			`${failed} links ${links} next ${next}`
		);
	}
	// ── 7. Removing, deleting, turning off ─────────────────────────────────
	{
		const leavesBefore = hs.hits.filter((h) => /\/(leave|forget)$/.test(h.path)).length;
		await call('remove', 'grandma', { channel: 'matrix' });
		await settle();
		const lf = hs.hits.filter((h) => /\/(leave|forget)$/.test(h.path)).slice(leavesBefore);
		check(
			'removing her Matrix address: the bot leaves and forgets her room',
			lf.length === 2 && lf[0]!.path.endsWith('/leave') && lf[1]!.path.endsWith('/forget'),
			lf.map((h) => h.path).join(' ')
		);
		await pend('trader-joe');
		await call('remove', 'grandma', { channel: 'all' });
		const left = await count(
			`SELECT (SELECT count(*) FROM offline_notify_channels WHERE account = 'grandma')
			      + (SELECT count(*) FROM offline_notify_pending WHERE account = 'grandma')
			      + (SELECT count(*) FROM offline_notify_links WHERE account = 'grandma') AS n`
		);
		check(
			'"delete all" leaves nothing of hers (but today\'s code count)',
			left === 0,
			String(left)
		);
		// Removing everything must not reset the daily code limit: one account
		// setting and removing again cannot send more than six codes a day.
		const sent: string[] = [];
		for (let i = 0; i < 9; i++) {
			const r = await call('set', 'spammer', {
				channel: 'email',
				address: `target${i}@victims.example`,
				locale: 'en'
			});
			sent.push(String(r.body.status));
			await call('remove', 'spammer', { channel: 'all' });
		}
		check(
			'removing everything does not reset the daily code limit',
			sent.filter((x) => x === 'code_sent').length === 6 && sent.at(-1) === 'too_many_codes',
			sent.join(',')
		);
		const purged = await store.purgeChannel('email');
		const emails = await count(
			`SELECT count(*) AS n FROM offline_notify_channels WHERE channel = 'email'`
		);
		check(
			'the operator turning email off deletes every email address',
			purged.removed > 0 && emails === 0,
			`${purged.removed} removed, ${emails} left`
		);
	}
	// ── 7b. Rooms opened for codes nobody confirmed are left too ───────────
	{
		const w = new OfflineNotifyWorker(cfg, store, new Presence(() => clock.getTime()), now);
		const leftRooms = (): string[] =>
			hs.hits
				.filter((h) => h.path.endsWith('/forget'))
				.map((h) => decodeURIComponent(h.path.split('/rooms/')[1]!.split('/')[0]!));
		const roomOf = (mxid: string): string =>
			hs.hits.findLast?.((h) => h.path.endsWith('/createRoom') && h.body.includes(mxid))
				? `!room${room}:hs`
				: '';
		// Someone types a stranger's Matrix ID and never confirms: the code
		// expires; the room the bot opened for it must not stay.
		await call('set', 'race1', { channel: 'matrix', address: '@victim:hs.org', locale: 'en' });
		const victimRoom = roomOf('@victim:hs.org');
		clock = new Date(clock.getTime() + 16 * 60_000);
		await w.tick();
		await settle();
		// The worker's own round left it (nothing else ran in between).
		const byWorker = leftRooms().includes(victimRoom);
		// Five wrong codes end another one at once.
		await call('set', 'race2', { channel: 'matrix', address: '@other:hs.org', locale: 'en' });
		const otherRoom = roomOf('@other:hs.org');
		for (let i = 0; i < 5; i++)
			await call('verify', 'race2', { channel: 'matrix', code: '000000' });
		await settle();
		// The bot opens a room whose first message fails: no row holds it.
		const ns = await call('set', 'race3', {
			channel: 'matrix',
			address: '@nosend:hs.org',
			locale: 'en'
		});
		await settle();
		const queued = await count(`SELECT count(*) AS n FROM offline_notify_leave`);
		const gone = leftRooms();
		check(
			'rooms opened for codes nobody confirmed, or whose first message failed, are left and forgotten',
			victimRoom !== '' &&
				byWorker &&
				gone.includes(victimRoom) &&
				gone.includes(otherRoom) &&
				gone.includes('!nosend:hs') &&
				ns.body.status === 'send_failed' &&
				queued === 0,
			`victim ${victimRoom} (by the worker: ${byWorker}) other ${otherRoom}; forgotten ${gone.join(',')}; queued ${queued}`
		);
	}
	// ── 7c. Every way a room stops being held queues it to leave ──────────
	{
		const leftRooms = (): string[] =>
			hs.hits
				.filter((h) => h.path.endsWith('/forget'))
				.map((h) => decodeURIComponent(h.path.split('/rooms/')[1]!.split('/')[0]!));
		const lastRoom = (): string => {
			const hit = hs.hits.filter((h) => h.path.includes('/send/')).at(-1)!;
			return decodeURIComponent(hit.path.split('/rooms/')[1]!.split('/')[0]!);
		};
		// She types one Matrix ID, then (before confirming) another: the room
		// for the first is held by nothing any more.
		await call('set', 'rory', { channel: 'matrix', address: '@rory1:hs.org', locale: 'en' });
		const firstRoom = lastRoom();
		await call('set', 'rory', { channel: 'matrix', address: '@rory2:hs.org', locale: 'en' });
		const secondRoom = lastRoom();
		await settle();
		const afterRetype = leftRooms();
		check(
			'typing another Matrix ID before confirming leaves the room opened for the first',
			firstRoom !== secondRoom &&
				afterRetype.includes(firstRoom) &&
				!afterRetype.includes(secondRoom),
			`${firstRoom} then ${secondRoom}; forgotten ${afterRetype.join(',')}`
		);
		// A room is kept only for the row still waiting for the code it was
		// opened for. A send for an older code (she typed another address
		// since, or cancelled) finishing late: its room is not kept — left.
		const codeMac = (
			await pool.query(
				`SELECT code_mac FROM offline_notify_channels WHERE account = 'rory' AND channel = 'matrix'`
			)
		).rows[0].code_mac as Buffer;
		const keptStale = await store.setRoute('rory', 'matrix', '!stale:hs', {
			codeMac: Buffer.alloc(codeMac.length, 7)
		});
		const keptRight = await store.setRoute('rory', 'matrix', '!kept:hs', { codeMac });
		const queuedRooms = (
			await pool.query(`SELECT route_sealed, account FROM offline_notify_leave`)
		).rows.map((r) => store.vault.open(r.route_sealed, r.account, 'matrix', 'route'));
		const nowHeld = (await store.status('rory')).channels;
		check(
			"a room from another code is never kept (it is left); the right code's room replaces the old one, which is left",
			!keptStale &&
				keptRight &&
				queuedRooms.includes('!stale:hs') &&
				queuedRooms.includes(secondRoom) &&
				!queuedRooms.includes('!kept:hs') &&
				(await store.roomHeld('rory', '!kept:hs')) &&
				!(await store.roomHeld('rory', '!stale:hs')) &&
				nowHeld.length === 1,
			`${keptStale} ${keptRight} ${queuedRooms.join(',')}`
		);
		await pool.query(`DELETE FROM offline_notify_leave`);
		// A saved address that can no longer be opened (damaged) is deleted
		// when read; the room it held is queued too.
		await pool.query(
			`INSERT INTO offline_notify_channels (account, channel, address_sealed, route_sealed, verified_at, locale)
			 VALUES ('tilly', 'matrix', '\\x0100'::bytea, $1, now(), 'en')
			 ON CONFLICT (account, channel) DO UPDATE SET address_sealed = EXCLUDED.address_sealed,
			   route_sealed = EXCLUDED.route_sealed, verified_at = EXCLUDED.verified_at`,
			[store.vault.seal('!damaged:hs', 'tilly', 'matrix', 'route')]
		);
		const seen = await store.verifiedChannels('tilly');
		const queuedDamaged = (
			await pool.query(`SELECT route_sealed, account FROM offline_notify_leave`)
		).rows.map((r) => store.vault.open(r.route_sealed, r.account, 'matrix', 'route'));
		check(
			'a damaged saved address is dropped and its room queued to leave',
			!seen.channels.some((c) => c.channel === 'matrix') && queuedDamaged.includes('!damaged:hs'),
			`${JSON.stringify(seen.channels.map((c) => c.channel))} queued ${queuedDamaged.join(',')}`
		);
		await pool.query(`DELETE FROM offline_notify_leave`);
	}
	// ── 8. The key ─────────────────────────────────────────────────────────
	{
		const rowsBefore = await count(`SELECT count(*) AS n FROM offline_notify_channels`);
		const empty = mkdtempSync(join(tmpdir(), 'notify-nokey-'));
		let missing: unknown = null;
		try {
			await openSealedStore(db, empty);
		} catch (e) {
			missing = e;
		}
		check(
			'the key file missing: refused, and no new key is made',
			missing instanceof VaultUnavailableError && !existsSync(join(empty, VAULT_KEY_FILE)),
			String(missing)
		);
		const other = mkdtempSync(join(tmpdir(), 'notify-otherkey-'));
		writeFileSync(join(other, VAULT_KEY_FILE), randomBytes(32), { mode: 0o600 });
		let wrongKey: unknown = null;
		try {
			await openSealedStore(db, other);
		} catch (e) {
			wrongKey = e;
		}
		const rowsAfter = await count(`SELECT count(*) AS n FROM offline_notify_channels`);
		check(
			'another key file: refused, and every saved address kept',
			wrongKey instanceof VaultUnavailableError && rowsAfter === rowsBefore && rowsBefore > 0,
			`${String(wrongKey)}; rows ${rowsBefore} → ${rowsAfter}`
		);
		rmSync(empty, { recursive: true, force: true });
		rmSync(other, { recursive: true, force: true });
	}
} catch (err) {
	check('ran to the end', false, String((err as Error)?.stack ?? err));
} finally {
	worker.stop();
	await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
	await admin.end();
	await pool.end();
	await smtp.close();
	await hs.close();
	await tg.close();
	rmSync(keyDir, { recursive: true, force: true });
}
console.log(
	failures === 0
		? `\n✓ all ${n} offline-notify flow checks passed`
		: `\n✗ ${failures} of ${n} offline-notify flow checks failed`
);
process.exit(failures === 0 ? 0 : 1);
