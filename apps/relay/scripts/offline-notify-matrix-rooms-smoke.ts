#!/usr/bin/env tsx
/**
 * offline-notify-matrix-rooms-smoke — the Matrix bot's ONE room per address,
 * kept in the relay's database (offline_notify_matrix_rooms, schema v71), on a
 * real Postgres (TEST_DATABASE_URL; skipped when unset) with the indexer's
 * schema.sql tables, the real store, the real Matrix client and the real leave
 * queue, against a stand-in homeserver that answers as Synapse does
 * (test/notifyFakes.ts fakeHomeserver).
 *
 *   A–C. The leave round racing a code to the same address — asked again
 *        before confirming, superseded by a newer code, given up and asked
 *        again: once her request is saved, the room stays.
 *   C2. Given up and NOT asked again: the room is left and its mapping goes;
 *        asked again only after that: a new room, nothing stranded.
 *   D. Another account typing her address and never confirming does not take
 *      her room. E. The operator's test address keeps its room.
 *   F. Leaving needs the bot's account to be fine: an error about the account
 *      is not a leave (tried again later). F2. A leave given up after its last
 *      try keeps nothing that names the room with her address.
 *   H. Removing every holder, and turning Matrix off: every room the bot has
 *      is left, the mapping and the queue end empty — by construction, no
 *      room is ever held by nothing (review 19b, finding 1).
 *   G. Upgrade from v1.21.18: rooms kept on each row move into the mapping —
 *      one per address, the newest — the rest are left; the rows keep none.
 */

import pg from 'pg';
import { leaveRoom, sendMatrix } from '../src/notify/channels/matrix.ts';
import { drainLeaves, LEAVE_TRIES } from '../src/notify/leaves.ts';
import { CODE_TTL_MS, TEST_ACCOUNT } from '../src/notify/store.ts';
import { openVault } from '../src/notify/vault.ts';
import { DB_TESTS, notifyDb, schemaFrom, schemaSection } from '../test/notifyDb.ts';
import { fakeHomeserver } from '../test/notifyFakes.ts';

