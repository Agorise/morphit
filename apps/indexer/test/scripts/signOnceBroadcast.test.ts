/**
 * the laptop broadcast scripts sign ONCE and fall back
 * through health-ranked nodes with that same transaction.
 *
 * Before: each script called dblurt's `customJson` per node in a fixed order,
 * which builds and signs a NEW transaction against each node's head. A node that
 * accepted but whose answer was lost was followed by a different transaction
 * carrying the same op — a second release op on chain from one ceremony.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, Socket, type Server } from 'node:net';
import { PrivateKey } from '@beblurt/dblurt';
import {
	DEFAULT_BLURT_RPC_ENDPOINTS,
	DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS
} from '@morphit/operator-config';
import {
	answersHttpProxy,
	answersSocks5,
	chooseNodes,
	detectLocalProxies,
	hiddenModeFromArgs,
	hostHiddenOnly,
	prepareNodes,
	rankNodes,
	signOnceAndBroadcast,
	type NodeHealth
} from '../../scripts/lib/signOnceBroadcast';

const key = PrivateKey.fromSeed('d12-test');
const props = (n: number) => ({
	head_block_number: n,
	head_block_id: `${n.toString(16).padStart(8, '0')}aabbccdd${'0'.repeat(24)}`,
	time: '2026-09-27T12:00:00'
});
const ok = (url: string, ms: number, head = 100): NodeHealth => ({
	url,
	ok: true,
	ms,
	headBlock: head,
	props: props(head)
});
const op = [
	[
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: ['morphit'],
			id: 'morphit_release_v1',
			json: '{}'
		}
	]
] as never;

describe('sign once, broadcast to ranked nodes (D12)', () => {
	const clock = () => {
		let t = 1_000_000;
		return { now: () => t, sleep: async (ms: number) => void (t += ms) };
	};
	it('ranks current, fast nodes first and silent ones last', async () => {
		const table: Record<string, NodeHealth> = {
			a: { url: 'a', ok: false, ms: 1, headBlock: null, reason: 'down' },
			b: ok('b', 50),
			c: ok('c', 10),
			d: ok('d', 5, 90)
		};
		const r = await rankNodes(['a', 'b', 'c', 'd'], { probe: async (u) => table[u]! });
		expect(r.map((h) => h.url)).toEqual(['c', 'b', 'd', 'a']);
	});

	it('the SAME signed transaction goes to every node tried — never a re-sign', async () => {
		const got: Array<{ url: string; tx: unknown }> = [];
		const res = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2), ok('c', 3)], {
			log: () => undefined,
			send: async (url, tx) => {
				got.push({ url, tx: JSON.parse(JSON.stringify(tx)) });
				if (url !== 'c') throw new Error('socket hang up');
				return { block_num: 7 };
			}
		});
		expect(got.map((g) => g.url)).toEqual(['a', 'b', 'c']);
		expect(got[1]!.tx, 'a fallback node was handed a different transaction').toEqual(got[0]!.tx);
		expect(got[2]!.tx).toEqual(got[0]!.tx);
		expect(res).toMatchObject({ via: 'c', blockNum: 7, duplicate: false });
	});

	it('"duplicate transaction" from a later node means an earlier attempt landed: success, same id', async () => {
		const res = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: () => undefined,
			...clock(),
			getTx: async () => null,
			send: async (url) => {
				if (url === 'a') throw new Error('timeout');
				throw new Error('Duplicate transaction check failed');
			}
		});
		expect(res.duplicate).toBe(true);
		expect(res.via).toBe('b');
	});

	it('an expired transaction stops the run — it is never re-signed automatically', async () => {
		let t = 0;
		const sent: number[] = [];
		await expect(
			signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
				log: () => undefined,
				now: () => t,
				send: async () => {
					sent.push(t);
					t += 60_000;
					throw new Error('timeout');
				}
			})
		).rejects.toThrow(/expired before any node confirmed/);
		expect(sent.length).toBe(1);
	});

	it('one node claiming a higher head is not used for TaPoS unless another node confirms that block', async () => {
		const liar: NodeHealth = { url: 'liar', ok: true, ms: 1, headBlock: 5000, props: props(5000) };
		const sent: Array<{ ref_block_num: number }> = [];
		await signOnceAndBroadcast(op, key, [liar, ok('b', 2, 101), ok('c', 3, 100)], {
			log: () => undefined,
			// b knows block 100 with the id c reported; nobody has the liar's block 5000.
			getBlock: async (url, num) =>
				num === 100 && url === 'b' ? { block_id: props(100).head_block_id } : null,
			sleep: async () => undefined,
			send: async (_url, tx) => {
				sent.push(tx as { ref_block_num: number });
				return { block_num: 102 };
			}
		});
		expect(sent[0]!.ref_block_num, 'built on the unconfirmed head of one node').toBe(100);
	});

	it('"accepted" is checked on another node; a lone claim is reported as not confirmed', async () => {
		const lines: string[] = [];
		const lone = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: (l) => void lines.push(l),
			getBlock: async () => ({ block_id: 'x', transaction_ids: [] }),
			sleep: async () => undefined,
			send: async () => ({ block_num: 101 })
		});
		expect(lone.confirmedBy).toBeNull();
		expect(lines.join('\n')).toMatch(/NOT confirmed by a second node/);
		const seen = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: () => undefined,
			getBlock: async (url) =>
				url === 'b' ? { block_id: 'x', transaction_ids: [lone.trxId] } : null,
			sleep: async () => undefined,
			send: async () => ({ block_num: 101 })
		});
		expect(seen.confirmedBy).toBe('b');
	});
	// 2026-10-07 (snapshot anchor): dblurt's send uses the asynchronous
	// broadcast_transaction, which answers without a block number, so nothing
	// was checked and the run said "NOT confirmed by a second node" for a
	// transaction that was in a block. Now the other nodes are asked for the
	// transaction by its id, and the block they name is checked for it.

	it('accepted without a block number: found by id on another node, then seen in that block', async () => {
		const lines: string[] = [];
		const c = clock();
		let id = '';
		const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2), ok('c', 3)], {
			log: (l) => void lines.push(l),
			...c,
			getTx: async (url, trx) => {
				id = trx;
				return url === 'b' ? { block_num: 105, transaction_id: trx } : null;
			},
			getBlock: async (url, num) =>
				num === 105
					? { block_id: 'x', transaction_ids: [id] }
					: { block_id: 'x', transaction_ids: [] },
			send: async () => ({})
		});
		expect(r.blockNum).toBe(105);
		expect(r.confirmedBy).not.toBeNull();
		expect(r.confirmedBy).not.toBe('a');
		expect(lines.join('\n')).toMatch(/Confirmed: .* has transaction .* in block 105/);
		expect(lines.join('\n')).not.toMatch(/NOT confirmed/);
	});

	it('an answer without the id, with a block before the head, or whose block lacks it is not a confirmation', async () => {
		// Each case breaks one rule only: in the first three the block the answer
		// names lists the transaction, so only the answer itself can reject it.
		for (const [answer, blockLists] of [
			[(_trx: string) => ({ block_num: 105, transaction_id: 'f'.repeat(40) }), true], // another id
			[(trx: string) => ({ block_num: 90, transaction_id: trx }), true], // before the head it was built on
			[(trx: string) => ({ block_num: 5_000, transaction_id: trx }), true], // after it expired
			[(trx: string) => ({ block_num: 105, transaction_id: trx }), false] // the block does not list it
		] as const) {
			const lines: string[] = [];
			let id = '';
			const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
				log: (l) => void lines.push(l),
				...clock(),
				getTx: async (_url, trx) => {
					id = trx;
					return answer(trx);
				},
				// Only the block the answer names exists (no new block yet for the
				// scan of new blocks), and it lists the id unless this case says not.
				getBlock: async (_u, num) =>
					num === answer(id).block_num
						? { block_id: 'x', transaction_ids: blockLists ? [id] : [] }
						: null,
				send: async () => ({})
			});
			expect(r.confirmedBy).toBeNull();
			expect(lines.join('\n')).toMatch(/NOT confirmed by a second node/);
		}
	});

	it('the block is checked on a node other than the one that answered, when there is one', async () => {
		let id = '';
		const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2), ok('c', 3)], {
			log: () => undefined,
			...clock(),
			getTx: async (url, trx) => {
				id = trx;
				return url === 'b' ? { block_num: 104, transaction_id: trx } : null;
			},
			getBlock: async (_u, num) => (num === 104 ? { block_id: 'x', transaction_ids: [id] } : null),
			send: async () => ({})
		});
		expect(r.blockNum).toBe(104);
		expect(r.confirmedBy, 'b confirmed its own answer').toBe('c');
	});

	it('the other nodes are asked in parallel each round, and the wait ends when the transaction has expired', async () => {
		const c = clock();
		const start = c.now();
		const calls: string[] = [];
		const nodes = [ok('a', 1), ok('b', 2), ok('c', 3), ok('d', 4)];
		await signOnceAndBroadcast(op, key, nodes, {
			log: () => undefined,
			...c,
			getTx: async (url) => {
				calls.push(url);
				return null;
			},
			getBlock: async () => ({ block_id: 'x', transaction_ids: [] }),
			send: async () => ({})
		});
		const waited = c.now() - start;
		expect(waited).toBeLessThanOrEqual(60_000 + 6_000 + 3_000);
		// Every round asks all three other nodes.
		expect(calls.length % 3).toBe(0);
		expect(calls.filter((u) => u === 'a').length).toBe(0);
	});

	// 2026-10-08 (v1.21.2 release broadcast): in block 64,311,469 within ~12 s,
	// but the look-up by id found it only after ~55 s, close to the give-up time.
	it('found in a new block as soon as another node serves it, without waiting for the look-up by id', async () => {
		const lines: string[] = [];
		let id = '';
		const c = clock();
		const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2), ok('c', 3)], {
			log: (l) => void lines.push(l),
			...c,
			// The look-up by id never knows it (its index lags).
			getTx: async (_u, trx) => {
				id = trx;
				return null;
			},
			// Blocks 101 and 102 are out without it; 103 lists it; 104 is not out yet.
			getBlock: async (_u, num) =>
				num <= 102
					? { block_id: 'x', transaction_ids: [] }
					: num === 103
						? { block_id: 'x', transaction_ids: [id] }
						: null,
			send: async () => ({})
		});
		expect(r.blockNum).toBe(103);
		expect(r.confirmedBy).not.toBeNull();
		expect(r.confirmedBy, 'the node it was sent to confirmed itself').not.toBe('a');
		expect(lines.join('\n')).toMatch(/Confirmed: .* in block 103/);
		expect(
			lines.filter((l) => /round \d+:/.test(l)).length,
			'it waited rounds for the look-up'
		).toBe(0);
	});

	it('a block only the node it was sent to serves is not a confirmation', async () => {
		let id = '';
		const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: () => undefined,
			...clock(),
			getTx: async (_u, trx) => {
				id = trx;
				return null;
			},
			getBlock: async (u, num) =>
				u === 'a' && num === 101 ? { block_id: 'x', transaction_ids: [id] } : null,
			send: async () => ({})
		});
		expect(r.confirmedBy).toBeNull();
	});

	it('no block after the last one the transaction can be in is read', async () => {
		const asked: number[] = [];
		await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: () => undefined,
			...clock(),
			getTx: async () => null,
			getBlock: async (_u, num) => {
				asked.push(num);
				return { block_id: 'x', transaction_ids: [] };
			},
			send: async () => ({})
		});
		// Built on head 100; it expires 60 s (20 blocks) later, plus two.
		expect(Math.max(...asked)).toBeLessThanOrEqual(100 + 20 + 2);
		expect(Math.min(...asked)).toBe(101);
	});

	it('"duplicate transaction": the block is looked up by id too', async () => {
		let id = '';
		const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: () => undefined,
			...clock(),
			getTx: async (_url, trx) => {
				id = trx;
				return { block_num: 103, transaction_id: trx };
			},
			getBlock: async (_u, num) => (num === 103 ? { block_id: 'x', transaction_ids: [id] } : null),
			send: async () => {
				throw new Error('Duplicate transaction check failed');
			}
		});
		expect(r.duplicate).toBe(true);
		expect(r.blockNum).toBe(103);
	});
});

describe('which nodes a laptop run asks: the hidden ones it can reach (v1.21.18)', () => {
	const onion = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.filter((u) => u.includes('.onion'));
	const i2p = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.filter((u) => u.includes('.i2p'));
	const found = (tor: string | null, i2pp: string | null) => async () => ({ tor, i2p: i2pp });

	it('Tor and i2pd on this machine: every node, clearnet and hidden, routed through them', async () => {
		const c = await chooseNodes(
			{ nodeOverride: null, hidden: 'auto' },
			{ env: {}, detect: found('127.0.0.1:9150', '127.0.0.1:4444') }
		);
		expect(c.nodes).toEqual([...DEFAULT_BLURT_RPC_ENDPOINTS, ...onion, ...i2p]);
		expect(c.nodes).toHaveLength(20);
		expect(c.proxies).toEqual({ torSocks: '127.0.0.1:9150', i2pHttpProxy: '127.0.0.1:4444' });
		expect(c.notes.join('\n')).toMatch(
			/Tor on this machine \(127\.0\.0\.1:9150\): the 7 \.onion nodes are asked too/
		);
	});
	it('Tor only: the .onion nodes join, the .b32.i2p ones are left out and it says how to add them', async () => {
		const c = await chooseNodes(
			{ nodeOverride: null, hidden: 'auto' },
			{ env: {}, detect: found('127.0.0.1:9050', null) }
		);
		expect(c.nodes).toEqual([...DEFAULT_BLURT_RPC_ENDPOINTS, ...onion]);
		expect(c.proxies).toEqual({ torSocks: '127.0.0.1:9050', i2pHttpProxy: '' });
		expect(c.notes.join('\n')).toMatch(/No I2P on this machine .*sudo apt install i2pd/);
	});
	it('neither: clearnet only, and it says so', async () => {
		const c = await chooseNodes(
			{ nodeOverride: null, hidden: 'auto' },
			{ env: {}, detect: found(null, null) }
		);
		expect(c.nodes).toEqual([...DEFAULT_BLURT_RPC_ENDPOINTS]);
		expect(c.proxies).toBeNull();
		expect(c.notes.join('\n')).toMatch(
			/No Tor on this machine \(looked at 127\.0\.0\.1:9050, 127\.0\.0\.1:9150\)/
		);
	});
	it('--no-hidden: clearnet only without looking; --include-hidden: all twenty; --node: that one', async () => {
		const never = async () => {
			throw new Error('must not look');
		};
		expect(
			(await chooseNodes({ nodeOverride: null, hidden: 'off' }, { env: {}, detect: never })).nodes
		).toEqual([...DEFAULT_BLURT_RPC_ENDPOINTS]);
		const all = await chooseNodes({ nodeOverride: null, hidden: 'on' }, { env: {}, detect: never });
		expect(all.nodes).toHaveLength(20);
		expect(
			(
				await chooseNodes(
					{ nodeOverride: 'https://x.example', hidden: 'auto' },
					{ env: {}, detect: never }
				)
			).nodes
		).toEqual(['https://x.example']);
		expect(hiddenModeFromArgs(['f.json'])).toBe('auto');
		expect(hiddenModeFromArgs(['--no-hidden'])).toBe('off');
		expect(hiddenModeFromArgs(['--include-hidden'])).toBe('on');
	});

	// Real sockets: a proxy counts only when it speaks its protocol.
	const servers: Server[] = [];
	afterEach(() => {
		for (const s of servers.splice(0)) s.close();
	});
	const listen = (onData: (d: Buffer, write: (b: Buffer | string) => void) => void) =>
		new Promise<string>((resolve) => {
			const srv = createServer((sock) => {
				sock.on('data', (d) => onData(d, (b) => sock.write(b)));
				sock.on('error', () => {});
			});
			servers.push(srv);
			srv.listen(0, '127.0.0.1', () => {
				const a = srv.address() as { port: number };
				resolve(`127.0.0.1:${a.port}`);
			});
		});
	/** A SOCKS5 server: greeting 05 00, then `onConnect` answers the CONNECT
	 *  (null: close without a reply, as an ssh -D tunnel does). */
	const socksServer = (onConnect: (req: Buffer) => number | null) =>
		listen((d, w) => {
			if (d.length === 3 && d[0] === 5 && d[1] === 1) return w(Buffer.from([5, 0]));
			if (d[0] === 5 && d[1] === 1) {
				const rep = onConnect(d);
				if (rep === null) return w(Buffer.alloc(0));
				w(Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]));
			}
		});
	// What Tor 0.4.9 answers (seen against a real tor, v1.21.18 review): the
	// greeting with 05 00, and a CONNECT to an .onion name it cannot reach
	// with 05 01 (general failure).
	const torLike = () =>
		socksServer((req) =>
			req[3] === 3 &&
			req
				.subarray(5, 5 + req[4]!)
				.toString()
				.endsWith('.onion')
				? 1
				: 8
		);
	// i2pd 2.x's answer to a request for an .i2p name it does not know.
	const I2PD_REPLY =
		'HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' +
		'<html>\r\n<head>\r\n  <title>I2Pd HTTP proxy</title>\r\n</head>\r\n<body><h1>Proxy error: Host not found</h1></body></html>\r\n';

	it('Tor: the greeting AND an .onion CONNECT answered as Tor does; any other SOCKS5 or HTTP server does not count', async () => {
		const tor = await torLike();
		expect(await answersSocks5(tor)).toBe(true);
		// A SOCKS5 that answers the greeting but refuses a name (address type not supported).
		const noNames = await socksServer(() => 8);
		expect(await answersSocks5(noNames)).toBe(false);
		// A SOCKS5 that connects anything (or says "succeeded" to an .onion it cannot reach).
		const anything = await socksServer(() => 0);
		expect(await answersSocks5(anything)).toBe(false);
		// An ssh -D tunnel: the greeting, then the connection closes.
		const sshD = await listen((d, w) => {
			if (d.length === 3) w(Buffer.from([5, 0]));
		});
		servers.at(-1)!.on('connection', (sock) => sock.on('data', (d) => d.length > 3 && sock.end()));
		expect(await answersSocks5(sshD, 800)).toBe(false);
		const http = await listen((_d, w) => w('HTTP/1.1 400 Bad Request\r\n\r\n'));
		expect(await answersSocks5(http)).toBe(false);
		// Nothing listening.
		const closed = await listen(() => {});
		servers.pop()!.close();
		expect(await answersSocks5(closed, 500)).toBe(false);
	});

	it('i2pd: only its own proxy page counts — not any HTTP server on the port, not one echoing the .i2p name', async () => {
		const i2pd = await listen((_d, w) => w(I2PD_REPLY));
		expect(await answersHttpProxy(i2pd)).toBe(true);
		// The reply arriving in two pieces (headers, then the page) still counts.
		// The second piece goes only once the prober has read the first one on
		// its own (its socket's 'data'), polled with vi.waitFor: real sockets.
		const first = I2PD_REPLY.slice(0, 40);
		const emits = vi.spyOn(Socket.prototype, 'emit');
		const firstReadAlone = (): boolean =>
			(emits.mock.calls as unknown[][]).some(
				([ev, d]) => ev === 'data' && Buffer.isBuffer(d) && d.toString('latin1') === first
			);
		try {
			const split = await listen((_d, w) => {
				w(first);
				void vi
					.waitFor(
						() => {
							if (!firstReadAlone()) throw new Error('first piece not read yet');
						},
						{ timeout: 2_000, interval: 5 }
					)
					.then(() => w(I2PD_REPLY.slice(40)))
					.catch(() => {});
			});
			expect(await answersHttpProxy(split)).toBe(true);
			expect(firstReadAlone()).toBe(true);
		} finally {
			emits.mockRestore();
		}
		const http = await listen((_d, w) =>
			w('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
		);
		expect(await answersHttpProxy(http)).toBe(false);
		const echo = await listen((d, w) => {
			const page = `<html><title>Not found</title>No such page: ${d.toString().split(' ')[1]} (i2p)</html>`;
			w(`HTTP/1.1 404 Not Found\r\nContent-Length: ${page.length}\r\n\r\n${page}`);
		});
		expect(await answersHttpProxy(echo)).toBe(false);
		// Tor's SOCKS port (it says "Tor is not an HTTP Proxy").
		const torHttp = await listen((_d, w) =>
			w(
				'HTTP/1.0 501 Tor is not an HTTP Proxy\r\nContent-Type: text/html\r\n\r\n<html><head><title>This is a SOCKS Proxy, Not An HTTP Proxy</title>'
			)
		);
		expect(await answersHttpProxy(torHttp)).toBe(false);
	});
	it('the first usual Tor port that answers is the one used (Tor Browser’s 9150 when 9050 is silent)', async () => {
		const socks = await torLike();
		const asked: string[] = [];
		const r = await detectLocalProxies(
			{},
			{
				socks: async (hp) => (asked.push(hp), hp === '127.0.0.1:9150'),
				http: async () => false
			}
		);
		expect(asked).toEqual(['127.0.0.1:9050', '127.0.0.1:9150']);
		expect(r).toEqual({ tor: '127.0.0.1:9150', i2p: null });
		// A configured address is the only one tried — with the real check.
		expect(
			await detectLocalProxies({
				MORPHIT_INDEXER_TOR_SOCKS: socks,
				MORPHIT_INDEXER_I2P_HTTP_PROXY: '127.0.0.1:1'
			})
		).toEqual({
			tor: socks,
			i2p: null
		});
	});
});

