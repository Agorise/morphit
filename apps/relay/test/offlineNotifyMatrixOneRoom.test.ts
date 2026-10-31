/**
 * Offline notices on Matrix: ONE direct room per address, kept for good —
 * run for real: the relay's store on a real Postgres (TEST_DATABASE_URL; the
 * tests skip without it), the admin tool as morphit-ops runs it, the real
 * endpoints and worker, against a stand-in homeserver that answers the
 * client-server API as Synapse does (test/notifyFakes.ts fakeHomeserver).
 *
 * Reported on a live site (v1.21.18): the test note's chat was left at once,
 * and later messages opened new rooms. Now the address's room is kept in the
 * relay's database (offline_notify_matrix_rooms): the test note, the codes
 * and every notice go there; the bot never leaves it for sending, nor while
 * any row of any account holds the address; she is invited back when she
 * left; only a room that cannot be used any more is replaced, and never
 * because of an error about the bot's account or a homeserver that did not
 * answer; two senders at once end in one room; nobody but the bot can invite
 * anyone into a room it opens.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { PrivateKey } from '@beblurt/dblurt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineNotifyEndpoints, notifyLimits } from '../src/notify/api.ts';
import type { NotifyConfig } from '../src/notify/config.ts';
import { sendMatrix } from '../src/notify/channels/matrix.ts';
import { drainLeaves } from '../src/notify/leaves.ts';
import { NotifySigVerifier, notifyCanonical, notifyPayload } from '../src/notify/sig.ts';
import type { DueNotice, OfflineNotifyStore } from '../src/notify/store.ts';
import { OfflineNotifyWorker, Presence } from '../src/notify/worker.ts';
import { DB_TESTS, notifyDb, type NotifyDb } from './notifyDb.ts';
import { fakeHomeserver, type Listening } from './notifyFakes.ts';

const RELAY = join(import.meta.dirname, '..');
const TSX = join(RELAY, '..', '..', 'node_modules', '.bin', 'tsx');
const OP = '@op:example.org';
const AUDIENCE = 'site-relay';
const key = PrivateKey.fromSeed('one-room-site-owner');
const direct = { torSocks: '', hiddenOnly: false };

const open: Array<Listening | NotifyDb> = [];
afterEach(async () => {
	for (const l of open.splice(0)) await l.close();
});
async function homeserver(o: Parameters<typeof fakeHomeserver>[0] = {}) {
	const hs = await fakeHomeserver(o);
	open.push(hs);
	return hs;
}
type Hs = Awaited<ReturnType<typeof homeserver>>;
async function database() {
	const d = await notifyDb();
	open.push(d);
	return d;
}

function notifyCfg(hs: Hs): NotifyConfig {
	return {
		siteName: 'Test Site',
		audience: AUDIENCE,
		linkOrigin: 'https://site.example',
		linkOrigins: { clearnet: null, tor: null, i2p: null, loki: null },
		policy: direct,
		email: null,
		matrix: { homeserver: hs.url, accessToken: hs.token, userId: hs.bot },
		xmpp: null,
		telegram: null,
		session: null,
		off: {}
	};
}

/** `adminCli send matrix`, run for real as morphit-ops runs it. */
async function testNote(hs: Hs, d: NotifyDb, to: string, dbUrl = d.url) {
	const keyFile = join(d.dataDir, 'active.key');
	writeFileSync(keyFile, PrivateKey.fromSeed('one-room-relay').toString(), { mode: 0o600 });
	const child = spawn(TSX, [join(RELAY, 'src/notify/adminCli.ts'), 'send', 'matrix'], {
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			MORPHIT_RELAY_ACCOUNT: AUDIENCE,
			MORPHIT_RELAY_ACTIVE_KEY_FILE: keyFile,
			MORPHIT_RELAY_DATABASE_URL: dbUrl,
			MORPHIT_RELAY_DATA_DIR: d.dataDir,
			MORPHIT_INSTANCE_ORIGIN: 'https://site.example'
		}
	});
	child.stdin.end(
		`${JSON.stringify({
			MORPHIT_NOTIFY_MATRIX_HOMESERVER: hs.url,
			MORPHIT_NOTIFY_MATRIX_TOKEN: hs.token,
			MORPHIT_NOTIFY_MATRIX_USER_ID: hs.bot,
			to
		})}\n`
	);
	let out = '';
	child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
	await new Promise<void>((r) => child.on('close', () => r()));
	return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
}

