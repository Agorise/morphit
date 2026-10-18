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
import { StringDecoder } from 'node:string_decoder';
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

/**
 * A password as servers keep it: SASLprep (RFC 4013) — non-ASCII spaces
 * (RFC 3454 C.1.2) become a space, characters "commonly mapped to nothing"
 * (B.1: soft hyphen, zero-width joiners, variation selectors…) go, then NFKC.
 * SCRAM must hash exactly this (RFC 5802 §2.2), and a server stores the
 * password this way when an account is made, so a login with the password
 * as typed fails for such a password. PURE.
 */
export function saslPrep(password: string): string {
	return (
		password
			.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
			.replace(/[\u00ad\u034f\u1806\u180b-\u180d\u200b-\u200d\u2060\ufe00-\ufe0f\ufeff]/g, '')
			// NFKC between the characters Unicode 3.2 did not have, which stay.
			.split(NEWER_THAN_3_2)
			.map((part, i) => (i % 2 === 1 ? part : part.normalize('NFKC')))
			.join('')
	);
}

/**
 * SASLprep is defined on Unicode 3.2 (RFC 3454 A.1 lists what it did not
 * have): such a character is left as it is, and servers store it so (real
 * Prosody 0.12: "⅐" U+2150, "ᴬ" U+1D2C, "爫" U+FA70 kept), where today's NFKC
 * would change it. These are the ranges unassigned in Unicode 3.2 that hold a
 * character Node's NFKC changes (ICU 77, Unicode 16).
 */
const NEWER_THAN_3_2 =
	/([\u03f7-\u03ff\u10fc-\u10ff\u18aa-\u1dff\u208f-\u209f\u213b-\u213c\u214c-\u2152\u2184-\u218f\u2b00-\u2e7f\u321d-\u321f\u3244-\u3250\u327c-\u327e\u32cc-\u32cf\u32ff\u3377-\u337a\u33de-\u33df\u33ff\ua4c7-\uabff\ufa2e-\ufa2f\ufa6b-\ufaff\ufe10-\ufe1f\ufe47-\ufe48\u{1044e}-\u{1cfff}\u{1d4c1}\u{1d6a4}-\u{1d6a7}\u{1d7ca}-\u{1d7cd}\u{1d800}-\u{1ffff}]+)/u;

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

/** One complete element the server sent at the top of its stream (a stanza,
 *  its features, a SASL or TLS answer), with where its start tag ends. */
export interface Top {
	readonly el: string;
	/** Length of the start tag (`el.slice(0, tagLen)` is it). */
	readonly tagLen: number;
}

/** The element's name (`iq`, `stream:features`…). PURE. */
export function topName(t: Top): string {
	return /^<([^\s/>]+)/.exec(t.el)?.[1] ?? '';
}

