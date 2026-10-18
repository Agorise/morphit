/**
 * Offline notices — the operator's Matrix test note must finish inside
 * morphit-ops's time limit for the relay's tool (180 s), even when the
 * homeserver stops answering: past the limit morphit-ops stops the tool, the
 * bot never leaves the test chat, and the operator reads "did not finish".
 */
import http from 'node:http';
import type net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { leaveTestRoom } from '../src/notify/channels/matrix.ts';

const direct = { torSocks: '', hiddenOnly: false };
const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of servers.splice(0)) await c();
});

/** A homeserver that takes every request and never answers it. */
async function silentHomeserver(): Promise<{ url: string; paths: string[] }> {
	const paths: string[] = [];
	const conns = new Set<net.Socket>();
	const s = http.createServer((req) => {
		paths.push(req.url ?? '');
		req.resume();
	});
	s.on('connection', (c) => conns.add(c));
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
	servers.push(
		() =>
			new Promise<void>((r) => {
				for (const c of conns) c.destroy();
				s.close(() => r());
			})
	);
	return { url: `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`, paths };
}

describe('the test chat wait keeps to its deadline', () => {
	it('a homeserver that stopped answering: done by the deadline, the leave still tried', async () => {
		const hs = await silentHomeserver();
		const cfg = { homeserver: hs.url, accessToken: 'tok', userId: '@bot:hs' };
		const t0 = Date.now();
		const joined = await leaveTestRoom(cfg, direct, '!t:hs', '@operator:hs.org', {
			waitMs: 1_000,
			pollMs: 200,
			deadline: t0 + 4_000
		});
		const took = Date.now() - t0;
		expect(joined).toBe(false);
		expect(took).toBeLessThan(5_000);
		expect(hs.paths.some((p) => p.endsWith('/joined_members'))).toBe(true);
		expect(hs.paths.some((p) => p.endsWith('/leave'))).toBe(true);
	}, 20_000);
});