describe('prepareNodes: says which hidden nodes are in and routes them', () => {
	const sink = () => {
		let text = '';
		return { stream: { write: (s: string) => ((text += s), true) } as never, text: () => text };
	};
	it('hidden nodes in: their proxies are installed, and the run says which', async () => {
		const out = sink();
		const enabled: unknown[] = [];
		const nodes = await prepareNodes({ nodeOverride: null, hidden: 'auto' }, out.stream, {
			choose: async () => ({
				nodes: ['https://a.example', 'http://x.onion:8091'],
				notes: ['Tor on this machine (127.0.0.1:9050): the 7 .onion nodes are asked too.'],
				proxies: { torSocks: '127.0.0.1:9050', i2pHttpProxy: '' }
			}),
			enable: async (p) => void enabled.push(p)
		});
		expect(nodes).toEqual(['https://a.example', 'http://x.onion:8091']);
		expect(enabled).toEqual([{ torSocks: '127.0.0.1:9050', i2pHttpProxy: '' }]);
		expect(out.text()).toMatch(/Looking for Tor and I2P on this machine/);
		expect(out.text()).toMatch(/Tor on this machine \(127\.0\.0\.1:9050\)/);
	});
	it('a choice this server forbids (a clearnet node on a hidden-only server): said plainly, the run ends', async () => {
		const out = sink();
		let code: number | null = null;
		await expect(
			prepareNodes({ nodeOverride: 'https://rpc.example.org', hidden: 'auto' }, out.stream, {
				choose: async () => {
					throw new Error(
						'https://rpc.example.org is a clearnet node, and this server is hidden-only'
					);
				},
				exit: ((c: number) => {
					code = c;
					throw new Error('exited');
				}) as never
			})
		).rejects.toThrow('exited');
		expect(code).toBe(1);
		expect(out.text()).toMatch(
			/✗ https:\/\/rpc\.example\.org is a clearnet node, and this server is hidden-only/
		);
		expect(out.text()).toMatch(/Nothing was signed or sent/);
	});
	it('clearnet only: nothing installed', async () => {
		const enabled: unknown[] = [];
		await prepareNodes({ nodeOverride: null, hidden: 'off' }, sink().stream, {
			choose: async () => ({ nodes: ['https://a.example'], notes: [], proxies: null }),
			enable: async (p) => void enabled.push(p)
		});
		expect(enabled).toEqual([]);
	});
});

