/**
 * Test doubles for the offline-notice channels: a SOCKS5 proxy (stands in
 * for Tor), a mail server with STARTTLS and AUTH, HTTP(S) servers. Every fake
 * records what it was sent so a test asserts on behaviour, not on code.
 */
import { createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { join } from 'node:path';

const FIX = join(import.meta.dirname, 'fixtures');
export const TEST_CERT = readFileSync(join(FIX, 'notify-test-localhost.crt'), 'utf8');
export const TEST_KEY = readFileSync(join(FIX, 'notify-test-localhost.key'), 'utf8');
export const OTHER_CERT = readFileSync(join(FIX, 'other-localhost.crt'), 'utf8');

export interface Listening {
	readonly port: number;
	close(): Promise<void>;
}

function listen(server: net.Server): Promise<number> {
	return new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
	);
}

/** Close a server and every connection it still holds (piped tunnels and
 *  keep-alive sockets would otherwise keep it open). */
function closer(server: net.Server): () => Promise<void> {
	const socks = new Set<net.Socket>();
	server.on('connection', (c: net.Socket) => {
		socks.add(c);
		c.on('close', () => socks.delete(c));
	});
	return () =>
		new Promise((r) => {
			for (const c of socks) c.destroy();
			server.close(() => r());
		});
}

/** A SOCKS5 proxy that connects onward and records each CONNECT target. */
export async function fakeSocks(): Promise<Listening & { targets: string[] }> {
	const targets: string[] = [];
	const server = net.createServer((c) => {
		let stage = 0;
		let buf = Buffer.alloc(0);
		c.on('data', (d: Buffer) => {
			buf = Buffer.concat([buf, d]);
			if (stage === 0 && buf.length >= 3) {
				buf = buf.subarray(2 + buf[1]!);
				c.write(Buffer.from([0x05, 0x00]));
				stage = 1;
			}
			if (stage === 1 && buf.length >= 7) {
				const atyp = buf[3];
				let host: string;
				let off: number;
				if (atyp === 0x03) {
					const len = buf[4]!;
					if (buf.length < 5 + len + 2) return;
					host = buf.subarray(5, 5 + len).toString('utf8');
					off = 5 + len;
				} else if (atyp === 0x01) {
					host = [...buf.subarray(4, 8)].join('.');
					off = 8;
				} else return c.destroy();
				const port = buf.readUInt16BE(off);
				targets.push(`${host}:${port}`);
				stage = 2;
				c.removeAllListeners('data');
				// .onion and test names land on 127.0.0.1, like Tor would route them.
				const up = net.connect({ host: '127.0.0.1', port }, () => {
					c.write(
						Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, (port >> 8) & 0xff, port & 0xff])
					);
					const rest = buf.subarray(off + 2);
					if (rest.length) up.write(rest);
					c.pipe(up).pipe(c);
				});
				up.on('error', () => {
					c.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
				});
			}
		});
		c.on('error', () => undefined);
	});
	const close = closer(server);
	const port = await listen(server);
	return { port, targets, close };
}

export interface ReceivedMail {
	readonly from: string;
	readonly to: string[];
	readonly data: string;
	readonly tls: boolean;
	readonly authUser: string;
}

/**
 * A submission server: EHLO, STARTTLS (TEST_CERT), AUTH PLAIN, one message.
 * `offerStartTls: false` plays a server that does not offer it; `linesBeforeTls`
 * records every line the client sent before TLS (a password must not be there);
 * `injectBeforeTls` plays a man in the middle who adds a reply of its own right
 * after the go-ahead, before the handshake (STARTTLS injection);
 * `rejectRcpt` plays a server that refuses some recipients (550).
 */
