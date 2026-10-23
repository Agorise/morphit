/**
 * Fan-out speed under load and on slow circuits (v1.21.14 full chat audit).
 *
 *   - S-H1: pushes to one peer went out strictly one after another, whatever
 *     their senders, each on a fresh Tor circuit — so N people writing to
 *     users of one instance at the same moment paid N circuits back to back
 *     and the later ones missed six seconds.
 *   - S-M5: a push whose onion rendezvous outlasted the budget was aborted and
 *     blamed on the peer; the peer's clearnet origin through a Tor exit was
 *     never tried.
 *   - S-L9: the isolated Tor connector ignored the abort, so a given-up push
 *     kept its SOCKS stream open until the handshake timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

import {
	HEDGE_AFTER_MS,
	PEER_PUSHES_IN_FLIGHT,
	PUSHES_IN_FLIGHT_TOTAL,
	PeerSender,
	type FastPeer
} from '$indexer/chatFastFederation';
import { postJsonViaTorIsolated } from '$indexer/hiddenServicePool';

const ONION = `http://${'a'.repeat(56)}.onion`;
const CLEARNET = 'https://peer.example';
const TOR = { torSocks: '127.0.0.1:9050', i2pHttpProxy: '', lokinet: false } as never;

function chatTrx(signer: string, n: number): unknown {
	return {
		operations: [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: [signer],
					id: 'morphit_chat_v1',
					json: `${n}`
				}
			]
		]
	};
}
const signersOf = (body: unknown): string[] =>
	((body as { trxs?: unknown[] }).trxs ?? [(body as { trx: unknown }).trx]).map(
		(t) =>
			(t as { operations: [string, { required_posting_auths: string[] }][] }).operations[0]![1]
				.required_posting_auths[0]!
	);

describe('pushes to one peer (fake timers)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('S-H1: six senders to one peer all arrive within one round trip', async () => {
		const arrived: { signer: string; at: number }[] = [];
		const t0 = Date.now();
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: (_url, body) =>
				new Promise((resolve) =>
					setTimeout(() => {
						for (const s of signersOf(body)) arrived.push({ signer: s, at: Date.now() - t0 });
						resolve({ status: 200, body: '{}' });
					}, 1500)
				)
		});
		const peer: FastPeer = { origin: ONION, hidden: true, key: 'p' };
		for (let i = 0; i < 6; i++) sender.enqueue(chatTrx(`s${i}`, i), [peer]);
		await vi.advanceTimersByTimeAsync(1500);
		expect(arrived.map((a) => a.signer).sort()).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
		expect(Math.max(...arrived.map((a) => a.at))).toBeLessThanOrEqual(1500);
		expect(sender.stats().delivered).toBe(6);
	});

	it("review B, F4: one sender filling a peer's queue does not push other senders' messages out", async () => {
		// Messages are fanned out before the node accepts them, so one account
		// can queue hundreds a peer will never get through quickly; the queue's
		// cap dropped whoever came NEXT, i.e. everyone else.
		const arrived: string[] = [];
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: (_url, body) =>
				new Promise((resolve) =>
					setTimeout(() => {
						for (const s of signersOf(body)) arrived.push(s);
						resolve({ status: 200, body: '{}' });
					}, 3000)
				)
		});
		const peer: FastPeer = { origin: ONION, hidden: true, key: 'p' };
		for (let i = 0; i < 400; i++) sender.enqueue(chatTrx('mallory', i), [peer]);
		for (let i = 0; i < 5; i++) sender.enqueue(chatTrx(`honest${i}`, i), [peer]);
		await vi.advanceTimersByTimeAsync(3000);
		expect(arrived.filter((s) => s.startsWith('honest')).sort()).toEqual([
			'honest0',
			'honest1',
			'honest2',
			'honest3',
			'honest4'
		]);
		expect(sender.stats().dropped).toBeGreaterThan(0);
	});

	it('S-H1: one sender still goes one push at a time, in order', async () => {
		const pushes: string[][] = [];
		let inFlight = 0;
		let most = 0;
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: (_url, body) => {
				inFlight++;
				most = Math.max(most, inFlight);
				pushes.push(
					((body as { trxs?: unknown[] }).trxs ?? [(body as { trx: unknown }).trx]).map(
						(t) => (t as { operations: [string, { json: string }][] }).operations[0]![1].json
					)
				);
				return new Promise((resolve) =>
					setTimeout(() => {
						inFlight--;
						resolve({ status: 200, body: '{}' });
					}, 1000)
				);
			}
		});
		const peer: FastPeer = { origin: ONION, hidden: true, key: 'p' };
		for (let i = 0; i < 4; i++) sender.enqueue(chatTrx('alice', i), [peer]);
		await vi.advanceTimersByTimeAsync(3000);
		expect(most).toBe(1);
		expect(pushes).toEqual([['0'], ['1', '2', '3']]);
	});

	it(`S-H1: at most ${PEER_PUSHES_IN_FLIGHT} pushes to one peer at once`, async () => {
		let inFlight = 0;
		let most = 0;
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: () => {
				inFlight++;
				most = Math.max(most, inFlight);
				return new Promise((resolve) =>
					setTimeout(() => {
						inFlight--;
						resolve({ status: 200, body: '{}' });
					}, 1000)
				);
			}
		});
		const peer: FastPeer = { origin: ONION, hidden: true, key: 'p' };
		for (let i = 0; i < PEER_PUSHES_IN_FLIGHT + 4; i++) sender.enqueue(chatTrx(`s${i}`, i), [peer]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(most).toBe(PEER_PUSHES_IN_FLIGHT);
		expect(sender.stats().delivered).toBe(PEER_PUSHES_IN_FLIGHT + 4);
	});

	it(`at most ${PUSHES_IN_FLIGHT_TOTAL} pushes in flight across all peers, and a waiting peer gets the next free slot (finding 9)`, async () => {
		let inFlight = 0;
		let most = 0;
		const arrivedAt = new Map<string, number>();
		const t0 = Date.now();
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: (url) => {
				inFlight++;
				most = Math.max(most, inFlight);
				return new Promise((resolve) =>
					setTimeout(() => {
						inFlight--;
						if (!arrivedAt.has(url)) arrivedAt.set(url, Date.now() - t0);
						resolve({ status: 200, body: '{}' });
					}, 1000)
				);
			}
		});
		const peers = Array.from(
			{ length: PUSHES_IN_FLIGHT_TOTAL / PEER_PUSHES_IN_FLIGHT },
			(_, i): FastPeer => ({
				origin: `http://${String.fromCharCode(97 + i).repeat(56)}.onion`,
				hidden: true,
				key: `p${i}`
			})
		);
		for (let s = 0; s < PEER_PUSHES_IN_FLIGHT; s++) sender.enqueue(chatTrx(`s${s}`, s), peers);
		// Every slot is taken; one more peer has a message and nothing in flight.
		const late: FastPeer = { origin: `http://${'z'.repeat(56)}.onion`, hidden: true, key: 'late' };
		sender.enqueue(chatTrx('t', 0), [late]);
		expect(inFlight).toBe(PUSHES_IN_FLIGHT_TOTAL);
		await vi.advanceTimersByTimeAsync(2500);
		expect(most).toBe(PUSHES_IN_FLIGHT_TOTAL);
		expect(sender.stats().delivered).toBe(PUSHES_IN_FLIGHT_TOTAL + 1);
		expect([...arrivedAt.entries()].find(([u]) => u.includes('zzzz'))?.[1]).toBe(2000);
	});

	it('under the ceiling a waiting peer gets the next free slot even while busy peers have a backlog (review 2, finding 2)', async () => {
		const arrivedAt = new Map<string, number>();
		const t0 = Date.now();
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: (url) =>
				new Promise((resolve) =>
					setTimeout(() => {
						if (!arrivedAt.has(url)) arrivedAt.set(url, Date.now() - t0);
						resolve({ status: 200, body: '{}' });
					}, 1000)
				)
		});
		const busy = Array.from(
			{ length: PUSHES_IN_FLIGHT_TOTAL / PEER_PUSHES_IN_FLIGHT },
			(_, i): FastPeer => ({
				origin: `http://${String.fromCharCode(97 + i).repeat(56)}.onion`,
				hidden: true,
				key: `p${i}`
			})
		);
		// Twice as many senders as slots per peer: every busy peer has a backlog.
		for (let s = 0; s < 2 * PEER_PUSHES_IN_FLIGHT; s++) sender.enqueue(chatTrx(`s${s}`, s), busy);
		const late: FastPeer = { origin: `http://${'z'.repeat(56)}.onion`, hidden: true, key: 'late' };
		sender.enqueue(chatTrx('t', 0), [late]);
		await vi.advanceTimersByTimeAsync(3500);
		expect([...arrivedAt.entries()].find(([u]) => u.includes('zzzz'))?.[1]).toBe(2000);
	});

	const twoAddresses: FastPeer = {
		origin: ONION,
		hidden: true,
		key: CLEARNET,
		alternates: [{ origin: CLEARNET, hidden: false }]
	};

	it('S-M5: a slow onion rendezvous does not lose the push: the exit path is tried beside it', async () => {
		const tried: string[] = [];
		const aborted: string[] = [];
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: (url, _body, _p, timeoutMs, signal) =>
				new Promise((resolve, reject) => {
					tried.push(new URL(url).origin);
					const slow = url.startsWith(ONION);
					let over = false;
					const t = setTimeout(
						() => {
							over = true;
							if (slow) reject(new Error('timeout'));
							else resolve({ status: 200, body: '{}' });
						},
						slow ? timeoutMs : 300
					);
					signal?.addEventListener('abort', () => {
						if (over) return;
						clearTimeout(t);
						aborted.push(new URL(url).origin);
						reject(new Error('aborted'));
					});
				})
		});
		sender.enqueue(chatTrx('alice', 0), [twoAddresses]);
		await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS + 300);
		expect(tried).toEqual([ONION, CLEARNET]);
		expect(sender.stats()).toMatchObject({ delivered: 1, failed: 0 });
		// The onion attempt was given up, not left running.
		expect(aborted).toEqual([ONION]);
	});

	it('S-M5: an onion that gives up without an answer moves to the exit path at once', async () => {
		const tried: { origin: string; at: number }[] = [];
		const t0 = Date.now();
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: (url) =>
				new Promise((resolve, reject) => {
					tried.push({ origin: new URL(url).origin, at: Date.now() - t0 });
					setTimeout(
						() =>
							url.startsWith(ONION)
								? reject(new Error('peer unreachable via Tor: closed'))
								: resolve({ status: 200, body: '{}' }),
						100
					);
				})
		});
		sender.enqueue(chatTrx('alice', 0), [twoAddresses]);
		await vi.advanceTimersByTimeAsync(300);
		expect(tried).toEqual([
			{ origin: ONION, at: 0 },
			{ origin: CLEARNET, at: 100 }
		]);
		expect(sender.stats()).toMatchObject({ delivered: 1, failed: 0 });
	});

	it('S-M5: a peer that ANSWERED is not asked again at its other address', async () => {
		const tried: string[] = [];
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: (url) => {
				tried.push(new URL(url).origin);
				return Promise.resolve({ status: 500, body: '' });
			}
		});
		sender.enqueue(chatTrx('alice', 0), [twoAddresses]);
		await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 3);
		expect(tried).toEqual([ONION]);
		expect(sender.stats()).toMatchObject({ delivered: 0, failed: 1 });
	});

	it("review B, F3: the exit path's edge refusing (403) does not kill a slow onion push that succeeds", async () => {
		const aborted: string[] = [];
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: (url, _body, _p, _timeoutMs, signal) =>
				new Promise((resolve, reject) => {
					const onion = url.startsWith(ONION);
					let over = false;
					const t = setTimeout(
						() => {
							over = true;
							resolve(onion ? { status: 202, body: '{}' } : { status: 403, body: 'blocked' });
						},
						onion ? 3000 : 10
					);
					signal?.addEventListener('abort', () => {
						if (over) return;
						clearTimeout(t);
						aborted.push(new URL(url).origin);
						reject(new Error('aborted'));
					});
				})
		});
		sender.enqueue(chatTrx('alice', 0), [twoAddresses]);
		await vi.advanceTimersByTimeAsync(3500);
		expect(aborted).toEqual([]);
		expect(sender.stats()).toMatchObject({ delivered: 1, failed: 0 });
	});

	it('review B, F3: when the onion then fails too, the answered refusal is the one failure', async () => {
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: (url) =>
				new Promise((resolve, reject) =>
					setTimeout(
						() =>
							url.startsWith(ONION)
								? reject(new Error('onion gave up'))
								: resolve({ status: 403, body: 'blocked' }),
						url.startsWith(ONION) ? 3000 : 10
					)
				)
		});
		sender.enqueue(chatTrx('alice', 0), [twoAddresses]);
		await vi.advanceTimersByTimeAsync(3500);
		const st = sender.stats();
		expect({ delivered: st.delivered, failed: st.failed }).toEqual({ delivered: 0, failed: 1 });
		expect(st.failures.some((f) => f.reason === 'HTTP 403')).toBe(true);
	});

	it('S-M5: when every address fails the push is one failure, with every reason kept', async () => {
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 4000,
			postIsolated: (url) =>
				Promise.reject(new Error(url.startsWith(ONION) ? 'onion gave up' : 'exit gave up'))
		});
		sender.enqueue(chatTrx('alice', 0), [twoAddresses]);
		await vi.advanceTimersByTimeAsync(100);
		const st = sender.stats();
		expect({ delivered: st.delivered, failed: st.failed }).toEqual({ delivered: 0, failed: 1 });
		expect(st.failures.map((f) => f.reason).sort()).toEqual(['exit gave up', 'onion gave up']);
	});
});

describe('S-L9: a given-up push closes its SOCKS stream at once', () => {
	it('the stream to a SOCKS port that never answers is closed when the push is given up', async () => {
		let closed!: () => void;
		const streamClosed = new Promise<void>((r) => (closed = r));
		let opened = 0;
		// A SOCKS port that accepts and then says nothing (Tor building a
		// circuit that never completes).
		const socks = net.createServer((c) => {
			opened++;
			c.resume();
			c.on('close', () => closed());
			c.on('error', () => undefined);
		});
		await new Promise<void>((r) => socks.listen(0, '127.0.0.1', r));
		try {
			const proxies = {
				torSocks: `127.0.0.1:${(socks.address() as AddressInfo).port}`,
				i2pHttpProxy: '',
				lokinet: false
			} as never;
			const ctrl = new AbortController();
			const push = postJsonViaTorIsolated(
				`${ONION}/x`,
				{},
				proxies,
				60_000,
				undefined,
				ctrl.signal
			);
			// Wait for the stream to exist, then give the push up.
			await vi.waitFor(() => expect(opened).toBe(1));
			ctrl.abort();
			await expect(push).rejects.toThrow();
			// Before the fix this waited out the 20 s handshake timeout, so the
			// test timed out here.
			await streamClosed;
		} finally {
			await new Promise<void>((r) => socks.close(() => r()));
		}
	}, 3000);
});
