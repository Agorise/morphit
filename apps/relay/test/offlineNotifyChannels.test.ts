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
import {
	DEFAULT_CALL_MS,
	leaveRoom,
	MatrixTimeoutError,
	sendMatrix
} from '../src/notify/channels/matrix.ts';
import { codeInTelegramText, pollTelegram, sendTelegram } from '../src/notify/channels/telegram.ts';
import { sendXmpp } from '../src/notify/channels/xmpp.ts';
import { newSessionIdentity, sendSession, sessionIdOf } from '../src/notify/channels/session.ts';
import {
	OTHER_CERT,
	TEST_CERT,
	fakeHomeserver,
	fakeHttp,
	memoryRoomBook,
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
	const mx = async (o: Parameters<typeof fakeHomeserver>[0] = {}) => {
		const hs = keep(await fakeHomeserver({ bot: '@bot:hs', ...o }));
		return { hs, cfg: { homeserver: hs.url, accessToken: hs.token, userId: hs.bot } };
	};
	const G = '@grandma:hs.org';

	it('opens a direct room only the bot may invite into, then reuses it; a room the bot is no longer in is replaced', async () => {
		const { hs, cfg } = await mx();
		const b = memoryRoomBook();
		const r1 = await sendMatrix(cfg, direct, G, 'code 123456', b.book);
		const asked = hs.rooms.get(r1)!.created as {
			invite: string[];
			is_direct: boolean;
			preset: string;
			power_level_content_override: { invite: number };
		};
		expect(asked).toMatchObject({ invite: [G], is_direct: true, preset: 'private_chat' });
		expect(asked.power_level_content_override.invite).toBe(100);
		expect(hs.hits.every((h) => h.headers.authorization === 'Bearer tok')).toBe(true);
		expect(await sendMatrix(cfg, direct, G, 'note', b.book)).toBe(r1);
		expect(hs.made()).toBe(1);
		hs.removeBot(r1);
		const r3 = await sendMatrix(cfg, direct, G, 'note 2', b.book);
		expect(r3).not.toBe(r1);
		expect(hs.rooms.get(r3)!.messages).toEqual([{ sender: '@bot:hs', body: 'note 2' }]);
		// The room it replaced is queued to be left.
		expect(b.queued).toEqual([r1]);
	});

	it.each([
		['403 M_FORBIDDEN to everything (a suspended bot)', 403, 'M_FORBIDDEN'],
		['403 M_USER_SUSPENDED', 403, 'M_USER_SUSPENDED'],
		['429 M_LIMIT_EXCEEDED', 429, 'M_LIMIT_EXCEEDED'],
		['403 M_RESOURCE_LIMIT_EXCEEDED', 403, 'M_RESOURCE_LIMIT_EXCEEDED']
	])(
		'an error about the bot’s account (%s) never counts as her room being gone',
		async (_w, status, errcode) => {
			const { hs, cfg } = await mx();
			const b = memoryRoomBook();
			const room = await sendMatrix(cfg, direct, G, 'one', b.book);
			hs.trouble({ status, errcode });
			await expect(sendMatrix(cfg, direct, G, 'two', b.book)).rejects.toThrow();
			hs.trouble(null);
			expect(hs.hits.filter((h) => h.path.endsWith('/createRoom'))).toHaveLength(1);
			expect(b.queued).toEqual([]);
			expect(await sendMatrix(cfg, direct, G, 'three', b.book)).toBe(room);
		}
	);

	it('she left and her homeserver refuses to invite her back: a new room', async () => {
		let refuse = false;
		const { hs, cfg } = await mx({ refuseInvite: () => refuse });
		const b = memoryRoomBook();
		const room = await sendMatrix(cfg, direct, G, 'one', b.book);
		hs.leave(room, G);
		refuse = true;
		await expect(sendMatrix(cfg, direct, G, 'two', b.book)).rejects.toThrow(); // createRoom refused too
		refuse = false;
		const again = await sendMatrix(cfg, direct, G, 'three', b.book);
		expect(again).toBe(room); // invited back once her homeserver lets it
	});

	it('a room an older version opened: used while only she is in it; replaced once someone else is', async () => {
		const { hs, cfg } = await mx({ autoJoin: [G, '@friend:hs.org'] });
		const b = memoryRoomBook();
		const r = await fetch(`${hs.url}/_matrix/client/v3/createRoom`, {
			method: 'POST',
			headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
			body: JSON.stringify({ preset: 'trusted_private_chat', is_direct: true, invite: [G] })
		});
		const old = ((await r.json()) as { room_id: string }).room_id;
		b.legacy(G, old);
		expect(await sendMatrix(cfg, direct, G, 'one', b.book)).toBe(old);
		// In that room she may invite others: she did.
		expect(hs.inviteBy(old, G, '@friend:hs.org')).toBe(true);
		const fresh = await sendMatrix(cfg, direct, G, 'code 123456', b.book);
		expect(fresh).not.toBe(old);
		expect(hs.rooms.get(fresh)!.messages.map((m) => m.body)).toEqual(['code 123456']);
		expect(b.queued).toEqual([old]);
		expect(hs.inviteBy(fresh, G, '@friend:hs.org')).toBe(false);
	});

	it('a room an older version opened, someone else only invited (not joined yet): replaced too', async () => {
		const { hs, cfg } = await mx({ autoJoin: [G] });
		const b = memoryRoomBook();
		const r = await fetch(`${hs.url}/_matrix/client/v3/createRoom`, {
			method: 'POST',
			headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
			body: JSON.stringify({ preset: 'trusted_private_chat', is_direct: true, invite: [G] })
		});
		const old = ((await r.json()) as { room_id: string }).room_id;
		b.legacy(G, old);
		// She invited someone, who has not accepted (yet): they could, and
		// read every later message.
		expect(hs.inviteBy(old, G, '@later:hs.org')).toBe(true);
		expect(hs.rooms.get(old)!.members.get('@later:hs.org')).toBe('invite');
		const fresh = await sendMatrix(cfg, direct, G, 'code 123456', b.book);
		expect(fresh).not.toBe(old);
		expect(hs.rooms.get(old)!.messages).toEqual([]);
		expect(b.queued).toEqual([old]);
	});

	it('a note to an address no row holds any more (it came too late): nothing sent, its room queued', async () => {
		const { hs, cfg } = await mx();
		const b = memoryRoomBook(() => false);
		await expect(sendMatrix(cfg, direct, G, 'late code', b.book)).rejects.toThrow(
			/no saved address holds/
		);
		expect(b.queued).toHaveLength(1);
		expect(hs.rooms.get(b.queued[0]!)!.messages).toEqual([]);
	});

	it('leaving: leave and forget; a room already left and forgotten is fine; an account in trouble is retried', async () => {
		const { hs, cfg } = await mx();
		const room = await sendMatrix(cfg, direct, G, 'code', memoryRoomBook().book);
		await leaveRoom(cfg, direct, room);
		expect(hs.leavesAndForgets().map((h) => h.path.replace(/^.*\//, ''))).toEqual([
			'leave',
			'forget'
		]);
		expect(hs.rooms.get(room)!.forgotten.has('@bot:hs')).toBe(true);
		await leaveRoom(cfg, direct, room);
		hs.trouble({ status: 403, errcode: 'M_FORBIDDEN' });
		await expect(leaveRoom(cfg, direct, room)).rejects.toThrow();
	});

	it(
		'a homeserver that stops answering: "took too long" after the real per-request limit',
		async () => {
			const { cfg } = await mx({ slow: () => null });
			const t0 = Date.now();
			const err = await sendMatrix(cfg, direct, G, 'x', memoryRoomBook().book).catch(
				(e: unknown) => e
			);
			const took = Date.now() - t0;
			expect(err).toBeInstanceOf(MatrixTimeoutError);
			expect((err as Error).name).toBe('TimeoutError');
			expect(took).toBeGreaterThanOrEqual(DEFAULT_CALL_MS - 200);
			expect(took).toBeLessThan(DEFAULT_CALL_MS + 5_000);
		},
		DEFAULT_CALL_MS + 15_000
	);
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
