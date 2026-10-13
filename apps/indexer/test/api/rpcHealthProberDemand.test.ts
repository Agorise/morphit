/**
 * The stats page's RPC card measures the Blurt nodes ONLY while someone is
 * looking at it, and no number of visitors or refresh clicks makes this
 * indexer contact a node more often than a fixed ceiling (v1.21.7).
 *
 * Before: the prober measured every published node every 20 s from boot,
 * forever, whether or not anyone ever opened the page (about one request a
 * second from every instance, Tor and I2P circuits included), and a refresh
 * (`?probe=1`, open to anyone) re-measured every node every 5 s — so one
 * script requesting it in a loop made the instance contact all ~20 nodes
 * four times as often as the schedule does, for as long as it ran.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	__resetDirectoryHiddenCacheForTest,
	directoryHiddenEndpoints,
	directoryNodeNames,
	PROBE_ANSWER_WITHIN_MS,
	rpcEndpointsApp,
	rpcEndpointsRoute,
	RpcHealthProber,
	type ProbeResult
} from '$api/rpcHealth';
import { _resetRateLimitForTest, rateLimit } from '$api/middleware/ratelimit';
import { Hono } from 'hono';

const OK: ProbeResult = { ok: true, latencyMs: 100, reason: null, httpStatus: null };
const FAKE = {
	toFake: [
		'setTimeout',
		'clearTimeout',
		'setInterval',
		'clearInterval',
		'Date',
		'performance'
	] as const
};

afterEach(() => {
	vi.useRealTimers();
});

function counting(urls: string[]): {
	p: RpcHealthProber;
	probes: Map<string, number[]>;
	reads: () => number;
} {
	const probes = new Map<string, number[]>();
	let reads = 0;
	const p = new RpcHealthProber(
		() => {
			reads++;
			return urls;
		},
		{
			probe: async (u) => {
				const at = probes.get(u) ?? [];
				at.push(Date.now());
				probes.set(u, at);
				return OK;
			}
		}
	);
	return { p, probes, reads: () => reads };
}
const total = (m: Map<string, number[]>): number =>
	[...m.values()].reduce((n, a) => n + a.length, 0);

describe('nobody is looking', () => {
	it('contacts no node and reads no node list, however long it runs', async () => {
		vi.useFakeTimers({ toFake: [...FAKE.toFake] });
		const { p, probes, reads } = counting(['https://a.example', 'http://b.onion']);
		p.start();
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		p.stop();
		expect(total(probes)).toBe(0);
		expect(reads()).toBe(0);
	});
});

describe('someone opens the card', () => {
	it('measures at once, every 20 s while the page keeps reading, and stops a minute after the last read', async () => {
		vi.useFakeTimers({ toFake: [...FAKE.toFake] });
		const t0 = Date.now();
		const { p, probes } = counting(['https://a.example']);
		const route = rpcEndpointsRoute(p, () => ['https://a.example']);
		p.start();
		await route.request('/');
		await vi.advanceTimersByTimeAsync(0);
		expect(probes.get('https://a.example')?.length, 'the first read woke nothing').toBe(1);
		// The card re-reads every 10 s for two minutes, then the visitor leaves.
		for (let i = 0; i < 12; i++) {
			await vi.advanceTimersByTimeAsync(10_000);
			await route.request('/');
		}
		const lastRead = Date.now();
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		p.stop();
		const at = probes.get('https://a.example')!.map((t) => t - t0);
		expect(at.slice(0, 7)).toEqual([0, 20_000, 40_000, 60_000, 80_000, 100_000, 120_000]);
		const after = at.filter((t) => t + t0 > lastRead + 60_000);
		expect(after, 'still measuring long after the last visitor left').toEqual([]);
	});
});

describe('refresh clicks and scripted ?probe=1 floods', () => {
	it('re-measure only a node not measured in the last 10 s', async () => {
		vi.useFakeTimers({ toFake: [...FAKE.toFake] });
		const { p, probes } = counting(['https://a.example']);
		const route = rpcEndpointsRoute(p, () => ['https://a.example']);
		p.start();
		await route.request('/');
		await vi.advanceTimersByTimeAsync(6_000);
		await route.request('/?probe=1');
		expect(probes.get('https://a.example')!.length, 'a 6 s-old figure was re-measured').toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		await route.request('/?probe=1');
		expect(probes.get('https://a.example')!.length).toBe(2);
		p.stop();
	});

	it('a flood from any number of clients contacts each node at most once per 10 s', async () => {
		vi.useFakeTimers({ toFake: [...FAKE.toFake] });
		const urls = ['https://a.example', 'http://b.onion', 'http://c.b32.i2p'];
		const { p, probes } = counting(urls);
		const route = rpcEndpointsRoute(p, () => urls);
		p.start();
		// 50 requests every 100 ms for five minutes — about 150 000 requests.
		for (let i = 0; i < 3000; i++) {
			await Promise.all(Array.from({ length: 50 }, () => route.request('/?probe=1')));
			await vi.advanceTimersByTimeAsync(100);
		}
		p.stop();
		for (const u of urls) {
			const at = probes.get(u)!;
			expect(at.length, u).toBeLessThanOrEqual(31);
			for (let i = 1; i < at.length; i++)
				expect(at[i]! - at[i - 1]!, u).toBeGreaterThanOrEqual(10_000);
		}
	});

	it('a refresh while a measurement runs waits for that one instead of starting another', async () => {
		let finish: ((r: ProbeResult) => void) | null = null;
		let probes = 0;
		const p = new RpcHealthProber(() => ['a'], {
			probe: () => {
				probes++;
				return new Promise<ProbeResult>((r) => (finish = r));
			}
		});
		p.noteViewer();
		const forced = p.checkAllNow();
		let done = false;
		void forced.then(() => (done = true));
		for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
		expect(probes).toBe(1);
		expect(done, 'the refresh answered before the running measurement').toBe(false);
		finish!(OK);
		await forced;
		expect(p.snapshot(['a']).endpoints[0]!.healthy).toBe(true);
	});
});

describe('a refresh is a read too', () => {
	it('a client that only refreshes keeps the schedule going while it does', async () => {
		vi.useFakeTimers({ toFake: [...FAKE.toFake] });
		const { p, probes } = counting(['https://a.example']);
		const route = rpcEndpointsRoute(p, () => ['https://a.example']);
		p.start();
		await route.request('/?probe=1');
		await vi.advanceTimersByTimeAsync(45_000);
		p.stop();
		// The refresh at 0 s, then the schedule at 20 s and 40 s.
		expect(probes.get('https://a.example')!.length).toBe(3);
	});
});

describe('a refresh answers in time', () => {
	it('the answer comes within 8 s at most', () => {
		// The card and `morphit-ops health` wait for it (health gives up at 15 s).
		expect(PROBE_ANSWER_WITHIN_MS).toBeLessThanOrEqual(8_000);
	});

	it('within PROBE_ANSWER_WITHIN_MS, with what is measured by then, while a dead node is still being tried', async () => {
		vi.useFakeTimers({ toFake: [...FAKE.toFake] });
		const p = new RpcHealthProber(() => ['https://fast.example', 'http://dead.onion'], {
			probe: (u) =>
				u.includes('fast')
					? Promise.resolve(OK)
					: new Promise<ProbeResult>(() => {
							/* a dead hidden node: no answer within any budget */
						})
		});
		const route = rpcEndpointsRoute(p, () => ['https://fast.example', 'http://dead.onion']);
		let answered: Response | null = null;
		void Promise.resolve(route.request('/?probe=1')).then((r: Response) => (answered = r));
		await vi.advanceTimersByTimeAsync(PROBE_ANSWER_WITHIN_MS - 1);
		expect(answered).toBeNull();
		await vi.advanceTimersByTimeAsync(2);
		expect(answered).not.toBeNull();
		const body = (await answered!.json()) as { endpoints: { url: string; healthy: boolean }[] };
		expect(body.endpoints.find((e) => e.url === 'https://fast.example')!.healthy).toBe(true);
	});
});