/** Settings → Offline Notifications, signed as the account `who`. */
function settings(cfg: NotifyConfig, store: OfflineNotifyStore, who = 'site-owner') {
	const app = new Hono();
	new OfflineNotifyEndpoints(
		cfg,
		store,
		new NotifySigVerifier(
			{ postingKeyAgreed: async () => ({ key: key.createPublic('BLT').toString() }) },
			AUDIENCE
		),
		new Presence(),
		notifyLimits(),
		{ codeAnswerMs: 2_000 }
	).register(app);
	const post = async (action: 'set' | 'verify', fields: Record<string, string>) => {
		const timestamp = Math.floor(Date.now() / 1000);
		const nonce = randomBytes(16).toString('hex');
		const digest = createHash('sha256')
			.update(
				notifyCanonical(action, AUDIENCE, who, nonce, notifyPayload(action, fields), timestamp),
				'utf8'
			)
			.digest();
		const r = await app.request(`/v1/notify/${action}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				...fields,
				account: who,
				nonce,
				timestamp,
				signature: key.sign(digest).toString()
			})
		});
		return ((await r.json()) as { status: string }).status;
	};
	return {
		set: (address: string) =>
			post('set', { channel: 'matrix', address, locale: 'en', net: 'clearnet' }),
		/** The code in the last message the bot sent to `room`. */
		verify: (code: string) => post('verify', { channel: 'matrix', code })
	};
}

const lastCode = (hs: Hs, room: string): string =>
	/\b(\d{6})\b/.exec(hs.rooms.get(room)?.messages.at(-1)?.body ?? '')?.[1] ?? '';

/** A chat message to `account` waiting for its notice (as the indexer queues it). */
async function pending(d: NotifyDb, account: string, thread: string): Promise<DueNotice> {
	return {
		account,
		sender: 'someone',
		orderPermlink: thread,
		eventAt: new Date(Date.now() - 20 * 60_000),
		attempts: 0
	};
}

/** The parts of the worker's decision a notice needs (no chain tables here). */
function worker(cfg: NotifyConfig, store: OfflineNotifyStore): OfflineNotifyWorker {
	const s = store as unknown as Record<string, unknown>;
	for (const m of ['repliedSince', 'blocked', 'readSince', 'alreadyNoticed', 'noticedSince'])
		s[m] = async () => false;
	s.unreadStoredFrom = async () => true;
	s.everWrote = async () => true;
	return new OfflineNotifyWorker(cfg, store, new Presence());
}

const drain = (cfg: NotifyConfig, store: OfflineNotifyStore) =>
	drainLeaves(store, cfg.matrix, direct, new Date());
const queued = (d: NotifyDb) => d.count(`SELECT count(*)::int AS n FROM offline_notify_leave`);

describe.skipIf(!DB_TESTS)('Matrix: one room per address, kept (real store)', () => {
	it('the test note, his code (asked twice) and two notices: ONE room, never left, with leave rounds in between', async () => {
		const hs = await homeserver({ autoJoin: [OP] });
		const d = await database();
		const cfg = notifyCfg(hs);
		// 1. sudo morphit-ops offline-notify → a test note to his own address.
		expect(await testNote(hs, d, OP)).toEqual({ ok: true });
		const [room] = [...hs.rooms.keys()];
		const store = await d.open();
		// 2. He turns offline notices on for his account in Settings, asks for
		// the code twice, with the leave round in between.
		const s = settings(cfg, store);
		expect(await s.set(OP)).toBe('code_sent');
		await drain(cfg, store);
		expect(await s.set(OP)).toBe('code_sent');
		await drain(cfg, store);
		expect(await s.verify(lastCode(hs, room!))).toBe('verified');
		await drain(cfg, store);
		// 3. Two messages reach him while he is away.
		const w = worker(cfg, store);
		expect(await w.handle(await pending(d, 'site-owner', 'a'), new Date())).toBe('sent');
		await w.tick();
		expect(await w.handle(await pending(d, 'site-owner', 'b'), new Date())).toBe('sent');
		await drain(cfg, store);
		// (a) one room for all five messages…
		expect.soft(hs.made(), 'rooms opened').toBe(1);
		expect.soft(hs.rooms.get(room!)!.messages.length, 'messages in it').toBe(5);
		// (b) …never left or forgotten, nothing waiting to be left.
		expect
			.soft(
				hs.leavesAndForgets().map((h) => h.path),
				'leave/forget'
			)
			.toEqual([]);
		expect.soft(await queued(d), 'queued').toBe(0);
		expect(hs.rooms.get(room!)!.members.get(hs.bot)).toBe('join');
		// The bot's own m.direct list is not written (nothing reads it).
		expect(hs.hits.some((h) => h.path.includes('/account_data/'))).toBe(false);
	}, 60_000);

	it('a room the bot opens holds only her and the bot: only the bot may invite', async () => {
		const hs = await homeserver({ autoJoin: [OP] });
		const d = await database();
		const store = await d.open();
		await store.holdTestAddress(OP, new Date());
		const room = await sendMatrix(notifyCfg(hs).matrix!, direct, OP, 'hi', store.matrixRoomBook());
		const r = hs.rooms.get(room)!;
		// All of it: who may invite, kick, ban, redact or change the room
		// (only the bot), who may join as a guest (nobody), what a newcomer
		// may read (only what comes after the invitation).
		expect(r.created).toEqual({
			preset: 'private_chat',
			is_direct: true,
			invite: [OP],
			visibility: 'private',
			initial_state: [
				{
					type: 'm.room.history_visibility',
					state_key: '',
					content: { history_visibility: 'invited' }
				},
				{ type: 'm.room.guest_access', state_key: '', content: { guest_access: 'forbidden' } }
			],
			power_level_content_override: {
				invite: 100,
				kick: 100,
				ban: 100,
				redact: 100,
				state_default: 100,
				users_default: 0
			}
		});
		expect(hs.inviteBy(room, OP, '@friend:example.org')).toBe(false);
	});

	it('a code given up (past its budget) and asked again, the leave round during the new send: one room', async () => {
		const hs = await homeserver({ autoJoin: [OP] });
		const d = await database();
		const cfg = notifyCfg(hs);
		const store = await d.open();
		const s = settings(cfg, store);
		expect(await s.set(OP)).toBe('code_sent');
		const room = [...hs.rooms.keys()][0]!;
		// The first code's send was given up: her waiting row goes; no row
		// holds the address: its room is queued.
		await store.restoreOrDrop('site-owner', 'matrix');
		expect(await queued(d)).toBe(1);
		// She asks again: once her request is saved, the leave round runs
		// while that code is on its way.
		const again = s.set(OP);
		while (
			(await d.count(
				`SELECT count(*)::int AS n FROM offline_notify_channels WHERE account = 'site-owner'`
			)) === 0
		)
			await new Promise((r) => setTimeout(r, 2));
		await drain(cfg, store);
		expect(await again).toBe('code_sent');
		await drain(cfg, store);
		expect(hs.made()).toBe(1);
		expect(hs.rooms.get(room)!.members.get(hs.bot)).toBe('join');
		expect(hs.rooms.get(room)!.messages).toHaveLength(2);
		expect(hs.leavesAndForgets()).toEqual([]);
		expect(await queued(d)).toBe(0);
		// Given up for good: now it is left.
		await store.restoreOrDrop('site-owner', 'matrix');
		await drain(cfg, store);
		expect(hs.rooms.get(room)!.members.get(hs.bot)).toBe('leave');
		expect(hs.rooms.get(room)!.forgotten.has(hs.bot)).toBe(true);
		expect((await store.matrixRoomCount()).rooms).toBe(0);
	});

	it('she left the room herself: invited to the SAME room again', async () => {
		const hs = await homeserver({ autoJoin: [OP] });
		const d = await database();
		const store = await d.open();
		await store.holdTestAddress(OP, new Date());
		const cfg = notifyCfg(hs);
		const book = store.matrixRoomBook();
		const room = await sendMatrix(cfg.matrix!, direct, OP, 'one', book);
		hs.leave(room, OP);
		expect(await sendMatrix(cfg.matrix!, direct, OP, 'two', book)).toBe(room);
		expect(hs.rooms.get(room)!.members.get(OP)).toBe('join');
		expect(hs.hits.filter((h) => h.path.endsWith('/invite'))).toHaveLength(1);
		expect(hs.made()).toBe(1);
	});

	it('the bot is no longer in her room: one new room, claimed for her; the old one left', async () => {
		const hs = await homeserver({ autoJoin: [OP] });
		const d = await database();
		const store = await d.open();
		await store.holdTestAddress(OP, new Date());
		const cfg = notifyCfg(hs);
		const book = store.matrixRoomBook();
		const first = await sendMatrix(cfg.matrix!, direct, OP, 'one', book);
		hs.removeBot(first);
		const second = await sendMatrix(cfg.matrix!, direct, OP, 'two', book);
		expect(second).not.toBe(first);
		expect(await sendMatrix(cfg.matrix!, direct, OP, 'three', book)).toBe(second);
		expect(hs.made()).toBe(2);
		expect(await queued(d)).toBe(1);
		await drain(cfg, store);
		expect(await queued(d)).toBe(0);
		expect(hs.rooms.get(second)!.members.get(hs.bot)).toBe('join');
	});

	it.each([
		['the homeserver is down (502)', { status: 502, errcode: 'M_UNKNOWN' }],
		[
			'the bot is suspended (403 M_FORBIDDEN to everything)',
			{ status: 403, errcode: 'M_FORBIDDEN' }
		],
		['the bot is suspended (403 M_USER_SUSPENDED)', { status: 403, errcode: 'M_USER_SUSPENDED' }],
		['the bot is rate-limited (429 M_LIMIT_EXCEEDED)', { status: 429, errcode: 'M_LIMIT_EXCEEDED' }]
	])('%s: no new room, the note is tried again', async (_what, trouble) => {
		const hs = await homeserver({ autoJoin: [OP] });
		const d = await database();
		const store = await d.open();
		await store.holdTestAddress(OP, new Date());
		const cfg = notifyCfg(hs);
		const book = store.matrixRoomBook();
		const room = await sendMatrix(cfg.matrix!, direct, OP, 'one', book);
		hs.trouble(trouble);
		await expect(sendMatrix(cfg.matrix!, direct, OP, 'two', book)).rejects.toThrow();
		hs.trouble(null);
		expect(hs.hits.filter((h) => h.path.endsWith('/createRoom'))).toHaveLength(1);
		expect(await sendMatrix(cfg.matrix!, direct, OP, 'three', book)).toBe(room);
		expect(hs.made()).toBe(1);
	});

	// A suspended account may still read (MSC3823): its joined rooms say it is
	// in her room, but every write is refused with M_USER_SUSPENDED — the
	// invitation back too. That is the account, not her room.
	it('she left, and the bot is suspended (reads still work): no new room, the note is tried again', async () => {
		const hs = await homeserver({ autoJoin: [OP] });
		const d = await database();
		const store = await d.open();
		await store.holdTestAddress(OP, new Date());
		const cfg = notifyCfg(hs);
		const book = store.matrixRoomBook();
		const room = await sendMatrix(cfg.matrix!, direct, OP, 'one', book);
		hs.leave(room, OP);
		hs.trouble({ status: 403, errcode: 'M_USER_SUSPENDED', writesOnly: true });
		await expect(sendMatrix(cfg.matrix!, direct, OP, 'two', book)).rejects.toThrow();
		hs.trouble(null);
		expect(hs.hits.filter((h) => h.path.endsWith('/createRoom'))).toHaveLength(1);
		expect(await sendMatrix(cfg.matrix!, direct, OP, 'three', book)).toBe(room);
		expect(hs.made()).toBe(1);
	});

	// A refusal of the message itself (403 M_FORBIDDEN) while the bot's own
	// list says it is in her room: the account, not the room.
	it('a message refused (403 M_FORBIDDEN) while the bot is in her room: no new room, tried again', async () => {
		const hs = await homeserver({ autoJoin: [OP] });
		const d = await database();
		const store = await d.open();
		await store.holdTestAddress(OP, new Date());
		const cfg = notifyCfg(hs);
		const book = store.matrixRoomBook();
		const room = await sendMatrix(cfg.matrix!, direct, OP, 'one', book);
		hs.trouble({ status: 403, errcode: 'M_FORBIDDEN', writesOnly: true });
		await expect(sendMatrix(cfg.matrix!, direct, OP, 'two', book)).rejects.toThrow();
		hs.trouble(null);
		expect(hs.hits.filter((h) => h.path.endsWith('/createRoom'))).toHaveLength(1);
		expect(await sendMatrix(cfg.matrix!, direct, OP, 'three', book)).toBe(room);
	});

	// She left; inviting her back is refused, and the bot cannot even read its
	// own joined rooms: its account is in trouble — nothing is judged.
	it('she left, the invitation is refused and the bot cannot read its own rooms: no new room', async () => {
		const hs = await homeserver({ autoJoin: [OP] });
		const d = await database();
		const store = await d.open();
		await store.holdTestAddress(OP, new Date());
		const cfg = notifyCfg(hs);
		const book = store.matrixRoomBook();
		const room = await sendMatrix(cfg.matrix!, direct, OP, 'one', book);
		hs.leave(room, OP);
		hs.trouble({
			status: 403,
			errcode: 'M_FORBIDDEN',
			only: (_m, path) => path.endsWith('/invite') || path.endsWith('/joined_rooms')
		});
		await expect(sendMatrix(cfg.matrix!, direct, OP, 'two', book)).rejects.toThrow();
		hs.trouble(null);
		expect(hs.hits.filter((h) => h.path.endsWith('/createRoom'))).toHaveLength(1);
		expect(await sendMatrix(cfg.matrix!, direct, OP, 'three', book)).toBe(room);
	});

	// Just before the bot leaves, the room is taken out of her address's
	// mapping (store.leaveIfUnused; nothing is held while the homeserver
	// answers): an address set up again while the bot is leaving gets its code
	// in a new room — never in the room the bot is leaving.
	it('her address set up again while the bot is leaving its room: the code goes to a room the bot stays in', async () => {
		let slowLeave = false;
		const hs = await homeserver({
			autoJoin: [OP],
			slow: (_m, path) => (slowLeave && path.endsWith('/leave') ? 500 : 0)
		});
		const d = await database();
		const store = await d.open();
		const cfg = notifyCfg(hs);
		const book = store.matrixRoomBook();
		const at = new Date();
		const b1 = await store.beginAddress('site-owner', 'matrix', OP, 'en', '111111', 'clearnet', at);
		if (!b1.ok) throw new Error('begin');
		const first = await sendMatrix(cfg.matrix!, direct, OP, 'code 111111', book);
		await store.restoreOrDrop('site-owner', 'matrix', b1.codeMac);
		slowLeave = true;
		const leaving = drain(cfg, store);
		await vi.waitFor(() => {
			if (!hs.hits.some((h) => h.path.endsWith('/leave'))) throw new Error('not yet');
		});
		await store.beginAddress('site-owner', 'matrix', OP, 'en', '222222', 'clearnet', at);
		const went = await sendMatrix(cfg.matrix!, direct, OP, 'code 222222', book);
		await leaving;
		expect(hs.rooms.get(went)!.members.get(hs.bot)).toBe('join');
		expect((await book.get(OP))?.room).toBe(went);
		expect(hs.rooms.get(first)!.members.get(hs.bot)).toBe('leave');
		expect(await queued(d)).toBe(0);
	});

	it('two sends at once — in one process, and in two — end in one room; the room the loser opened is left', async () => {
		// Opening a room takes a moment: both senders get as far as that.
		const hs = await homeserver({
			autoJoin: [OP, '@x:example.org'],
			slow: (_m, path) => (path.endsWith('/createRoom') ? 300 : 0)
		});
		const d = await database();
		const store = await d.open();
		await store.holdTestAddress(OP, new Date());
		const cfg = notifyCfg(hs);
		const [a, b] = await Promise.all([
			sendMatrix(cfg.matrix!, direct, OP, 'one', store.matrixRoomBook()),
			sendMatrix(cfg.matrix!, direct, OP, 'two', store.matrixRoomBook())
		]);
		expect(a).toBe(b);
		expect(hs.made()).toBe(1);
		// Another process: another copy of the module (no shared lock), and
		// another store on the same database.
		const other = (await import(
			// @ts-expect-error -- a query makes a separate module instance
			'../src/notify/channels/matrix.ts?another-process'
		)) as typeof import('../src/notify/channels/matrix.ts');
		const X = '@x:example.org';
		await store.holdTestAddress(X, new Date());
		const store2 = await d.open();
		const [p, q] = await Promise.all([
			sendMatrix(cfg.matrix!, direct, X, 'one', store.matrixRoomBook()),
			other.sendMatrix(cfg.matrix!, direct, X, 'two', store2.matrixRoomBook())
		]);
		expect(p).toBe(q);
		const forX = [...hs.rooms.values()].filter((r) => r.members.has(X));
		expect(forX).toHaveLength(2);
		// Every message to X is in the one room; a room the loser opened is
		// queued, and the leave round leaves it.
		expect(hs.rooms.get(p)!.messages).toHaveLength(2);
		await drain(cfg, store);
		for (const r of forX) expect(r.members.get(hs.bot)).toBe(r.id === p ? 'join' : 'leave');
		expect(await queued(d)).toBe(0);
	});

	it('a test note while the saved addresses cannot be opened: nothing is sent, no room opened', async () => {
		const hs = await homeserver({ autoJoin: [OP] });
		const d = await database();
		const r = await testNote(hs, d, OP, 'postgres://nobody@127.0.0.1:1/none');
		expect(r).toMatchObject({ ok: false, error: 'no_store' });
		expect(hs.hits).toEqual([]);
	}, 60_000);
});
