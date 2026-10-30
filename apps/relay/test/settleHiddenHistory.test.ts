/**
 * settleTransfer on a relay whose RPC nodes are hidden services (.onion/.i2p).
 *
 * Measured on a real hidden-only node (2026-10-29): over Tor/I2P a 10-position
 * get_account_history page answered in about 34 s; 100 positions gave no
 * answer within 240 s, and 1000 never did. settleTransfer read 1000-position
 * pages, so on a hidden-only relay a payout whose broadcast outcome was unknown
 * could never be settled — it escalated to the operator every time.
 *
 * The stand-in hidden nodes here are reached the way the relay reaches real
 * ones: by .onion name, through the hidden-service router and a stand-in Tor
 * (SOCKS5) on loopback. Like the measured node, they answer slowly and give no
 * answer to a page over 50 positions (the connection is dropped).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	installHiddenServiceDispatcher,
	type HiddenDispatcherHandle
} from '@morphit/hidden-transport/router';
import { fakeSocks } from './notifyFakes.ts';
import { BlurtClient } from '../src/blurt/client.ts';

const RELAY = 'relayacct';
const TARGET_TX = 'f'.repeat(40);

function isoNoZ(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19);
}

interface Entry {
	trx_id: string;
	block: number;
	timestamp: string;
	op: [string, Record<string, unknown>];
}

/** `count` history entries of the relay account, newest at `newestMs`, one
 *  every `spacingMs`; the entry at `targetIdx` (if any) is our transfer. */
function history(count: number, newestMs: number, spacingMs: number, targetIdx = -1): Entry[] {
	const out: Entry[] = [];
	for (let i = 0; i < count; i++) {
		const t = newestMs - (count - 1 - i) * spacingMs;
		const ours = i === targetIdx;
		out.push({
			trx_id: ours ? TARGET_TX : i.toString(16).padStart(40, '0'),
			block: Math.floor(t / 3000),
			timestamp: isoNoZ(t),
			op: [
				'transfer',
				{
					from: RELAY,
					to: ours ? 'alice' : `user${i}`,
					amount: '10.000 BLURT',
					memo: ours ? 'morphit:welcome' : ''
				}
			]
		});
	}
	return out;
}

interface Node {
	port: number;
	/** limit of every get_account_history asked, in order. */
	limits: number[];
	b: {
		history: Entry[];
		delayMs: number;
		/** Pages over this many positions get no answer (connection dropped). */
		refuseOver: number;
		/** History pages answered before every later one hangs (no answer). */
		hangAfterPages?: number;
		/** History pages answered before every later one is dropped. */
		dropAfterPages?: number;
		/** Every history request hangs. */
		historyHang?: boolean;
		/** Every history request is answered with a redirect to this URL. */
		redirectHistoryTo?: string;
	};
}
const servers: http.Server[] = [];
async function node(host: string, b: Node['b']): Promise<Node> {
	const n: Node = { port: 0, limits: [], b };
	const srv = http.createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', async () => {
			const j = JSON.parse(body) as { id: number; method: string; params: unknown[] };
			const [method, params] =
				j.method === 'call'
					? [j.params[1] as string, j.params[2] as unknown[]]
					: [j.method.slice(j.method.lastIndexOf('.') + 1), j.params];
			await new Promise((r) => setTimeout(r, n.b.delayMs));
			const reply = (result: unknown): void => {
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
			};
			if (method === 'get_dynamic_global_properties') {
				const head = Math.floor(Date.now() / 3000);
				return reply({
					head_block_number: head,
					head_block_id: head.toString(16).padStart(8, '0') + 'ab'.repeat(16),
					time: isoNoZ(head * 3000),
					last_irreversible_block_num: head - 15
				});
			}
			if (method === 'get_account_history') {
				const [, rawStart, limit] = params as [string, number, number];
				n.limits.push(limit);
				const page = n.limits.length;
				if (n.b.historyHang) return;
				if (n.b.redirectHistoryTo !== undefined) {
					res.statusCode = 307;
					res.setHeader('location', n.b.redirectHistoryTo);
					return res.end();
				}
				if (n.b.hangAfterPages !== undefined && page > n.b.hangAfterPages) return;
				if (
					limit > n.b.refuseOver ||
					(n.b.dropAfterPages !== undefined && page > n.b.dropAfterPages)
				) {
					req.socket.destroy();
					return;
				}
				const h = n.b.history;
				const start = rawStart === -1 ? h.length - 1 : rawStart;
				const rows: unknown[] = [];
				for (let i = Math.max(0, start - limit); i <= start && i < h.length; i++) {
					rows.push([i, h[i]]);
				}
				return reply(rows);
			}
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'no' } }));
		});
	});
	srv.keepAliveTimeout = 1;
	await new Promise<void>((r) => srv.listen(0, host, () => r()));
	servers.push(srv);
	n.port = (srv.address() as AddressInfo).port;
	return n;
}
const onionOf = (letter: string, n: Node): string => `http://${letter.repeat(56)}.onion:${n.port}`;
const clearOf = (host: string, n: Node): string => `http://${host}:${n.port}`;
/** Pages read from a node (history requests made). */
const pages = (n: Node): number => n.limits.length;

