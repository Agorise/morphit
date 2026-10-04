/**
 * One RPC node must not decide the relay's reads for everyone.
 *
 * A node that answers every call with a JSON-RPC error — a public node with the
 * condenser API switched off, or a hostile one — used to pin the relay's pool:
 * the error was handed to the caller with no rotation and no cooldown, so
 * signup availability, the signup account read and the live-fee read failed
 * for as long as that node sorted first, while a healthy node sat unused.
 *
 * These drive the REAL BlurtClient (dblurt over the guarded fetch) against two
 * local JSON-RPC servers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stateDir = '';
let BlurtClient: typeof import('../src/blurt/client.ts').BlurtClient;

interface Node {
	url: string;
	hits: () => number;
	close: () => Promise<void>;
}

/** A JSON-RPC node on its own loopback address; `answer` builds each reply. */
function node(host: string, answer: (method: string, id: unknown) => unknown): Promise<Node> {
	let hits = 0;
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			hits++;
			const j = JSON.parse(body) as { method: string; id: unknown; params?: unknown[] };
			const method = j.method === 'call' ? String((j.params ?? [])[1]) : String(j.method);
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(answer(method.replace(/^condenser_api\./, ''), j.id)));
		});
	});
	return new Promise((resolve) =>
		server.listen(0, host, () =>
			resolve({
				url: `http://${host}:${(server.address() as { port: number }).port}`,
				hits: () => hits,
				close: () => new Promise((r) => server.close(() => r()))
			})
		)
	);
}

const ok = (method: string, id: unknown) => {
	if (method === 'get_accounts') return { jsonrpc: '2.0', id, result: [] };
	if (method === 'get_chain_properties')
		return {
			jsonrpc: '2.0',
			id,
			result: { account_creation_fee: '100.000 BLURT', maximum_block_size: 65536 }
		};
	return {
		jsonrpc: '2.0',
		id,
		result: {
			head_block_number: 1,
			head_block_id: '00000001' + 'ab'.repeat(16),
			time: '2026-10-01T00:00:00'
		}
	};
};

beforeAll(async () => {
	// The pool persists endpoint health; keep it out of the real state path.
	stateDir = mkdtempSync(join(tmpdir(), 'relay-rpc-fault-'));
	process.env.MORPHIT_RPC_HEALTH_STATE = join(stateDir, 'rpc-health.json');
	({ BlurtClient } = await import('../src/blurt/client.ts'));
});
afterAll(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

describe('relay BlurtClient: a node that answers with errors does not pin the pool', () => {
	it('a node without the API is rotated off: every account read is answered by the healthy node', async () => {
		const bad = await node('127.0.0.2', (_m, id) => ({
			jsonrpc: '2.0',
			id,
			error: { code: -32003, message: 'Assert Exception: Could not find API condenser_api' }
		}));
		const good = await node('127.0.0.3', ok);
		try {
			// The healthy node is listed first and proves itself; the bad node is
			// then the "never measured" one the pool used to try first.
			const c = new BlurtClient([good.url, bad.url], 100);
			await c.getDynamicGlobalProperties();
			const answers: unknown[] = [];
			for (let i = 0; i < 5; i++) answers.push(await c.getAccount(`alice${i}`));
			expect(answers).toEqual([null, null, null, null, null]);
			expect(bad.hits()).toBeLessThanOrEqual(1);
		} finally {
			await bad.close();
			await good.close();
		}
	});

	it('a node answering a plausible chain error on a read is failed over and parked', async () => {
		const liar = await node('127.0.0.4', (_m, id) => ({
			jsonrpc: '2.0',
			id,
			error: { code: -32000, message: 'Assert Exception: itr != idx.end(): unknown key' }
		}));
		const good = await node('127.0.0.5', ok);
		try {
			const c = new BlurtClient([liar.url, good.url], 100);
			const props = await c.getChainProperties();
			expect(props.account_creation_fee).toBe('100.000 BLURT');
			expect(await c.getAccount('bob')).toBeNull();
			const liarState = c.endpointSnapshot().find((e) => e.url === liar.url)!;
			expect(liarState.consecutiveFailures).toBeGreaterThan(0);
			expect(liar.hits()).toBe(1);
		} finally {
			await liar.close();
			await good.close();
		}
	});
});