export async function fakeSmtp(
	opts: {
		offerStartTls?: boolean;
		user?: string;
		password?: string;
		injectBeforeTls?: string;
		rejectRcpt?: (address: string) => boolean;
	} = {}
): Promise<Listening & { mails: ReceivedMail[]; linesBeforeTls: string[] }> {
	const mails: ReceivedMail[] = [];
	const linesBeforeTls: string[] = [];
	const user = opts.user ?? 'ops@example.org';
	const password = opts.password ?? 'mailpass';
	const server = net.createServer((raw) => {
		let sock: net.Socket | tls.TLSSocket = raw;
		let secure = false;
		let buf = '';
		let authed = '';
		let from = '';
		let to: string[] = [];
		let inData = false;
		let data = '';
		const send = (l: string): void => {
			sock.write(`${l}\r\n`);
		};
		const onLine = (line: string): void => {
			if (!secure) linesBeforeTls.push(line);
			if (inData) {
				if (line === '.') {
					inData = false;
					mails.push({ from, to, data, tls: secure, authUser: authed });
					send('250 queued');
				} else data += `${line.startsWith('.') ? line.slice(1) : line}\r\n`; // RFC 5321 4.5.2
				return;
			}
			const cmd = line.split(' ')[0]!.toUpperCase();
			if (cmd === 'EHLO') {
				const caps = ['250-localhost'];
				if (!secure && opts.offerStartTls !== false) caps.push('250-STARTTLS');
				if (secure) caps.push('250-AUTH PLAIN LOGIN');
				caps.push('250 8BITMIME');
				for (const c of caps) send(c);
			} else if (cmd === 'STARTTLS') {
				send(opts.injectBeforeTls ? `220 go ahead\r\n${opts.injectBeforeTls}` : '220 go ahead');
				raw.removeAllListeners('data');
				sock = new tls.TLSSocket(raw, { isServer: true, cert: TEST_CERT, key: TEST_KEY });
				secure = true;
				sock.on('data', onData);
				sock.on('error', () => undefined);
			} else if (cmd === 'AUTH') {
				const parts = line.split(' ');
				const dec = Buffer.from(parts[2] ?? '', 'base64')
					.toString('utf8')
					.split('\u0000');
				if (secure && dec[1] === user && dec[2] === password) {
					authed = user;
					send('235 ok');
				} else send('535 no');
			} else if (cmd === 'MAIL') {
				if (!authed) return send('530 auth first');
				from = /<([^>]*)>/.exec(line)?.[1] ?? '';
				to = [];
				send('250 ok');
			} else if (cmd === 'RCPT') {
				const rcpt = /<([^>]*)>/.exec(line)?.[1] ?? '';
				if (opts.rejectRcpt?.(rcpt)) return send('550 no such user');
				to.push(rcpt);
				send('250 ok');
			} else if (cmd === 'DATA') {
				inData = true;
				data = '';
				send('354 go');
			} else if (cmd === 'QUIT') {
				send('221 bye');
				sock.end();
			} else send('500 ?');
		};
		const onData = (d: Buffer): void => {
			buf += d.toString('utf8');
			let i: number;
			while ((i = buf.indexOf('\r\n')) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				onLine(line);
			}
		};
		raw.on('data', onData);
		raw.on('error', () => undefined);
		send('220 fake mail ready');
	});
	const close = closer(server);
	const port = await listen(server);
	return { port, mails, linesBeforeTls, close };
}

export interface HttpHit {
	readonly method: string;
	readonly path: string;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
}

/** An HTTP or HTTPS (TEST_CERT) server answering with `handler`. */
export async function fakeHttp(
	handler: (hit: HttpHit) => { status: number; body: unknown },
	opts: { https?: boolean; cert?: string; key?: string } = {}
): Promise<Listening & { hits: HttpHit[] }> {
	const hits: HttpHit[] = [];
	const onReq = (req: http.IncomingMessage, res: http.ServerResponse): void => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const hit = {
				method: req.method ?? '',
				path: req.url ?? '',
				headers: req.headers,
				body: Buffer.concat(chunks).toString('utf8')
			};
			hits.push(hit);
			const r = handler(hit);
			res.writeHead(r.status, { 'Content-Type': 'application/json' });
			res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
		});
	};
	const server = opts.https
		? https.createServer({ cert: opts.cert ?? TEST_CERT, key: opts.key ?? TEST_KEY }, onReq)
		: http.createServer(onReq);
	const close = closer(server);
	const port = await listen(server);
	return { port, hits, close };
}

export interface FakeXmppOptions {
	/** Offer STARTTLS before login (default true). */
	readonly offerStartTls?: boolean;
	/** SASL mechanisms offered after TLS (default PLAIN). */
	readonly mechs?: readonly string[];
	/** The bot's password; a PLAIN login with another one fails. */
	readonly password?: string;
	/** SCRAM-SHA-256: 'bad' answers with a server signature that is wrong (a
	 *  server that does not know the password). */
	readonly scramProof?: 'good' | 'bad';
}

/**
 * An XMPP server for one bot: STARTTLS (TEST_CERT), SASL PLAIN, resource
 * binding, and it records every <message> it receives. `plain` is everything
 * the client sent before TLS, `secure` everything after.
 */
