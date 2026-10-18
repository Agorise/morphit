/**
 * Offline notices — XMPP stream reader, v1.21.10 review.
 *
 * 1. Each piece the server sends must cost the relay only for what is new in
 *    it. Elements the client is not waiting for are kept (up to the 64 KB
 *    cap); comparing all of them again on every piece that arrives lets a
 *    server that fills the queue and then sends one space per TLS record
 *    freeze the whole relay for seconds (Node hands every record of a read to
 *    the reader in one go, with no turn for timers in between).
 * 2. An answer that arrives together with the end of the stream still counts:
 *    v1.21.9 took it, and a registration the server confirmed is a made
 *    account.
 */
import net from 'node:net';
import tls from 'node:tls';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { registerXmpp, sendXmpp, xmppArchiveOff } from '../src/notify/channels/xmpp.ts';
import { TEST_CERT, TEST_KEY, fakeXmpp, type Listening } from './notifyFakes.ts';

const open: Listening[] = [];
afterEach(async () => {
	for (const l of open.splice(0)) await l.close();
});
const keep = <T extends Listening>(l: T): T => (open.push(l), l);
const direct = { torSocks: '', hiddenOnly: false };

async function longestStall<T>(p: () => Promise<T>): Promise<{ stall: number; result: unknown }> {
	let last = performance.now();
	let stall = 0;
	const iv = setInterval(() => {
		const now = performance.now();
		stall = Math.max(stall, now - last);
		last = now;
	}, 5);
	let result: unknown;
	try {
		result = await p();
	} catch (e) {
		result = e;
	}
	clearInterval(iv);
	stall = Math.max(stall, performance.now() - last);
	return { stall, result };
}

/** Direct-TLS server: logs in with PLAIN, then answers the bind request by
 *  filling the queue with `unit` and sending one space per TLS record. */
