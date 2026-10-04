/**
 * Chain RPC neither follows redirects nor reads unbounded bodies.
 *
 *
 * An RPC node is a third party — anyone can publish one in the on-chain
 * directory. dblurt (and the batch get_block path) used fetch's defaults: a node
 * answering `307 Location: http://127.0.0.1:<port>/` made the indexer re-POST to
 * its own loopback (a blind SSRF), and a node streaming an endless body was read
 * into memory. Driven here through the real BlurtClient and the real dblurt
 * Client, against real sockets: the "victim" counts requests that reached it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type net from 'node:net';
import { BlurtClient } from '$blurt/client';

type Cfg = ConstructorParameters<typeof BlurtClient>[0];

const DGP = {
	head_block_number: 100,
	last_irreversible_block_num: 90,
	time: '2026-09-24T00:00:00'
};

const servers: http.Server[] = [];
let victimHits = 0;
let victimUrl = '';

async function serve(handler: http.RequestListener): Promise<string> {
	const s = http.createServer(handler);
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
	servers.push(s);
	return `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`;
}

/** Answer any JSON-RPC request (single or batch) with a valid reply. */
function answer(req: http.IncomingMessage, res: http.ServerResponse, pad = 0): void {
	let raw = '';
	req.on('data', (c) => (raw += c));
	req.on('end', () => {
		const body = JSON.parse(raw) as { id: number; method: string } | { id: number }[];
		const reply = Array.isArray(body)
			? body.map((b) => ({ jsonrpc: '2.0', id: b.id, result: null }))
			: { jsonrpc: '2.0', id: body.id, result: DGP };
		res.writeHead(200, { 'content-type': 'application/json' });
		res.write(JSON.stringify(reply));
		// Valid JSON followed by whitespace: parses fine if read whole.
		const chunk = ' '.repeat(1024 * 1024);
		for (let i = 0; i < pad; i++) res.write(chunk);
		res.end();
	});
}

beforeEach(async () => {
	victimHits = 0;
	victimUrl = await serve((req, res) => {
		victimHits++;
		answer(req, res);
	});
});
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const client = (url: string): BlurtClient =>
	new BlurtClient({
		localRpcEndpoints: [],
		blurtRpcEndpoints: [url],
		hiddenRpcEndpoints: []
	} as unknown as Cfg);

describe('M2 — a redirecting RPC node', () => {
	it('control: a well-behaved node answers', async () => {
		const dgp = await client(victimUrl).getDynamicGlobalProperties();
		expect(dgp.head_block_number).toBe(100);
	});

	it('dblurt calls do not follow a 307 to the loopback', async () => {
		let hits = 0;
		const redirector = await serve((_req, res) => {
			hits++;
			res.writeHead(307, { location: `${victimUrl}/` });
			res.end();
		});
		// Refused at once: the call fails, the node is asked ONCE (not again
		// until dblurt's 10 s budget runs out), and nobody follows the redirect.
		await expect(client(redirector).getDynamicGlobalProperties()).rejects.toThrow();
		expect(victimHits, 'the indexer re-POSTed to where the node pointed it').toBe(0);
		expect(hits, 'the refused node was asked again').toBe(1);
	});

	it('the batch get_block path does not follow a 307 either', async () => {
		const redirector = await serve((_req, res) => {
			res.writeHead(307, { location: `${victimUrl}/` });
			res.end();
		});
		await client(redirector)
			.getBlocks([1, 2, 3])
			.catch(() => undefined);
		expect(victimHits, 'the batch path re-POSTed to where the node pointed it').toBe(0);
	});
});

describe('M2 — an RPC node that sends a huge body', () => {
	it('a reply past the cap is refused, not read whole', async () => {
		let hits = 0;
		const flooder = await serve((req, res) => {
			hits++;
			answer(req, res, 40);
		});
		// A get_dynamic_global_properties reply's budget is 8 MiB: the 40 MiB
		// answer is refused, once, not read whole and not re-downloaded.
		await expect(client(flooder).getDynamicGlobalProperties()).rejects.toThrow();
		expect(hits, 'the refused node was asked again').toBe(1);
	});
});