export async function fakeXmpp(
	o: FakeXmppOptions = {}
): Promise<Listening & { plain: string[]; secure: string[]; messages: string[] }> {
	const plain: string[] = [];
	const secure: string[] = [];
	const messages: string[] = [];
	const server = net.createServer((raw) => {
		raw.on('error', () => undefined);
		let sock: net.Socket | tls.TLSSocket = raw;
		let isSecure = false;
		let authed = false;
		let buf = '';
		let scram: { clientFirstBare: string; serverFirst: string; salt: Buffer } | null = null;
		const w = (x: string): void => {
			sock.write(x);
		};
		const hdr =
			"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0' from='localhost' id='1'>";
		const onData = (d: Buffer): void => {
			const x = d.toString('utf8');
			(isSecure ? secure : plain).push(x);
			buf += x;
			for (;;) {
				if (buf.includes('<stream:stream')) {
					buf = buf.replace(/<\?xml[^>]*>/, '').replace(/<stream:stream[^>]*>/, '');
					if (!isSecure && o.offerStartTls !== false)
						w(
							`${hdr}<stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/></stream:features>`
						);
					else if (!authed)
						w(
							`${hdr}<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'>${(o.mechs ?? ['PLAIN']).map((m) => `<mechanism>${m}</mechanism>`).join('')}</mechanisms></stream:features>`
						);
					else
						w(
							`${hdr}<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>`
						);
					continue;
				}
				let m: RegExpExecArray | null;
				if ((m = /<starttls[^>]*\/>/.exec(buf))) {
					buf = buf.slice(m.index + m[0].length);
					w("<proceed xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>");
					raw.removeAllListeners('data');
					sock = new tls.TLSSocket(raw, { isServer: true, cert: TEST_CERT, key: TEST_KEY });
					isSecure = true;
					sock.on('data', onData);
					sock.on('error', () => undefined);
					return;
				}
				if ((m = /<auth[^>]*mechanism='SCRAM-SHA-256'[^>]*>([^<]*)<\/auth>/.exec(buf))) {
					buf = buf.slice(m.index + m[0].length);
					const first = Buffer.from(m[1] ?? '', 'base64').toString('utf8');
					const clientFirstBare = first.replace(/^[^,]*,[^,]*,/, '');
					const nonce = /r=([^,]*)/.exec(clientFirstBare)?.[1] ?? '';
					const salt = randomBytes(16);
					const serverFirst = `r=${nonce}srv${randomBytes(8).toString('hex')},s=${salt.toString('base64')},i=4096`;
					scram = { clientFirstBare, serverFirst, salt };
					w(
						`<challenge xmlns='urn:ietf:params:xml:ns:xmpp-sasl'>${Buffer.from(serverFirst).toString('base64')}</challenge>`
					);
					continue;
				}
				if (scram !== null && (m = /<response[^>]*>([^<]*)<\/response>/.exec(buf))) {
					buf = buf.slice(m.index + m[0].length);
					const final = Buffer.from(m[1] ?? '', 'base64').toString('utf8');
					const withoutProof = final.replace(/,p=[^,]*$/, '');
					const authMessage = `${scram.clientFirstBare},${scram.serverFirst},${withoutProof}`;
					const salted = pbkdf2Sync(o.password ?? 'secret', scram.salt, 4096, 32, 'sha256');
					const serverKey = createHmac('sha256', salted).update('Server Key').digest();
					let sig = createHmac('sha256', serverKey).update(authMessage).digest();
					if (o.scramProof === 'bad') sig = randomBytes(32);
					authed = true;
					w(
						`<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'>${Buffer.from(`v=${sig.toString('base64')}`).toString('base64')}</success>`
					);
					continue;
				}
				if ((m = /<auth[^>]*>([^<]*)<\/auth>/.exec(buf))) {
					buf = buf.slice(m.index + m[0].length);
					const pass = Buffer.from(m[1] ?? '', 'base64')
						.toString('utf8')
						.split('\u0000')[2];
					if (pass === (o.password ?? 'secret')) {
						authed = true;
						w("<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>");
					} else w("<failure xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><not-authorized/></failure>");
					continue;
				}
				if ((m = /<iq[^>]*type='set'[\s\S]*?<\/iq>/.exec(buf))) {
					buf = buf.slice(m.index + m[0].length);
					const id = /id='([^']*)'/.exec(m[0])?.[1] ?? '';
					w(
						`<iq type='result' id='${id}'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>bot@localhost/notices</jid></bind></iq>`
					);
					continue;
				}
				if ((m = /<iq[^>]*type='get'[\s\S]*?<\/iq>/.exec(buf))) {
					buf = buf.slice(m.index + m[0].length);
					w(`<iq type='result' id='${/id='([^']*)'/.exec(m[0])?.[1] ?? ''}'/>`);
					continue;
				}
				if ((m = /<message[\s\S]*?<\/message>/.exec(buf))) {
					buf = buf.slice(m.index + m[0].length);
					messages.push(m[0]);
					continue;
				}
				break;
			}
		};
		raw.on('data', onData);
	});
	const close = closer(server);
	const port = await listen(server);
	return { port, plain, secure, messages, close };
}
