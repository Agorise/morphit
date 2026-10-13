/**
 * RpcHealthProber (v1.21.6) — the background measurements behind
 * /v1/rpc-endpoints, driven through behaviour.
 *
 *  - Each node is measured every 20 s from the START of its last round (a
 *    healthy node read every 22-24 s was "every 20 s" only on paper).
 *  - The schedule and the refresh limit follow a monotonic clock: a wall clock
 *    stepped back (NTP, a VM restore) froze every figure and the refresh button
 *    until the clock caught up again, while the card said "measured 0 s ago".
 *  - A slow node-list read never stacks up ticks; a node that left the list is
 *    not brought back by its last round; stop() stops.
 *  - A node that sends headers and then stalls timed out — it did not send a
 *    bad body; a `null` reply is an RPC error, not a network failure.
 *
 * Since v1.21.7 it measures only while the card is read (`noteViewer()`), so
 * these cases keep a reader on the page; rpcHealthProberDemand.test.ts covers
 * the quiet spells and the refresh ceiling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type net from 'node:net';

import {
	__resetDirectoryHiddenCacheForTest,
	directoryHiddenEndpoints,
	probeEndpoints,
	probeNodeRound,
	publishedRpcEndpoints,
	rpcEndpointsRoute,
	RpcHealthProber,
	type ProbeResult
} from '$api/rpcHealth';
import { RPC_DIRECTORY_MAX_NODES } from '$blurt/rpcDirectoryOp';

const OK: ProbeResult = { ok: true, latencyMs: 100, reason: null, httpStatus: null };
const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
	vi.useRealTimers();
});

describe('RpcHealthProber — schedule', () => {
	it('re-measures a healthy node every 20 s, start to start', async () => {
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance']
		});
		const starts: number[] = [];
		const p = new RpcHealthProber(() => ['https://a.example'], {
			probe: () =>
				new Promise<ProbeResult>((res) => {
					starts.push(Date.now());
					setTimeout(() => res(OK), 300);
				})
		});
		p.start();
		p.noteViewer();
		const reader = setInterval(() => p.noteViewer(), 10_000);
		await vi.advanceTimersByTimeAsync(100_000);
		clearInterval(reader);
		p.stop();
		const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
		expect(gaps.length).toBeGreaterThanOrEqual(4);
		expect(new Set(gaps)).toEqual(new Set([20_000]));
	});

	it('keeps measuring, and honours a refresh, after the wall clock is stepped back', async () => {
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance']
		});
		let probes = 0;
		const p = new RpcHealthProber(() => ['https://a.example'], {
			probe: async () => {
				probes++;
				return OK;
			}
		});
		p.start();
		p.noteViewer();
		const reader = setInterval(() => p.noteViewer(), 10_000);
		await vi.advanceTimersByTimeAsync(11_000);
		await p.checkAllNow();
		expect(probes).toBe(2);
		vi.setSystemTime(Date.now() - 3_600_000); // NTP steps the clock back an hour
		await vi.advanceTimersByTimeAsync(25_000);
		expect(probes, 'no background measurement after the step').toBe(3);
		await vi.advanceTimersByTimeAsync(10_000);
		await p.checkAllNow();
		expect(probes, 'the refresh was refused after the step').toBe(4);
		clearInterval(reader);
		p.stop();
	});

	it('does not stack ticks while the node list is slow to read', async () => {
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance']
		});
		let reads = 0;
		const p = new RpcHealthProber(
			() => {
				reads++;
				return new Promise<string[]>(() => {}); // the DB never answers
			},
			{ probe: async () => OK }
		);
		p.start();
		p.noteViewer();
		await vi.advanceTimersByTimeAsync(60_000);
		p.stop();
		expect(reads).toBe(1);
	});
});

describe('RpcHealthProber — the node list and stop()', () => {
	it('a node that left the list is not brought back by its last round', async () => {
		let list = ['a', 'b'];
		let listFails = false;
		let finishB: ((r: ProbeResult) => void) | null = null;
		const probed: string[] = [];
		let now = 0;
		const p = new RpcHealthProber(
			() => {
				if (listFails) throw new Error('db down');
				return list;
			},
			{
				now: () => now,
				probe: (u) => {
					probed.push(u);
					return u === 'b' ? new Promise<ProbeResult>((r) => (finishB = r)) : Promise.resolve(OK);
				}
			}
		);
		p.noteViewer();
		await p.tick();
		list = ['a'];
		await p.tick(); // b leaves the directory while its round runs
		finishB!(OK);
		await flush();
		expect(p.snapshot(['b']).endpoints[0]!.checked_at, 'b was recorded after it left').toBeNull();
		listFails = true;
		now += 60_000;
		probed.length = 0;
		p.noteViewer();
		await p.tick();
		await flush();
		expect(probed, 'a read failure fell back to a list that includes b').toEqual(['a']);
	});

	it('stop() launches nothing more, even from a tick already under way', async () => {
		let release: ((u: string[]) => void) | null = null;
		const probed: string[] = [];
		const p = new RpcHealthProber(
			() => (release === null ? new Promise<string[]>((r) => (release = r)) : ['x', 'y']),
			{
				probe: async (u) => {
					probed.push(u);
					return OK;
				}
			}
		);
		p.start();
		p.noteViewer();
		p.stop();
		release!(['x', 'y']);
		await flush();
		expect(probed, 'probes started after stop()').toEqual([]);
		await p.checkAllNow();
		expect(probed, 'a refresh after stop() probed').toEqual([]);
	});

	it('a refresh while a timer round runs joins it (one probe per node)', async () => {
		let finish: ((r: ProbeResult) => void) | null = null;
		let probes = 0;
		const p = new RpcHealthProber(() => ['a'], {
			probe: () => {
				probes++;
				return new Promise<ProbeResult>((r) => (finish = r));
			}
		});
		p.noteViewer();
		await p.tick();
		const forced = p.checkAllNow();
		const forced2 = p.checkAllNow();
		await flush();
		expect(probes).toBe(1);
		finish!(OK);
		await Promise.all([forced, forced2]);
		expect(p.snapshot(['a']).endpoints[0]!.healthy).toBe(true);
	});
});

// ── real sockets ──
const servers: http.Server[] = [];
const sockets = new Set<net.Socket>();
async function serve(handler: http.RequestListener): Promise<string> {
	const s = http.createServer(handler);
	s.on('connection', (c) => sockets.add(c));
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
	servers.push(s);
	return `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`;
}
afterEach(async () => {
	for (const c of sockets) c.destroy();
	sockets.clear();
	await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('probe classification', () => {
	it('a node that sends headers and then stalls timed out', async () => {
		const staller = await serve((_q, r) => {
			r.writeHead(200, { 'content-type': 'application/json' });
			r.write('{"jsonrpc":"2.0",');
		});
		const { endpoints } = await probeEndpoints([staller]);
		expect(endpoints[0]!.healthy).toBe(false);
		expect(endpoints[0]!.failure_reason).toBe('timeout');
	}, 20_000);

	it('a `null` reply is an RPC error, not a network failure', async () => {
		const nul = await serve((_q, r) => r.end('null'));
		const { endpoints } = await probeEndpoints([nul]);
		expect(endpoints[0]!.healthy).toBe(false);
		expect(endpoints[0]!.failure_reason).toBe('rpc_error');
	});

	it('a `result: null` reply is an RPC error, not a healthy node', async () => {
		const nul = await serve((_q, r) =>
			r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }))
		);
		const { endpoints } = await probeEndpoints([nul]);
		expect(endpoints[0]!.healthy).toBe(false);
		expect(endpoints[0]!.failure_reason).toBe('rpc_error');
	});

	it('a published row carries only the documented fields and never the node’s error text', async () => {
		const node = await serve((_q, r) =>
			r.end(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					error: { message: 'secret /srv/internal 10.0.0.7' }
				})
			)
		);
		const p = new RpcHealthProber(() => [node]);
		await p.checkAllNow();
		const body = await (await rpcEndpointsRoute(p, () => [node]).request('/')).text();
		expect(body.includes('secret')).toBe(false);
		const row = (JSON.parse(body) as { endpoints: Record<string, unknown>[] }).endpoints[0]!;
		expect(Object.keys(row).sort()).toEqual(
			[
				'checked_at',
				'consecutive_failures',
				'cooldown_ms',
				'failure_reason',
				'healthy',
				'http_status',
				'latency_ms',
				'transport',
				'url'
			].sort()
		);
		expect(row.failure_reason).toBe('rpc_error');
	});
});

describe('probeNodeRound — one retry before a miss counts', () => {
	let server: http.Server | null = null;
	afterEach(async () => {
		await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
		server = null;
	});
	/** A node whose answers follow `script` (HTTP status per request). */
	async function node(script: number[]): Promise<{ url: string; hits: () => number }> {
		let n = 0;
		server = http.createServer((req, res) => {
			req.resume();
			req.on('end', () => {
				const status = script[Math.min(n, script.length - 1)]!;
				n++;
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(
					status === 200 ? '{"jsonrpc":"2.0","id":1,"result":{"head_block_number":1}}' : 'no'
				);
			});
		});
		await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
		const { port } = server.address() as net.AddressInfo;
		return { url: `http://127.0.0.1:${port}`, hits: () => n };
	}
	it('a miss followed by an answer is a success (retried once)', async () => {
		const n = await node([502, 200]);
		expect((await probeNodeRound(n.url)).ok).toBe(true);
		expect(n.hits()).toBe(2);
	});
	it('two misses are a failure with the last reason; no third try', async () => {
		const n = await node([502, 503, 200]);
		const r = await probeNodeRound(n.url);
		expect([r.ok, r.reason, r.httpStatus, r.latencyMs]).toEqual([false, 'http', 503, null]);
		expect(n.hits()).toBe(2);
	});
	it('an answer at once is not probed again', async () => {
		const n = await node([200]);
		expect((await probeNodeRound(n.url)).ok).toBe(true);
		expect(n.hits()).toBe(1);
	});
});

