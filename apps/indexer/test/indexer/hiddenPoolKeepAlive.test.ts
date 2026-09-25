/**
 * The idle keep-alive, and the warm-up interval that has to fit inside it.
 *
 * WHY THIS FILE EXISTS. `KEEP_ALIVE_MS` (hiddenServicePool, 4 min) and
 * `WARM_INTERVAL_MS` (chatFastDispatcher, 3 min) are two constants in two files
 * with a live relationship neither of them names, and nothing asserted it. Set
 * the keep-alive below the warm interval and every warm-up finds a closed
 * socket: the loop that exists to REMOVE the cold-start cost starts paying it
 * instead, on a timer, forever. Nothing about that failure announces itself —
 * messages still arrive, the warm-up still reports success, and only the
 * latency moves, on precisely the transports where a rebuild is thirty to sixty
 * seconds rather than a millisecond.
 *
 * It was found by mutation: lowering `KEEP_ALIVE_MS` to 1 ms left the entire
 * battery green, because every existing reuse check sends its messages
 * back-to-back and undici reuses a socket that has had no chance to go idle.
 * The pooling tests are not wrong; they simply cannot see this.
 *
 * TWO PARTS, and the first is what makes the second more than a spelling test.
 *
 * The mechanism is DEMONSTRATED at millisecond scale: an idle period longer
 * than the keep-alive really does cost a new tunnel, and one shorter than it
 * really does not. That establishes the cliff exists and where it is. Only then
 * is it worth asserting that the shipped constants sit on the safe side of it —
 * which is a claim about two numbers, and would be an empty one if the cliff
 * they straddle had never been shown to be real.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
	createConnection,
	createServer as createTcpServer,
	type Server as TcpServer,
	type Socket
} from 'node:net';
import { readFileSync } from 'node:fs';
import { Agent, request } from 'undici';
import { makeHttpConnectConnector } from '@morphit/hidden-transport';
import { KEEP_ALIVE_MS, KEEP_ALIVE_MAX_MS } from '$indexer/hiddenServicePool';
import { WARM_INTERVAL_MS } from '$indexer/chatFastDispatcher';

const I2P_HOST = `${'b'.repeat(52)}.b32.i2p`;

interface Rig {
	/** How many tunnels the proxy has been asked to open. */
	connects: () => number;
	agentFor: (keepAliveTimeout: number) => Agent;
	close: () => Promise<void>;
}

/**
 * A real CONNECT proxy spliced to a real origin — the same shape the federation
 * smoke uses. Nothing on this machine answers for a `.b32.i2p` hostname, so a
 * request arriving at the origin is proof the tunnel carried it.
 */
async function rig(): Promise<Rig> {
	let connects = 0;
	const agents: Agent[] = [];

	const origin: Server = createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"ok":true}');
		});
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
	const originPort = (origin.address() as { port: number }).port;

	const proxy: Server = createServer((_req, res) => res.writeHead(400).end());
	proxy.on('connect', (_req, clientSocket, head: Buffer) => {
		connects++;
		const upstream = createConnection({ host: '127.0.0.1', port: originPort }, () => {
			clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head?.length) upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
		});
		upstream.on('error', () => clientSocket.destroy());
		clientSocket.on('error', () => upstream.destroy());
	});
	await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
	const proxyPort = (proxy.address() as { port: number }).port;

	return {
		connects: () => connects,
		agentFor: (keepAliveTimeout: number) => {
			const a = new Agent({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici's
				// connect type doesn't model a custom tunnelling connector cleanly.
				connect: makeHttpConnectConnector('127.0.0.1', proxyPort) as any,
				keepAliveTimeout,
				keepAliveMaxTimeout: keepAliveTimeout,
				connections: 1
			});
			agents.push(a);
			return a;
		},
		close: async () => {
			for (const a of agents) await a.close().catch(() => undefined);
			proxy.closeAllConnections?.();
			await new Promise<void>((r) => proxy.close(() => r()));
			origin.closeAllConnections?.();
			await new Promise<void>((r) => origin.close(() => r()));
		}
	};
}

