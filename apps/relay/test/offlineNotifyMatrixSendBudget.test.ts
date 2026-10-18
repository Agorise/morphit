/**
 * `send matrix` (the operator's test note), run for real as morphit-ops runs
 * it, against a slow homeserver (an .onion one over Tor, or a loaded one) and
 * an operator who never joins: the tool must be done, the test chat left and
 * forgotten, before morphit-ops stops it (ADMIN_TIMEOUT_MS 180 s). This guards
 * adminCli's deadline, not only leaveTestRoom's arithmetic (v1.21.10 review).
 *
 * At 1/15 scale, so it runs in seconds, not the 2½ minutes the real numbers
 * take on every CI run: the budget (150 s) is shortened to 10 s through
 * MORPHIT_NOTIFY_SEND_BUDGET_MS (which can only shorten it), and the
 * homeserver is slowed in proportion — opening the chat and sending take 29 s
 * / 15 each, each join check, leave and forget 14.5 s / 15. morphit-ops's
 * 180 s becomes 20 s here (twice the budget: room for starting tsx on a loaded
 * CI box). Without the deadline the tool waits the full 100 s for a join.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import { expect, it } from 'vitest';
import { TEST_NOTE_BUDGET_MS, testNoteBudgetMs } from '../src/notify/channels/matrix.ts';

const RELAY = join(import.meta.dirname, '..');
const TSX = join(RELAY, '..', '..', 'node_modules', '.bin', 'tsx');
const SCALE = 15;
/** The send budget, shortened: 150 s / 15. */
const BUDGET_MS = 10_000;
/** morphit-ops's limit for this tool (apps/ops-cli offlineNotify.ts ADMIN_TIMEOUT_MS
 *  180 s), as this scale leaves room for it: twice the budget. */
const OPS_LIMIT_MS = 2 * BUDGET_MS;

it('a slow homeserver: done, the chat left and forgotten, before morphit-ops gives up', async () => {
	const seen: Array<[string, number]> = [];
	const t0 = Date.now();
	const conns = new Set<net.Socket>();
	const hs = http.createServer((req, res) => {
		const path = req.url ?? '';
		seen.push([path.replace(/^.*\//, ''), Date.now() - t0]);
		req.resume();
		const slow =
			(path.endsWith('/createRoom') || path.includes('/send/') ? 29_000 : 14_500) / SCALE;
		setTimeout(() => {
			let body: unknown = {};
			if (path.endsWith('/createRoom')) body = { room_id: '!t:hs' };
			else if (path.includes('/send/')) body = { event_id: '$e' };
			else if (path.endsWith('/joined_members')) body = { joined: { '@notices:hs': {} } };
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(body));
		}, slow);
	});
	hs.on('connection', (c) => conns.add(c));
	await new Promise<void>((r) => hs.listen(0, '127.0.0.1', () => r()));
	const port = (hs.address() as net.AddressInfo).port;
	const work = mkdtempSync(join(tmpdir(), 'send-budget-'));
	const keyFile = join(work, 'active.key');
	writeFileSync(keyFile, PrivateKey.fromSeed('send-budget').toString(), { mode: 0o600 });
	const child = spawn(TSX, [join(RELAY, 'src/notify/adminCli.ts'), 'send', 'matrix'], {
		detached: true,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			MORPHIT_RELAY_ACCOUNT: 'site-relay',
			MORPHIT_RELAY_ACTIVE_KEY_FILE: keyFile,
			MORPHIT_RELAY_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
			MORPHIT_RELAY_DATA_DIR: join(work, 'state'),
			MORPHIT_INSTANCE_ORIGIN: 'https://site.example',
			MORPHIT_NOTIFY_SEND_BUDGET_MS: String(BUDGET_MS)
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
	child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
	// As morphit-ops does: past its limit the tool is stopped.
	const stop = setTimeout(() => process.kill(-child.pid!, 'SIGKILL'), OPS_LIMIT_MS);
	const code = await new Promise<number | null>((r) => child.on('close', (c) => r(c)));
	clearTimeout(stop);
	const took = Date.now() - t0;
	for (const c of conns) c.destroy();
	hs.close();
	const last = out.trim().split('\n').at(-1) ?? '';
	expect(code, `exit ${code}, ${last}, saw ${JSON.stringify(seen)}`).toBe(0);
	expect(took).toBeLessThan(OPS_LIMIT_MS);
	expect(JSON.parse(last)).toMatchObject({ ok: true, joined: false });
	expect(seen.some(([p]) => p === 'leave')).toBe(true);
	expect(seen.some(([p]) => p === 'forget')).toBe(true);
}, 60_000);

it('the budget can only be shortened, never lengthened, and not below 1 s', () => {
	expect(testNoteBudgetMs({})).toBe(TEST_NOTE_BUDGET_MS);
	expect(TEST_NOTE_BUDGET_MS).toBe(150_000);
	expect(testNoteBudgetMs({ MORPHIT_NOTIFY_SEND_BUDGET_MS: '10000' })).toBe(10_000);
	for (const v of ['999999', '150000', '999', '0', '-5', 'x', ''])
		expect(testNoteBudgetMs({ MORPHIT_NOTIFY_SEND_BUDGET_MS: v }), v).toBe(TEST_NOTE_BUDGET_MS);
});