/** An attribute of the element's start tag, unescaped (linear scan). PURE. */
export function topAttr(t: Top, name: string): string | undefined {
	const tag = t.el.slice(0, t.tagLen);
	for (const m of tag.matchAll(/\s([^\s=/>]+)\s*=\s*(?:'([^']*)'|"([^"]*)")/g))
		if (m[1] === name) return xmlUnescape(m[2] ?? m[3] ?? '');
	return undefined;
}

/** What is between the start and the end tag ('' when self-closing). PURE. */
export function topInner(t: Top): string {
	if (t.el.slice(0, t.tagLen).endsWith('/>')) return '';
	const end = t.el.lastIndexOf('</');
	return end > t.tagLen ? t.el.slice(t.tagLen, end) : '';
}

/**
 * Accumulates the server's stream and waits for one of its top-level
 * elements. The bytes are split into elements by a small scanner that looks
 * at each character once, so nothing the server sends costs more than linear
 * time — this runs inside the relay, where a slow regular expression over a
 * server's bytes would stall every user. A `<` inside a tag (never valid XML)
 * ends the stream.
 */
class Stream {
	private buf = '';
	private pos = 0;
	private depth = 0;
	private inTag = false;
	private quote: string | null = null;
	private tagStart = 0;
	private elemStart = 0;
	private decoder = new StringDecoder('utf8');
	private readonly queue: Top[] = [];
	private queued = 0;
	/** Queued elements already compared with the current wait: each piece
	 *  that arrives costs only what is new in it. */
	private checked = 0;
	private waiting: {
		match: (t: Top) => boolean;
		resolve: (t: Top) => void;
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
		// A new transport (after STARTTLS): nothing read before it counts.
		this.buf = '';
		this.pos = 0;
		this.depth = 0;
		this.inTag = false;
		this.quote = null;
		this.queue.length = 0;
		this.queued = 0;
		this.checked = 0;
		this.decoder = new StringDecoder('utf8');
		sock.on('data', (d: Buffer) => {
			if (this.dead) return;
			this.buf += this.decoder.write(d);
			this.scan();
			// Every element this client waits for is small; past this the
			// server is flooding.
			if (this.dead === null && this.queued + this.buf.length > MAX_STREAM_CHARS) {
				this.die(new XmppError('stream (too much data)'));
				sock.destroy();
				return;
			}
			this.check();
		});
		sock.on('error', (e) => this.die(e));
		sock.on('close', () => this.die(new XmppError('stream (closed)')));
	}
	/** Split what arrived into top-level elements (each character once). */
	private scan(): void {
		const b = this.buf;
		for (let i = this.pos; i < b.length; i++) {
			const c = b[i]!;
			if (!this.inTag) {
				if (c === '<') {
					this.inTag = true;
					this.tagStart = i;
				}
				continue;
			}
			if (this.quote !== null) {
				if (c === this.quote) this.quote = null;
				else if (c === '<') return this.die(new XmppError('stream (not XML)'));
				continue;
			}
			if (c === "'" || c === '"') this.quote = c;
			else if (c === '<') return this.die(new XmppError('stream (not XML)'));
			else if (c === '>') {
				this.inTag = false;
				const tag = b.slice(this.tagStart, i + 1);
				if (tag.startsWith('<?') || tag.startsWith('<!')) continue;
				if (tag.startsWith('</')) {
					if (this.depth <= 1) {
						// The server ended its stream (with its reason, if it gave one).
						const said = this.queue.some((t) => topName(t) === 'stream:error');
						// What it answered before its end still counts.
						this.check();
						return this.die(new XmppError(said ? 'stream (server error)' : 'stream (closed)'));
					}
					this.depth--;
					if (this.depth === 1) this.push(this.elemStart, i + 1);
				} else if (/^<stream:stream[\s>]/.test(tag)) {
					// The server's stream header (again after each restart).
					this.depth = 1;
				} else if (tag.endsWith('/>')) {
					if (this.depth === 1) this.push(this.tagStart, i + 1);
				} else {
					if (this.depth === 1) this.elemStart = this.tagStart;
					if (this.depth >= 1) this.depth++;
				}
			}
		}
		// Keep only what an unfinished element still needs.
		const keep = this.depth > 1 ? this.elemStart : this.inTag ? this.tagStart : b.length;
		this.buf = b.slice(keep);
		this.pos = b.length - keep;
		this.elemStart -= keep;
		this.tagStart -= keep;
	}
	private push(start: number, end: number): void {
		// A copy: a slice would keep the whole received piece alive (V8 shares
		// the parent string), so what is kept would not be what is counted.
		const el = Buffer.from(this.buf.slice(start, end), 'utf8').toString('utf8');
		let tagLen = start === this.tagStart ? end - start : 0;
		if (tagLen === 0) {
			// The start tag's end: the first '>' outside quotes.
			let q: string | null = null;
			for (let k = 0; k < el.length; k++) {
				const c = el[k]!;
				if (q !== null) {
					if (c === q) q = null;
				} else if (c === "'" || c === '"') q = c;
				else if (c === '>') {
					tagLen = k + 1;
					break;
				}
			}
		}
		this.queue.push({ el, tagLen });
		this.queued += el.length;
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
		for (let i = this.checked; i < this.queue.length; i++) {
			const t = this.queue[i]!;
			if (topName(t) === 'stream:error') return this.die(new XmppError('stream (server error)'));
			if (!this.waiting.match(t)) continue;
			for (const d of this.queue.splice(0, i + 1)) this.queued -= d.el.length;
			this.checked = 0;
			const w = this.waiting;
			this.waiting = null;
			clearTimeout(w.t);
			w.resolve(t);
			return;
		}
		this.checked = this.queue.length;
	}
	wait(match: (t: Top) => boolean, stage: string): Promise<Top> {
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				this.waiting = null;
				reject(new XmppError(`${stage} (no answer in time)`));
			}, this.timeoutMs);
			this.waiting = { match, resolve, reject, t };
			this.checked = 0;
			// An answer that came before the stream ended still counts.
			this.check();
			if (this.waiting !== null && this.dead !== null) {
				clearTimeout(t);
				this.waiting = null;
				reject(this.dead);
			}
		});
	}
	write(s: string): void {
		this.sock.write(s);
	}
	/** The server ended the stream (or it broke). */
	get closed(): boolean {
		return this.dead !== null;
	}
}

