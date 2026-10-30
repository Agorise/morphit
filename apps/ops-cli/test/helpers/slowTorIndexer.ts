/**
 * Test helpers: this node's indexer as a hidden-only node sees it — every chain
 * read relayed over Tor/I2P — and a clock the test advances.
 *
 * Measured through morphitlat's indexer (v1.21.16): the chain head (995 bytes)
 * took 7.9 s, 10 entries of @morphit's history (23,646 bytes) 33.7 s, and 100
 * or 1000 entries never came within 240 s. The stand-in answers after
 * MS_PER_KB of simulated time per KB of its answer, and never answers a page of
 * more than MAX_ENTRIES entries.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';

export const MS_PER_KB = 3_000;
export const MAX_ENTRIES = 50;

/** The stand-ins now listening: requests each has taken but not yet answered,
 *  held or left hanging (`pending`), answers it holds on the simulated clock
 *  (`scheduled`), and requests arrived in all. underSimulatedTime reads it so
 *  the clock never runs ahead of a request still crossing the socket or still
 *  being read. */
interface Live {
	pending: number;
	scheduled: number;
	arrived: number;
}
const live = new Set<Live>();

/** An account's history: positions 0..top, `entries` the ones an answer lists
 *  (the chain's fee for each op takes a position the answer leaves out). */
export interface PagedHistory {
	readonly top: number;
	readonly entries: ReadonlyArray<readonly [number, unknown]>;
	readonly blocks: Readonly<Record<number, unknown>>;
}

/** get_account_history as Blurt answers it: positions from-limit .. from
 *  (from = -1: the newest), and an error when from < limit. */
export function historyPage(h: PagedHistory, params: readonly unknown[]): unknown[] {
	const [, from, limit] = params as [string, number, number];
	if (from !== -1 && from < limit) throw new Error('start must be greater than limit');
	const hi = from === -1 ? h.top : from;
	const lo = Math.max(0, hi - limit);
	return h.entries.filter(([s]) => s >= lo && s <= hi);
}

export interface SlowIndexer {
	readonly base: string;
	historyReads(): number;
	close(): Promise<void>;
}

/** This node's indexer on a hidden-only node: `/v1/release`, `/v1/instances`
 *  and the `/v1/chain/condenser` relay, slow as Tor/I2P. */
export async function slowIndexer(o: {
	history: PagedHistory;
	release?: unknown;
	instances?: unknown;
}): Promise<SlowIndexer> {
	let historyReads = 0;
	const hanging = new Set<ServerResponse>();
	const state: Live = { pending: 0, scheduled: 0, arrived: 0 };
	live.add(state);
	const server: Server = createServer((req, res) => {
		state.arrived++;
		state.pending++;
		const send = (status: number, body: unknown): void => {
			state.pending--;
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (req.url === '/v1/instance')
			return send(200, { clearnet_eliminated: true, clearnet_eliminated_missing: [] });
		if (req.url === '/v1/release')
			return o.release !== undefined ? send(200, o.release) : send(404, {});
		if (req.url === '/v1/instances') return send(200, o.instances ?? { instances: [] });
		if (req.url === '/v1/chain/condenser' && req.method === 'POST') {
			let body = '';
			req.on('data', (d) => (body += d));
			req.on('end', () => {
				const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
				let result: unknown;
				try {
					if (method === 'get_account_history') {
						historyReads++;
						result = historyPage(o.history, params);
					} else if (method === 'get_block') {
						result = o.history.blocks[Number(params[0])] ?? null;
					} else return send(400, { message: 'method not allowed' });
				} catch (err) {
					return send(502, { message: String(err) });
				}
				// Over Tor/I2P a large page never comes: the reader waits for nothing.
				if (Array.isArray(result) && result.length > MAX_ENTRIES) {
					state.pending--;
					hanging.add(res);
					return;
				}
				const text = JSON.stringify({ result });
				state.pending--;
				state.scheduled++;
				setTimeout(
					() => {
						state.scheduled--;
						res.writeHead(200, { 'content-type': 'application/json' });
						res.end(text);
					},
					Math.ceil((Buffer.byteLength(text) / 1024) * MS_PER_KB)
				);
			});
			return;
		}
		send(404, {});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${port}`,
		historyReads: () => historyReads,
		close: () =>
			new Promise<void>((r) => {
				live.delete(state);
				for (const h of hanging) h.destroy();
				server.closeAllConnections();
				server.close(() => r());
			})
	};
}

/** Simulated timers (sockets and setImmediate stay real). */
export function useSimulatedTimers(): void {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
}

/** Real time the clock waits, when no stand-in holds an answer, for a request
 *  that may still be crossing the socket. */
export const IDLE_GRACE_MS = 25;
/** Real time the clock waits at most for a stand-in to finish reading a
 *  request it has taken. */
export const READ_GRACE_MS = 10_000;

// Real clocks, kept before any test fakes one.
const realNow = performance.now.bind(performance);
const holding = (): boolean => [...live].some((s) => s.scheduled > 0);
const reading = (): boolean => [...live].some((s) => s.pending > 0);
const arrivedSoFar = (): number => [...live].reduce((n, s) => n + s.arrived, 0);

/** Run `p` while the simulated clock advances a second at a time and the
 *  sockets get real turns in between. It never moves while a stand-in is still
 *  reading a request it took (up to READ_GRACE_MS of real time). While a
 *  stand-in holds an answer the clock runs on; otherwise it first waits up to
 *  IDLE_GRACE_MS of real time for a request to arrive. On a loaded machine a request can take
 *  many event-loop turns to cross the socket, and a clock that ran on counted
 *  that against the reader's deadline (the full suite timed out there).
 *  Gives up after `maxSimMs`. */
export async function underSimulatedTime<T>(p: Promise<T>, maxSimMs = 30 * 60_000): Promise<T> {
	let settled = false;
	p.then(
		() => (settled = true),
		() => (settled = true)
	);
	for (let t = 0; !settled && t < maxSimMs; t += 1_000) {
		await vi.advanceTimersByTimeAsync(1_000);
		for (let i = 0; i < 5 && !settled; i++) await new Promise((r) => setImmediate(r));
		if (settled || live.size === 0) continue;
		const readUntil = realNow() + READ_GRACE_MS;
		while (!settled && reading() && realNow() < readUntil)
			await new Promise((r) => setImmediate(r));
		if (settled || holding()) continue;
		const seen = arrivedSoFar();
		const until = realNow() + IDLE_GRACE_MS;
		while (!settled && !holding() && arrivedSoFar() === seen && realNow() < until)
			await new Promise((r) => setImmediate(r));
		while (!settled && reading() && realNow() < readUntil + READ_GRACE_MS)
			await new Promise((r) => setImmediate(r));
		for (let i = 0; i < 5 && !settled; i++) await new Promise((r) => setImmediate(r));
	}
	return p;
}
