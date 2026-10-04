/**
 * The installer's network and clock checks:
 * they asked www.google.com for the time and ONE hard-coded RPC node for
 * reachability, so that one node being down read as "check your network and
 * DNS" with a default-No abort. Now both read one probe of the shipped RPC
 * pool: no other host, and one dead node is fine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import { checkOutboundHttps, checkSystemTime } from '../src/init/systemCheck.ts';

const root = mkdtempSync(join(tmpdir(), 'syscheck-'));
const realFetch = globalThis.fetch;
let asked: string[] = [];
let dead = new Set<string>();
let chainTime = '';

beforeAll(() => {
	mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
	writeFileSync(
		join(root, 'etc', 'morphit', 'indexer.env'),
		`MORPHIT_INDEXER_RPC_ENDPOINTS=${DEFAULT_BLURT_RPC_ENDPOINTS.join(',')}\n`
	);
	process.env.MORPHIT_ENV_ROOT = root;
	globalThis.fetch = (async (u: unknown) => {
		const url = String(u);
		asked.push(url);
		if (dead.has(url) || !DEFAULT_BLURT_RPC_ENDPOINTS.includes(url))
			throw new Error('connect ECONNREFUSED');
		return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { time: chainTime } }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}) as typeof fetch;
});
afterAll(() => {
	globalThis.fetch = realFetch;
	delete process.env.MORPHIT_ENV_ROOT;
	rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
	asked = [];
	dead = new Set();
	chainTime = new Date().toISOString().slice(0, 19);
});

describe('system check network probes', () => {
	it('ask only nodes of the shipped RPC pool', async () => {
		await checkOutboundHttps();
		await checkSystemTime();
		expect(asked.length).toBeGreaterThan(0);
		for (const u of asked) expect(DEFAULT_BLURT_RPC_ENDPOINTS, `asked ${u}`).toContain(u);
	});

	it('one dead node is not a network problem', async () => {
		dead = new Set([DEFAULT_BLURT_RPC_ENDPOINTS[0]!, DEFAULT_BLURT_RPC_ENDPOINTS[1]!]);
		const c = await checkOutboundHttps();
		expect(c.status).toBe('ok');
	});

	it('the clock is compared with the chain', async () => {
		chainTime = new Date(Date.now() - 600_000).toISOString().slice(0, 19);
		const t = await checkSystemTime();
		expect(t.status).toBe('error');
	});
});