async function floodServer(unit: string, floodMs: number): Promise<number> {
	const hdr =
		"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0' from='localhost' id='1'>";
	const conns = new Set<tls.TLSSocket>();
	const srv = tls.createServer({ cert: TEST_CERT, key: TEST_KEY }, (c) => {
		conns.add(c);
		c.on('error', () => undefined);
		let buf = '';
		let authed = false;
		c.on('data', (d: Buffer) => {
			buf += d.toString();
			if (buf.includes('<stream:stream')) {
				buf = '';
				c.write(
					hdr +
						(authed
							? "<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>"
							: "<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>")
				);
			} else if (buf.includes('</auth>')) {
				buf = '';
				authed = true;
				c.write("<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>");
			} else if (buf.includes('bind1')) {
				buf = '';
				const end = Date.now() + floodMs;
				const go = (): void => {
					if (Date.now() > end || c.destroyed) return void c.destroy();
					for (let i = 0; i < 64; i++) c.write(' ');
					setImmediate(go);
				};
				// The queue full first, then the trickle.
				c.write(unit.repeat(Math.floor(65_000 / unit.length)), () => setImmediate(go));
			}
		});
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	keep({
		port: (srv.address() as net.AddressInfo).port,
		close: () =>
			new Promise<void>((r) => {
				for (const c of conns) c.destroy();
				srv.close(() => r());
			})
	});
	return (srv.address() as net.AddressInfo).port;
}

describe('a full queue of unwanted stanzas, then one space per TLS record', () => {
	it.each([["<iq id='z'/>"], ['<a/>']])(
		'%s: the relay never stalls',
		async (unit) => {
			const port = await floodServer(unit, 2_500);
			const { stall, result } = await longestStall(() =>
				sendXmpp(
					{
						jid: 'bot@localhost',
						password: 'secret',
						host: '127.0.0.1',
						port,
						security: 'tls',
						ca: TEST_CERT
					},
					direct,
					'u@example.org',
					'hi',
					1_500
				)
			);
			expect(result).toBeInstanceOf(Error);
			expect(stall).toBeLessThan(250);
		},
		30_000
	);
});

describe('an answer that arrives with the end of the stream still counts', () => {
	const cfg = (port: number) => ({
		jid: 'bot@localhost',
		password: 'secret',
		host: '127.0.0.1',
		port,
		security: 'starttls' as const,
		ca: TEST_CERT
	});

	it('registration confirmed, then the server closes: the account is made', async () => {
		const x = keep(
			await fakeXmpp({
				iq: (iq) => {
					if (/id='reg1'/.test(iq))
						return "<iq type='result' id='reg1'><query xmlns='jabber:iq:register'><username/><password/></query></iq>";
					if (/id='reg2'/.test(iq)) return "<iq type='result' id='reg2'/></stream:stream>";
					return null;
				}
			})
		);
		const r = await registerXmpp(
			{ domain: 'localhost', host: '127.0.0.1', port: x.port, security: 'starttls', ca: TEST_CERT },
			direct,
			'newbot',
			'Tr4in-Lamp-Stone',
			undefined,
			5_000
		);
		expect(r).toEqual({ ok: true });
	});

	it('the delivery ping answered, then the server closes: the note was sent', async () => {
		const x = keep(
			await fakeXmpp({
				iq: (iq, authed) =>
					authed && /id='ping1'/.test(iq) ? "<iq type='result' id='ping1'/></stream:stream>" : null
			})
		);
		await expect(
			sendXmpp(cfg(x.port), direct, 'grandma@example.org', 'hi', 5_000)
		).resolves.toBeUndefined();
		expect(x.messages).toHaveLength(1);
	});

	it('two answers and the end in one piece: the second wait still gets its answer', async () => {
		const x = keep(
			await fakeXmpp({
				iq: (iq, authed) => {
					if (!authed || !/<prefs/.test(iq)) return null;
					// The server answers the set and, ahead of time, the read-back.
					if (/type='set'/.test(iq))
						return "<iq type='result' id='mam1'/><iq type='result' id='mam2'><prefs xmlns='urn:xmpp:mam:2' default='never'/></iq></stream:stream>";
					return '';
				}
			})
		);
		await expect(xmppArchiveOff(cfg(x.port), direct, 5_000)).resolves.toBe('off');
	});
});

/**
 * 3. What the reader keeps must be about what it counts against the 64 KB
 *    cap. A queued element cut out of a received piece (a V8 "sliced" string)
 *    keeps that whole piece alive: a server that sends 16 KB pieces, each
 *    mostly spaces with one small stanza at its end, would make the relay hold
 *    about 80 MB (330 MB with the 64 KB pieces of a clear connection) while
 *    counting only 64 KB.
 */
describe('memory kept is what is counted', () => {
	it('pieces of spaces, each ending in a small stanza: the relay does not keep the pieces', async () => {
		setFlagsFromString('--expose-gc');
		const gc = runInNewContext('gc') as () => void;
		const piece = ' '.repeat(16_000 - 13) + "<iq id='zz'/>";
		const pieces = 4_900; // 4 900 × 13 counted chars: under the cap, so the stream lives
		const hdr =
			"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0' from='localhost' id='1'>";
		let sent!: () => void;
		const allSent = new Promise<void>((r) => (sent = r));
		const conns = new Set<tls.TLSSocket>();
		const srv = tls.createServer({ cert: TEST_CERT, key: TEST_KEY }, (c) => {
			conns.add(c);
			c.on('error', () => undefined);
			c.once('data', () => {
				c.write(hdr);
				let i = 0;
				const go = (): void => {
					if (c.destroyed) return;
					// one TLS record per piece
					for (let k = 0; k < 50 && i < pieces; k++, i++) c.write(piece);
					if (i < pieces) setImmediate(go);
					// Then the end of the stream: the reader has taken in every piece
					// when it sees it (records arrive in order).
					else c.write('</stream:stream>', () => sent());
				};
				go();
			});
		});
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
		keep({
			port: 0,
			close: () =>
				new Promise<void>((r) => {
					for (const c of conns) c.destroy();
					srv.close(() => r());
				})
		});
		const port = (srv.address() as net.AddressInfo).port;
		gc();
		const before = process.memoryUsage().heapUsed;
		// Measured the moment the reader gives up at the end of the stream: it
		// still holds what it queued then (its socket is not gone yet).
		let grew = Infinity;
		const p = xmppArchiveOff(
			{
				jid: 'bot@localhost',
				password: 'secret',
				host: '127.0.0.1',
				port,
				security: 'tls',
				ca: TEST_CERT
			},
			direct,
			20_000
		).catch((e: unknown) => {
			gc();
			grew = process.memoryUsage().heapUsed - before;
			return e;
		});
		await allSent;
		expect(String(await p)).toMatch(/closed/);
		for (const c of conns) c.destroy();
		expect(grew).toBeLessThan(20e6);
	}, 60_000);
});

/**
 * 4. What the reader must tell apart (each was untested: changing it in the
 *    code left every test passing).
 */
type Reply = string | null | ((c: tls.TLSSocket) => void);
/** A direct-TLS server: PLAIN login, `features` after it, and `onIq` for each
 *  iq the client sends (null: no answer). Records what it received. */
async function scripted(
	onIq: (iq: string) => Reply,
	opts: { features?: string; afterAuth?: string } = {}
): Promise<{ port: number; got: string[] }> {
	const hdr =
		"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0' from='localhost' id='1'>";
	const got: string[] = [];
	const conns = new Set<tls.TLSSocket>();
	const srv = tls.createServer({ cert: TEST_CERT, key: TEST_KEY }, (c) => {
		conns.add(c);
		c.on('error', () => undefined);
		let buf = '';
		let authed = false;
		c.on('data', (d: Buffer) => {
			buf += d.toString();
			for (;;) {
				let m: RegExpExecArray | null;
				if ((m = /<\?xml[^>]*>|<stream:stream[^>]*>/.exec(buf)) && m.index === 0) {
					buf = buf.slice(m[0].length);
					if (m[0].startsWith('<stream'))
						c.write(
							hdr +
								(authed
									? (opts.features ??
										"<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>")
									: "<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>")
						);
					continue;
				}
				if ((m = /^<auth[^>]*>[^<]*<\/auth>/.exec(buf))) {
					buf = buf.slice(m[0].length);
					authed = true;
					c.write(opts.afterAuth ?? "<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>");
					continue;
				}
				if ((m = /^<iq\b[^>]*\/>|^<iq\b[\s\S]*?<\/iq>/.exec(buf))) {
					buf = buf.slice(m[0].length);
					got.push(m[0]);
					const r = onIq(m[0]);
					if (typeof r === 'string') c.write(r);
					else if (typeof r === 'function') r(c);
					continue;
				}
				if ((m = /^<message[\s\S]*?<\/message>/.exec(buf))) {
					buf = buf.slice(m[0].length);
					got.push(m[0]);
					continue;
				}
				if ((m = /^<\/stream:stream>/.exec(buf))) {
					buf = buf.slice(m[0].length);
					continue;
				}
				break;
			}
		});
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	const port = (srv.address() as net.AddressInfo).port;
	keep({
		port,
		close: () =>
			new Promise<void>((r) => {
				for (const c of conns) c.destroy();
				srv.close(() => r());
			})
	});
	return { port, got };
}
const tlsCfg = (port: number) => ({
	jid: 'bot@localhost',
	password: 'secret',
	host: '127.0.0.1',
	port,
	security: 'tls' as const,
	ca: TEST_CERT
});
const id = (iq: string): string => /id='([^']*)'/.exec(iq)?.[1] ?? '';
const bindOk = (iq: string): string =>
	`<iq type='result' id='${id(iq)}'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>bot@localhost/notices</jid></bind></iq>`;
const answerAll = (iq: string): string =>
	/<bind/.test(iq) ? bindOk(iq) : `<iq type='result' id='${id(iq)}'/>`;

describe('the reader tells stanzas apart', () => {
	it('a server ping (another iq) before the bind answer is not taken for it', async () => {
		const x = await scripted((iq) =>
			/<bind/.test(iq)
				? `<iq type='get' id='s2c1' from='localhost'><ping xmlns='urn:xmpp:ping'/></iq>${bindOk(iq)}`
				: answerAll(iq)
		);
		await expect(
			sendXmpp(tlsCfg(x.port), direct, 'u@example.org', 'hi', 5_000)
		).resolves.toBeUndefined();
		expect(x.got.some((s) => s.startsWith('<message'))).toBe(true);
	});

	it("'/>' and '>' inside an attribute value do not end the tag", async () => {
		const x = await scripted((iq) =>
			/<bind/.test(iq)
				? `<message from='a@b' note='x/>y' other="1>2"><body>t &gt; u</body></message>${bindOk(iq)}`
				: answerAll(iq)
		);
		await expect(
			sendXmpp(tlsCfg(x.port), direct, 'u@example.org', 'hi', 5_000)
		).resolves.toBeUndefined();
	});

	it('a stream error with the connection left open fails at once, not at the time limit', async () => {
		const x = await scripted((iq) =>
			/<bind/.test(iq)
				? "<stream:error><conflict xmlns='urn:ietf:params:xml:ns:xmpp-streams'/></stream:error>"
				: answerAll(iq)
		);
		const t0 = Date.now();
		await expect(sendXmpp(tlsCfg(x.port), direct, 'u@example.org', 'hi', 8_000)).rejects.toThrow(
			/server error/
		);
		expect(Date.now() - t0).toBeLessThan(2_000);
	});

	it('the stream ended right after the login: the next wait fails at once, not at the time limit', async () => {
		const x = await scripted(answerAll, {
			afterAuth: "<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/></stream:stream>"
		});
		const t0 = Date.now();
		await expect(sendXmpp(tlsCfg(x.port), direct, 'u@example.org', 'hi', 8_000)).rejects.toThrow();
		expect(Date.now() - t0).toBeLessThan(2_000);
	});

	it.each([
		["<session xmlns='urn:ietf:params:xml:ns:xmpp-session'/>", true],
		["<session xmlns='urn:ietf:params:xml:ns:xmpp-session'><optional/></session>", false],
		['', false]
	])('features %j: the RFC 3921 session is asked for: %s', async (session, asked) => {
		const x = await scripted(answerAll, {
			features: `<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/>${session}</stream:features>`
		});
		await sendXmpp(tlsCfg(x.port), direct, 'u@example.org', 'hi', 5_000);
		expect(x.got.some((s) => /<session/.test(s))).toBe(asked);
	});
});

describe('the picture check: the stream closes as the answer goes', () => {
	it('closed instead of an answer to the registration: "captcha_expired"', async () => {
		const form =
			"<iq type='result' id='reg1'><query xmlns='jabber:iq:register'><x xmlns='jabber:x:data' type='form'>" +
			"<field var='FORM_TYPE' type='hidden'><value>jabber:iq:register</value></field>" +
			"<field var='username'><required/></field><field var='password' type='text-private'><required/></field>" +
			"<field var='captcha-fallback-url' type='text-single'><value>https://x.example/captcha/1/image</value></field>" +
			"<field var='ocr'><required/></field></x></query></iq>";
		const x = await scripted((iq) =>
			/id='reg1'/.test(iq)
				? form
				: (c: tls.TLSSocket) => {
						// ejabberd's idle limit runs out just as the answer arrives.
						c.end(
							"<stream:error><connection-timeout xmlns='urn:ietf:params:xml:ns:xmpp-streams'/></stream:error></stream:stream>"
						);
					}
		);
		const r = await registerXmpp(
			{ domain: 'localhost', host: '127.0.0.1', port: x.port, security: 'tls', ca: TEST_CERT },
			direct,
			'morphitio',
			'Tr4in-Lamp-Stone',
			async () => 'K7Q2X',
			5_000
		).catch((e: Error) => e);
		expect(r).toMatchObject({ ok: false, why: 'captcha_expired' });
	});
});
