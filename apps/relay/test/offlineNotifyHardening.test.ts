/**
 * Offline notices — what a hostile or broken server cannot do to the relay.
 *
 * Each case plays a server (or something in front of it: a Tor exit, a
 * Session node, whose TLS is not checked) that misbehaves on purpose:
 * - a node address that is not one (a 300-byte "ip") must fail that send,
 *   never crash the relay (a throw inside a socket listener is uncaught);
 * - a server that sends a byte now and then cannot hold a request open past
 *   its deadline, nor send headers or a body past their caps;
 * - a mail or XMPP server cannot flood the relay with an endless reply;
 * - the XMPP login goes through TLS, with the no-store hints, and refuses a
 *   server that cannot prove it knows the password;
 * - a mail body line that is a lone "." cannot end the message early;
 * - an XMPP address written with invisible characters is the same address;
 * - a Matrix room opened for a send that then failed is named, so it can be
 *   left; a server's free text never becomes an error code;
 * - one stuck send does not hold up the other notices;
 * - Session asks its seeds again after two hours and after a failed send.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { NetRefusedError, httpRequest, openSocket } from '../src/notify/net.ts';
import { MAX_REPLY_CHARS, sendMail } from '../src/notify/channels/smtp.ts';
import { MAX_STREAM_CHARS, sendXmpp } from '../src/notify/channels/xmpp.ts';
import { MatrixRoomLeftOpen, errcodeOf, sendMatrix } from '../src/notify/channels/matrix.ts';
import { newSessionIdentity, sendSession } from '../src/notify/channels/session.ts';
import { normalizeAddress, countingKey } from '../src/notify/addresses.ts';
import {
	TEST_CERT,
	fakeHttp,
	fakeSmtp,
	fakeSocks,
	fakeXmpp,
	type Listening
} from './notifyFakes.ts';

const open: Listening[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
	for (const l of open.splice(0)) await l.close();
	for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
	vi.useRealTimers();
});
const keep = <T extends Listening>(l: T): T => {
	open.push(l);
	return l;
};
const direct = { torSocks: '', hiddenOnly: false };

/** A raw TCP server; `onConn` plays the server's side. */
async function rawServer(onConn: (c: net.Socket) => void): Promise<number> {
	const sockets = new Set<net.Socket>();
	const s = net.createServer((c) => {
		sockets.add(c);
		c.on('error', () => undefined);
		c.on('close', () => sockets.delete(c));
		onConn(c);
	});
	const close = s.close.bind(s);
	s.close = ((cb?: (err?: Error) => void) => {
		for (const c of sockets) c.destroy();
		return close(cb);
	}) as typeof s.close;
	servers.push(s);
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
	return (s.address() as net.AddressInfo).port;
}

describe('connections', () => {
	it('a name SOCKS cannot carry, or a port that is not one, is refused before any connection', async () => {
		const socks = keep(await fakeSocks());
		const tor = { torSocks: `127.0.0.1:${socks.port}`, hiddenOnly: false };
		await expect(openSocket('a'.repeat(300), 443, tor, { viaTor: true })).rejects.toBeInstanceOf(
			NetRefusedError
		);
		await expect(openSocket('1.2.3.4', 70000, tor, { viaTor: true })).rejects.toBeInstanceOf(
			NetRefusedError
		);
		await expect(openSocket('evil\u0000.org', 443, tor, { viaTor: true })).rejects.toBeInstanceOf(
			NetRefusedError
		);
		expect(socks.targets).toEqual([]);
	});

	it('a server sending a byte now and then cannot keep a request open past its deadline', async () => {
		const port = await rawServer((c) => {
			c.once('data', () => {
				c.write('HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n');
				const t = setInterval(() => (c.destroyed ? clearInterval(t) : c.write('x')), 100);
				c.on('close', () => clearInterval(t));
			});
		});
		const started = Date.now();
		await expect(
			httpRequest(`http://127.0.0.1:${port}/`, direct, { timeoutMs: 1500 })
		).rejects.toThrow(/timed out/);
		expect(Date.now() - started).toBeLessThan(4000);
	});

	it('headers past their cap and a body past its cap are refused', async () => {
		const big = await rawServer((c) => {
			c.once('data', () =>
				c.end(`HTTP/1.1 200 OK\r\nX-Pad: ${'a'.repeat(40_000)}\r\nContent-Length: 0\r\n\r\n`)
			);
		});
		await expect(
			httpRequest(`http://127.0.0.1:${big}/`, direct, { timeoutMs: 5000 })
		).rejects.toThrow();
		const huge = await rawServer((c) => {
			c.once('data', () => {
				c.write(`HTTP/1.1 200 OK\r\nContent-Length: ${3 * 1024 * 1024}\r\n\r\n`);
				c.end(Buffer.alloc(3 * 1024 * 1024, 0x61));
			});
		});
		await expect(
			httpRequest(`http://127.0.0.1:${huge}/`, direct, { timeoutMs: 10_000 })
		).rejects.toThrow(/too large/);
	});
});

