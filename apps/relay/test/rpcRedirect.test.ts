/**
 * The relay's chain RPC does not follow redirects.
 *
 * The relay broadcasts signups and transfers through dblurt, which followed
 * redirects by default: an RPC node (anyone can list one in the on-chain
 * directory) answering `307 Location: http://127.0.0.1:<port>/` made the relay
 * re-POST to its own loopback. Driven through the real relay BlurtClient and
 * real sockets; the "victim" counts requests that reached it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type net from 'node:net';
import { BlurtClient } from '$blurt/client';

const servers: http.Server[] = [];
async function serve(handler: http.RequestListener): Promise<string> {
	const s = http.createServer(handler);
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
	servers.push(s);
	return `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`;
}
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function until(cond: () => boolean, maxMs: number): Promise<void> {
	const deadline = performance.now() + maxMs;
	while (!cond() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

describe('M2 — relay RPC and a redirecting node', () => {
	it('does not re-POST to where the node points it', async () => {
		let victimHits = 0;
		const victim = await serve((req, res) => {
			victimHits++;
			let raw = '';
			req.on('data', (c) => (raw += c));
			req.on('end', () => {
				const { id } = JSON.parse(raw) as { id: number };
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id, result: [] }));
			});
		});
		let hits = 0;
		const redirector = await serve((_req, res) => {
			hits++;
			res.writeHead(307, { location: `${victim}/` });
			res.end();
		});
		let resolved = false;
		new BlurtClient([redirector], 100).getAccount('alice').then(
			() => (resolved = true),
			() => undefined
		);
		// dblurt retries a refused attempt on the same node for its whole 10 s
		// budget; a second request to the node proves the first was refused.
		await until(() => resolved || hits >= 2, 8_000);
		expect(resolved, 'the call succeeded by following the redirect').toBe(false);
		expect(victimHits, 'the relay re-POSTed to where the node pointed it').toBe(0);
	});
});