/** Waits for a top-level element by name. */
const named =
	(...names: string[]) =>
	(t: Top): boolean =>
		names.includes(topName(t));
const FEATURES = named('stream:features');

function openStream(s: Stream, domain: string): void {
	s.write(
		`<?xml version='1.0'?><stream:stream to='${xmlEscape(domain)}' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>`
	);
}

/** Where an XMPP server is reached (the account's domain, and how). */
export interface XmppServer {
	readonly domain: string;
	readonly host: string;
	readonly port: number;
	readonly security: 'starttls' | 'tls';
	readonly ca?: string;
}

/** Connect and secure the stream (or refuse): returns it with its features. */
async function secureStream(
	server: XmppServer,
	policy: NetPolicy,
	timeoutMs: number
): Promise<{ s: Stream; feat: string }> {
	const { domain } = server;
	const raw = await openSocket(server.host, server.port, policy, { timeoutMs });
	let sock: net.Socket | tls.TLSSocket = raw;
	const onion = isOnionHost(server.host);
	let encrypted = onion;
	// An .onion address IS the server's key (Tor proves who answers): its
	// certificate is not checked there, unless one is pinned.
	const tlsOpts =
		server.ca !== undefined ? { ca: server.ca } : onion ? { rejectUnauthorized: false } : {};
	try {
		if (server.security === 'tls') {
			sock = await startTls(raw, domain, tlsOpts);
			encrypted = true;
		}
	} catch (err) {
		raw.destroy();
		throw err;
	}
	const s = new Stream(sock, timeoutMs);
	try {
		openStream(s, domain);
		let feat = topInner(await s.wait(FEATURES, 'stream features'));
		if (server.security === 'starttls' && /<starttls[\s/>]/.test(feat)) {
			s.write("<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>");
			await s.wait(named('proceed'), 'STARTTLS');
			s.detach();
			sock = await startTls(sock as net.Socket, domain, tlsOpts);
			s.attach(sock);
			encrypted = true;
			openStream(s, domain);
			feat = topInner(await s.wait(FEATURES, 'stream features'));
		}
		if (!encrypted)
			throw new XmppError(
				'STARTTLS (not offered by a clearnet server; refusing to log in unencrypted)'
			);
		return { s, feat };
	} catch (err) {
		closeStream(s);
		throw err;
	}
}

function closeStream(s: Stream): void {
	s.detach();
	s.sock.destroy();
}

/** Log in on a secured stream and bind a resource. */
async function logIn(
	s: Stream,
	feat0: string,
	domain: string,
	user: string,
	typed: string
): Promise<void> {
	let feat = feat0;
	const password = saslPrep(typed);
	const mechs = [...feat.matchAll(/<mechanism>([^<]+)<\/mechanism>/g)].map((m) =>
		m[1]!.trim().toUpperCase()
	);
	const alg = mechs.includes('SCRAM-SHA-256')
		? 'sha256'
		: mechs.includes('SCRAM-SHA-1')
			? 'sha1'
			: null;
	if (alg !== null) {
		const scram = scramClient(alg, user, password);
		s.write(
			`<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='${alg === 'sha256' ? 'SCRAM-SHA-256' : 'SCRAM-SHA-1'}'>${Buffer.from(scram.first, 'utf8').toString('base64')}</auth>`
		);
		const ch = await s.wait(named('challenge', 'failure'), 'login');
		if (topName(ch) !== 'challenge') throw new XmppError('login');
		const final = scram.final(Buffer.from(topInner(ch), 'base64').toString('utf8'));
		s.write(
			`<response xmlns='urn:ietf:params:xml:ns:xmpp-sasl'>${Buffer.from(final, 'utf8').toString('base64')}</response>`
		);
		const ok = await s.wait(named('success', 'failure'), 'login');
		if (topName(ok) !== 'success') throw new XmppError('login');
		if (!scram.verify(Buffer.from(topInner(ok), 'base64').toString('utf8'))) {
			throw new XmppError('login (the server could not prove it knows the password)');
		}
	} else if (mechs.includes('PLAIN')) {
		s.write(
			`<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>${Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64')}</auth>`
		);
		const ok = await s.wait(named('success', 'failure'), 'login');
		if (topName(ok) !== 'success') throw new XmppError('login');
	} else {
		throw new XmppError('login (no SCRAM or PLAIN offered)');
	}

	openStream(s, domain);
	feat = topInner(await s.wait(FEATURES, 'stream features'));
	s.write(
		"<iq type='set' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>notices</resource></bind></iq>"
	);
	const bound = await s.wait(iqAnswer('bind1'), 'bind');
	if (topAttr(bound, 'type') !== 'result') throw new XmppError('bind');
	// RFC 3921 session, only where the server still requires it.
	if (sessionRequired(feat)) {
		s.write(
			"<iq type='set' id='sess1'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>"
		);
		await s.wait(iqAnswer('sess1'), 'session');
	}
}