describe('Session nodes', () => {
	it('a node naming a "node" that is no address fails that send — the relay goes on', async () => {
		const uncaught: unknown[] = [];
		const onUncaught = (e: unknown): void => {
			uncaught.push(e);
		};
		process.on('uncaughtException', onUncaught);
		try {
			const socks = keep(await fakeSocks());
			const me = await newSessionIdentity();
			const her = await newSessionIdentity();
			const node = keep(
				await fakeHttp(
					() => ({
						status: 200,
						body: {
							results: [
								{
									code: 200,
									body: {
										snodes: [
											{
												ip: 'x'.repeat(258),
												port: '443',
												pubkey_ed25519: 'e'.repeat(64),
												pubkey_x25519: 'x'.repeat(64)
											}
										]
									}
								}
							]
						}
					}),
					{ https: true }
				)
			);
			const seed = keep(
				await fakeHttp(
					() => ({
						status: 200,
						body: {
							result: {
								service_node_states: [
									// Not an address: dropped from the list.
									{
										public_ip: 'y'.repeat(300),
										storage_port: 1,
										pubkey_x25519: 'x',
										pubkey_ed25519: 'e'
									},
									{
										public_ip: '127.0.0.1',
										storage_port: node.port,
										pubkey_x25519: 'x'.repeat(64),
										pubkey_ed25519: 'e'.repeat(64)
									}
								]
							}
						}
					}),
					{ https: true }
				)
			);
			const tor = { torSocks: `127.0.0.1:${socks.port}`, hiddenOnly: false };
			await expect(
				sendSession({ mnemonic: me.mnemonic }, 'Site', tor, her.sessionId, 'hello', [
					{ host: 'localhost', cert: TEST_CERT, port: seed.port }
				])
			).rejects.toThrow();
			// Close the proxy and every connection through it: after that no
			// more data can reach the relay's SOCKS code (where it used to throw).
			await socks.close();
			await new Promise((r) => setImmediate(r));
			expect(uncaught).toEqual([]);
			// Only real addresses were ever asked for.
			expect(socks.targets.every((t) => t.length < 40)).toBe(true);
		} finally {
			process.off('uncaughtException', onUncaught);
		}
	}, 60_000);

	it('a node named by a host name (not an IPv4 address) is never contacted', async () => {
		const socks = keep(await fakeSocks());
		const me = await newSessionIdentity();
		const her = await newSessionIdentity();
		const node = keep(
			await fakeHttp(
				() => ({
					status: 200,
					body: {
						results: [
							{
								code: 200,
								body: {
									snodes: [
										{
											ip: 'evil.example',
											port: '443',
											pubkey_ed25519: 'e'.repeat(64),
											pubkey_x25519: 'x'.repeat(64)
										}
									]
								}
							}
						]
					}
				}),
				{ https: true }
			)
		);
		const seed = keep(
			await fakeHttp(
				() => ({
					status: 200,
					body: {
						result: {
							service_node_states: [
								{
									public_ip: '127.0.0.1',
									storage_port: node.port,
									pubkey_x25519: 'x'.repeat(64),
									pubkey_ed25519: 'e'.repeat(64)
								}
							]
						}
					}
				}),
				{ https: true }
			)
		);
		const tor = { torSocks: `127.0.0.1:${socks.port}`, hiddenOnly: false };
		await expect(
			sendSession({ mnemonic: me.mnemonic }, 'Site', tor, her.sessionId, 'hello', [
				{ host: 'localhost', cert: TEST_CERT, port: seed.port }
			])
		).rejects.toThrow();
		expect(socks.targets.some((t) => t.startsWith('evil'))).toBe(false);
	}, 60_000);

	it('asks its seeds again after two hours, and after a failed send', async () => {
		const socks = keep(await fakeSocks());
		const me = await newSessionIdentity();
		const her = await newSessionIdentity();
		let failStore = false;
		const node = keep(
			await fakeHttp(
				(h) => {
					const sub = (JSON.parse(h.body) as { params: { requests: Array<{ method: string }> } })
						.params.requests[0]!;
					if (sub.method === 'get_swarm')
						return {
							status: 200,
							body: {
								results: [
									{
										code: 200,
										body: {
											snodes: [
												{
													ip: '127.0.0.1',
													port: String(nodePort()),
													pubkey_ed25519: 'e'.repeat(64),
													pubkey_x25519: 'x'.repeat(64)
												}
											]
										}
									}
								]
							}
						};
					return failStore
						? { status: 500, body: {} }
						: { status: 200, body: { results: [{ code: 200, body: { hash: 'h' } }] } };
				},
				{ https: true }
			)
		);
		const nodePort = (): number => node.port;
		const seed = keep(
			await fakeHttp(
				() => ({
					status: 200,
					body: {
						result: {
							service_node_states: [
								{
									public_ip: '127.0.0.1',
									storage_port: node.port,
									pubkey_x25519: 'x'.repeat(64),
									pubkey_ed25519: 'e'.repeat(64)
								}
							]
						}
					}
				}),
				{ https: true }
			)
		);
		const seeds = [{ host: 'localhost', cert: TEST_CERT, port: seed.port }];
		const tor = { torSocks: `127.0.0.1:${socks.port}`, hiddenOnly: false };
		const send = (): Promise<void> =>
			sendSession({ mnemonic: me.mnemonic }, 'Site', tor, her.sessionId, 'hi', seeds);
		await send();
		await send();
		expect(seed.hits).toHaveLength(1);
		const realNow = Date.now;
		const later = realNow() + 3 * 60 * 60_000;
		vi.spyOn(Date, 'now').mockImplementation(() => later);
		try {
			await send();
			expect(seed.hits).toHaveLength(2);
			failStore = true;
			await expect(send()).rejects.toThrow();
			failStore = false;
			const before = seed.hits.length;
			await send();
			expect(seed.hits.length).toBe(before + 1);
		} finally {
			vi.restoreAllMocks();
		}
	}, 120_000);
});