describe('the ranking does not wait out a dead hidden node (v1.21.18)', () => {
	it('once a node has answered, the rest get the grace time; the silent one is ranked last and still tried', async () => {
		const never = new Promise<NodeHealth>(() => {});
		const started = Date.now();
		const r = await rankNodes(['https://a.example', 'http://x.onion:8091', 'http://y.onion:8091'], {
			graceMs: 50,
			probe: async (u) =>
				u === 'https://a.example' ? ok(u, 10) : u === 'http://x.onion:8091' ? ok(u, 40) : never
		});
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(r.map((h) => h.url)).toEqual([
			'https://a.example',
			'http://x.onion:8091',
			'http://y.onion:8091'
		]);
		expect(r[2]!.ok).toBe(false);
		expect(r[2]!.reason).toMatch(/tried last/);
	});
	it('without a grace time every node gets its full answer, as before', async () => {
		// The hidden node answers 19 s after the clearnet one (inside its 20 s
		// limit). No grace was asked for, so the ranking waits for it: with any
		// grace shorter than that, it would be "tried last" instead.
		vi.useFakeTimers();
		try {
			const p = rankNodes(['https://a.example', 'http://x.onion:8091'], {
				probe: (u) =>
					u === 'http://x.onion:8091'
						? new Promise<NodeHealth>((r) => setTimeout(() => r(ok(u, 5)), 19_000))
						: Promise.resolve(ok(u, 10))
			});
			await vi.advanceTimersByTimeAsync(19_000);
			const r = await p;
			expect(r.map((h) => h.url)).toEqual(['http://x.onion:8091', 'https://a.example']);
			expect(r.every((h) => h.ok)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('--node and --include-hidden use the Tor this machine really has (9050, else Tor Browser’s 9150)', () => {
	const onionNode = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.find((u) => u.includes('.onion'))!;
	const detect = async () => ({ tor: '127.0.0.1:9150', i2p: '127.0.0.1:4444' });
	it('--node <an .onion node>: through Tor Browser’s 9150 when that is the Tor here', async () => {
		const c = await chooseNodes(
			{ nodeOverride: onionNode, hidden: 'auto' },
			{ env: {}, detect, hostHiddenOnly: () => false }
		);
		expect(c.nodes).toEqual([onionNode]);
		expect(c.proxies?.torSocks).toBe('127.0.0.1:9150');
	});
	it('--include-hidden: the same', async () => {
		const c = await chooseNodes(
			{ nodeOverride: null, hidden: 'on' },
			{ env: {}, detect, hostHiddenOnly: () => false }
		);
		expect(c.proxies?.torSocks).toBe('127.0.0.1:9150');
		expect(c.nodes).toHaveLength(20);
	});
});

describe('on a hidden-only server, no clearnet node is ever asked (treasury re-pin runs from a systemd unit)', () => {
	function root(indexerEnv: string | null): string {
		const r = mkdtempSync(join(tmpdir(), 'morphit-hostho-'));
		mkdirSync(join(r, 'etc', 'morphit'), { recursive: true });
		if (indexerEnv === null) mkdirSync(join(r, 'etc', 'morphit', 'indexer.env'));
		else writeFileSync(join(r, 'etc', 'morphit', 'indexer.env'), indexerEnv);
		return r;
	}
	it('reads the server’s own settings: an empty clearnet RPC pool, or Kubo routing nothing', () => {
		const none = () => null;
		expect(
			hostHiddenOnly({
				env: { MORPHIT_ENV_ROOT: root('MORPHIT_INDEXER_RPC_ENDPOINTS=   # tor-only\n') },
				ipfsRoutingType: none
			})
		).toBe('yes');
		expect(
			hostHiddenOnly({
				env: { MORPHIT_ENV_ROOT: root('MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.org\n') },
				ipfsRoutingType: none
			})
		).toBe('no');
		expect(
			hostHiddenOnly({
				env: { MORPHIT_ENV_ROOT: root('MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.org\n') },
				ipfsRoutingType: () => 'none'
			})
		).toBe('yes');
		// Not readable by this user, and Kubo does not say: not known.
		expect(hostHiddenOnly({ env: { MORPHIT_ENV_ROOT: root(null) }, ipfsRoutingType: none })).toBe(
			'unknown'
		);
		expect(
			hostHiddenOnly({ env: { MORPHIT_ENV_ROOT: root(null) }, ipfsRoutingType: () => 'none' })
		).toBe('yes');
		// A laptop: no Morphit settings at all.
		expect(
			hostHiddenOnly({
				env: { MORPHIT_ENV_ROOT: mkdtempSync(join(tmpdir(), 'x-')) },
				ipfsRoutingType: none
			})
		).toBe('no');
	});
	it('the nodes chosen there: hidden ones only, whatever the mode; a clearnet --node or --no-hidden is refused', async () => {
		const env = { MORPHIT_ENV_ROOT: root('MORPHIT_INDEXER_RPC_ENDPOINTS=\n') };
		const detect = async () => ({ tor: '127.0.0.1:9050', i2p: '127.0.0.1:4444' });
		for (const hidden of ['auto', 'on'] as const) {
			const c = await chooseNodes({ nodeOverride: null, hidden }, { env, detect });
			expect(c.nodes.length).toBeGreaterThan(0);
			expect(c.nodes.filter((u) => !/\.(onion|i2p)(:\d+)?(\/|$)/.test(u))).toEqual([]);
			expect(c.notes.join('\n')).toMatch(/hidden-only/);
		}
		await expect(
			chooseNodes(
				{ nodeOverride: DEFAULT_BLURT_RPC_ENDPOINTS[0]!, hidden: 'auto' },
				{ env, detect }
			)
		).rejects.toThrow(/hidden-only/);
		await expect(
			chooseNodes({ nodeOverride: null, hidden: 'off' }, { env, detect })
		).rejects.toThrow(/hidden-only/);
	});
});
