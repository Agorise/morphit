/**
 * offline-notify-store-smoke — the relay's notice store against a real
 * Postgres (TEST_DATABASE_URL; skipped when unset), the indexer's schema.sql
 * v69 tables in a private schema. The rules that keep what is kept short and
 * the limits honest:
 *
 *   - a notice link opens for seven days, then never again;
 *   - the daily clean-up drops yesterday's code counts, expired links, and
 *     waiting messages older than a day — and keeps today's;
 *   - Telegram codes share the daily code limit; a Telegram code that ran out
 *     links nothing;
 *   - "read everything from this person" (thread '*') counts as reading the
 *     thread, for both "has she read it" and "was she already told";
 *   - turning a channel off leaves no waiting messages or links behind for
 *     accounts that have nothing left, and touches no one else's.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { Database } from '../src/db/pool.ts';
import {
	CODE_TTL_MS,
	CODES_PER_ACCOUNT_PER_DAY,
	LINK_TTL_MS,
	openSealedStore
} from '../src/notify/store.ts';

let n = 0;
let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
	n++;
	if (!ok) failures++;
	console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
};

const url = process.env.TEST_DATABASE_URL;
if (!url) {
	console.log('offline-notify-store-smoke: skipped — TEST_DATABASE_URL is not set');
	process.exit(0);
}

const schemaSql = readFileSync(
	join(import.meta.dirname, '../../indexer/src/db/schema.sql'),
	'utf8'
);
const v69 = schemaSql.slice(schemaSql.indexOf('-- ─── v69:'));
if (!v69.startsWith('-- ─── v69:')) throw new Error('schema.sql has no v69 section');
const SCHEMA = `offline_notify_store_${process.pid}`;
const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(
	`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path = ${SCHEMA}`
);
await admin.query(v69);
await admin.query(
	`CREATE TABLE chat_messages (sender TEXT NOT NULL, recipient TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`
);
await admin.query(`CREATE TABLE chat_read_state (reader_account TEXT NOT NULL, peer_account TEXT NOT NULL,
	order_permlink TEXT NOT NULL DEFAULT '', last_read_at TIMESTAMPTZ NOT NULL)`);
const pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${SCHEMA}` });
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
const count = async (sql: string, params: unknown[] = []): Promise<number> =>
	Number((await pool.query(sql, params)).rows[0].n);
const keyDir = mkdtempSync(join(tmpdir(), 'notify-store-'));

try {
	const { store } = await openSealedStore(db, keyDir);
	const t0 = new Date('2026-10-15T12:00:00Z');
	const at = (ms: number): Date => new Date(t0.getTime() + ms);
	const DAY = 24 * 60 * 60_000;

	// ── Links: seven days, for her only ──────────────────────────────────
	{
		const token = await store.createLink('grandma', 'trader-joe', 'thread-1', t0);
		const justBefore = await store.resolveLink('grandma', token, at(LINK_TTL_MS - 1000));
		const after = await store.resolveLink('grandma', token, at(LINK_TTL_MS + 1000));
		const someoneElse = await store.resolveLink('mallory', token, at(1000));
		check(
			'a notice link opens for seven days, then never again (and never for anyone else)',
			LINK_TTL_MS === 7 * DAY &&
				justBefore?.peer === 'trader-joe' &&
				justBefore.orderPermlink === 'thread-1' &&
				after === null &&
				someoneElse === null,
			`${JSON.stringify(justBefore)} ${JSON.stringify(after)} ${JSON.stringify(someoneElse)}`
		);
	}

	// ── The daily clean-up ───────────────────────────────────────────────
	{
		await pool.query(`DELETE FROM offline_notify_links`);
		const old = await store.createLink('grandma', 'p1', '', at(-8 * DAY));
		const fresh = await store.createLink('grandma', 'p2', '', at(-1 * DAY));
		await pool.query(
			`INSERT INTO offline_notify_code_log (account, sent_on) VALUES ('a', $1::date), ('a', $2::date)`,
			[at(-DAY), t0]
		);
		await pool.query(
			`INSERT INTO offline_notify_address_log (address_mac, sent_on, sent)
			 VALUES ('\\x01'::bytea, $1::date, 1), ('\\x02'::bytea, $2::date, 1)`,
			[at(-DAY), t0]
		);
		await pool.query(
			`INSERT INTO offline_notify_pending (account, sender, order_permlink, event_at, due_at)
			 VALUES ('grandma', 'stale', '', $1, $1), ('grandma', 'recent', '', $2, $2)`,
			[at(-DAY - 60_000), at(-DAY + 60_000)]
		);
		await store.purge(t0);
		const codeDays = (await pool.query(`SELECT sent_on FROM offline_notify_code_log`)).rows.length;
		const addrDays = (await pool.query(`SELECT sent_on FROM offline_notify_address_log`)).rows
			.length;
		const pending = (await pool.query(`SELECT sender FROM offline_notify_pending`)).rows.map(
			(r) => r.sender as string
		);
		check(
			"the daily clean-up drops yesterday's code counts, expired links and day-old waiting messages — and keeps today's",
			codeDays === 1 &&
				addrDays === 1 &&
				(await store.resolveLink('grandma', old, t0)) === null &&
				(await count(`SELECT count(*) AS n FROM offline_notify_links`)) === 1 &&
				(await store.resolveLink('grandma', fresh, t0))?.peer === 'p2' &&
				JSON.stringify(pending) === JSON.stringify(['recent']),
			`code days ${codeDays}, address days ${addrDays}, pending ${pending.join(',')}`
		);
		await pool.query(`DELETE FROM offline_notify_pending; DELETE FROM offline_notify_links;
			DELETE FROM offline_notify_code_log; DELETE FROM offline_notify_address_log`);
	}

	// ── Telegram codes ───────────────────────────────────────────────────
	{
		// Two address codes today, then Telegram codes: they share the limit.
		await pool.query(
			`INSERT INTO offline_notify_code_log (account, sent_on) VALUES ('tilly', $1::date), ('tilly', $1::date)`,
			[t0]
		);
		const codes: Array<string | null> = [];
		for (let i = 0; i < CODES_PER_ACCOUNT_PER_DAY; i++)
			codes.push(await store.beginTelegram('tilly', 'en', 'tor', t0));
		const given = codes.filter((c) => c !== null).length;
		check(
			'Telegram codes count against the same daily code limit as the others',
			given === CODES_PER_ACCOUNT_PER_DAY - 2 && codes.at(-1) === null,
			`${given} given`
		);
		const last = codes.filter((c): c is string => c !== null).at(-1)!;
		// Sent after the code ran out: links nothing.
		const late = await store.linkTelegram(
			last,
			'424242',
			at(CODE_TTL_MS + 1000),
			at(CODE_TTL_MS + 2000)
		);
		const status = await store.status('tilly');
		check(
			'a Telegram code that ran out links nothing',
			late === null &&
				JSON.stringify(status.channels) ===
					JSON.stringify([{ channel: 'telegram', state: 'pending' }]),
			`${JSON.stringify(late)} ${JSON.stringify(status)}`
		);
		// The same code in time does link.
		const inTime = await store.linkTelegram(last, '424242', at(60_000), at(61_000));
		check('…and in time it does', inTime?.account === 'tilly');
	}

	// ── "Read everything from this person" ────────────────────────────────
	{
		const msgAt = at(-30 * 60_000);
		await store.createLink('grandma', 'bob', 'deal-7', at(-20 * 60_000));
		const toldBefore = await store.alreadyNoticed('grandma', 'bob', 'deal-7');
		const readBefore = await store.readSince('grandma', 'bob', 'deal-7', msgAt);
		await pool.query(
			`INSERT INTO chat_read_state (reader_account, peer_account, order_permlink, last_read_at)
			 VALUES ('grandma', 'bob', '*', $1)`,
			[at(-10 * 60_000)]
		);
		const toldAfter = await store.alreadyNoticed('grandma', 'bob', 'deal-7');
		const readAfter = await store.readSince('grandma', 'bob', 'deal-7', msgAt);
		check(
			'"read everything from this person" counts as reading each thread with them',
			toldBefore && !readBefore && !toldAfter && readAfter,
			`told ${toldBefore}→${toldAfter}, read ${readBefore}→${readAfter}`
		);
	}

	// ── Turning a channel off ────────────────────────────────────────────
	{
		const seal = (a: string, ch: string): Buffer => store.vault.seal(a, a, ch, 'address');
		await pool.query(
			`INSERT INTO offline_notify_channels (account, channel, address_sealed, verified_at, locale)
			 VALUES ('onlyxmpp', 'xmpp', $1, now(), 'en'),
			        ('both', 'xmpp', $2, now(), 'en'),
			        ('both', 'email', $3, now(), 'en')`,
			[seal('onlyxmpp', 'xmpp'), seal('both', 'xmpp'), seal('both', 'email')]
		);
		for (const a of ['onlyxmpp', 'both']) {
			await pool.query(
				`INSERT INTO offline_notify_pending (account, sender, order_permlink, event_at, due_at)
				 VALUES ($1, 'x', '', now(), now())`,
				[a]
			);
			await store.createLink(a, 'x', '', new Date());
		}
		const r = await store.purgeChannel('xmpp');
		const left = async (table: string, a: string): Promise<number> =>
			count(`SELECT count(*) AS n FROM ${table} WHERE account = $1`, [a]);
		check(
			"turning a channel off leaves nothing waiting for accounts left with no address — and keeps others'",
			r.removed === 2 &&
				(await left('offline_notify_pending', 'onlyxmpp')) === 0 &&
				(await left('offline_notify_links', 'onlyxmpp')) === 0 &&
				(await left('offline_notify_pending', 'both')) === 1 &&
				(await left('offline_notify_links', 'both')) === 1 &&
				(await left('offline_notify_channels', 'both')) === 1,
			JSON.stringify(r)
		);
	}

	// ── A failed send gives back only for ITS code ───────────────────────
	{
		const first = await store.beginAddress(
			'una',
			'email',
			'una1@example.net',
			'en',
			'111111',
			'clearnet',
			t0
		);
		const second = await store.beginAddress(
			'una',
			'email',
			'una2@example.net',
			'en',
			'222222',
			'clearnet',
			t0
		);
		if (!first.ok || !second.ok) throw new Error('codes refused');
		// The first send fails late: the newer code must survive it.
		await store.restoreOrDrop('una', 'email', first.codeMac);
		const r = await store.verifyCode('una', 'email', '222222', at(60_000));
		check('a late failure of an older code leaves the newer one waiting', r === 'verified', r);
	}

	// ── The silent path still counts ─────────────────────────────────────
	{
		const target = 'popular@example.net';
		for (let i = 0; i < 5; i++)
			await store.beginAddress(`fan${i}`, 'email', target, 'en', '333333', 'clearnet', t0);
		const answers: string[] = [];
		for (let i = 0; i < 4; i++) {
			const b = await store.beginAddress('vic', 'email', target, 'en', '444444', 'clearnet', t0);
			answers.push(b.ok ? (b.send ? 'send' : 'silent') : 'refused');
		}
		const logged = await count(
			`SELECT count(*) AS n FROM offline_notify_code_log WHERE account = 'vic'`
		);
		check(
			'codes not sent (the address had its five) still count against her own limits',
			JSON.stringify(answers) === JSON.stringify(['silent', 'silent', 'silent', 'refused']) &&
				logged === 3,
			`${answers.join(',')} logged ${logged}`
		);
	}

	// ── Telegram: a re-link forgets the chat she had ─────────────────────
	{
		const c1 = await store.beginTelegram('tom', 'en', 'clearnet', t0);
		await store.linkTelegram(c1!, '1001', at(1000), at(2000));
		const c2 = await store.beginTelegram('tom', 'en', 'clearnet', at(3000));
		await store.linkTelegram(c2!, '1002', at(4000), at(5000));
		const row = (
			await pool.query(
				`SELECT prev_address_sealed, prev_route_sealed, prev_verified_at, prev_link_net
				   FROM offline_notify_channels WHERE account = 'tom' AND channel = 'telegram'`
			)
		).rows[0];
		const chats = (await store.verifiedChannels('tom')).channels.map((c) => c.address);
		check(
			'a Telegram re-link keeps nothing of the chat she had',
			row.prev_address_sealed === null &&
				row.prev_verified_at === null &&
				row.prev_link_net === null &&
				JSON.stringify(chats) === JSON.stringify(['1002']),
			JSON.stringify({ chats, prev: row.prev_verified_at })
		);
	}

	// ── The same room saved again is still her room ──────────────────────
	{
		await pool.query(`DELETE FROM offline_notify_leave`);
		const sealedAddr = store.vault.seal('@vera:hs.org', 'vera', 'matrix', 'address');
		await pool.query(
			`INSERT INTO offline_notify_channels (account, channel, address_sealed, route_sealed, verified_at, locale)
			 VALUES ('vera', 'matrix', $1, $2, now(), 'en')`,
			[sealedAddr, store.vault.seal('!vera:hs', 'vera', 'matrix', 'route')]
		);
		const kept = await store.setRoute('vera', 'matrix', '!vera:hs', {
			addressSealed: sealedAddr,
			prev: false
		});
		const queued = await count(`SELECT count(*) AS n FROM offline_notify_leave`);
		check(
			'her room saved again (sealed anew) is not queued to be left',
			kept && queued === 0 && (await store.roomHeld('vera', '!vera:hs')),
			`kept ${kept} queued ${queued}`
		);
	}

	// ── A notice's room goes only to the row that still holds its address ─
	{
		await pool.query(`DELETE FROM offline_notify_leave`);
		const oldSealed = store.vault.seal('@wes-old:hs.org', 'wes', 'matrix', 'address');
		const newSealed = store.vault.seal('@wes-new:hs.org', 'wes', 'matrix', 'address');
		// The worker read @wes-old; meanwhile she confirmed @wes-new.
		await pool.query(
			`INSERT INTO offline_notify_channels (account, channel, address_sealed, verified_at, locale)
			 VALUES ('wes', 'matrix', $1, now(), 'en')`,
			[newSealed]
		);
		const keptForOld = await store.setRoute('wes', 'matrix', '!for-old:hs', {
			addressSealed: oldSealed,
			prev: false
		});
		// During a change, a room for the address she had goes to that one.
		await pool.query(
			`UPDATE offline_notify_channels SET prev_address_sealed = address_sealed, prev_verified_at = verified_at,
			        address_sealed = $1, verified_at = NULL WHERE account = 'wes'`,
			[oldSealed]
		);
		// (not for an address she no longer has kept aside)
		const keptWrongPrev = await store.setRoute('wes', 'matrix', '!wrong-prev:hs', {
			addressSealed: oldSealed,
			prev: true
		});
		const keptPrev = await store.setRoute('wes', 'matrix', '!for-prev:hs', {
			addressSealed: newSealed,
			prev: true
		});
		const ch = (await store.verifiedChannels('wes')).channels;
		check(
			"a notice's room is kept only for the row that still holds its address (the one kept aside during a change too)",
			!keptForOld &&
				!(await store.roomHeld('wes', '!for-old:hs')) &&
				(await count(`SELECT count(*) AS n FROM offline_notify_leave WHERE account = 'wes'`)) ===
					2 &&
				!keptWrongPrev &&
				keptPrev &&
				ch.length === 1 &&
				ch[0]!.prev &&
				ch[0]!.route === '!for-prev:hs',
			JSON.stringify({
				keptForOld,
				keptWrongPrev,
				keptPrev,
				queued: await count(`SELECT count(*) AS n FROM offline_notify_leave WHERE account = 'wes'`),
				ch: ch.map((c) => [c.address, c.route, c.prev])
			})
		);
	}
} catch (err) {
	check('ran to the end', false, String((err as Error)?.stack ?? err));
} finally {
	await pool.end();
	await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
	await admin.end();
	rmSync(keyDir, { recursive: true, force: true });
}
console.log(
	failures === 0
		? `\n✓ all ${n} offline-notify store checks passed`
		: `\n✗ ${failures} of ${n} offline-notify store checks failed`
);
process.exit(failures === 0 ? 0 : 1);