describe('email', () => {
	it('an endless reply is cut off, not read into memory', async () => {
		const port = await rawServer((c) => {
			c.write('220 hello\r\n');
			c.once('data', () => {
				const line = `250-${'A'.repeat(1000)}\r\n`;
				const pump = (): void => {
					while (!c.destroyed && c.write(line));
					if (!c.destroyed) c.once('drain', pump);
				};
				pump();
			});
		});
		const started = Date.now();
		await expect(
			sendMail(
				{
					host: '127.0.0.1',
					port,
					security: 'starttls',
					user: 'u',
					password: 'p',
					from: 'a@b.org'
				},
				'S',
				'g@x.org',
				's',
				'b',
				direct,
				60_000
			)
		).rejects.toThrow(/too long/);
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(MAX_REPLY_CHARS).toBeLessThanOrEqual(64 * 1024);
	});

	it('a body line that is a lone "." (or starts with one) arrives as written', async () => {
		const smtp = keep(await fakeSmtp());
		await sendMail(
			{
				host: 'localhost',
				port: smtp.port,
				security: 'starttls',
				user: 'ops@example.org',
				password: 'mailpass',
				from: 'notes@example.org',
				ca: TEST_CERT
			},
			'Site',
			'g@x.org',
			'subject',
			'one\n.\n.hidden\nRSET\nlast',
			direct
		);
		expect(smtp.mails).toHaveLength(1);
		const body = smtp.mails[0]!.data.split('\r\n\r\n').slice(1).join('\r\n\r\n');
		expect(body).toContain('one\r\n.\r\n.hidden\r\nRSET\r\nlast');
	});
});

