/**
 * Offline notices — each channel against a stand-in server that records what
 * arrived: the mail server, a Matrix homeserver, the Telegram Bot API, an XMPP
 * server that offers no TLS, and Session's seeds and nodes behind a SOCKS
 * proxy standing in for Tor. (Checked by hand against real Prosody, Synapse
 * and an aiosmtpd server too; see docs/OPERATIONS.md, offline notices.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { displayName, sendMail, quotedPrintable } from '../src/notify/channels/smtp.ts';
import { leaveTestRoom, sendMatrix } from '../src/notify/channels/matrix.ts';
import { codeInTelegramText, pollTelegram, sendTelegram } from '../src/notify/channels/telegram.ts';
import { sendXmpp } from '../src/notify/channels/xmpp.ts';
import { newSessionIdentity, sendSession, sessionIdOf } from '../src/notify/channels/session.ts';
import {
	OTHER_CERT,
	TEST_CERT,
	fakeHttp,
	fakeSmtp,
	fakeSocks,
	type Listening
} from './notifyFakes.ts';

const open: Listening[] = [];
afterEach(async () => {
	for (const l of open.splice(0)) await l.close();
});
const keep = <T extends Listening>(l: T): T => {
	open.push(l);
	return l;
};
const direct = { torSocks: '', hiddenOnly: false };

describe('email', () => {
	it('logs in only after STARTTLS and delivers a UTF-8 plain-text note', async () => {
		const smtp = keep(await fakeSmtp());
		await sendMail(
			{
				host: 'localhost',
				port: smtp.port,
				security: 'starttls',
				user: 'ops@example.org',
				password: 'mailpass',
				from: 'ops@example.org',
				ca: TEST_CERT
			},
			'Vigilante Trading',
			'grandma@example.net',
			'Nuevo mensaje de chat en Vigilante Trading',
			'Ábrelo aquí: https://vigilante.trading/es/chat?n=AbC\n.una línea con punto',
			direct
		);
		expect(smtp.mails).toHaveLength(1);
		const m = smtp.mails[0]!;
		expect(m.tls).toBe(true);
		expect(m.to).toEqual(['grandma@example.net']);
		expect(m.data).toMatch(/^From: "Vigilante Trading" <ops@example\.org>\r\n/m);
		expect(m.data).toMatch(/^Subject: Nuevo mensaje de chat en Vigilante Trading\r\n/m);
		expect(m.data).toContain('Content-Type: text/plain; charset=UTF-8');
		expect(m.data).toContain(
			quotedPrintable('Ábrelo aquí: https://vigilante.trading/es/chat?n=AbC\n.una línea con punto')
		);
		// Nothing of the password crossed before TLS.
		expect(smtp.linesBeforeTls.join('\n')).not.toMatch(/AUTH|mailpass|bWFpbHBhc3M/);
	});

	it('a reply slipped in before the TLS handshake is refused (STARTTLS injection)', async () => {
		const smtp = keep(await fakeSmtp({ injectBeforeTls: '250 AUTH PLAIN' }));
		await expect(
			sendMail(
				{
					host: 'localhost',
					port: smtp.port,
					security: 'starttls',
					user: 'u',
					password: 'mailpass',
					from: 'a@b.org',
					ca: TEST_CERT
				},
				'S',
				'g@x.org',
				's',
				'b',
				direct
			)
		).rejects.toThrow(/before the TLS handshake/);
		expect(smtp.mails).toHaveLength(0);
	});

	it('the From name stays one valid name whatever the site is called', () => {
		expect(displayName('Trading Co. "Best", Ltd')).toBe('"Trading Co. \\"Best\\", Ltd"');
		expect(displayName('Libertad Latina')).toBe('"Libertad Latina"');
		expect(displayName('Café Ñandú')).toMatch(/^=\?UTF-8\?B\?/);
	});

	it('a server that offers no STARTTLS gets no password', async () => {
		const smtp = keep(await fakeSmtp({ offerStartTls: false }));
		await expect(
			sendMail(
				{
					host: 'localhost',
					port: smtp.port,
					security: 'starttls',
					user: 'u',
					password: 'mailpass',
					from: 'a@b.org',
					ca: TEST_CERT
				},
				'S',
				'g@x.org',
				's',
				'b',
				direct
			)
		).rejects.toThrow(/STARTTLS/);
		expect(smtp.linesBeforeTls.join('\n')).not.toMatch(/AUTH|mailpass/);
		expect(smtp.mails).toHaveLength(0);
	});

	it('a certificate it does not trust stops it before the password', async () => {
		const smtp = keep(await fakeSmtp());
		await expect(
			sendMail(
				{
					host: 'localhost',
					port: smtp.port,
					security: 'starttls',
					// The right login: only the certificate check can stop it.
					user: 'ops@example.org',
					password: 'mailpass',
					from: 'a@b.org',
					ca: OTHER_CERT
				},
				'S',
				'g@x.org',
				's',
				'b',
				direct
			)
		).rejects.toThrow();
		expect(smtp.mails).toHaveLength(0);
		expect(smtp.linesBeforeTls.join('\n')).not.toMatch(/AUTH/);
	});
});

describe('Matrix', () => {
	it('opens a direct room that invites her, then reuses it; a room she left is replaced', async () => {
		let room = 0;
		const gone = new Set<string>();
		const hs = keep(
			await fakeHttp((h) => {
				if (h.path === '/_matrix/client/v3/createRoom')
					return { status: 200, body: { room_id: `!r${++room}:hs` } };
				const m = /\/rooms\/([^/]+)\/send\//.exec(h.path);
				if (m && gone.has(decodeURIComponent(m[1]!)))
					return { status: 403, body: { errcode: 'M_FORBIDDEN' } };
				if (m) return { status: 200, body: { event_id: '$e' } };
				return { status: 404, body: { errcode: 'M_UNRECOGNIZED' } };
			})
		);
		const cfg = {
			homeserver: `http://127.0.0.1:${hs.port}`,
			accessToken: 'tok',
			userId: '@bot:hs'
		};
		const r1 = await sendMatrix(cfg, direct, '@grandma:hs.org', null, 'code 123456');
		const create = JSON.parse(hs.hits[0]!.body) as { invite: string[]; is_direct: boolean };
		expect(create.invite).toEqual(['@grandma:hs.org']);
		expect(create.is_direct).toBe(true);
		expect(hs.hits[0]!.headers.authorization).toBe('Bearer tok');
		const r2 = await sendMatrix(cfg, direct, '@grandma:hs.org', r1, 'note');
		expect(r2).toBe(r1);
		expect(hs.hits.filter((h) => h.path.endsWith('createRoom'))).toHaveLength(1);
		gone.add(r1);
		const r3 = await sendMatrix(cfg, direct, '@grandma:hs.org', r1, 'note 2');
		expect(r3).not.toBe(r1);
		expect(JSON.parse(hs.hits.at(-1)!.body)).toEqual({ msgtype: 'm.text', body: 'note 2' });
	});
});

describe('Matrix: the operator’s test chat', () => {
	// A homeserver where she joins after `joinAfter` membership checks (never: -1).
	async function homeserver(joinAfter: number, failChecks = 0) {
		let checks = 0;
		let left = false;
		const hs = keep(
			await fakeHttp((h) => {
				if (h.method === 'GET' && h.path === '/_matrix/client/v3/rooms/!t%3Ahs/joined_members') {
					checks++;
					if (checks <= failChecks) return { status: 502, body: { errcode: 'M_UNKNOWN' } };
					const joined: Record<string, unknown> = { '@bot:hs': {} };
					if (!left && joinAfter >= 0 && checks > joinAfter) joined['@operator:hs.org'] = {};
					return { status: 200, body: { joined } };
				}
				if (h.path === '/_matrix/client/v3/rooms/!t%3Ahs/leave') {
					left = true;
					return { status: 200, body: {} };
				}
				if (h.path === '/_matrix/client/v3/rooms/!t%3Ahs/forget') return { status: 200, body: {} };
				return { status: 404, body: { errcode: 'M_UNRECOGNIZED' } };
			})
		);
		const cfg = {
			homeserver: `http://127.0.0.1:${hs.port}`,
			accessToken: 'tok',
			userId: '@bot:hs'
		};
		return { hs, cfg, checks: () => checks };
	}
	const clock = () => {
		let t = 0;
		return { now: () => t, sleep: async (ms: number) => void (t += ms) };
	};

	it('the bot leaves only once she has joined — so the note can still be read', async () => {
		const { hs, cfg, checks } = await homeserver(2);
		const c = clock();
		expect(
			await leaveTestRoom(cfg, direct, '!t:hs', '@operator:hs.org', { ...c, pollMs: 3000 })
		).toBe(true);
		expect(checks()).toBe(3);
		const paths = hs.hits.map((h) => h.path.replace(/^.*\/rooms\/[^/]+\//, ''));
		// Every check comes before the leave, and the leave is followed by forget.
		expect(paths).toEqual([
			'joined_members',
			'joined_members',
			'joined_members',
			'leave',
			'forget'
		]);
	});

	it('she never joins: the bot leaves when the wait is over, and says so', async () => {
		const { hs, cfg } = await homeserver(-1);
		const c = clock();
		expect(
			await leaveTestRoom(cfg, direct, '!t:hs', '@operator:hs.org', {
				...c,
				waitMs: 9000,
				pollMs: 3000
			})
		).toBe(false);
		expect(c.now()).toBe(9000);
		expect(hs.hits.at(-2)?.path).toMatch(/\/leave$/);
	});

	it('a homeserver hiccup while checking does not end the wait', async () => {
		const { cfg } = await homeserver(0, 2);
		const c = clock();
		expect(
			await leaveTestRoom(cfg, direct, '!t:hs', '@operator:hs.org', { ...c, pollMs: 3000 })
		).toBe(true);
	});
});

describe('Telegram', () => {
	it('sends with link previews off, and reads the codes users send the bot', async () => {
		const api = keep(
			await fakeHttp((h) => {
				if (h.path.endsWith('/sendMessage')) return { status: 200, body: { ok: true, result: {} } };
				if (h.path.endsWith('/getUpdates'))
					return {
						status: 200,
						body: {
							ok: true,
							result: [
								{
									update_id: 5,
									message: { chat: { id: 42, type: 'private' }, text: '/start 12345678' }
								},
								{ update_id: 6, message: { chat: { id: -9, type: 'group' }, text: '12345678' } }
							]
						}
					};
				return { status: 404, body: { ok: false } };
			})
		);
		const cfg = {
			token: '1:abc',
			username: 'VigilanteBot',
			apiBase: `http://127.0.0.1:${api.port}`
		};
		await sendTelegram(
			cfg,
			direct,
			'42',
			'Someone just sent you a chat message on X. Open: https://x/en/chat?n=t'
		);
		const sent = JSON.parse(api.hits[0]!.body) as Record<string, unknown>;
		expect(sent.chat_id).toBe('42');
		expect(sent.link_preview_options).toEqual({ is_disabled: true });
		const ups = await pollTelegram(cfg, direct, 0, 1);
		expect(ups.map((u) => [u.updateId, u.chatId, codeInTelegramText(u.text)])).toEqual([
			[5, '42', '12345678'],
			[6, '', null] // a group chat is never linked
		]);
		expect(codeInTelegramText('/start@VigilanteBot 87654321')).toBe('87654321');
		expect(codeInTelegramText('hello 12345678')).toBeNull();
	});
});

describe('XMPP', () => {
	it('a clearnet server that offers no TLS gets no login', async () => {
		const got: string[] = [];
		const server = net.createServer((c) => {
			c.on('data', (d: Buffer) => {
				got.push(d.toString('utf8'));
				if (got.length === 1) {
					c.write(
						"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0' from='localhost' id='1'>" +
							"<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>"
					);
				}
			});
			c.on('error', () => undefined);
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as net.AddressInfo).port;
		try {
			await expect(
				sendXmpp(
					{
						jid: 'bot@localhost',
						password: 'secret',
						host: '127.0.0.1',
						port,
						security: 'starttls'
					},
					direct,
					'g@x.org',
					'hi',
					5_000
				)
			).rejects.toThrow(/STARTTLS/);
			expect(got.join('')).not.toMatch(/<auth|secret|c2VjcmV0/);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});
});

describe('Session', () => {
	it('a new identity is 13 words that give its Session ID back', async () => {
		const id = await newSessionIdentity();
		expect(id.mnemonic.split(' ')).toHaveLength(13);
		expect(id.sessionId).toMatch(/^05[0-9a-f]{64}$/);
		expect(await sessionIdOf(id.mnemonic)).toBe(id.sessionId);
		expect(await sessionIdOf('not thirteen words')).toBeNull();
	});

	it('everything goes through Tor; the seed is pinned; the note is stored for her only', async () => {
		const socks = keep(await fakeSocks());
		const me = await newSessionIdentity();
		const her = await newSessionIdentity();
		const node = keep(
			await fakeHttp(
				(h) => {
					const req = JSON.parse(h.body) as {
						method: string;
						params: { requests: Array<{ method: string; params: Record<string, unknown> }> };
					};
					const sub = req.params.requests[0]!;
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
					if (sub.method === 'store')
						return {
							status: 200,
							body: {
								results: [
									{ code: 200, body: { hash: `h-${String(sub.params.pubkey).slice(0, 6)}` } }
								]
							}
						};
					return { status: 400, body: {} };
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
		const tor = { torSocks: `127.0.0.1:${socks.port}`, hiddenOnly: false };
		await sendSession(
			{ mnemonic: me.mnemonic },
			'Vigilante Trading',
			tor,
			her.sessionId,
			'Someone just sent you a chat message on Vigilante Trading.',
			[{ host: 'localhost', cert: TEST_CERT, port: seed.port }]
		);
		const asked = node.hits.map(
			(h) =>
				(
					JSON.parse(h.body) as {
						params: {
							requests: Array<{ method: string; params: { pubkey: string; data: string } }>;
						};
					}
				).params.requests[0]!
		);
		const stores = asked.filter((r) => r.method === 'store');
		// Only HER copy is stored. Session.js also stores a "sync" copy on the
		// sender's own account — a list of everyone the site wrote to — which is
		// answered locally and never sent: the site's own ID never reaches a node.
		expect(stores.map((s) => s.params.pubkey)).toEqual([her.sessionId]);
		expect(JSON.stringify(asked)).not.toContain(me.sessionId);
		expect(
			stores.every((s) => typeof s.params.data === 'string' && s.params.data.length > 100)
		).toBe(true);
		// The note travels encrypted: the stored data does not contain its text.
		expect(
			stores.some((s) =>
				Buffer.from(s.params.data, 'base64').toString('utf8').includes('Someone just sent')
			)
		).toBe(false);
		// Every connection — the seed and the node — went through the proxy.
		expect(socks.targets.length).toBeGreaterThanOrEqual(3);
		expect(
			socks.targets.every((t) => t === `localhost:${seed.port}` || t === `127.0.0.1:${node.port}`)
		).toBe(true);
		expect(seed.hits).toHaveLength(1);

		// A seed showing a certificate other than the pinned one is refused.
		await expect(
			sendSession({ mnemonic: me.mnemonic }, 'Vigilante Trading', tor, her.sessionId, 'x', [
				{ host: 'localhost', cert: OTHER_CERT, port: seed.port }
			])
		).rejects.toThrow();
		expect(seed.hits).toHaveLength(1);
	}, 60_000);
});