afterAll(() => {
	for (const s of servers) {
		s.closeAllConnections();
		s.close();
	}
});

const ENV = ['MORPHIT_RPC_HEALTH_STATE', 'MORPHIT_HIDDEN_RPC_TIMEOUT_MS'];
const saved: Record<string, string | undefined> = {};
let dir = '';
let handle: HiddenDispatcherHandle | null = null;
let socks: Awaited<ReturnType<typeof fakeSocks>> | null = null;
beforeEach(async () => {
	for (const k of ENV) saved[k] = process.env[k];
	dir = mkdtempSync(join(tmpdir(), 'settle-hidden-'));
	process.env.MORPHIT_RPC_HEALTH_STATE = join(dir, 'rpc-health.json');
	// A short hidden per-call budget keeps the suite fast; the real one is 60 s.
	process.env.MORPHIT_HIDDEN_RPC_TIMEOUT_MS = '5000';
	socks = await fakeSocks();
});
afterEach(async () => {
	await handle?.uninstall();
	handle = null;
	await socks?.close();
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(dir, { recursive: true, force: true });
});

function relay(
	urls: string[],
	policy: 'refuse' | 'allow',
	settleHiddenWalkMs = 60_000
): BlurtClient {
	handle ??= installHiddenServiceDispatcher(
		{ torSocks: `127.0.0.1:${socks!.port}`, i2pHttpProxy: '' },
		policy
	);
	return new BlurtClient(urls, 3, { settleHiddenWalkMs });
}

/** The drainer's own question: did the payment with this txid land? */
function settle(blurt: BlurtClient, expirationMs: number) {
	return blurt.settleTransfer({
		account: RELAY,
		sinceMs: expirationMs - 15 * 60_000,
		expirationMs,
		match: (_op, _body, trxId) => trxId === TARGET_TX
	});
}

/** Slow like a hidden node: every reply takes 1.5 s (over real Tor a history
 *  page took about 34 s). A client that gives up on a read after 500 ms and
 *  sends it again — as dblurt does — asks each page several times. */
const slowHidden = (h: Entry[]): Node['b'] => ({ history: h, delayMs: 1500, refuseOver: 50 });

describe('hidden-only relay: an outcome-unknown payout can be settled', () => {
	it('finds the transfer on page 3, every page small enough to answer', async () => {
		const now = Date.now();
		const exp = now - 60_000;
		// One entry per block; the transfer (index 270) landed 27 s before its
		// expiration. With 10-position pages it is on page 3.
		const h = history(300, now, 3000, 270);
		const a = await node('127.0.0.1', slowHidden(h));
		const b = await node('127.0.0.1', slowHidden(h));
		const blurt = relay([onionOf('a', a), onionOf('b', b)], 'refuse');

		expect(await settle(blurt, exp)).toBe('found');
		for (const n of [a, b]) {
			expect(Math.max(...n.limits), 'no page the hidden node cannot answer').toBeLessThanOrEqual(
				50
			);
		}
		// Three pages, each asked once.
		expect(Math.max(pages(a), pages(b))).toBe(3);
		// Reached through the stand-in Tor, by onion name.
		expect(socks!.targets.some((t) => t.startsWith('a'.repeat(56)))).toBe(true);
	}, 30_000);

	it('proves "absent" from two operators once their walks pass the time bound', async () => {
		const now = Date.now();
		const exp = now - 60_000;
		// An entry every 30 s, our transfer nowhere: the 15-minute window ends
		// about 32 entries back, a few small pages.
		const h = history(300, now, 30_000);
		const a = await node('127.0.0.1', slowHidden(h));
		const b = await node('127.0.0.1', slowHidden(h));
		const blurt = relay([onionOf('c', a), onionOf('d', b)], 'refuse');

		expect(await settle(blurt, exp)).toBe('absent');
		expect(pages(a)).toBeGreaterThanOrEqual(3);
		expect(Math.max(...a.limits, ...b.limits)).toBeLessThanOrEqual(50);
	}, 30_000);
});

