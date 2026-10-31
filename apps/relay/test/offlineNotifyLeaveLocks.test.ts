/**
 * Offline notices — leaving Matrix rooms never holds the database: on a real
 * Postgres (TEST_DATABASE_URL; skipped without), with the relay's own pool
 * (db/pool.ts: 5 connections, 5 s to get one) and a stand-in homeserver that
 * takes longer than that to answer a leave.
 *
 *   - Leave rounds started by many users at once (every remove, cancel,
 *     confirm and code send starts one) run one at a time, and no
 *     transaction is open while the homeserver answers: the relay's other
 *     queries are not starved (review 19c, HIGH-1, probe rv-pool).
 *   - A slow leave does not hold up anyone's address change — of any app —
 *     nor the one that sets the left room's address again (probe
 *     rv-lockchain); that address then gets a room the bot stays in.
 *   - A leave that fails puts the room back with its address: kept if a row
 *     set the address again meanwhile.
 *   - No store transaction waits for a lock without end (LOCK_WAIT_MS).
 *   - Lock order: confirming a code and the purge of expired ones never
 *     deadlock (verifyCode takes the Matrix lock first).
 *   - A given-up leave never deletes a mapping a row took back.
 *   - Moving old rooms (upgrade) never overwrites a room just claimed.
 */
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/db/pool.ts';
import { sendMatrix } from '../src/notify/channels/matrix.ts';
import { drainLeaves } from '../src/notify/leaves.ts';
import {
	CODE_TTL_MS,
	LOCK_WAIT_MS,
	openSealedStore,
	ROOM_ACCOUNT,
	type OfflineNotifyStore
} from '../src/notify/store.ts';
import { DB_TESTS, notifyDb, type NotifyDb } from './notifyDb.ts';
import { fakeHomeserver } from './notifyFakes.ts';