/** The server's answer to the iq with this id: a top-level <iq> only. */
function iqAnswer(id: string): (t: Top) => boolean {
	return (t) => topName(t) === 'iq' && topAttr(t, 'id') === id;
}

/** Whether the features ask for an RFC 3921 session that is not optional
 *  (linear: each '<session' start tag is read once). PURE. */
export function sessionRequired(feat: string): boolean {
	for (let i = feat.indexOf('<session'); i >= 0; ) {
		const end = feat.indexOf('>', i);
		if (end < 0) return false;
		const tag = feat.slice(i, end + 1);
		if (/^<session[\s/>]/.test(tag) && tag.includes('urn:ietf:params:xml:ns:xmpp-session')) {
			if (tag.endsWith('/>')) return true;
			const close = feat.indexOf('</session>', end);
			return !/<optional\s*\/>/.test(close < 0 ? '' : feat.slice(end + 1, close));
		}
		i = feat.indexOf('<session', end);
	}
	return false;
}

function serverOf(cfg: XmppConfig): { server: XmppServer; user: string } {
	const at = cfg.jid.indexOf('@');
	if (at < 1) throw new XmppError('settings (the bot JID has no @)');
	return {
		user: cfg.jid.slice(0, at),
		server: {
			domain: cfg.jid.slice(at + 1),
			host: cfg.host,
			port: cfg.port,
			security: cfg.security,
			...(cfg.ca !== undefined ? { ca: cfg.ca } : {})
		}
	};
}

export async function sendXmpp(
	cfg: XmppConfig,
	policy: NetPolicy,
	to: string,
	text: string,
	timeoutMs = 60_000
): Promise<void> {
	const { server, user } = serverOf(cfg);
	const { s, feat } = await secureStream(server, policy, timeoutMs);
	try {
		await logIn(s, feat, server.domain, user, cfg.password);
		s.write(
			`<message to='${xmlEscape(to)}' type='chat' id='${randomBytes(8).toString('hex')}'><body>${xmlEscape(text)}</body>${NO_STORE}</message>`
		);
		// A ping round-trip proves the server took the message before we close.
		s.write("<iq type='get' id='ping1'><ping xmlns='urn:xmpp:ping'/></iq>");
		await s.wait(iqAnswer('ping1'), 'delivery');
		s.write('</stream:stream>');
	} finally {
		closeStream(s);
	}
}

/**
 * Turn the account's message archive (XEP-0313) off: from now on its server
 * keeps no copy of the notes it sends, so it does not become a list of the
 * users it wrote to. 'off' when the server took it, 'unsupported' when it has
 * no such archive setting (it may keep none, or keep it anyway).
 */