describe('its own rate limit', () => {
	it('a flood of it never uses up the limit of the other public reads (/v1/broadcast)', async () => {
		const { p } = counting(['https://a.example']);
		const card = rpcEndpointsApp(
			p,
			() => ['https://a.example'],
			() => new Map(),
			5
		);
		const other = new Hono();
		other.use('*', rateLimit('resource', 5));
		other.get('/', (c) => c.text('ok'));
		// Every request from one shared address (as every Tor or I2P visitor
		// is: 25 times the limit).
		_resetRateLimitForTest();
		let last = 0;
		for (let i = 0; i < 200 && last !== 429; i++) last = (await card.request('/')).status;
		expect(last).toBe(429);
		expect((await other.request('/')).status).toBe(200);
		_resetRateLimitForTest();
	});
});

describe('the node list behind it', () => {
	it('a cold cache is read once for any number of requests at the same moment', async () => {
		__resetDirectoryHiddenCacheForTest();
		let reads = 0;
		const db = {
			query: async () => {
				reads++;
				// Still running when the others ask (a later turn of the loop).
				await new Promise((r) => setImmediate(r));
				return { rows: [{ endpoints: [`http://${'a'.repeat(56)}.onion:8091`] }] };
			}
		};
		await Promise.all(Array.from({ length: 50 }, () => directoryHiddenEndpoints(db)));
		expect(reads).toBe(1);
		__resetDirectoryHiddenCacheForTest();
	});

	it('the node names too', async () => {
		__resetDirectoryHiddenCacheForTest();
		let reads = 0;
		const db = {
			query: async () => {
				reads++;
				// Still running when the others ask (a later turn of the loop).
				await new Promise((r) => setImmediate(r));
				return { rows: [{ node_names: { 'https://a.example': 'alice' } }] };
			}
		};
		const all = await Promise.all(Array.from({ length: 50 }, () => directoryNodeNames(db)));
		expect(reads).toBe(1);
		expect(all.every((m) => m.get('https://a.example') === 'alice')).toBe(true);
		__resetDirectoryHiddenCacheForTest();
	});
});

describe('the minute after the last read', () => {
	it('starts again at every read', async () => {
		vi.useFakeTimers({ toFake: [...FAKE.toFake] });
		const t0 = Date.now();
		const { p, probes } = counting(['https://a.example']);
		const route = rpcEndpointsRoute(p, () => ['https://a.example']);
		p.start();
		await route.request('/');
		await vi.advanceTimersByTimeAsync(50_000);
		await route.request('/'); // still within the first minute: extends it to 110 s
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		p.stop();
		expect(probes.get('https://a.example')!.map((t) => t - t0)).toEqual([
			0, 20_000, 40_000, 60_000, 80_000, 100_000
		]);
	});
});
