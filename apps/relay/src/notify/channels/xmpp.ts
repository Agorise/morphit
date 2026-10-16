/**
 * Offline notices — XMPP (Jabber), through the operator's bot account.
 *
 * A minimal client for one job: connect, secure the stream (STARTTLS, or TLS
 * from the first byte), log in with SCRAM-SHA-256 or SCRAM-SHA-1 (PLAIN only
 * when the stream is already encrypted), bind a resource, send one chat
 * message, close. The password never crosses an unencrypted clearnet stream:
 * a clearnet server that offers no TLS is refused. An .onion server is reached
 * through Tor, which encrypts the stream itself; STARTTLS is still used when
 * offered.
 *
 * The server's address comes from the operator's settings (host and port), so
 * no DNS SRV lookup is made — on a zero-clearnet box there must be none.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import type net from 'node:net';
import type tls from 'node:tls';
import { isOnionHost, openSocket, startTls, type NetPolicy } from '../net.ts';

export interface XmppConfig {
	/** The bot's bare JID (bot@example.org). */
	readonly jid: string;
	readonly password: string;
	/** Where to connect; defaults to the JID's domain. */
	readonly host: string;
	readonly port: number;
	/** 'starttls' (5222) or 'tls' (5223). */
	readonly security: 'starttls' | 'tls';
	/** Trust exactly this certificate instead of the system's. */
	readonly ca?: string;
}

export class XmppError extends Error {
	constructor(readonly stage: string) {
		super(`XMPP server refused at ${stage}`);
		this.name = 'XmppError';
	}
}

/**
 * Message Processing Hints (XEP-0334): ask the bot's server not to keep the
 * note in its archive (no-store, no-permanent-store) nor copy it to the bot's
 * other clients (no-copy), so the bot's account does not become a list of the
 * users it wrote to. A server may ignore hints; the operator docs say to turn
 * archiving off for the bot (docs/OPERATIONS.md §54).
 */
const NO_STORE =
	"<no-store xmlns='urn:xmpp:hints'/><no-permanent-store xmlns='urn:xmpp:hints'/><no-copy xmlns='urn:xmpp:hints'/>";

/** XML text escaping. PURE. */
export function xmlEscape(s: string): string {
	return (
		s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;')
			// Characters XML 1.0 does not allow at all.
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
	);
}

/** SCRAM (RFC 5802) client, for SHA-1 and SHA-256. Exported for tests. */
export function scramClient(
	alg: 'sha1' | 'sha256',
	user: string,
	password: string,
	cnonce = randomBytes(18).toString('base64')
) {
	const saslName = user.replace(/=/g, '=3D').replace(/,/g, '=2C');
	const clientFirstBare = `n=${saslName},r=${cnonce}`;
	let expectedServerSig: Buffer | null = null;
	return {
		first: `n,,${clientFirstBare}`,
		final(serverFirst: string): string {
			const attrs = new Map(serverFirst.split(',').map((kv) => [kv[0]!, kv.slice(2)] as const));
			const nonce = attrs.get('r') ?? '';
			const salt = Buffer.from(attrs.get('s') ?? '', 'base64');
			const iter = Number(attrs.get('i') ?? '0');
			if (
				!nonce.startsWith(cnonce) ||
				salt.length === 0 ||
				!Number.isInteger(iter) ||
				iter < 1 ||
				iter > 1_000_000
			) {
				throw new XmppError('SCRAM (bad server challenge)');
			}
			const keyLen = alg === 'sha1' ? 20 : 32;
			const salted = pbkdf2Sync(password, salt, iter, keyLen, alg);
			const clientKey = createHmac(alg, salted).update('Client Key').digest();
			const storedKey = createHash(alg).update(clientKey).digest();
			const finalNoProof = `c=biws,r=${nonce}`;
			const authMessage = `${clientFirstBare},${serverFirst},${finalNoProof}`;
			const clientSig = createHmac(alg, storedKey).update(authMessage).digest();
			const proof = Buffer.alloc(keyLen);
			for (let i = 0; i < keyLen; i++) proof[i] = clientKey[i]! ^ clientSig[i]!;
			const serverKey = createHmac(alg, salted).update('Server Key').digest();
			expectedServerSig = createHmac(alg, serverKey).update(authMessage).digest();
			return `${finalNoProof},p=${proof.toString('base64')}`;
		},
		/** The server proved it knows the password too. */
		verify(serverFinal: string): boolean {
			const v = /(?:^|,)v=([^,]*)/.exec(serverFinal)?.[1];
			if (v === undefined || expectedServerSig === null) return false;
			const got = Buffer.from(v, 'base64');
			return got.length === expectedServerSig.length && timingSafeEqual(got, expectedServerSig);
		}
	};
}