export async function xmppArchiveOff(
	cfg: XmppConfig,
	policy: NetPolicy,
	timeoutMs = 60_000
): Promise<'off' | 'unsupported'> {
	const { server, user } = serverOf(cfg);
	const { s, feat } = await secureStream(server, policy, timeoutMs);
	try {
		await logIn(s, feat, server.domain, user, cfg.password);
		// mam:2, then the older mam:1. Only "no such setting" moves on (Prosody
		// answers an unknown version with service-unavailable); any other
		// refusal is a refusal, not "unsupported".
		let answer: 'off' | 'unsupported' = 'unsupported';
		for (const ns of ['urn:xmpp:mam:2', 'urn:xmpp:mam:1']) {
			s.write(`<iq type='set' id='mam1'><prefs xmlns='${ns}' default='never'/></iq>`);
			const r = await s.wait(iqAnswer('mam1'), 'archive setting');
			if (topAttr(r, 'type') !== 'result') {
				if (/<(?:service-unavailable|feature-not-implemented)\b/.test(r.el)) continue;
				throw new XmppError('archive setting (refused)');
			}
			// Taken: read it back — "off" only when the server now says never.
			s.write(`<iq type='get' id='mam2'><prefs xmlns='${ns}'/></iq>`);
			const g = await s.wait(iqAnswer('mam2'), 'archive setting');
			const def = /<prefs\b[^>]*\bdefault=['"]([a-z]+)['"]/.exec(g.el)?.[1];
			if (topAttr(g, 'type') !== 'result' || def !== 'never')
				throw new XmppError('archive setting (the server still keeps copies)');
			answer = 'off';
			break;
		}
		s.write('</stream:stream>');
		return answer;
	} finally {
		closeStream(s);
	}
}

// ─── In-band registration (XEP-0077) ───────────────────────────────────────

/** What a server asks of a new account, read from its registration form. */
export interface RegistrationForm {
	/** 'open': a username and a password are all it needs; 'captcha': it also
	 *  wants a picture check (answerable only with `captchaUrl`); 'web': it
	 *  registers only on its web page; 'needs_more': it asks for more (an
	 *  email address…); 'closed': it takes no new accounts this way. */
	readonly status: 'open' | 'captcha' | 'web' | 'needs_more' | 'closed';
	/** A web page: the registration page ('web'), or the picture ('captcha'). */
	readonly url?: string;
	/** What else it asks for ('needs_more'): field names. */
	readonly fields?: readonly string[];
	/** Whether the answer goes in its data form (else the plain fields). */
	readonly dataForm: boolean;
	/** The form's hidden fields, sent back as they came. */
	readonly hidden: ReadonlyArray<readonly [string, string]>;
	/** The form's captcha field name ('ocr', 'qa'…), when it has one. */
	readonly captchaField?: string;
}

const xmlUnescape = (s: string): string =>
	s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n) % 0x110000))
		.replace(/&amp;/g, '&');

