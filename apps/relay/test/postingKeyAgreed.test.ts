/**
 * Settings → Offline Notifications trusts a user's posting key to decide who
 * may read and change her notice settings. One RPC node must not be able to
 * name a key of its own choosing for someone else's account: with more than
 * one operator, two must agree (BlurtClient.postingKeyAgreed).
 */
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REAL = 'BLT6LLegbAgLAy28EHrffBVuANFWcFgmqRMW13wBmTExqFE9SCkg4';
const FAKE = 'BLT5MBWcjHWnTsG8AC7Tv7ZQvVwG6dxb2Z6BUfnxbHy8G4ZJnLdBu';

const servers: http.Server[] = [];
/** A node on its own loopback address (operators are told apart by host). */
async function node(
	host: string,
	key: string | null,
	posting?: { weight_threshold: number; key_auths: Array<[string, number]> }
): Promise<string> {
	const srv = http.createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			const j = JSON.parse(body) as { id: number; method: string; params: unknown[] };
			const result = j.method.endsWith('get_accounts')
				? key === null
					? []
					: [{ name: 'alice', posting: posting ?? { weight_threshold: 1, key_auths: [[key, 1]] } }]
				: null;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
		});
	});
	await new Promise<void>((r) => srv.listen(0, host, () => r()));
	servers.push(srv);
	return `http://${host}:${(srv.address() as { port: number }).port}`;
}

let work = '';
beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), 'pk-agree-'));
	process.env.MORPHIT_RPC_HEALTH_STATE = join(work, 'h.json');
});
afterAll(() => {
	for (const s of servers) s.close();
	rmSync(work, { recursive: true, force: true });
});

describe('the posting key, as the RPC operators agree it is', () => {
	it('two honest operators outvote one that names another key', async () => {
		const { BlurtClient } = await import('../src/blurt/client.ts');
		const urls = [
			await node('127.0.0.21', FAKE),
			await node('127.0.0.22', REAL),
			await node('127.0.0.23', REAL)
		];
		const c = new BlurtClient(urls, 100);
		expect(await c.postingKeyAgreed('alice')).toEqual({ key: REAL });
	});

	it('two operators that disagree: no key at all, not either one', async () => {
		const { BlurtClient } = await import('../src/blurt/client.ts');
		const c = new BlurtClient(
			[await node('127.0.0.24', FAKE), await node('127.0.0.25', REAL)],
			100
		);
		expect(await c.postingKeyAgreed('alice')).toBeNull();
	});

	it('an account the operators agree does not exist has no key', async () => {
		const { BlurtClient } = await import('../src/blurt/client.ts');
		const c = new BlurtClient(
			[await node('127.0.0.26', null), await node('127.0.0.27', null)],
			100
		);
		expect(await c.postingKeyAgreed('alice')).toEqual({ key: null });
	});

	it('a multi-key posting authority: no single key speaks for her', async () => {
		const { BlurtClient } = await import('../src/blurt/client.ts');
		const twoOfTwo = {
			weight_threshold: 2,
			key_auths: [
				[FAKE, 1],
				[REAL, 1]
			] as Array<[string, number]>
		};
		const c = new BlurtClient(
			[await node('127.0.0.28', '', twoOfTwo), await node('127.0.0.29', '', twoOfTwo)],
			100
		);
		expect(await c.postingKeyAgreed('alice')).toEqual({ key: null });
		// A key heavy enough on its own does (whatever its place in the list).
		const heavy = {
			weight_threshold: 2,
			key_auths: [
				[FAKE, 1],
				[REAL, 2]
			] as Array<[string, number]>
		};
		const d = new BlurtClient(
			[await node('127.0.0.30', '', heavy), await node('127.0.0.31', '', heavy)],
			100
		);
		expect(await d.postingKeyAgreed('alice')).toEqual({ key: REAL });
	});
});