/** The most the server may send before what this client waits for. */
export const MAX_STREAM_CHARS = 64 * 1024;

/** Accumulates the server's stream and waits for one of a set of elements. */
class Stream {
	private buf = '';
	private waiting: {
		re: RegExp;
		resolve: (m: RegExpExecArray) => void;
		reject: (e: Error) => void;
		t: NodeJS.Timeout;
	} | null = null;
	private dead: Error | null = null;
	constructor(
		public sock: net.Socket | tls.TLSSocket,
		private readonly timeoutMs: number
	) {
		this.attach(sock);
	}
	attach(sock: net.Socket | tls.TLSSocket): void {
		this.sock = sock;
		this.buf = '';
		sock.on('data', (d: Buffer) => {
			this.buf += d.toString('utf8');
			// Every element this client waits for is small; past this the
			// server is flooding (each check scans what is buffered).
			if (this.buf.length > MAX_STREAM_CHARS) {
				this.buf = '';
				this.die(new XmppError('stream (too much data)'));
				sock.destroy();
				return;
			}
			this.check();
		});
		sock.on('error', (e) => this.die(e));
		sock.on('close', () => this.die(new XmppError('stream (closed)')));
	}
	detach(): void {
		this.sock.removeAllListeners('data');
		this.sock.removeAllListeners('error');
		this.sock.removeAllListeners('close');
	}
	private die(e: Error): void {
		if (this.dead) return;
		this.dead = e;
		if (this.waiting) {
			clearTimeout(this.waiting.t);
			this.waiting.reject(e);
			this.waiting = null;
		}
	}
	private check(): void {
		if (!this.waiting) return;
		const m = this.waiting.re.exec(this.buf);
		if (!m) {
			if (/<stream:error[\s>]/.test(this.buf)) this.die(new XmppError('stream (server error)'));
			return;
		}
		this.buf = this.buf.slice(m.index + m[0].length);
		const w = this.waiting;
		this.waiting = null;
		clearTimeout(w.t);
		w.resolve(m);
	}
	wait(re: RegExp, stage: string): Promise<RegExpExecArray> {
		if (this.dead) return Promise.reject(this.dead);
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				this.waiting = null;
				reject(new XmppError(`${stage} (no answer in time)`));
			}, this.timeoutMs);
			this.waiting = { re, resolve, reject, t };
			this.check();
		});
	}
	write(s: string): void {
		this.sock.write(s);
	}
}

const FEATURES = /<stream:features[^>]*>([\s\S]*?)<\/stream:features>|<stream:features[^>]*\/>/;

function openStream(s: Stream, domain: string): void {
	s.write(
		`<?xml version='1.0'?><stream:stream to='${xmlEscape(domain)}' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>`
	);
}