describe("a hidden walk may take longer than the pool's 60 s hidden floor", () => {
	it('the transfer 41 slow pages back is still found', async () => {
		const now = Date.now();
		// An entry a second; each 10-position page reaches 11 entries further
		// back, so the transfer at index 55 is on page 41. At 1.6 s a reply that
		// is about 67 s of reading: more than the pool's own 60 s floor for a
		// hidden endpoint, well inside the walk budget given here (120 s).
		const h = history(500, now, 1000, 55);
		const slow: Node['b'] = { ...slowHidden(h), delayMs: 1600 };
		const a = await node('127.0.0.1', slow);
		const b = await node('127.0.0.1', slow);
		const blurt = relay([onionOf('s', a), onionOf('t', b)], 'refuse', 120_000);

		const t0 = Date.now();
		expect(await settle(blurt, now - 60_000)).toBe('found');
		expect(Date.now() - t0, 'setup: the walk outlasted 60 s').toBeGreaterThan(60_000);
		expect(Math.max(pages(a), pages(b))).toBe(41);
	}, 150_000);
});

describe('an unreadable history stays "unknown", never "not landed"', () => {
	it('history that stops answering part-way through the window', async () => {
		const now = Date.now();
		const h = history(300, now, 30_000);
		const a = await node('127.0.0.1', { ...slowHidden(h), dropAfterPages: 2 });
		const b = await node('127.0.0.1', { ...slowHidden(h), dropAfterPages: 2 });
		const blurt = relay([onionOf('e', a), onionOf('f', b)], 'refuse');

		expect(await settle(blurt, now - 60_000)).toBe('unknown');
		expect(pages(a), 'setup: the walk did get two pages in').toBeGreaterThanOrEqual(3);
	}, 30_000);

	it('a walk that runs out of time before the time bound', async () => {
		const now = Date.now();
		const h = history(300, now, 30_000);
		const mk = async () => node('127.0.0.1', slowHidden(h));
		const a = await mk();
		const b = await mk();
		// The head read and about 4 pages are needed at 1.5 s each; 4 s is not enough.
		const blurt = relay([onionOf('g', a), onionOf('h', b)], 'refuse', 4000);
		expect(await settle(blurt, now - 60_000)).toBe('unknown');

		// Control: the same nodes with time to finish prove it absent.
		const c = await mk();
		const d = await mk();
		const roomy = relay([onionOf('i', c), onionOf('j', d)], 'refuse', 60_000);
		expect(await settle(roomy, now - 60_000)).toBe('absent');
	}, 30_000);
});

