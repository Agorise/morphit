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

/** An HTTP or HTTPS (TEST_CERT) server answering with `handler` (null: it
 *  never answers that request). */
export async function fakeHttp(
	handler: (hit: HttpHit) => { status: number; body: unknown } | null,
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
			if (r === null) return;
			const send = (x: { status: number; body: unknown }): void => {
				res.writeHead(x.status, { 'Content-Type': 'application/json' });
				res.end(typeof x.body === 'string' ? x.body : JSON.stringify(x.body));
			};
			const later = r.body as {
				__later?: number;
				__answer?: () => { status: number; body: unknown };
			};
			if (r.status === 0 && later.__answer)
				setTimeout(() => send(later.__answer!()), later.__later ?? 0);
			else send(r);
		});
	};
	const server = opts.https
		? https.createServer({ cert: opts.cert ?? TEST_CERT, key: opts.key ?? TEST_KEY }, onReq)
		: http.createServer(onReq);
	const close = closer(server);
	const port = await listen(server);
	return { port, hits, close };
}

/** One room on {@link fakeHomeserver}. */
export interface FakeMatrixRoom {
	readonly id: string;
	/** user id → 'join' | 'invite' | 'leave' | 'ban' */
	readonly members: Map<string, string>;
	/** What a member that left could still read: the memberships as they were
	 *  when it left (Synapse lets a departed user read the state at its leave). */
	readonly atLeave: Map<string, Map<string, string>>;
	readonly forgotten: Set<string>;
	readonly messages: Array<{ readonly sender: string; readonly body: string }>;
	/** The createRoom request as asked (preset, power levels, initial state). */
	readonly created: Record<string, unknown>;
	/** Power level a member needs to invite, and each member's level. */
	inviteLevel: number;
	readonly levels: Map<string, number>;
}

const mxErr = (status: number, errcode: string) => ({ status, body: { errcode, error: errcode } });

/**
 * A Matrix homeserver for the client-server API calls the relay's bot makes,
 * answering as Synapse does:
 *   - createRoom: a new room, the bot joined, everyone in `invite` invited;
 *     power levels from the preset (trusted_private_chat: invitees get the
 *     creator's level; private_chat: 0) and power_level_content_override;
 *   - send: only a member that has JOINED may send (else 403 M_FORBIDDEN) —
 *     whether the other person is still there or not;
 *   - state/m.room.member/<user>: to a joined bot, her membership now (404
 *     M_NOT_FOUND if she was never in the room); to a bot that left and did
 *     not forget, as it was when it left; else 403 M_FORBIDDEN;
 *   - members: every member and membership (a joined bot only);
 *   - joined_rooms: the rooms the bot is in;
 *   - invite: by a joined bot, of someone not joined and not banned;
 *   - leave (403 when not in the room) and forget (400 while joined);
 *   - account/whoami.
 * The people the bot writes to act through `join` / `leave` / `inviteBy`;
 * those in `autoJoin` accept every invitation at once. `trouble` makes the
 * bot's ACCOUNT answer an error to everything (suspended, rate-limited …).
 * Every request is recorded in `hits`.
 */
