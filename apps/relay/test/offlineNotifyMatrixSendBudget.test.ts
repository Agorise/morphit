/**
 * `send matrix` (the operator's test note), run for real as morphit-ops runs
 * it, on a real database (TEST_DATABASE_URL; skipped without it: the tool
 * opens no room it could keep nowhere), against a slow homeserver (an .onion
 * one over Tor, or a loaded one): the tool must be done before morphit-ops
 * stops it (ADMIN_TIMEOUT_MS 180 s) — with the note sent and the bot still in
 * the chat, or, on a homeserver too slow for that, with "slow" (morphit-ops
 * words it plainly).
 *
 * The first case runs at 1/15 scale (MORPHIT_NOTIFY_SEND_BUDGET_MS can only
 * shorten the 150 s budget; the homeserver slowed in proportion). The second
 * uses the REAL limits — no budget given, each request its real 30 s — so it
 * catches a request that times out being called anything but "slow".
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import { afterEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_CALL_MS,
	TEST_NOTE_BUDGET_MS,
	testNoteBudgetMs
} from '../src/notify/channels/matrix.ts';
import { DB_TESTS, notifyDb, type NotifyDb } from './notifyDb.ts';

const RELAY = join(import.meta.dirname, '..');
const TSX = join(RELAY, '..', '..', 'node_modules', '.bin', 'tsx');
const SCALE = 15;
/** The send budget, shortened: 150 s / 15. */
const BUDGET_MS = 10_000;
/** morphit-ops's limit for this tool (apps/ops-cli offlineNotify.ts ADMIN_TIMEOUT_MS). */
const OPS_LIMIT_MS = 180_000;

const dbs: NotifyDb[] = [];
afterEach(async () => {
	for (const d of dbs.splice(0)) await d.close();
});

/** `slowMs(path)`: how long the homeserver takes to answer; null: never. */
async function runTestNote(slowMs: (path: string) => number | null, budget?: number) {
	const d = await notifyDb();
	dbs.push(d);
	const seen: Array<[string, number]> = [];
	const t0 = Date.now();
	const conns = new Set<net.Socket>();
	const hs = http.createServer((req, res) => {
		const path = req.url ?? '';
		seen.push([path.replace(/^.*\//, ''), Date.now() - t0]);
		req.resume();
		req.on('end', () => {
			const after = slowMs(path);
			if (after === null) return;
			setTimeout(() => {
				let body: unknown = {};
				if (path.endsWith('/createRoom')) body = { room_id: '!t:hs' };
				else if (path.includes('/send/')) body = { event_id: '$e' };
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(body));
			}, after);
		});
	});
	hs.on('connection', (c) => conns.add(c));
	await new Promise<void>((r) => hs.listen(0, '127.0.0.1', () => r()));
	const port = (hs.address() as net.AddressInfo).port;
	const keyFile = join(d.dataDir, 'active.key');
	writeFileSync(keyFile, PrivateKey.fromSeed('send-budget').toString(), { mode: 0o600 });
	const child = spawn(TSX, [join(RELAY, 'src/notify/adminCli.ts'), 'send', 'matrix'], {
		detached: true,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			MORPHIT_RELAY_ACCOUNT: 'site-relay',
			MORPHIT_RELAY_ACTIVE_KEY_FILE: keyFile,
			MORPHIT_RELAY_DATABASE_URL: d.url,
			MORPHIT_RELAY_DATA_DIR: d.dataDir,
			MORPHIT_INSTANCE_ORIGIN: 'https://site.example',
			...(budget !== undefined ? { MORPHIT_NOTIFY_SEND_BUDGET_MS: String(budget) } : {})
		}
	});
	child.stdin.end(
		`${JSON.stringify({
			MORPHIT_NOTIFY_MATRIX_HOMESERVER: `http://127.0.0.1:${port}`,
			MORPHIT_NOTIFY_MATRIX_TOKEN: 'tok',
			MORPHIT_NOTIFY_MATRIX_USER_ID: '@notices:hs',
			to: '@operator:hs.org'
		})}\n`
	);
	let out = '';
	child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
	// As morphit-ops does: past its limit the tool is stopped.
	const stop = setTimeout(() => process.kill(-child.pid!, 'SIGKILL'), OPS_LIMIT_MS);
	const code = await new Promise<number | null>((r) => child.on('close', (c) => r(c)));
	clearTimeout(stop);
	const took = Date.now() - t0;
	for (const c of conns) c.destroy();
	hs.close();
	const last = out.trim().split('\n').at(-1) ?? '';
	const rooms = await d.count(`SELECT count(*)::int AS n FROM offline_notify_matrix_rooms`);
	return { code, took, last, seen, rooms };
}

describe.skipIf(!DB_TESTS)('the operator’s Matrix test note on a slow homeserver', () => {
	it('slow (1/15 scale): the note is sent, the bot keeps the chat, before morphit-ops gives up', async () => {
		const r = await runTestNote(
			(path) => (path.endsWith('/createRoom') || path.includes('/send/') ? 29_000 : 14_500) / SCALE,
			BUDGET_MS
		);
		expect(r.code, `exit ${r.code}, ${r.last}, saw ${JSON.stringify(r.seen)}`).toBe(0);
		expect(r.took).toBeLessThan(2 * BUDGET_MS);
		expect(JSON.parse(r.last)).toEqual({ ok: true });
		expect(r.seen.some(([p]) => p === 'leave' || p === 'forget')).toBe(false);
		// The room is kept for that address in the relay's database.
		expect(r.rooms).toBe(1);
	}, 60_000);

	it(
		'stopped answering, REAL limits: "slow" after the first request’s 30 s, long before morphit-ops gives up',
		async () => {
			const r = await runTestNote(() => null);
			expect(r.code, `exit ${r.code}, ${r.last}, saw ${JSON.stringify(r.seen)}`).toBe(1);
			expect(JSON.parse(r.last)).toEqual({ ok: false, error: 'slow' });
			expect(r.took).toBeGreaterThanOrEqual(DEFAULT_CALL_MS);
			expect(r.took).toBeLessThan(OPS_LIMIT_MS - 20_000);
			expect(r.rooms).toBe(0);
		},
		OPS_LIMIT_MS + 10_000
	);
});

it('the budget can only be shortened, never lengthened, and not below 1 s', () => {
	expect(testNoteBudgetMs({})).toBe(TEST_NOTE_BUDGET_MS);
	expect(TEST_NOTE_BUDGET_MS).toBe(150_000);
	expect(testNoteBudgetMs({ MORPHIT_NOTIFY_SEND_BUDGET_MS: '10000' })).toBe(10_000);
	for (const v of ['999999', '150000', '999', '0', '-5', 'x', ''])
		expect(testNoteBudgetMs({ MORPHIT_NOTIFY_SEND_BUDGET_MS: v }), v).toBe(TEST_NOTE_BUDGET_MS);
});