describe('the directory row the prober reads', () => {
	it('never yields more nodes than a valid signed directory can hold', async () => {
		// The row is read before the boot-time proof, and every URL it returns is
		// measured at once, every 20 s: a 10 000-URL row opened ~2 300 sockets.
		const endpoints = Array.from(
			{ length: 10_000 },
			(_, i) => `http://${i.toString(32).padStart(4, 'a')}${'b'.repeat(52)}.onion/`
		);
		__resetDirectoryHiddenCacheForTest();
		const got = await directoryHiddenEndpoints({
			query: async () => ({ rows: [{ endpoints }] })
		} as never);
		const urls = publishedRpcEndpoints({
			usesClearnet: false,
			clearnetCanon: [],
			hiddenCanon: [],
			configuredHidden: [],
			directoryHidden: got
		});
		expect(urls.length).toBeGreaterThan(0);
		expect(urls.length).toBeLessThanOrEqual(2 * RPC_DIRECTORY_MAX_NODES);
		__resetDirectoryHiddenCacheForTest();
	});
});

describe('probe classification — answers cut off', () => {
	const servers: http.Server[] = [];
	afterEach(async () => {
		await Promise.all(
			servers.splice(0).map((srv) => new Promise<void>((r) => srv.close(() => r())))
		);
	});
	async function serve(h: http.RequestListener): Promise<string> {
		const srv = http.createServer(h);
		servers.push(srv);
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
		return `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
	}
	it('a connection that drops mid-answer is a network failure, not a bad body', async () => {
		const url = await serve((_q, r) => {
			r.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
			// Half an answer, then the connection is gone (a Tor circuit collapsing).
			r.write('{"jsonrpc":"2.0","id":1,"result":{"head_bl', () => r.socket?.destroy());
		});
		const { endpoints } = await probeEndpoints([url]);
		expect(endpoints[0]!.failure_reason).toBe('network');
	});
	it('an answer over the size cap is still an unreadable answer', async () => {
		const url = await serve((_q, r) => {
			r.writeHead(200, { 'content-type': 'application/json' });
			r.end(`{"jsonrpc":"2.0","id":1,"result":"${'x'.repeat(1_100_000)}"}`);
		});
		const { endpoints } = await probeEndpoints([url]);
		expect(endpoints[0]!.failure_reason).toBe('bad_body');
	});
	it('the wall clock stepped back an hour during a probe: the latency is still the round trip', async () => {
		const real = Date.now.bind(Date);
		let offset = 0;
		const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
		try {
			const url = await serve((q, r) => {
				q.resume();
				q.on('end', () => {
					offset = -3_600_000; // NTP / a Tor-only box's time sync, mid-probe
					r.end('{"jsonrpc":"2.0","id":1,"result":{"head_block_number":1}}');
				});
			});
			const r = await probeNodeRound(url);
			expect(r.ok).toBe(true);
			expect(r.latencyMs).toBeGreaterThanOrEqual(0);
			expect(r.latencyMs).toBeLessThan(5_000);
		} finally {
			spy.mockRestore();
		}
	});
});

describe('RpcHealthProber — schedule under real-world timing', () => {
	it('a slow round on a slow list read is still re-measured every 20 s, start to start', async () => {
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance']
		});
		const starts: number[] = [];
		// The DB read takes 40 ms the first time (cold), 5 ms afterwards; a Tor
		// node answers in ~5 s.
		let reads = 0;
		const p = new RpcHealthProber(
			() =>
				new Promise<string[]>((r) =>
					setTimeout(() => r(['http://x.onion']), reads++ === 0 ? 40 : 5)
				),
			{
				probe: () =>
					new Promise<ProbeResult>((res) => {
						starts.push(Date.now());
						setTimeout(() => res({ ...OK, latencyMs: 5_000 }), 5_000);
					})
			}
		);
		p.start();
		p.noteViewer();
		const reader = setInterval(() => p.noteViewer(), 10_000);
		await vi.advanceTimersByTimeAsync(130_000);
		clearInterval(reader);
		p.stop();
		const gaps = starts.slice(1).map((st, i) => st - starts[i]!);
		expect(gaps.length).toBeGreaterThanOrEqual(5);
		// Never a skipped tick (22 s) or a schedule from the end of the round (25 s).
		for (const g of gaps) {
			expect(g).toBeGreaterThan(19_000);
			expect(g).toBeLessThanOrEqual(20_100);
		}
	});
});