export async function fakeHomeserver(
	opts: {
		readonly bot?: string;
		readonly token?: string;
		readonly autoJoin?: readonly string[];
		/** Her homeserver refuses invitations from this one. */
		readonly refuseInvite?: (user: string) => boolean;
		/** A message to this room fails (500), as on a homeserver in trouble. */
		readonly failSend?: (room: string) => boolean;
		/** How long each answer takes (ms; null: never answered). */
		readonly slow?: (method: string, path: string) => number | null;
	} = {}
) {
	const bot = opts.bot ?? '@notices:example.org';
	const token = opts.token ?? 'tok';
	const server = bot.slice(bot.indexOf(':') + 1);
	const autoJoin = new Set(opts.autoJoin ?? []);
	const rooms = new Map<string, FakeMatrixRoom>();
	let made = 0;
	type Trouble = {
		status: number;
		errcode: string;
		/** Only reads still work (a suspended account may read, MSC3823). */
		writesOnly?: boolean;
		/** Only these requests get the error. */
		only?: (method: string, path: string) => boolean;
	};
	let trouble: Trouble | null = null;
	const v3 = '/_matrix/client/v3';
	const json = (body: string): Record<string, unknown> => {
		try {
			return JSON.parse(body) as Record<string, unknown>;
		} catch {
			return {};
		}
	};
	const invite = (room: FakeMatrixRoom, user: string): void => {
		room.members.set(user, autoJoin.has(user) ? 'join' : 'invite');
	};
	const setMember = (room: FakeMatrixRoom, user: string, m: string): void => {
		if (user === bot && m === 'leave') room.atLeave.set(bot, new Map(room.members));
		room.members.set(user, m);
	};
	const answer = (h: HttpHit): { status: number; body: unknown } => {
		if (h.headers.authorization !== `Bearer ${token}`) return mxErr(401, 'M_UNKNOWN_TOKEN');
		if (
			trouble !== null &&
			!(trouble.writesOnly === true && h.method === 'GET') &&
			(trouble.only === undefined || trouble.only(h.method, h.path))
		)
			return mxErr(trouble.status, trouble.errcode);
		const path = h.path.split('?')[0]!;
		if (h.method === 'GET' && path === `${v3}/account/whoami`)
			return { status: 200, body: { user_id: bot } };
		if (h.method === 'GET' && path === `${v3}/joined_rooms`)
			return {
				status: 200,
				body: {
					joined_rooms: [...rooms.values()]
						.filter((r) => r.members.get(bot) === 'join')
						.map((r) => r.id)
				}
			};
		if (h.method === 'POST' && path === `${v3}/createRoom`) {
			const b = json(h.body);
			const invites = Array.isArray(b.invite) ? (b.invite as string[]) : [];
			if (invites.some((u) => opts.refuseInvite?.(u))) return mxErr(403, 'M_FORBIDDEN');
			const id = `!r${++made}:${server}`;
			const over = (b.power_level_content_override ?? {}) as Record<string, unknown>;
			const trusted = b.preset === 'trusted_private_chat';
			const room: FakeMatrixRoom = {
				id,
				members: new Map([[bot, 'join']]),
				atLeave: new Map(),
				forgotten: new Set(),
				messages: [],
				created: b,
				inviteLevel: typeof over.invite === 'number' ? over.invite : 0,
				levels: new Map([[bot, 100]])
			};
			for (const u of invites) room.levels.set(u, trusted ? 100 : 0);
			rooms.set(id, room);
			for (const u of invites) invite(room, u);
			return { status: 200, body: { room_id: id } };
		}
		const m = new RegExp(`^${v3}/rooms/([^/]+)/(.+)$`).exec(path);
		if (!m) return mxErr(404, 'M_UNRECOGNIZED');
		const room = rooms.get(decodeURIComponent(m[1]!));
		const rest = m[2]!;
		const mine = room?.members.get(bot);
		if (h.method === 'PUT' && rest.startsWith('send/m.room.message/')) {
			if (!room || mine !== 'join') return mxErr(403, 'M_FORBIDDEN');
			if (opts.failSend?.(room.id)) return mxErr(500, 'M_UNKNOWN');
			room.messages.push({ sender: bot, body: String(json(h.body).body ?? '') });
			return { status: 200, body: { event_id: `$e${room.messages.length}` } };
		}
		const st = /^state\/m\.room\.member\/([^/]+)$/.exec(rest);
		if (h.method === 'GET' && st) {
			const user = decodeURIComponent(st[1]!);
			if (!room || room.forgotten.has(bot)) return mxErr(403, 'M_FORBIDDEN');
			const view = mine === 'join' ? room.members : room.atLeave.get(bot);
			if (view === undefined) return mxErr(403, 'M_FORBIDDEN');
			const ms = view.get(user);
			return ms === undefined
				? mxErr(404, 'M_NOT_FOUND')
				: { status: 200, body: { membership: ms } };
		}
		if (h.method === 'GET' && rest === 'members') {
			if (!room || mine !== 'join') return mxErr(403, 'M_FORBIDDEN');
			return {
				status: 200,
				body: {
					chunk: [...room.members].map(([u, ms]) => ({
						type: 'm.room.member',
						state_key: u,
						content: { membership: ms }
					}))
				}
			};
		}
		if (h.method === 'POST' && rest === 'invite') {
			const user = String(json(h.body).user_id ?? '');
			if (!room || mine !== 'join') return mxErr(403, 'M_FORBIDDEN');
			const now = room.members.get(user);
			if (now === 'join' || now === 'ban' || opts.refuseInvite?.(user))
				return mxErr(403, 'M_FORBIDDEN');
			invite(room, user);
			return { status: 200, body: {} };
		}
		if (h.method === 'POST' && rest === 'leave') {
			if (!room || (mine !== 'join' && mine !== 'invite')) return mxErr(403, 'M_FORBIDDEN');
			setMember(room, bot, 'leave');
			return { status: 200, body: {} };
		}
		if (h.method === 'POST' && rest === 'forget') {
			if (mine === 'join') return mxErr(400, 'M_UNKNOWN');
			room?.forgotten.add(bot);
			return { status: 200, body: {} };
		}
		return mxErr(404, 'M_UNRECOGNIZED');
	};
	const srv = await fakeHttp((h) => {
		const after = opts.slow ? opts.slow(h.method, h.path) : 0;
		if (after === null) return null;
		if (after === 0) return answer(h);
		return { status: 0, body: { __later: after, __answer: () => answer(h) } };
	});
	const roomOf = (id: string): FakeMatrixRoom => {
		const r = rooms.get(id);
		if (!r) throw new Error(`no room ${id}`);
		return r;
	};
	return {
		...srv,
		url: `http://127.0.0.1:${srv.port}`,
		bot,
		token,
		rooms,
		/** How many rooms were opened. */
		made: () => made,
		/** Leave and forget requests the bot made. */
		leavesAndForgets: () => srv.hits.filter((h) => /\/rooms\/[^/]+\/(leave|forget)$/.test(h.path)),
		/** She accepts the invitation. */
		join: (id: string, user: string) => setMember(roomOf(id), user, 'join'),
		/** She leaves the room (or declines its invitation). */
		leave: (id: string, user: string) => setMember(roomOf(id), user, 'leave'),
		/** A member invites someone else, if the room's power levels let her. */
		inviteBy: (id: string, from: string, to: string): boolean => {
			const r = roomOf(id);
			if (r.members.get(from) !== 'join' || (r.levels.get(from) ?? 0) < r.inviteLevel) return false;
			invite(r, to);
			return true;
		},
		/** The bot is put out of the room (kicked; or the room is gone for it). */
		removeBot: (id: string) => {
			const r = roomOf(id);
			setMember(r, bot, 'leave');
			r.forgotten.add(bot);
		},
		/** The bot's ACCOUNT answers this to everything (null: fine again) —
		 *  or, `writesOnly`, to everything but reads (a suspended account
		 *  may still read, MSC3823). */
		trouble: (t: Trouble | null) => {
			trouble = t;
		}
	};
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
	/** Answer an <iq> before the built-in answers (bind, ping): return the reply,
	 *  or null to fall through. `authed`: after the login. */
	readonly iq?: (iq: string, authed: boolean, secure: boolean) => string | null;
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
				if (o.iq && (m = /<iq\b[^>]*\/>|<iq\b[\s\S]*?<\/iq>/.exec(buf))) {
					const reply = o.iq(m[0], authed, isSecure);
					if (reply !== null) {
						buf = buf.slice(m.index + m[0].length);
						w(reply);
						continue;
					}
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

/**
 * A MatrixRoomBook kept in memory, with the store's rules for a claim
 * (compare-and-set on what was read; refused when no row holds the address:
 * `held`), for tests of the Matrix client alone. The store's own book, on a
 * real database, is tested in offlineNotifyMatrixOneRoom.test.ts and
 * scripts/offline-notify-matrix-rooms-smoke.ts.
 */
export function memoryRoomBook(held: (userId: string) => boolean = () => true) {
	const rooms = new Map<string, { room: string; version: Buffer; botOnly: boolean }>();
	const queued: string[] = [];
	let n = 0;
	return {
		rooms,
		queued,
		/** As a room an older version opened (anyone in it may invite). */
		legacy(userId: string, room: string) {
			rooms.set(userId, { room, version: Buffer.from(`v${++n}`), botOnly: false });
		},
		book: {
			get: async (userId: string) => rooms.get(userId) ?? null,
			claim: async (userId: string, version: Buffer | null, room: string) => {
				if (!held(userId)) {
					queued.push(room);
					return null;
				}
				const cur = rooms.get(userId);
				if (cur !== undefined && (version === null || !cur.version.equals(version))) {
					queued.push(room);
					return { room: cur.room, botOnly: cur.botOnly, won: false };
				}
				if (cur !== undefined) queued.push(cur.room);
				rooms.set(userId, { room, version: Buffer.from(`v${++n}`), botOnly: true });
				return { room, botOnly: true, won: true };
			}
		}
	};
}