describe('XMPP', () => {
	const cfg = (port: number) => ({
		jid: 'bot@localhost',
		password: 'secret',
		host: '127.0.0.1',
		port,
		security: 'starttls' as const,
		ca: TEST_CERT
	});

	it('logs in only after TLS, and the note carries the do-not-store hints', async () => {
		const x = keep(await fakeXmpp());
		await sendXmpp(cfg(x.port), direct, 'grandma@example.org', 'Someone wrote to you', 10_000);
		expect(x.messages).toHaveLength(1);
		const m = x.messages[0]!;
		expect(m).toContain("to='grandma@example.org'");
		expect(m).toMatch(/<no-store\s+xmlns='urn:xmpp:hints'\s*\/>/);
		expect(m).toMatch(/<no-permanent-store\s+xmlns='urn:xmpp:hints'\s*\/>/);
		expect(m).toMatch(/<no-copy\s+xmlns='urn:xmpp:hints'\s*\/>/);
		expect(x.plain.join('')).not.toMatch(/<auth|c2VjcmV0/);
	});

	it('refuses a server that cannot prove it knows the password (SCRAM)', async () => {
		const good = keep(await fakeXmpp({ mechs: ['SCRAM-SHA-256', 'PLAIN'] }));
		await sendXmpp(cfg(good.port), direct, 'grandma@example.org', 'hi', 10_000);
		expect(good.messages).toHaveLength(1);
		expect(good.secure.join('')).toContain("mechanism='SCRAM-SHA-256'");
		const bad = keep(await fakeXmpp({ mechs: ['SCRAM-SHA-256', 'PLAIN'], scramProof: 'bad' }));
		await expect(
			sendXmpp(cfg(bad.port), direct, 'grandma@example.org', 'hi', 10_000)
		).rejects.toThrow(/prove/);
		expect(bad.messages).toHaveLength(0);
	});

	it('PLAIN is never used when the server did not offer it', async () => {
		const x = keep(await fakeXmpp({ mechs: ['X-OTHER'] }));
		await expect(
			sendXmpp(cfg(x.port), direct, 'grandma@example.org', 'hi', 10_000)
		).rejects.toThrow(/no SCRAM or PLAIN/);
		expect(x.secure.join('')).not.toContain('<auth');
	});

	it('an endless stream is cut off', async () => {
		const port = await rawServer((c) => {
			c.once('data', () => {
				c.write(
					"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0' id='1'>"
				);
				const chunk = `<junk>${'z'.repeat(4000)}</junk>`;
				const pump = (): void => {
					while (!c.destroyed && c.write(chunk));
					if (!c.destroyed) c.once('drain', pump);
				};
				pump();
			});
		});
		await expect(sendXmpp(cfg(port), direct, 'grandma@example.org', 'hi', 30_000)).rejects.toThrow(
			/too much data/
		);
		expect(MAX_STREAM_CHARS).toBeLessThanOrEqual(64 * 1024);
	});

	it('an address written with invisible or full-width characters is the same address', () => {
		expect(normalizeAddress('xmpp', 'a\u0001lice@example.org')).toBeNull();
		expect(normalizeAddress('xmpp', 'al​ice@example.org')).toBeNull();
		expect(normalizeAddress('xmpp', 'al‮ice@example.org')).toBeNull();
		expect(normalizeAddress('xmpp', 'alice @example.org')).toBeNull();
		const wide = normalizeAddress('xmpp', 'ａlice@Example.org');
		expect(wide).toBe('alice@example.org');
		expect(countingKey('xmpp', wide!)).toBe(countingKey('xmpp', 'ALICE@example.org'));
		expect(normalizeAddress('xmpp', 'josé@example.org')).toBe('josé@example.org');
	});
});

describe('Matrix', () => {
	it('a room opened for a send that then failed is named, so it can be left', async () => {
		const hs = keep(
			await fakeHttp((h) =>
				h.path.endsWith('/createRoom')
					? { status: 200, body: { room_id: '!new:hs' } }
					: { status: 500, body: { errcode: 'M_UNKNOWN' } }
			)
		);
		const err = await sendMatrix(
			{ homeserver: `http://127.0.0.1:${hs.port}`, accessToken: 't', userId: '@bot:hs' },
			{ torSocks: '', hiddenOnly: false },
			'@grandma:hs.org',
			null,
			'hi'
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(MatrixRoomLeftOpen);
		expect((err as MatrixRoomLeftOpen).room).toBe('!new:hs');
	});

	it("a server's free text never becomes the error code", () => {
		expect(errcodeOf('M_FORBIDDEN')).toBe('M_FORBIDDEN');
		expect(errcodeOf('@grandma:hs.org is not allowed')).toBe('unknown');
		expect(errcodeOf('M_X'.padEnd(60, 'Y'))).toBe('unknown');
		expect(errcodeOf(42)).toBe('unknown');
	});
});