describe('one hidden page that never answers costs one per-call budget, not the walk', () => {
	it("an operator's address that hangs mid-walk is left for its other address", async () => {
		const now = Date.now();
		const h = history(300, now, 30_000);
		const hangs = await node('127.0.0.1', { ...slowHidden(h), hangAfterPages: 1 });
		const x2 = await node('127.0.0.1', slowHidden(h));
		const y = await node('127.0.0.1', slowHidden(h));
		const urlHang = onionOf('k', hangs);
		const urlX2 = onionOf('l', x2);
		const urlY = onionOf('m', y);
		// Walk budget 60 s; per-call budget 5 s (MORPHIT_HIDDEN_RPC_TIMEOUT_MS).
		const blurt = relay([urlHang, urlY], 'refuse', 60_000);
		blurt.mergeRpcEndpoints([urlX2], { [urlHang]: 'x', [urlX2]: 'x', [urlY]: 'y' });

		const t0 = Date.now();
		expect(await settle(blurt, now - 60_000)).toBe('absent');
		expect(pages(hangs), 'setup: the hanging address was asked first').toBeGreaterThanOrEqual(2);
		expect(pages(x2), "the operator's other address answered").toBeGreaterThan(0);
		expect(Date.now() - t0).toBeLessThan(30_000);
		const ep = blurt.endpointSnapshot().find((e) => e.url === urlHang)!;
		expect(ep.consecutiveFailures, 'the hanging address is cooled down').toBeGreaterThan(0);
	}, 60_000);
});

describe('a hidden read sent once is still guarded like every other RPC read', () => {
	it('a node that redirects the history read is not followed', async () => {
		const now = Date.now();
		const h = history(300, now, 3000, 270);
		// Where the redirect points: a node that would say "found".
		const elsewhere = await node('127.0.0.1', slowHidden(h));
		const elsewhereUrl = onionOf('p', elsewhere);
		const a = await node('127.0.0.1', { ...slowHidden(h), redirectHistoryTo: elsewhereUrl });
		const b = await node('127.0.0.1', { ...slowHidden(h), redirectHistoryTo: elsewhereUrl });
		const blurt = relay([onionOf('q', a), onionOf('r', b)], 'refuse');

		expect(await settle(blurt, now - 60_000)).toBe('unknown');
		expect(pages(a), 'setup: the history read was made').toBeGreaterThan(0);
		expect(pages(elsewhere), 'the redirect was never followed').toBe(0);
	}, 30_000);
});

describe('clearnet nodes are read exactly as before', () => {
	it('1000-position pages on a clearnet node', async () => {
		const now = Date.now();
		const h = history(300, now, 3000, 270);
		const big: Node['b'] = { history: h, delayMs: 0, refuseOver: 10_000 };
		const a = await node('127.0.0.31', big);
		const b = await node('127.0.0.32', big);
		const blurt = relay([clearOf('127.0.0.31', a), clearOf('127.0.0.32', b)], 'allow');
		expect(await settle(blurt, now - 60_000)).toBe('found');
		expect(a.limits[0]).toBe(1000);
		expect(b.limits[0]).toBe(1000);
	}, 30_000);

	it('mixed pool: a clearnet walk still has 10 s in all, not the hidden budget', async () => {
		const now = Date.now();
		// An entry every 0.4 s: the 15-minute window is about 2,400 entries, three
		// 1000-position pages. Each read takes 1.2 s at the node — about 3 s
		// through dblurt, which cuts a read off at 500 ms, then 1 s, and resends
		// it — so the head read and three pages need about 12 s.
		const h = history(3000, now, 400);
		const slowClear = (delayMs: number): Node['b'] => ({ history: h, delayMs, refuseOver: 10_000 });
		const c1 = await node('127.0.0.34', slowClear(1200));
		const c2 = await node('127.0.0.35', slowClear(1200));
		// A hidden node in the pool (down) is what raises the pool's own timer.
		const down = await node('127.0.0.1', slowHidden(h));
		const downUrl = onionOf('u', down);
		servers.at(-1)!.close();
		servers.at(-1)!.closeAllConnections();
		const urls = [clearOf('127.0.0.34', c1), clearOf('127.0.0.35', c2), downUrl];
		const blurt = relay(urls, 'allow', 60_000);
		const t0 = Date.now();
		expect(await settle(blurt, now - 60_000)).toBe('unknown');
		expect(Date.now() - t0).toBeLessThan(20_000);

		// Control: the same clearnet nodes, answering at once, prove it absent.
		const c3 = await node('127.0.0.36', slowClear(0));
		const c4 = await node('127.0.0.37', slowClear(0));
		const quick = relay([clearOf('127.0.0.36', c3), clearOf('127.0.0.37', c4), downUrl], 'allow');
		expect(await settle(quick, now - 60_000)).toBe('absent');
	}, 60_000);
});