const live: Rig[] = [];
afterEach(async () => {
	for (const r of live) await r.close();
	live.length = 0;
});

async function post(agent: Agent): Promise<void> {
	const res = await request(`http://${I2P_HOST}/v1/federation/chat-fast`, {
		method: 'POST',
		body: '{}',
		headers: { 'content-type': 'application/json' },
		dispatcher: agent
	});
	await res.body.text();
}

const idle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('an idle tunnel survives exactly as long as the keep-alive says', () => {
	it('a gap SHORTER than the keep-alive reuses the tunnel', async () => {
		const r = await rig();
		live.push(r);
		const agent = r.agentFor(2_000);

		await post(agent);
		const afterFirst = r.connects();
		await idle(150);
		await post(agent);

		expect(afterFirst, 'the first message builds the tunnel').toBe(1);
		expect(
			r.connects() - afterFirst,
			'a socket idle for less than its keep-alive must still be there'
		).toBe(0);
	});

	/**
	 * The cliff itself. This is the behaviour a keep-alive shorter than the warm
	 * interval would produce on every single warm-up.
	 */
	it('a gap LONGER than the keep-alive costs a fresh tunnel', async () => {
		const r = await rig();
		live.push(r);
		const agent = r.agentFor(60);

		await post(agent);
		const afterFirst = r.connects();
		await idle(400);
		await post(agent);

		expect(afterFirst).toBe(1);
		expect(
			r.connects() - afterFirst,
			'past the keep-alive the socket is gone and the tunnel is rebuilt — which is ' +
				'a millisecond here and thirty to sixty seconds on a real hidden network'
		).toBe(1);
	});
});

/**
 * Now the constants, which mean something only because the cliff above is real.
 *
 * These are deliberately expressed as the RELATIONSHIP rather than as the
 * literal values: the point is not that the keep-alive is four minutes, it is
 * that whatever it is, a warm-up never lands on the far side of it. Changing
 * either number freely is fine; changing them into the wrong order is not.
 */
describe('the shipped constants sit on the safe side of that cliff', () => {
	it('the keep-alive outlasts the warm-up interval', () => {
		expect(
			KEEP_ALIVE_MS,
			'a keep-alive shorter than the gap between warm-ups means every warm-up finds a ' +
				'closed socket, so the loop that removes the cold-start cost pays it instead'
		).toBeGreaterThan(WARM_INTERVAL_MS);
	});

	/**
	 * And the other side. Tor reclaims an idle circuit at roughly ten minutes,
	 * so a keep-alive past that holds a connection the network has already
	 * dropped — the first message over it then fails or stalls rather than being
	 * fast, which is worse than having rebuilt it deliberately.
	 */
	it('the keep-alive stays inside the circuit idle timeout it is protecting', () => {
		const TOR_CIRCUIT_IDLE_MS = 10 * 60 * 1000;
		expect(KEEP_ALIVE_MS).toBeLessThan(TOR_CIRCUIT_IDLE_MS);
		expect(KEEP_ALIVE_MAX_MS).toBeLessThan(TOR_CIRCUIT_IDLE_MS);
	});

	/** The negotiated ceiling cannot be below the value it is a ceiling for. */
	it('the negotiable maximum is not below the default', () => {
		expect(KEEP_ALIVE_MAX_MS).toBeGreaterThanOrEqual(KEEP_ALIVE_MS);
	});
});

/**
 * THE PEER'S HALF (v1.18.0 review, S5). The idle lifetime that decides whether
 * a warm-up keeps a connection is the SHORTER of ours and the peer's. Every
 * test above — and F13's fix — looked only at ours. A peer's Tor and I2P
 * services land on the frontend nginx, which set no `keepalive_timeout`, so
 * nginx's default of 75 seconds applied: every peer closed our warmed
 * connection long before the next three-minute warm-up, and nginx sends no
 * Keep-Alive hint, so undici could not know to expect it.
 *
 * Demonstrated first, as above: a peer that drops idle connections quickly
 * costs a fresh tunnel after a gap our own keep-alive would have survived.
 */
