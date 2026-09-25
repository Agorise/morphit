/**
 * The RPC health probe neither follows redirects nor reads unbounded bodies
 * (v1.18.0 deep-deep, M2).
 *
 * `probeOne` POSTed to every canonical RPC node — third parties, listed in the
 * on-chain directory — with fetch's defaults. A node answering `307 Location:
 * http://127.0.0.1:<port>/` had the indexer re-POST to its own loopback, and a
 * node streaming a huge body was read whole. Driven through the exported
 * `probeEndpoints` against real sockets.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type net from 'node:net';
import { probeEndpoints } from '$api/rpcHealth';

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

const DGP = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { head_block_number: 1 } });

describe('M2 — rpcHealth probe', () => {
	it('control: a healthy node reads healthy', async () => {
		const ok = await serve((_q, r) => r.end(DGP));
		const { endpoints } = await probeEndpoints([ok]);
		expect(endpoints[0]!.healthy).toBe(true);
	});

	it('a 307 is reported, not followed', async () => {
		let victimHits = 0;
		const victim = await serve((_q, r) => {
			victimHits++;
			r.end(DGP);
		});
		const redirector = await serve((_q, r) => {
			r.writeHead(307, { location: `${victim}/` });
			r.end();
		});
		const { endpoints } = await probeEndpoints([redirector]);
		expect(victimHits, 'the probe re-POSTed to where the node pointed it').toBe(0);
		expect(endpoints[0]!.healthy).toBe(false);
		expect(endpoints[0]!.http_status).toBe(307);
	});

	it('a reply past the cap is not read whole, and does not read healthy', async () => {
		const flooder = await serve((_q, r) => {
			r.write(DGP);
			const chunk = ' '.repeat(1024 * 1024);
			for (let i = 0; i < 8; i++) r.write(chunk);
			r.end();
		});
		const { endpoints } = await probeEndpoints([flooder]);
		expect(endpoints[0]!.healthy, 'an 8 MB reply was read whole and accepted').toBe(false);
	});
});