if (!DB_TESTS) {
	console.log('offline-notify-matrix-rooms-smoke: skipped — TEST_DATABASE_URL is not set');
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

const d = await notifyDb();
const store = await d.open();
const hs = await fakeHomeserver({ bot: '@bot:hs.example' });
const mx = { homeserver: hs.url, accessToken: hs.token, userId: hs.bot };
const pol = { torSocks: '', hiddenOnly: false };
const now = new Date();
const book = store.matrixRoomBook();
const queued = () => d.count(`SELECT count(*)::int AS n FROM offline_notify_leave`);
const drain = () => drainLeaves(store, mx, pol, new Date());
const send = (who: string, text: string) => sendMatrix(mx, pol, who, text, book);
/** The bot is in the room and the mapping has it as `who`'s room. */
const kept = async (room: string, who: string): Promise<boolean> =>
	hs.rooms.get(room)?.members.get(hs.bot) === 'join' && (await book.get(who))?.room === room;
const gone = (room: string): boolean =>
	hs.rooms.get(room)?.members.get(hs.bot) === 'leave' && hs.rooms.get(room)!.forgotten.has(hs.bot);
const state = async (room: string, who: string) =>
	JSON.stringify({
		bot: hs.rooms.get(room)?.members.get(hs.bot),
		mapped: (await book.get(who))?.room ?? null,
		made: hs.made(),
		queued: await queued()
	});
const begin = async (acct: string, who: string, code: string) => {
	const b = await store.beginAddress(acct, 'matrix', who, 'en', code, 'clearnet', now);
	if (!b.ok) throw new Error('begin');
	return b;
};

try {
	console.log('\n── offline-notify-matrix-rooms-smoke ──');
	// ── A. "send me a code" again before confirming ───────────────────────
	{
		const who = '@resend:hs.org';
		await begin('resend', who, '111111');
		const r1 = await send(who, 'code 111111');
		await begin('resend', who, '222222');
		const [r2] = await Promise.all([send(who, 'code 222222'), drain()]);
		await drain();
		await store.verifyCode('resend', 'matrix', '222222', now);
		check(
			'A. a code asked again before confirming, the leave round during the send: one room, kept',
			r2 === r1 && (await kept(r1, who)) && (await queued()) === 0 && hs.made() === 1,
			await state(r1, who)
		);
	}
	// ── B. a code superseded by a newer one ───────────────────────────────
	{
		const who = '@super:hs.org';
		const made = hs.made();
		await begin('super', who, '111111');
		const first = send(who, 'code 111111');
		await begin('super', who, '222222');
		const r1 = await first;
		const [r2] = await Promise.all([send(who, 'code 222222'), drain()]);
		await store.verifyCode('super', 'matrix', '222222', now);
		await drain();
		check(
			'B. a code superseded by a newer one, the leave round during the newer send: one room, kept',
			r2 === r1 && hs.made() === made + 1 && (await kept(r1, who)) && (await queued()) === 0,
			await state(r1, who)
		);
	}
	// ── C. given up, asked again ──────────────────────────────────────────
	{
		const who = '@late:hs.org';
		const made = hs.made();
		const b1 = await begin('late', who, '111111');
		const r1 = await send(who, 'code 111111');
		// Past its budget: her waiting row goes (api.ts): the room is queued.
		await store.restoreOrDrop('late', 'matrix', b1.codeMac);
		const q = await queued();
		// She asks again (saved), the leave round during that send.
		await begin('late', who, '222222');
		const [r2] = await Promise.all([send(who, 'code 222222'), drain()]);
		await drain();
		await store.verifyCode('late', 'matrix', '222222', now);
		check(
			'C. a code given up, then asked again (saved before the leave round): one room, kept',
			q === 1 &&
				r2 === r1 &&
				hs.made() === made + 1 &&
				(await kept(r1, who)) &&
				(await queued()) === 0,
			`${q} ${await state(r1, who)}`
		);
	}
	{
		const who = '@late2:hs.org';
		const b1 = await begin('late2', who, '111111');
		const r1 = await send(who, 'code 111111');
		await store.restoreOrDrop('late2', 'matrix', b1.codeMac);
		await drain();
		const leftFirst = gone(r1) && (await book.get(who)) === null && (await queued()) === 0;
		// Asked again only after the bot left: a new room, and it is hers.
		await begin('late2', who, '222222');
		const r2 = await send(who, 'code 222222');
		check(
			'C2. given up and not asked again: left, its mapping gone; asked again later: a new room, kept',
			leftFirst && r2 !== r1 && (await kept(r2, who)) && (await queued()) === 0,
			await state(r2, who)
		);
		await store.verifyCode('late2', 'matrix', '222222', now);
	}
	// ── D. another account types her address and never confirms ───────────
	{
		const who = '@owner:hs.org';
		await begin('owner-acct', who, '111111');
		const room = await send(who, 'code 111111');
		await store.verifyCode('owner-acct', 'matrix', '111111', now);
		await begin('typo-acct', who, '333333');
		const r2 = await send(who, 'code 333333');
		await store.purge(new Date(now.getTime() + CODE_TTL_MS + 60_000));
		await drain();
		check(
			'D. another account typing her address and never confirming does not take her room',
			r2 === room && (await kept(room, who)) && (await queued()) === 0,
			await state(room, who)
		);
	}
	// ── E. the operator's test address ────────────────────────────────────
	{
		const who = '@site-operator:hs.org';
		await store.holdTestAddress(who, now);
		const room = await send(who, 'test');
		await begin('other-acct', who, '444444');
		await send(who, 'code 444444');
		const o = await d.pool.query(
			`SELECT code_mac FROM offline_notify_channels WHERE account = 'other-acct'`
		);
		await store.restoreOrDrop('other-acct', 'matrix', o.rows[0].code_mac);
		await drain();
		await store.holdTestAddress(who, now);
		const next = await send(who, 'test 2');
		check(
			'E. the test address keeps its room: the next test note comes there, whatever users do',
			next === room && (await kept(room, who)) && (await queued()) === 0,
			await state(room, who)
		);
	}
	// ── F. an error about the bot's account is not a leave ────────────────
	{
		const who = '@going:hs.org';
		const b = await begin('going', who, '555555');
		const room = await send(who, 'code 555555');
		await store.restoreOrDrop('going', 'matrix', b.codeMac);
		hs.trouble({ status: 403, errcode: 'M_FORBIDDEN' });
		const r = await drain();
		const after = await d.pool.query<{ tries: number }>(`SELECT tries FROM offline_notify_leave`);
		hs.trouble(null);
		const stillMapped = (await book.get(who))?.room === room;
		await d.pool.query(`UPDATE offline_notify_leave SET next_at = '-infinity'`);
		const r2 = await drain();
		check(
			'F. a suspended bot (M_FORBIDDEN to everything): nothing counted as left, tried again, then left',
			r.left === 0 &&
				after.rows.length === 1 &&
				after.rows[0]!.tries === 1 &&
				stillMapped &&
				r2.left === 1 &&
				gone(room) &&
				(await book.get(who)) === null,
			JSON.stringify({ r, after: after.rows, r2 })
		);
	}
	// ── F2. a leave given up after its last try ───────────────────────────
	{
		const who = '@unreachable:hs.org';
		const b = await begin('unreachable', who, '565656');
		const room = await send(who, 'code 565656');
		await store.restoreOrDrop('unreachable', 'matrix', b.codeMac);
		await d.pool.query(`UPDATE offline_notify_leave SET tries = $1 - 1`, [LEAVE_TRIES]);
		hs.trouble({ status: 502, errcode: '' });
		const r = await drain();
		hs.trouble(null);
		const rows = await d.count(`SELECT count(*)::int AS n FROM offline_notify_matrix_rooms
			WHERE released_at IS NOT NULL`);
		check(
			'F2. a leave given up after its last try: off the queue, and nothing here keeps that room with her address',
			r.left === 0 && (await queued()) === 0 && rows === 0 && (await book.get(who)) === null,
			JSON.stringify({ r, rows, bot: hs.rooms.get(room)?.members.get(hs.bot) })
		);
		// The bot is still in it on the homeserver (as the operator docs say): left here by hand.
		await leaveRoom(mx, pol, room);
	}
	// ── H. every holder gone, then Matrix turned off ──────────────────────
	{
		await store.remove('resend', 'matrix');
		await store.remove('super', 'all');
		await drain();
		const afterRemoves = await queued();
		await store.purgeChannel('matrix');
		for (let i = 0; i < 5 && (await queued()) > 0; i++) await drain();
		const bot = [...hs.rooms.values()].filter((r) => r.members.get(hs.bot) === 'join');
		const counts = await store.matrixRoomCount();
		const testRow = await d.count(
			`SELECT count(*)::int AS n FROM offline_notify_channels WHERE account = $1`,
			[TEST_ACCOUNT]
		);
		check(
			'H. every room the bot had is left once nothing holds its address (removed, then Matrix off): nothing stranded',
			afterRemoves === 0 &&
				bot.length === 0 &&
				counts.rooms === 0 &&
				(await queued()) === 0 &&
				testRow === 0,
			JSON.stringify({ stillIn: bot.map((r) => r.id), counts })
		);
	}
	// ── G. upgrade from v1.21.18 ──────────────────────────────────────────
	{
		// A database as v1.21.18 left it: v69 and v70, no v71.
		const old = await notifyDb({ sql: `${schemaSection(69)}\n${schemaSection(70)}` });
		// Its key (what sealed the rows), as v1.21.18 made it and recorded it.
		const s2 = openVault(old.dataDir);
		await old.pool.query(`INSERT INTO offline_notify_key (id, key_check) VALUES (1, $1)`, [
			s2.vault.mac('key-check')
		]);
		const mk = async (who: string) => {
			const r = await fetch(`${hs.url}/_matrix/client/v3/createRoom`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${hs.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ preset: 'trusted_private_chat', is_direct: true, invite: [who] })
			});
			return ((await r.json()) as { room_id: string }).room_id;
		};
		const X = '@twice:hs.org';
		const [older, newer, aside] = [await mk(X), await mk(X), await mk('@aside:hs.org')];
		// Sealed as v1.21.18 did (bound to the account).
		const seal = (v: string, acct: string, kind: 'address' | 'route') =>
			s2.vault.seal(v, acct, 'matrix', kind);
		await old.pool.query(
			`INSERT INTO offline_notify_channels (account, channel, address_sealed, route_sealed, verified_at, created_at)
			 VALUES ('alice', 'matrix', $1, $2, '2026-09-01', '2026-09-01'),
			        ('bob', 'matrix', $3, $4, '2026-10-01', '2026-10-01')`,
			[
				seal(X, 'alice', 'address'),
				seal(older, 'alice', 'route'),
				seal(X, 'bob', 'address'),
				seal(newer, 'bob', 'route')
			]
		);
		// A change on the way: the address kept aside has its room.
		await old.pool.query(
			`INSERT INTO offline_notify_channels (account, channel, address_sealed, verified_at, prev_address_sealed, prev_route_sealed, prev_verified_at)
			 VALUES ('carol', 'matrix', $1, NULL, $2, $3, '2026-10-02')`,
			[
				seal('@new-carol:hs.org', 'carol', 'address'),
				seal('@aside:hs.org', 'carol', 'address'),
				seal(aside, 'carol', 'route')
			]
		);
		// A queue entry v1.21.18 left for a room that is now kept.
		await old.pool.query(
			`INSERT INTO offline_notify_leave (route_sealed, account) VALUES ($1, 'bob')`,
			[seal(newer, 'bob', 'route')]
		);
		// Before the indexer's v71 migration has run the store does not open
		// (42P01): the relay tries again by itself until it has
		// (src/notify/opening.ts, test/offlineNotifyOpening.test.ts).
		const tooEarly = await old.open().then(
			() => 'opened',
			(e: unknown) => (e as { code?: string }).code ?? String(e)
		);
		await old.admin.query(schemaFrom(71)); // the indexer's v71 migration (its SQL)
		const upgraded = await old.open(); // the relay opens the store after the upgrade
		const b2 = upgraded.matrixRoomBook();
		const routes = await old.count(
			`SELECT count(*)::int AS n FROM offline_notify_channels WHERE route_sealed IS NOT NULL OR prev_route_sealed IS NOT NULL`
		);
		const q = await old.count(`SELECT count(*)::int AS n FROM offline_notify_leave`);
		const xRoom = (await b2.get(X))?.room;
		const asideRoom = (await b2.get('@aside:hs.org'))?.room;
		await drainLeaves(upgraded, mx, pol, new Date());
		const again = await upgraded.moveOldRooms();
		check(
			'G. upgrade: one room per address (the newest), the other queued and left, the rows keep none, done once',
			tooEarly === '42P01' &&
				xRoom === newer &&
				asideRoom === aside &&
				routes === 0 &&
				q === 1 &&
				gone(older) &&
				hs.rooms.get(newer)!.members.get(hs.bot) === 'join' &&
				again.moved === 0 &&
				again.queued === 0 &&
				(await b2.get(X))?.botOnly === false,
			JSON.stringify({ tooEarly, xRoom, newer, older, asideRoom, routes, q, again })
		);
		await old.close();
	}
} catch (err) {
	check('ran to the end', false, String((err as Error)?.stack ?? err));
} finally {
	await d.close();
	await hs.close();
}

void pg;
console.log(
	failures === 0
		? `\n✓ all ${n} offline-notify matrix-rooms checks passed`
		: `\n✗ ${failures} of ${n} offline-notify matrix-rooms checks failed`
);
process.exit(failures === 0 ? 0 : 1);