const direct = { torSocks: '', hiddenOnly: false };
const X = '@her:example.org';
/** Longer than the relay's pool waits for a connection (5 s). */
const LEAVE_MS = 6_000;
/** The store's Matrix lock (store.ts lockMatrix): this test's schema only. */
const MATRIX_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('offline-notify:matrix-rooms:' || current_schema(), 0))`;

const closing: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const c of closing.splice(0).reverse()) await c().catch(() => undefined);
});

async function setup(slow?: (method: string, path: string) => number) {
	const d = await notifyDb();
	closing.push(() => d.close());
	const hs = await fakeHomeserver({ autoJoin: [X], ...(slow ? { slow } : {}) });
	closing.push(() => hs.close());
	// The relay's own pool, on this test's schema.
	const relayDb = createDatabase({ databaseUrl: d.url } as never);
	closing.push(() => relayDb.close());
	const store = (await openSealedStore(relayDb, d.dataDir)).store;
	const cfg = { homeserver: hs.url, accessToken: hs.token, userId: hs.bot };
	return { d, hs, relayDb, store, cfg, book: store.matrixRoomBook() };
}

/** Another connection, as another relay process or a hung transaction. */
async function other(d: NotifyDb): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: d.url });
	await c.connect();
	closing.push(() => c.end());
	return c;
}

/** This test's own backends (its schema's connections) waiting for a lock. */
async function waiting(d: NotifyDb): Promise<number> {
	return d.count(
		`SELECT count(*)::int AS n FROM pg_stat_activity
		  WHERE application_name = $1 AND wait_event_type = 'Lock'`,
		[d.name]
	);
}

const within = async <T>(ms: number, p: Promise<T>): Promise<{ v: T; ms: number }> => {
	const t0 = Date.now();
	const v = await p;
	const took = Date.now() - t0;
	expect(took, 'took').toBeLessThan(ms);
	return { v, ms: took };
};

async function heldAndLeft(store: OfflineNotifyStore, cfg: never, acct: string, who: string) {
	await store.beginAddress(acct, 'matrix', who, 'en', '111111', 'clearnet', new Date());
	await store.verifyCode(acct, 'matrix', '111111', new Date());
	await sendMatrix(cfg, direct, who, 'hi', store.matrixRoomBook());
	await store.remove(acct, 'matrix');
}

describe.skipIf(!DB_TESTS)('offline notices: leaving rooms never holds the database', () => {
	it('five leave rounds at once with a slow homeserver: one at a time, other queries not starved', async () => {
		let slow = false;
		let inFlight = 0;
		let most = 0;
		const s = await setup((m, p) => {
			if (!(slow && m === 'POST' && p.endsWith('/leave'))) return 0;
			most = Math.max(most, ++inFlight);
			setTimeout(() => inFlight--, LEAVE_MS);
			return LEAVE_MS;
		});
		for (let i = 0; i < 6; i++)
			await heldAndLeft(s.store, s.cfg as never, `acct${i}`, `@u${i}:example.org`);
		slow = true;
		const rounds = Array.from({ length: 5 }, () =>
			drainLeaves(s.store, s.cfg, direct, new Date(Date.now() + 1000), 1)
		);
		// The homeserver is answering a leave now.
		await vi.waitFor(() => expect(inFlight).toBe(1));
		await within(1500, s.relayDb.query('SELECT 1'));
		await within(
			1500,
			s.store.beginAddress('zed', 'email', 'z@example.org', 'en', '123456', 'clearnet', new Date())
		);
		// Nothing of this store sits in an open transaction while the
		// homeserver answers.
		const idle = await s.d.count(
			`SELECT count(*)::int AS n FROM pg_stat_activity
			  WHERE state LIKE 'idle in transaction%' AND query LIKE '%offline_notify_matrix_rooms%'`
		);
		expect(idle).toBe(0);
		const results = await Promise.all(rounds);
		// One pass: the others joined it (and asked for one more, which runs
		// on its own — tested in offlineNotifyLeaves.test.ts).
		expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
		expect(most).toBe(1);
		expect(results[0]!.left).toBeGreaterThanOrEqual(1);
	}, 60_000);

	it('a slow leave: address changes of everyone (any app) go on; her address set again gets a room the bot stays in', async () => {
		let slowLeave = false;
		const s = await setup((m, p) =>
			slowLeave && m === 'POST' && p.endsWith('/leave') ? LEAVE_MS : 0
		);
		const now = new Date();
		await s.store.beginAddress('alice', 'matrix', X, 'en', '111111', 'clearnet', now);
		await s.store.verifyCode('alice', 'matrix', '111111', now);
		const old = await sendMatrix(s.cfg, direct, X, 'hi', s.book);
		await s.store.beginAddress('carol', 'email', 'c@example.org', 'en', '222222', 'clearnet', now);
		await s.store.remove('alice', 'matrix');
		slowLeave = true;
		const leaving = drainLeaves(s.store, s.cfg, direct, new Date(Date.now() + 1000));
		await vi.waitFor(() => {
			if (!s.hs.hits.some((h) => h.path.endsWith('/leave'))) throw new Error('not yet');
		});
		await within(1500, s.store.beginAddress('bob', 'matrix', X, 'en', '333333', 'clearnet', now));
		const carol = await within(1500, s.store.verifyCode('carol', 'email', '222222', now));
		expect(carol.v).toBe('verified');
		await within(
			1500,
			Promise.all(
				['dave', 'erin'].map((a) =>
					s.store.beginAddress(a, 'email', `${a}@example.org`, 'en', '444444', 'clearnet', now)
				)
			)
		);
		await within(1500, s.relayDb.query('SELECT 1'));
		expect(await leaving).toEqual({ claimed: 1, left: 1 });
		slowLeave = false;
		// Bob's code: a new room (the old one is left), and it is his address's.
		const room = await sendMatrix(s.cfg, direct, X, 'code 333333', s.book);
		expect(room).not.toBe(old);
		expect(s.hs.rooms.get(room)!.members.get(s.hs.bot)).toBe('join');
		expect(s.hs.rooms.get(old)!.members.get(s.hs.bot)).toBe('leave');
		expect((await s.book.get(X))?.room).toBe(room);
		expect(await s.d.count(`SELECT count(*)::int AS n FROM offline_notify_leave`)).toBe(0);
	}, 60_000);

	it('a leave that fails while her address is set again: the room is kept, and comes back as hers', async () => {
		let failLeave = false;
		const s = await setup((m, p) => (failLeave && m === 'POST' && p.endsWith('/leave') ? 1000 : 0));
		const now = new Date();
		await s.store.beginAddress('alice', 'matrix', X, 'en', '111111', 'clearnet', now);
		await s.store.verifyCode('alice', 'matrix', '111111', now);
		const room = await sendMatrix(s.cfg, direct, X, 'hi', s.book);
		await s.store.remove('alice', 'matrix');
		failLeave = true;
		s.hs.trouble({
			status: 502,
			errcode: 'M_UNKNOWN',
			only: (m, p) => m === 'POST' && p.endsWith('/leave')
		});
		const leaving = drainLeaves(s.store, s.cfg, direct, new Date(Date.now() + 1000));
		await vi.waitFor(() => {
			if (!s.hs.hits.some((h) => h.path.endsWith('/leave'))) throw new Error('not yet');
		});
		await s.store.beginAddress('bob', 'matrix', X, 'en', '333333', 'clearnet', now);
		expect(await leaving).toEqual({ claimed: 1, left: 0 });
		s.hs.trouble(null);
		failLeave = false;
		expect(await s.d.count(`SELECT count(*)::int AS n FROM offline_notify_leave`)).toBe(0);
		expect(await sendMatrix(s.cfg, direct, X, 'code 333333', s.book)).toBe(room);
		expect(s.hs.made()).toBe(1);
	}, 30_000);

	it('a leave that fails after a newer room was claimed for her address: the newer one stays hers, the old one is left', async () => {
		let failLeave = false;
		const s = await setup((m, p) => (failLeave && m === 'POST' && p.endsWith('/leave') ? 1000 : 0));
		const now = new Date();
		await s.store.beginAddress('alice', 'matrix', X, 'en', '111111', 'clearnet', now);
		await s.store.verifyCode('alice', 'matrix', '111111', now);
		const old = await sendMatrix(s.cfg, direct, X, 'hi', s.book);
		await s.store.remove('alice', 'matrix');
		failLeave = true;
		s.hs.trouble({
			status: 502,
			errcode: 'M_UNKNOWN',
			only: (m, p) => m === 'POST' && p.endsWith('/leave')
		});
		const leaving = drainLeaves(s.store, s.cfg, direct, new Date(Date.now() + 1000));
		await vi.waitFor(() => {
			if (!s.hs.hits.some((h) => h.path.endsWith('/leave'))) throw new Error('not yet');
		});
		// While the bot is (failing to be) leaving: bob sets her address, and
		// his code opens a new room.
		await s.store.beginAddress('bob', 'matrix', X, 'en', '333333', 'clearnet', now);
		const fresh = await sendMatrix(s.cfg, direct, X, 'code 333333', s.book);
		expect(fresh).not.toBe(old);
		await leaving;
		s.hs.trouble(null);
		failLeave = false;
		// The failed leave did not put the old room back over the new one…
		expect((await s.book.get(X))?.room).toBe(fresh);
		// …and the old one is left on the next try.
		await drainLeaves(s.store, s.cfg, direct, new Date(Date.now() + 3 * 60_000));
		expect(s.hs.rooms.get(old)!.members.get(s.hs.bot)).toBe('leave');
		expect(s.hs.rooms.get(fresh)!.members.get(s.hs.bot)).toBe('join');
		expect(await s.d.count(`SELECT count(*)::int AS n FROM offline_notify_leave`)).toBe(0);
		expect(await sendMatrix(s.cfg, direct, X, 'note', s.book)).toBe(fresh);
	}, 30_000);

	it('a failed leave puts the room back under the Matrix lock: its last holder going at that moment lets it go again', async () => {
		const s = await setup();
		const now = new Date();
		await s.store.beginAddress('alice', 'matrix', X, 'en', '111111', 'clearnet', now);
		await s.store.verifyCode('alice', 'matrix', '111111', now);
		const room = await sendMatrix(s.cfg, direct, X, 'hi', s.book);
		await s.store.remove('alice', 'matrix');
		const [item] = await s.store.claimLeaves(1, new Date(Date.now() + 1000));
		const mac = (s.store as unknown as { roomMac(a: string): Buffer }).roomMac(X);
		const c = await other(s.d);
		const leaving = s.store
			.leaveIfUnused(item!, async () => {
				// While the bot "leaves": bob sets her address (he holds it now),
				// and another transaction is putting a room into the mapping.
				await s.store.beginAddress('bob', 'matrix', X, 'en', '333333', 'clearnet', now);
				await c.query('BEGIN');
				await c.query(
					`INSERT INTO offline_notify_matrix_rooms (address_mac, room_sealed) VALUES ($1, '\\x00'::bytea)`,
					[mac]
				);
				throw new Error('ECONNREFUSED');
			})
			.then(
				(r) => r,
				() => 'threw'
			);
		// Putting the room back waits for that transaction.
		await vi.waitFor(async () => expect(await waiting(s.d)).toBe(1));
		// Bob removes it at that very moment: no row holds her address any more.
		let removed = false;
		const removing = s.store.remove('bob', 'matrix').then(() => (removed = true));
		await vi.waitFor(async () => {
			if (!removed && (await waiting(s.d)) < 2) throw new Error('not yet');
		});
		await c.query('ROLLBACK');
		await Promise.all([leaving, removing]);
		// So the room must be on its way out — not kept for nobody.
		const q = await s.d.pool.query<{ route_sealed: Buffer }>(
			`SELECT route_sealed FROM offline_notify_leave`
		);
		expect(
			q.rows.map((r) => s.store.vault.open(r.route_sealed, ROOM_ACCOUNT, 'matrix', 'route'))
		).toEqual([room]);
		await drainLeaves(s.store, s.cfg, direct, new Date(Date.now() + 1000));
		expect(s.hs.rooms.get(room)!.members.get(s.hs.bot)).toBe('leave');
		expect(await s.d.count(`SELECT count(*)::int AS n FROM offline_notify_matrix_rooms`)).toBe(0);
	}, 30_000);

	it(`no transaction waits for a lock longer than ${LOCK_WAIT_MS} ms`, async () => {
		const s = await setup();
		const c = await other(s.d);
		await c.query('BEGIN');
		await c.query(MATRIX_LOCK_SQL); // held, as by a transaction that hangs
		const t0 = Date.now();
		const err = await s.store
			.beginAddress('alice', 'matrix', X, 'en', '111111', 'clearnet', new Date())
			.then(
				() => null,
				(e: unknown) => e as { code?: string }
			);
		const took = Date.now() - t0;
		await c.query('ROLLBACK');
		expect(err?.code).toBe('55P03'); // lock_not_available
		expect(took).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 200);
		expect(took).toBeLessThan(LOCK_WAIT_MS + 3000);
	}, 30_000);

	it("another schema's Matrix lock (another test, another site on one database) is not this one", async () => {
		const s = await setup();
		const elsewhere = await notifyDb();
		closing.push(() => elsewhere.close());
		const c = await other(elsewhere);
		await c.query('BEGIN');
		await c.query(MATRIX_LOCK_SQL); // its own schema's lock, held
		await within(
			1500,
			s.store.beginAddress('alice', 'matrix', X, 'en', '111111', 'clearnet', new Date())
		);
		await c.query('ROLLBACK');
	}, 30_000);

	it('confirming a code while expired ones are purged: no deadlock (the Matrix lock is taken first)', async () => {
		const s = await setup();
		const now = new Date();
		await s.store.beginAddress('vic', 'matrix', X, 'en', '111111', 'clearnet', now);
		const c = await other(s.d);
		await c.query('BEGIN');
		await c.query(MATRIX_LOCK_SQL);
		// The purge comes first and waits for the lock; then the confirmation.
		const purging = s.store.purge(new Date(now.getTime() + CODE_TTL_MS + 60_000)).then(
			() => 'ok',
			(e: { code?: string }) => e.code ?? String(e)
		);
		await vi.waitFor(async () => expect(await waiting(s.d)).toBe(1));
		const verifying = s.store.verifyCode('vic', 'matrix', '111111', now).then(
			(r) => `ok ${r}`,
			(e: { code?: string }) => e.code ?? String(e)
		);
		await vi.waitFor(async () => expect(await waiting(s.d)).toBe(2));
		await c.query('COMMIT');
		const [p, v] = await Promise.all([purging, verifying]);
		expect(p).toBe('ok');
		expect(v).toMatch(/^ok /); // never 40P01 (deadlock_detected)
	}, 30_000);

	it('a leave given up after its last try never deletes a mapping a row took back', async () => {
		const s = await setup();
		const now = new Date();
		await s.store.beginAddress('alice', 'matrix', X, 'en', '111111', 'clearnet', now);
		await s.store.verifyCode('alice', 'matrix', '111111', now);
		const room = await sendMatrix(s.cfg, direct, X, 'hi', s.book);
		await s.store.remove('alice', 'matrix');
		const [item] = await s.store.claimLeaves(1, new Date(Date.now() + 1000));
		// The last try fails…
		await expect(
			s.store.leaveIfUnused(item!, async () => {
				throw new Error('ECONNREFUSED');
			})
		).rejects.toThrow();
		// …bob sets her address again before it is given up…
		await s.store.beginAddress('bob', 'matrix', X, 'en', '333333', 'clearnet', now);
		await s.store.leaveDone(item!);
		// …so it is still her room.
		expect((await s.book.get(X))?.room).toBe(room);
		expect(await sendMatrix(s.cfg, direct, X, 'code', s.book)).toBe(room);
		expect(s.hs.made()).toBe(1);
	}, 30_000);

	it('two processes claim a room for one address at the same moment: one wins, the other gets its room', async () => {
		const s = await setup();
		await s.store.holdTestAddress(X, new Date());
		const vault = s.store.vault;
		const mac = (s.store as unknown as { roomMac(a: string): Buffer }).roomMac(X);
		// Another process claims room N for her address, under the Matrix lock
		// (as the store's claim does), and has not committed yet…
		const c = await other(s.d);
		await c.query('BEGIN');
		await c.query(MATRIX_LOCK_SQL);
		await c.query(
			`INSERT INTO offline_notify_matrix_rooms (address_mac, room_sealed, bot_only_invites) VALUES ($1, $2, TRUE)`,
			[mac, vault.seal('!n:hs', ROOM_ACCOUNT, 'matrix', 'route')]
		);
		// …when this one claims the room it has just opened.
		const claiming = s.book.claim(X, null, '!mine:hs').then(
			(r) => r,
			(e: { code?: string }) => e.code ?? String(e)
		);
		await vi.waitFor(async () => expect(await waiting(s.d)).toBe(1));
		await c.query('COMMIT');
		expect(await claiming).toEqual({ room: '!n:hs', botOnly: true, won: false });
		const q = await s.d.pool.query<{ route_sealed: Buffer }>(
			`SELECT route_sealed FROM offline_notify_leave`
		);
		expect(q.rows.map((r) => vault.open(r.route_sealed, ROOM_ACCOUNT, 'matrix', 'route'))).toEqual([
			'!mine:hs'
		]);
	}, 30_000);

	it('moving the rooms of v1.21.18 never overwrites a room claimed at the same moment', async () => {
		const s = await setup();
		const vault = s.store.vault;
		const mac = (s.store as unknown as { roomMac(a: string): Buffer }).roomMac(X);
		// A row as v1.21.18 left it: her address, its room O on the row.
		const mk = async () => {
			const r = await fetch(`${s.hs.url}/_matrix/client/v3/createRoom`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${s.hs.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ preset: 'trusted_private_chat', is_direct: true, invite: [X] })
			});
			return ((await r.json()) as { room_id: string }).room_id;
		};
		const [o, n] = [await mk(), await mk()];
		await s.d.pool.query(
			`INSERT INTO offline_notify_channels (account, channel, address_sealed, route_sealed, verified_at)
			 VALUES ('old', 'matrix', $1, $2, now())`,
			[vault.seal(X, 'old', 'matrix', 'address'), vault.seal(o, 'old', 'matrix', 'route')]
		);
		// Another process claims room N for her address, under the Matrix lock
		// (as the store's claim does), and has not committed yet…
		const c = await other(s.d);
		await c.query('BEGIN');
		await c.query(MATRIX_LOCK_SQL);
		await c.query(
			`INSERT INTO offline_notify_matrix_rooms (address_mac, room_sealed, bot_only_invites) VALUES ($1, $2, TRUE)`,
			[mac, vault.seal(n, ROOM_ACCOUNT, 'matrix', 'route')]
		);
		// …when this relay moves the old rooms.
		const moving = s.store.moveOldRooms();
		await vi.waitFor(async () => expect(await waiting(s.d)).toBe(1));
		await c.query('COMMIT');
		await moving;
		expect((await s.book.get(X))?.room).toBe(n);
		const q = await s.d.pool.query<{ route_sealed: Buffer }>(
			`SELECT route_sealed FROM offline_notify_leave`
		);
		expect(q.rows.map((r) => vault.open(r.route_sealed, ROOM_ACCOUNT, 'matrix', 'route'))).toEqual([
			o
		]);
	}, 30_000);
});
