/**
 * `send matrix` (the operator's test note), run for real as morphit-ops runs
 * it, against a slow homeserver (an .onion one over Tor, or a loaded one):
 * opening the chat and sending take 29 s each (inside the 30 s a request may
 * take), each join check, leave and forget 14.5 s (inside the 15 s each may
 * take), and an operator who never joins: the tool must be done, the test chat
 * left, before morphit-ops stops it at 180 s (ADMIN_TIMEOUT_MS). This guards
 * adminCli's deadline, not only leaveTestRoom's arithmetic (v1.21.10
 * review). Slow by nature: about 2½ minutes.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import { expect, it } from 'vitest';

const RELAY = join(import.meta.dirname, '..');
const TSX = join(RELAY, '..', '..', 'node_modules', '.bin', 'tsx');
/** morphit-ops's limit for this tool (apps/ops-cli offlineNotify.ts ADMIN_TIMEOUT_MS). */
const OPS_LIMIT_MS = 180_000;

it('a slow homeserver: done, the chat left and forgotten, before morphit-ops gives up', async () => {
	const seen: Array<[string, number]> = [];
	const t0 = Date.now();
	const conns = new Set<net.Socket>();
	const hs = http.createServer((req, res) => {
		const path = req.url ?? '';
		seen.push([path.replace(/^.*\//, ''), Math.round((Date.now() - t0) / 1000)]);
		req.resume();
		const slow = path.endsWith('/createRoom') || path.includes('/send/') ? 29_000 : 14_500;
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
	const work = mkdtempSync(join(tmpdir(), 'v1-send-budget-'));
	const keyFile = join(work, 'active.key');
	writeFileSync(keyFile, PrivateKey.fromSeed('v1-send-budget').toString(), { mode: 0o600 });
	const child = spawn(TSX, [join(RELAY, 'src/notify/adminCli.ts'), 'send', 'matrix'], {
		detached: true,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			MORPHIT_RELAY_ACCOUNT: 'site-relay',
			MORPHIT_RELAY_ACTIVE_KEY_FILE: keyFile,
			MORPHIT_RELAY_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
			MORPHIT_RELAY_DATA_DIR: join(work, 'state'),
			MORPHIT_INSTANCE_ORIGIN: 'https://site.example'
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
	console.log(
		`took ${Math.round(took / 1000)} s, exit ${code}, ${last}, saw ${JSON.stringify(seen)}`
	);
	expect(took).toBeLessThan(OPS_LIMIT_MS);
	expect(JSON.parse(last)).toMatchObject({ ok: true, joined: false });
	expect(seen.some(([p]) => p === 'leave')).toBe(true);
	expect(seen.some(([p]) => p === 'forget')).toBe(true);
}, 240_000);