export async function sendXmpp(
	cfg: XmppConfig,
	policy: NetPolicy,
	to: string,
	text: string,
	timeoutMs = 60_000
): Promise<void> {
	const at = cfg.jid.indexOf('@');
	if (at < 1) throw new XmppError('settings (the bot JID has no @)');
	const user = cfg.jid.slice(0, at);
	const domain = cfg.jid.slice(at + 1);
	const raw = await openSocket(cfg.host, cfg.port, policy, { timeoutMs });
	let sock: net.Socket | tls.TLSSocket = raw;
	const onion = isOnionHost(cfg.host);
	let encrypted = onion;
	// An .onion address IS the server's key (Tor proves who answers): its
	// certificate is not checked there, unless one is pinned.
	const tlsOpts =
		cfg.ca !== undefined ? { ca: cfg.ca } : onion ? { rejectUnauthorized: false } : {};
	if (cfg.security === 'tls') {
		sock = await startTls(raw, domain, tlsOpts);
		encrypted = true;
	}
	const s = new Stream(sock, timeoutMs);
	try {
		openStream(s, domain);
		let feat = (await s.wait(FEATURES, 'stream features'))[1] ?? '';
		if (cfg.security === 'starttls' && /<starttls[\s/>]/.test(feat)) {
			s.write("<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>");
			await s.wait(/<proceed[^>]*\/>|<proceed[^>]*>\s*<\/proceed>/, 'STARTTLS');
			s.detach();
			sock = await startTls(sock as net.Socket, domain, tlsOpts);
			s.attach(sock);
			encrypted = true;
			openStream(s, domain);
			feat = (await s.wait(FEATURES, 'stream features'))[1] ?? '';
		}
		if (!encrypted)
			throw new XmppError(
				'STARTTLS (not offered by a clearnet server; refusing to log in unencrypted)'
			);

		const mechs = [...feat.matchAll(/<mechanism>([^<]+)<\/mechanism>/g)].map((m) =>
			m[1]!.trim().toUpperCase()
		);
		const alg = mechs.includes('SCRAM-SHA-256')
			? 'sha256'
			: mechs.includes('SCRAM-SHA-1')
				? 'sha1'
				: null;
		if (alg !== null) {
			const scram = scramClient(alg, user, cfg.password);
			s.write(
				`<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='${alg === 'sha256' ? 'SCRAM-SHA-256' : 'SCRAM-SHA-1'}'>${Buffer.from(scram.first, 'utf8').toString('base64')}</auth>`
			);
			const ch = await s.wait(
				/<challenge[^>]*>([^<]*)<\/challenge>|<failure[\s\S]*?<\/failure>/,
				'login'
			);
			if (ch[1] === undefined) throw new XmppError('login');
			const final = scram.final(Buffer.from(ch[1], 'base64').toString('utf8'));
			s.write(
				`<response xmlns='urn:ietf:params:xml:ns:xmpp-sasl'>${Buffer.from(final, 'utf8').toString('base64')}</response>`
			);
			const ok = await s.wait(
				/<success[^>]*\/>|<success[^>]*>([^<]*)<\/success>|<failure[\s\S]*?<\/failure>/,
				'login'
			);
			if (!ok[0].startsWith('<success')) throw new XmppError('login');
			if (!scram.verify(Buffer.from(ok[1] ?? '', 'base64').toString('utf8'))) {
				throw new XmppError('login (the server could not prove it knows the password)');
			}
		} else if (mechs.includes('PLAIN')) {
			s.write(
				`<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>${Buffer.from(`\u0000${user}\u0000${cfg.password}`, 'utf8').toString('base64')}</auth>`
			);
			const ok = await s.wait(
				/<success[^>]*\/>|<success[^>]*>[^<]*<\/success>|<failure[\s\S]*?<\/failure>/,
				'login'
			);
			if (!ok[0].startsWith('<success')) throw new XmppError('login');
		} else {
			throw new XmppError('login (no SCRAM or PLAIN offered)');
		}

		openStream(s, domain);
		feat = (await s.wait(FEATURES, 'stream features'))[1] ?? '';
		s.write(
			"<iq type='set' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>notices</resource></bind></iq>"
		);
		const bound = await s.wait(
			/<iq[^>]*\bid=['"]bind1['"][^>]*>[\s\S]*?<\/iq>|<iq[^>]*\bid=['"]bind1['"][^>]*\/>/,
			'bind'
		);
		if (!/type=['"]result['"]/.test(bound[0])) throw new XmppError('bind');
		// RFC 3921 session, only where the server still requires it.
		const sess =
			/<session[^>]*urn:ietf:params:xml:ns:xmpp-session[^>]*(?:\/>|>([\s\S]*?)<\/session>)/.exec(
				feat
			);
		if (sess !== null && !/<optional\s*\/>/.test(sess[1] ?? '')) {
			s.write(
				"<iq type='set' id='sess1'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>"
			);
			await s.wait(/<iq[^>]*\bid=['"]sess1['"][^>]*(?:\/>|>[\s\S]*?<\/iq>)/, 'session');
		}
		s.write(
			`<message to='${xmlEscape(to)}' type='chat' id='${randomBytes(8).toString('hex')}'><body>${xmlEscape(text)}</body>${NO_STORE}</message>`
		);
		// A ping round-trip proves the server took the message before we close.
		s.write("<iq type='get' id='ping1'><ping xmlns='urn:xmpp:ping'/></iq>");
		await s.wait(/<iq[^>]*\bid=['"]ping1['"][^>]*(?:\/>|>[\s\S]*?<\/iq>)/, 'delivery');
		s.write('</stream:stream>');
	} finally {
		s.detach();
		sock.destroy();
	}
}