describe('the peer’s idle timeout counts as much as ours', () => {
	/** An origin that answers, then closes any connection idle for `idleMs` —
	 *  nginx's behaviour, including sending no Keep-Alive hint. */
	async function closingOrigin(idleMs: number): Promise<{ port: number; server: TcpServer }> {
		const server = createTcpServer((sock: Socket) => {
			let buf = '';
			let timer: NodeJS.Timeout | null = null;
			const arm = (): void => {
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => sock.end(), idleMs);
			};
			sock.on('data', (d) => {
				buf += d.toString('latin1');
				for (;;) {
					const end = buf.indexOf('\r\n\r\n');
					if (end < 0) return;
					const len = Number(/content-length:\s*(\d+)/i.exec(buf.slice(0, end))?.[1] ?? 0);
					if (buf.length < end + 4 + len) return;
					buf = buf.slice(end + 4 + len);
					const body = '{"ok":true}';
					sock.write(
						`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`
					);
					arm();
				}
			});
			sock.on('close', () => timer && clearTimeout(timer));
			sock.on('error', () => undefined);
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		return { port: (server.address() as { port: number }).port, server };
	}

	it('a peer that closes idle connections sooner than we would costs a fresh tunnel', async () => {
		const origin = await closingOrigin(60);
		let connects = 0;
		const proxy: Server = createServer((_q, res) => res.writeHead(400).end());
		proxy.on('connect', (_req, client, head: Buffer) => {
			connects++;
			const up = createConnection({ host: '127.0.0.1', port: origin.port }, () => {
				client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				if (head?.length) up.write(head);
				up.pipe(client);
				client.pipe(up);
			});
			up.on('error', () => client.destroy());
			client.on('error', () => up.destroy());
		});
		await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
		const agent = new Agent({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
			connect: makeHttpConnectConnector(
				'127.0.0.1',
				(proxy.address() as { port: number }).port
			) as any,
			keepAliveTimeout: 5_000, // OUR side would keep it far longer than the gap
			keepAliveMaxTimeout: 5_000,
			connections: 1
		});
		try {
			await post(agent);
			await idle(400);
			await post(agent);
			expect(
				connects,
				'the peer closed the idle connection, so the second message paid for a new tunnel'
			).toBe(2);
		} finally {
			await agent.close().catch(() => undefined);
			proxy.closeAllConnections?.();
			await new Promise<void>((r) => proxy.close(() => r()));
			await new Promise<void>((r) => origin.server.close(() => r()));
		}
	});

	/**
	 * So the frontend every hidden service lands on must keep an idle
	 * connection longer than the gap between warm-ups, and should outlast our
	 * own keep-alive so it is always US that closes an idle connection — never
	 * a peer's close crossing our next message on the wire. It also names its
	 * timeout in a Keep-Alive header, which undici honours.
	 */
	it('the shipped frontend nginx keeps idle connections past the warm-up interval', () => {
		const conf = readFileSync(
			new URL('../../../../ops/bunkerweb/frontend/nginx.conf', import.meta.url),
			'utf8'
		);
		const m = /^\s*keepalive_timeout\s+(\d+)s(?:\s+(\d+)s)?\s*;/m.exec(conf);
		expect(
			m,
			'no keepalive_timeout: nginx falls back to 75 s, well inside the warm-up interval'
		).not.toBeNull();
		const idleMs = Number(m![1]) * 1000;
		const hintMs = Number(m![2] ?? 0) * 1000;
		expect(idleMs).toBeGreaterThan(WARM_INTERVAL_MS);
		expect(
			idleMs,
			'the peer should outlast our own keep-alive, so we close first'
		).toBeGreaterThanOrEqual(KEEP_ALIVE_MS);
		expect(
			hintMs,
			'the Keep-Alive header tells a client how long the connection will live'
		).toBeGreaterThan(WARM_INTERVAL_MS);
		expect(hintMs).toBeLessThanOrEqual(KEEP_ALIVE_MAX_MS);
	});
});