/** A web address worth showing: http(s) only, printable, bounded. */
function webUrl(v: string | undefined): string | undefined {
	if (v === undefined) return undefined;
	const u = xmlUnescape(v).trim();
	return /^https?:\/\/[^\s<>"'\u0000-\u001f\u007f-\u009f]{1,500}$/.test(u) ? u : undefined;
}

const PLAIN_ASKED = ['username', 'password'];
/** Plain-field elements a registration answer may carry that ask nothing. */
const NOT_ASKED = new Set(['instructions', 'registered', 'x', 'data']);
/** Data-form field names that are not questions. */
const CAPTCHA_FIELDS = new Set([
	'ocr',
	'qa',
	'picture_q',
	'picture_recog',
	'speech_q',
	'speech_recog',
	'audio_recog',
	'video_q',
	'video_recog'
]);

/** Fields that carry the picture check's web page (ejabberd: captcha-fallback-url; XEP-0158: url). */
const PICTURE_PAGE = new Set(['captcha-fallback-url', 'url']);

/** Read a server's answer to the registration question. PURE. */
export function classifyRegistration(iq: string): RegistrationForm {
	const none = { dataForm: false, hidden: [] } as const;
	if (!/type=['"]result['"]/.test(iq.slice(0, iq.indexOf('>') + 1)))
		return { status: 'closed', ...none };
	const query = /<query\b[^>]*jabber:iq:register[^>]*>([\s\S]*?)<\/query>/.exec(iq)?.[1];
	if (query === undefined) return { status: 'closed', ...none };
	const xform = /<x\b[^>]*jabber:x:data[^>]*>([\s\S]*?)<\/x>/.exec(query)?.[1];
	const oob = webUrl(/<x\b[^>]*jabber:x:oob[^>]*>[\s\S]*?<url>([^<]*)<\/url>/.exec(query)?.[1]);
	// The plain fields, outside any form.
	const outside = query
		.replace(/<x\b[^>]*jabber:x:data[\s\S]*?<\/x>/g, '')
		.replace(/<x\b[^>]*jabber:x:oob[\s\S]*?<\/x>/g, '')
		.replace(/<data\b[\s\S]*?<\/data>/g, '');
	const plain = [...outside.matchAll(/<([a-z_]+)\b[^>]*?(?:\/>|>)/gi)]
		.map((m) => m[1]!.toLowerCase())
		.filter((n) => !NOT_ASKED.has(n));
	if (xform === undefined) {
		if (plain.includes('username') && plain.includes('password')) {
			const more = plain.filter((n) => !PLAIN_ASKED.includes(n));
			return more.length > 0
				? { status: 'needs_more', fields: more, ...none }
				: { status: 'open', ...none };
		}
		return oob !== undefined ? { status: 'web', url: oob, ...none } : { status: 'closed', ...none };
	}
	const fields = [...xform.matchAll(/<field\b([^>]*?)(?:\/>|>([\s\S]*?)<\/field>)/g)].map((m) => {
		const attrs = m[1] ?? '';
		const body = m[2] ?? '';
		return {
			name: /\bvar=['"]([^'"]*)['"]/.exec(attrs)?.[1] ?? '',
			type: /\btype=['"]([^'"]*)['"]/.exec(attrs)?.[1] ?? 'text-single',
			required: /<required\s*\/>/.test(body),
			value: xmlUnescape(/<value>([^<]*)<\/value>/.exec(body)?.[1] ?? ''),
			media: /<uri\b[^>]*>([^<]*)<\/uri>/.exec(body)?.[1]
		};
	});
	const hidden = fields
		.filter((f) => f.type === 'hidden' && f.name !== '')
		.map((f) => [f.name, f.value] as const);
	const formType = hidden.find(([n]) => n === 'FORM_TYPE')?.[1] ?? '';
	const captcha = fields.find((f) => CAPTCHA_FIELDS.has(f.name));
	const asked = fields.filter(
		(f) => f.name !== '' && f.type !== 'hidden' && f.type !== 'fixed' && !PICTURE_PAGE.has(f.name)
	);
	const base = { dataForm: true, hidden };
	if (!asked.some((f) => f.name === 'username') || !asked.some((f) => f.name === 'password'))
		return oob !== undefined ? { status: 'web', url: oob, ...base } : { status: 'closed', ...base };
	// Anything else it requires (an email address…) cannot be answered here,
	// picture check or not.
	const more = asked
		.filter((f) => f.required && !PLAIN_ASKED.includes(f.name) && f !== captcha)
		.map((f) => f.name);
	if (more.length > 0) return { status: 'needs_more', fields: more, ...base };
	if (captcha !== undefined || formType === 'urn:xmpp:captcha') {
		// The picture as a web page: ejabberd's "CAPTCHA web page" field, an
		// http(s) media address, or the out-of-band page.
		const url =
			webUrl(fields.find((f) => PICTURE_PAGE.has(f.name))?.value) ?? webUrl(captcha?.media) ?? oob;
		return {
			status: 'captcha',
			...base,
			...(url !== undefined ? { url } : {}),
			...(captcha !== undefined ? { captchaField: captcha.name } : {})
		};
	}
	return { status: 'open', ...base };
}

/** Ask the server what a new account needs (nothing is registered). */
export async function xmppRegistrationForm(
	server: XmppServer,
	policy: NetPolicy,
	timeoutMs = 30_000
): Promise<RegistrationForm> {
	const { s } = await secureStream(server, policy, timeoutMs);
	try {
		return classifyRegistration(await askForm(s, server.domain));
	} finally {
		closeStream(s);
	}
}

async function askForm(s: Stream, domain: string): Promise<string> {
	s.write(
		`<iq type='get' id='reg1' to='${xmlEscape(domain)}'><query xmlns='jabber:iq:register'/></iq>`
	);
	return (await s.wait(iqAnswer('reg1'), 'registration form')).el;
}

/** Why a server refused a new account. */
export type RegistrationRefusal =
	/** That username is taken. */
	| 'taken'
	/** It refused the username or the password (too weak, not allowed…): see `text`. */
	| 'not_acceptable'
	/** Too many new accounts from this address lately. */
	| 'rate_limited'
	/** The picture check was answered wrongly. */
	| 'captcha_wrong'
	/** The server closed the stream before the picture check was answered
	 *  (ejabberd waits about 30 s): a new picture comes with the next try. */
	| 'captcha_expired'
	/** It takes no new accounts (this way, or now). */
	| 'not_allowed'
	| 'failed';

export type RegistrationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly form: RegistrationForm }
	| { readonly ok: false; readonly why: RegistrationRefusal; readonly text: string };

/** Text made safe to print: control and direction characters become
 *  spaces, runs of spaces one. PURE. */
const printable = (t: string): string =>
	t
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/** The server's own words in an error (`<text>`), made safe to print, with
 *  `secret` taken out — as cleaning shows it, and before the cut at 200
 *  characters, so neither lets a piece of it through. PURE. */
function errorText(iq: string, secret = ''): string {
	const t = printable(xmlUnescape(/<text\b[^>]*>([^<]*)<\/text>/.exec(iq)?.[1] ?? ''));
	const shown = printable(secret);
	return (shown === '' ? t : t.split(shown).join('…')).slice(0, 200);
}

/**
 * Register `user` with `password` (XEP-0077), on a secured stream only. When
 * the server wants a picture check, `answerCaptcha` is asked (with the form)
 * on the same stream; without it, or with no answer, nothing is registered.
 */
export async function registerXmpp(
	server: XmppServer,
	policy: NetPolicy,
	user: string,
	password: string,
	answerCaptcha?: (form: RegistrationForm) => Promise<string | null>,
	timeoutMs = 60_000
): Promise<RegistrationResult> {
	const { s } = await secureStream(server, policy, timeoutMs);
	try {
		const form = classifyRegistration(await askForm(s, server.domain));
		let captcha: string | null = null;
		if (
			form.status === 'captcha' &&
			answerCaptcha !== undefined &&
			form.captchaField !== undefined
		) {
			captcha = (await answerCaptcha(form))?.trim() || null;
			if (captcha !== null && s.closed) return { ok: false, why: 'captcha_expired', text: '' };
		}
		if (form.status !== 'open' && captcha === null) return { ok: false, form };
		const fields: Array<readonly [string, string]> = [
			...form.hidden,
			['username', user],
			['password', password],
			...(captcha !== null && form.captchaField !== undefined
				? [[form.captchaField, captcha] as const]
				: [])
		];
		const payload = form.dataForm
			? `<x xmlns='jabber:x:data' type='submit'>${fields
					.map(([n, v]) => `<field var='${xmlEscape(n)}'><value>${xmlEscape(v)}</value></field>`)
					.join('')}</x>`
			: `<username>${xmlEscape(user)}</username><password>${xmlEscape(password)}</password>`;
		s.write(
			`<iq type='set' id='reg2' to='${xmlEscape(server.domain)}'><query xmlns='jabber:iq:register'>${payload}</query></iq>`
		);
		let r: string;
		try {
			r = (await s.wait(iqAnswer('reg2'), 'registration')).el;
		} catch (err) {
			// Closed just as the answer went: the picture's time ran out.
			if (captcha !== null && s.closed) return { ok: false, why: 'captcha_expired', text: '' };
			throw err;
		}
		s.write('</stream:stream>');
		if (/type=['"]result['"]/.test(r.slice(0, r.indexOf('>') + 1))) return { ok: true };
		// The server's words, without the password should it repeat it.
		const text = errorText(r, password);
		const cond = (c: string): boolean => new RegExp(`<${c}\\b`).test(r);
		const why: RegistrationRefusal = cond('conflict')
			? 'taken'
			: cond('resource-constraint') || cond('policy-violation')
				? 'rate_limited'
				: captcha !== null &&
					  (cond('not-acceptable') || cond('not-allowed')) &&
					  /captcha|answer|challenge/i.test(text)
					? 'captcha_wrong'
					: cond('not-acceptable') ||
						  cond('bad-request') ||
						  cond('jid-malformed') ||
						  // Prosody: feature-not-implemented "password fails SASLprep".
						  /saslprep/i.test(text)
						? 'not_acceptable'
						: cond('not-allowed') ||
							  cond('forbidden') ||
							  cond('service-unavailable') ||
							  cond('feature-not-implemented')
							? 'not_allowed'
							: 'failed';
		return { ok: false, why, text };
	} finally {
		closeStream(s);
	}
}
