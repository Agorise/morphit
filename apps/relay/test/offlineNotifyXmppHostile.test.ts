/**
 * Offline notices — XMPP: what a hostile or broken server sends must never
 * stall the relay. sendXmpp runs inside the relay process (the notice worker),
 * so a regular expression that backtracks over the server's bytes would freeze
 * every relay user, and no timer could fire meanwhile.
 */
import diagnostics from 'node:diagnostics_channel';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { sendXmpp, xmppRegistrationForm } from '../src/notify/channels/xmpp.ts';
import { TEST_CERT, TEST_KEY, fakeXmpp, type Listening } from './notifyFakes.ts';

const open: Listening[] = [];
afterEach(async () => {
	for (const l of open.splice(0)) await l.close();
});
const direct = { torSocks: '', hiddenOnly: false };

/** The longest the event loop went without a turn while `p` ran. */
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

describe('a hostile XMPP server cannot stall the relay', () => {
	it('after login: an endless unfinished <iq id=…> answer to the bind', async () => {
		const junk = "<iq id='bind1' ".repeat(Math.floor(20_000 / 15));
		const x = await fakeXmpp({ iq: (iq) => (/bind1/.test(iq) ? junk : null) });
		open.push(x);
		const cfg = {
			jid: 'bot@localhost',
			password: 'secret',
			host: '127.0.0.1',
			port: x.port,
			security: 'starttls' as const,
			ca: TEST_CERT
		};
		const { stall, result } = await longestStall(() =>
			sendXmpp(cfg, direct, 'u@example.org', 'hi', 3_000)
		);
		expect(result).toBeInstanceOf(Error);
		expect(stall).toBeLessThan(250);
	}, 60_000);

	it('before TLS: unfinished <stream:features (anyone on the path can send it)', async () => {
		const conns = new Set<net.Socket>();
		const server = net.createServer((c) => {
			conns.add(c);
			c.on('error', () => undefined);
			c.once('data', () => {
				c.write(
					"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>"
				);
				const unit = '<stream:features';
				const all = unit.repeat(Math.floor(60_000 / unit.length));
				// In pieces, as a slow link would deliver it.
				let i = 0;
				const iv = setInterval(() => {
					if (i >= all.length || c.destroyed) return clearInterval(iv);
					c.write(all.slice(i, i + 4096));
					i += 4096;
				}, 2);
			});
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		open.push({
			port: (server.address() as net.AddressInfo).port,
			close: () =>
				new Promise<void>((r) => {
					for (const c of conns) c.destroy();
					server.close(() => r());
				})
		});
		const port = (server.address() as net.AddressInfo).port;
		const { stall, result } = await longestStall(() =>
			xmppRegistrationForm(
				{ domain: 'localhost', host: '127.0.0.1', port, security: 'starttls', ca: TEST_CERT },
				direct,
				3_000
			)
		);
		expect(result).toBeInstanceOf(Error);
		expect(stall).toBeLessThan(250);
	}, 60_000);

	it('an endless well-formed answer: refused as too much data, still without a stall', async () => {
		const junk = "<iq type='result' id='bind1'>" + '<a/>'.repeat(20_000);
		const x = await fakeXmpp({ iq: (iq) => (/bind1/.test(iq) ? junk : null) });
		open.push(x);
		const cfg = {
			jid: 'bot@localhost',
			password: 'secret',
			host: '127.0.0.1',
			port: x.port,
			security: 'starttls' as const,
			ca: TEST_CERT
		};
		const { stall, result } = await longestStall(() =>
			sendXmpp(cfg, direct, 'u@example.org', 'hi', 3_000)
		);
		expect(String(result)).toMatch(/too much data/);
		expect(stall).toBeLessThan(250);
	}, 60_000);
});

describe('the stream is read as it really arrives', () => {
	/** A plain server: stream header, STARTTLS refused, then `tail` in two writes. */
	async function twoPieces(first: Buffer, second: Buffer) {
		// The relay's own socket (the first one it opens from here on), so the
		// second piece goes out only once the relay has READ the first: two
		// reads for certain, whatever the timing.
		let relaySock: net.Socket | null = null;
		const onSocket = (m: unknown): void => {
			relaySock ??= (m as { socket: net.Socket }).socket;
		};
		diagnostics.subscribe('net.client.socket', onSocket);
		const conns = new Set<net.Socket>();
		const server = net.createServer((c) => {
			conns.add(c);
			c.on('error', () => undefined);
			c.once('data', () => {
				const before = relaySock?.bytesRead ?? 0;
				c.setNoDelay(true);
				c.write(first);
				const next = (): void => {
					if (c.destroyed) return;
					if ((relaySock?.bytesRead ?? 0) < before + first.length) return void setImmediate(next);
					diagnostics.unsubscribe('net.client.socket', onSocket);
					c.write(second);
				};
				setImmediate(next);
			});
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as net.AddressInfo).port;
		open.push({
			port,
			close: () =>
				new Promise<void>((r) => {
					for (const c of conns) c.destroy();
					server.close(() => r());
				})
		});
		return port;
	}

	it('a character cut between two TCP pieces is read whole (a .onion server, so no TLS)', async () => {
		// Through a SOCKS fake would be closer to life; the stream reading is the same.
		const { fakeSocks } = await import('./notifyFakes.ts');
		const s = await fakeSocks();
		open.push(s);
		const form = Buffer.from(
			"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'><stream:features/>" +
				"<iq type='result' id='reg1'><query xmlns='jabber:iq:register'><x xmlns='jabber:x:data' type='form'><field var='FORM_TYPE' type='hidden'><value>jabber:iq:register</value></field><field var='tok' type='hidden'><value>Ünïcødé✓</value></field><field var='username'><required/></field><field var='password'><required/></field></x></query></iq>",
			'utf8'
		);
		const cut = form.indexOf(Buffer.from('✓', 'utf8')) + 1; // inside the 3-byte character
		const port = await twoPieces(form.subarray(0, cut), form.subarray(cut));
		const f = await xmppRegistrationForm(
			{ domain: 'x.onion', host: 'x.onion', port, security: 'starttls' },
			{ torSocks: `127.0.0.1:${s.port}`, hiddenOnly: false },
			5_000
		);
		expect(f.hidden).toContainEqual(['tok', 'Ünïcødé✓']);
	}, 30_000);

	it('STARTTLS: features injected in the clear after <proceed/> are not used after TLS', async () => {
		const hdr =
			"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0' from='localhost'>";
		const conns = new Set<net.Socket>();
		const server = net.createServer((raw) => {
			conns.add(raw);
			raw.on('error', () => undefined);
			let buf = '';
			raw.on('data', (d: Buffer) => {
				buf += d.toString('utf8');
				if (buf.includes('<stream:stream') && !buf.includes('<starttls')) {
					buf = '';
					raw.write(
						`${hdr}<stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/></stream:features>`
					);
				} else if (buf.includes('<starttls')) {
					raw.removeAllListeners('data');
					// The go-ahead, and in the same piece, clear-text features offering PLAIN.
					raw.write(
						`<proceed xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>${hdr}<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>`
					);
					const t = new tls.TLSSocket(raw, { isServer: true, cert: TEST_CERT, key: TEST_KEY });
					t.on('error', () => undefined);
					// After TLS: features with no login method at all.
					t.on('data', () => t.write(`${hdr}<stream:features/>`));
				}
			});
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as net.AddressInfo).port;
		open.push({
			port,
			close: () =>
				new Promise<void>((r) => {
					for (const c of conns) c.destroy();
					server.close(() => r());
				})
		});
		const cfg = {
			jid: 'bot@localhost',
			password: 'secret',
			host: '127.0.0.1',
			port,
			security: 'starttls' as const,
			ca: TEST_CERT
		};
		await expect(sendXmpp(cfg, direct, 'u@example.org', 'hi', 5_000)).rejects.toThrow(
			/no SCRAM or PLAIN offered/
		);
	}, 30_000);

	it('the certificate is checked against the account’s domain, not the host connected to', async () => {
		const x = await fakeXmpp({});
		open.push(x);
		const base = { host: '127.0.0.1', port: x.port, security: 'starttls' as const, ca: TEST_CERT };
		// The test certificate names localhost: right for domain localhost on host 127.0.0.1…
		await expect(
			xmppRegistrationForm({ ...base, domain: 'localhost' }, direct, 5_000)
		).resolves.toBeDefined();
		// …and refused for another domain on the very same host.
		await expect(
			xmppRegistrationForm({ ...base, domain: 'other.example' }, direct, 5_000)
		).rejects.toThrow(/altname|certificate|Hostname/i);
		expect(x.secure.join('')).not.toMatch(/other\.example/);
	}, 30_000);
});
