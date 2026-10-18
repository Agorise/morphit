/**
 * Offline notices — making the site's XMPP account from `sudo morphit-ops
 * offline-notify` (in-band registration, XEP-0077), and turning its message
 * archive off (XEP-0313). The forms below were recorded from real Prosody
 * 0.12 and ejabberd 23.10 servers (the picture check's image shortened).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	classifyRegistration,
	registerXmpp,
	xmppArchiveOff,
	xmppRegistrationForm
} from '../src/notify/channels/xmpp.ts';
import { TEST_CERT, fakeXmpp, type Listening } from './notifyFakes.ts';

const open: Listening[] = [];
afterEach(async () => {
	for (const l of open.splice(0)) await l.close();
});
const keep = <T extends Listening>(l: T): T => {
	open.push(l);
	return l;
};
const direct = { torSocks: '', hiddenOnly: false };

const PROSODY_OPEN =
	"<iq type='result' id='reg1' from='localhost'><query xmlns='jabber:iq:register'><instructions>Choose a username and password for use with this service.</instructions><username/><password/><x type='form' xmlns='jabber:x:data'><title>Creating a new account</title><instructions>Choose a username and password for use with this service.</instructions><field var='FORM_TYPE' type='hidden'><value>jabber:iq:register</value></field><field var='username' label='Username' type='text-single'><required/></field><field var='password' label='Password' type='text-private'><required/></field></x></query></iq>";
const PROSODY_CLOSED =
	"<iq from='localhost' id='reg1' type='error'><error type='cancel'><service-unavailable xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error></iq>";
const EJABBERD_OPEN =
	"<iq xml:lang='en' from='localhost' type='result' id='reg1'><query xmlns='jabber:iq:register'><username/><password/><instructions>Choose a username and password to register with this server</instructions></query></iq>";
const EJABBERD_CAPTCHA =
	"<iq xml:lang='en' from='localhost' type='result' id='reg1'><query xmlns='jabber:iq:register'><x type='form' xmlns='jabber:x:data'><instructions>Choose a username and password to register with this server</instructions><field var='FORM_TYPE' type='hidden'><value>jabber:iq:register</value></field><field var='username' type='text-single' label='User'><required/></field><field var='password' type='text-private' label='Password'><required/></field><field var='captcha-fallback-text' type='fixed'><value>If you don&apos;t see the CAPTCHA image here, visit the web page.</value></field><field var='captcha-fallback-url' type='text-single' label='CAPTCHA web page'><value>https://xmpp.example/captcha/2910843835466922464/image</value></field><field var='from' type='hidden' label='Attribute &apos;to&apos; of stanza that triggered challenge'><value>localhost</value></field><field var='challenge' type='hidden' label='Challenge ID'><required/><value>2910843835466922464</value></field><field var='sid' type='hidden' label='Stanza ID'><value>reg1</value></field><field var='ocr' type='text-single' label='Enter the text you see'><media xmlns='urn:xmpp:media-element'><uri type='image/png'>cid:sha1+2be6a4e9fc307636fe5b1a240c14c2d8d7c76772@bob.xmpp.org</uri></media><required/></field></x><data type='image/png' max-age='0' cid='sha1+2be6a4e9fc307636fe5b1a240c14c2d8d7c76772@bob.xmpp.org' xmlns='urn:xmpp:bob'>iVBORw0KGgo=</data><instructions>You need a client that supports x:data and CAPTCHA to register</instructions></query></iq>";

describe('reading a server’s registration form', () => {
	it('real servers: Prosody and ejabberd open, Prosody closed, ejabberd’s picture check', () => {
		expect(classifyRegistration(PROSODY_OPEN)).toEqual({
			status: 'open',
			dataForm: true,
			hidden: [['FORM_TYPE', 'jabber:iq:register']]
		});
		expect(classifyRegistration(EJABBERD_OPEN)).toEqual({
			status: 'open',
			dataForm: false,
			hidden: []
		});
		expect(classifyRegistration(PROSODY_CLOSED).status).toBe('closed');
		expect(classifyRegistration(EJABBERD_CAPTCHA)).toEqual({
			status: 'captcha',
			dataForm: true,
			url: 'https://xmpp.example/captcha/2910843835466922464/image',
			captchaField: 'ocr',
			hidden: [
				['FORM_TYPE', 'jabber:iq:register'],
				['from', 'localhost'],
				['challenge', '2910843835466922464'],
				['sid', 'reg1']
			]
		});
	});

	it('a web page only, more questions (plain or in the form), a picture with no web page', () => {
		const q = (inner: string) =>
			`<iq type='result' id='reg1'><query xmlns='jabber:iq:register'>${inner}</query></iq>`;
		expect(
			classifyRegistration(
				q(
					"<instructions>Register on the web.</instructions><x xmlns='jabber:x:oob'><url>https://xmpp.example/register</url></x>"
				)
			)
		).toEqual({ status: 'web', url: 'https://xmpp.example/register', dataForm: false, hidden: [] });
		expect(classifyRegistration(q('<username/><password/><email/>'))).toEqual({
			status: 'needs_more',
			fields: ['email'],
			dataForm: false,
			hidden: []
		});
		expect(
			classifyRegistration(
				q(
					"<x xmlns='jabber:x:data' type='form'><field var='username'><required/></field><field var='password' type='text-private'><required/></field><field var='email'><required/></field><field var='nick'/></x>"
				)
			)
		).toMatchObject({ status: 'needs_more', fields: ['email'] });
		const cidOnly = EJABBERD_CAPTCHA.replace(
			/<field var='captcha-fallback-url'[\s\S]*?<\/field>/,
			''
		);
		const f = classifyRegistration(cidOnly);
		expect(f.status).toBe('captcha');
		expect(f.url).toBeUndefined();
	});

	it('only an http(s) address is ever shown as a web page', () => {
		for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://x.example/\u001b[2J'])
			expect(
				classifyRegistration(
					EJABBERD_CAPTCHA.replace('https://xmpp.example/captcha/2910843835466922464/image', bad)
				).url
			).toBeUndefined();
	});
});

/** A fake server that registers accounts (the iq hook) and remembers what came. */
async function registrar(
	answer: (iq: string) => string | null,
	opts: { offerStartTls?: boolean } = {}
) {
	const seen: Array<{ iq: string; secure: boolean }> = [];
	const x = keep(
		await fakeXmpp({
			...opts,
			iq: (iq, _authed, secure) => {
				if (!/jabber:iq:register/.test(iq)) return null;
				seen.push({ iq, secure });
				return answer(iq);
			}
		})
	);
	const server = {
		domain: 'localhost',
		host: '127.0.0.1',
		port: x.port,
		security: 'starttls' as const,
		ca: TEST_CERT
	};
	return { x, seen, server };
}
const isGet = (iq: string) => /type='get'/.test(iq);
const result = (id: string) => `<iq type='result' id='${id}'/>`;
const error = (id: string, cond: string, text = '') =>
	`<iq type='error' id='${id}'><error type='modify'><${cond} xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/>${text === '' ? '' : `<text xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'>${text}</text>`}</error></iq>`;

describe('registering the site’s account', () => {
	it('asks the form, sends the name and password on the TLS stream only, and succeeds', async () => {
		const { x, seen, server } = await registrar((iq) =>
			isGet(iq) ? EJABBERD_OPEN : result('reg2')
		);
		expect(
			await registerXmpp(server, direct, 'morphitio', 'pa ss&<word>', undefined, 10_000)
		).toEqual({
			ok: true
		});
		expect(seen.map((s) => s.secure)).toEqual([true, true]);
		expect(seen[1]!.iq).toContain('<username>morphitio</username>');
		expect(seen[1]!.iq).toContain('<password>pa ss&amp;&lt;word&gt;</password>');
		expect(x.plain.join('')).not.toMatch(/jabber:iq:register|morphitio|pa ss/);
	});

	it('a data form is answered in the form, its hidden fields sent back', async () => {
		const { seen, server } = await registrar((iq) => (isGet(iq) ? PROSODY_OPEN : result('reg2')));
		expect((await registerXmpp(server, direct, 'morphitio', 'pw', undefined, 10_000)).ok).toBe(
			true
		);
		const sent = seen[1]!.iq;
		expect(sent).toContain("<x xmlns='jabber:x:data' type='submit'>");
		expect(sent).toContain(
			"<field var='FORM_TYPE'><value>jabber:iq:register</value></field><field var='username'><value>morphitio</value></field><field var='password'><value>pw</value></field>"
		);
	});

	it.each([
		['conflict', 'User already exists', 'taken'],
		['not-acceptable', 'The password is too weak', 'not_acceptable'],
		['resource-constraint', 'Too many registrations', 'rate_limited'],
		['policy-violation', 'Slow down', 'rate_limited'],
		['not-allowed', 'Access denied by service policy', 'not_allowed']
	])('a refusal (%s) says why, in the server’s words', async (cond, text, why) => {
		const { server } = await registrar((iq) =>
			isGet(iq) ? EJABBERD_OPEN : error('reg2', cond, text)
		);
		expect(await registerXmpp(server, direct, 'morphitio', 'pw', undefined, 10_000)).toEqual({
			ok: false,
			why,
			text
		});
	});

	it('the server’s words are made safe to print', async () => {
		const { server } = await registrar((iq) =>
			isGet(iq)
				? EJABBERD_OPEN
				: error('reg2', 'not-acceptable', `weak\u001b[31m &amp; ${'x'.repeat(400)}`)
		);
		const r = await registerXmpp(server, direct, 'morphitio', 'pw', undefined, 10_000);
		expect(r.ok).toBe(false);
		const text = 'text' in r ? r.text : '';
		expect(text).not.toMatch(/\u001b/);
		expect(text.startsWith('weak [31m & x')).toBe(true);
		expect(text.length).toBe(200);
	});

	it('a closed server: nothing is sent but the question', async () => {
		const { seen, server } = await registrar(() => PROSODY_CLOSED.replace("from='localhost' ", ''));
		const r = await registerXmpp(server, direct, 'morphitio', 'pw', undefined, 10_000);
		expect(r).toMatchObject({ ok: false, form: { status: 'closed' } });
		expect(seen).toHaveLength(1);
	});

	it('a picture check: asked with its web page, answered on the same stream', async () => {
		const { x, seen, server } = await registrar((iq) =>
			isGet(iq) ? EJABBERD_CAPTCHA : result('reg2')
		);
		const asked: Array<string | undefined> = [];
		const r = await registerXmpp(
			server,
			direct,
			'morphitio',
			'pw',
			async (f) => {
				asked.push(f.url);
				return ' K7Q2X ';
			},
			10_000
		);
		expect(r).toEqual({ ok: true });
		expect(asked).toEqual(['https://xmpp.example/captcha/2910843835466922464/image']);
		const sent = seen[1]!.iq;
		expect(sent).toContain("<field var='challenge'><value>2910843835466922464</value></field>");
		expect(sent).toContain("<field var='ocr'><value>K7Q2X</value></field>");
		// One connection: the answer belongs to the challenge of this stream.
		expect(x.plain.join('').match(/<stream:stream/g)).toHaveLength(1);
	});

	it('a picture check left unanswered registers nothing', async () => {
		const { seen, server } = await registrar((iq) =>
			isGet(iq) ? EJABBERD_CAPTCHA : result('reg2')
		);
		const r = await registerXmpp(server, direct, 'morphitio', 'pw', async () => '  ', 10_000);
		expect(r).toMatchObject({ ok: false, form: { status: 'captcha' } });
		expect(seen).toHaveLength(1);
		const none = await registrar((iq) => (isGet(iq) ? EJABBERD_CAPTCHA : result('reg2')));
		expect(
			await registerXmpp(none.server, direct, 'morphitio', 'pw', undefined, 10_000)
		).toMatchObject({ ok: false, form: { status: 'captcha' } });
		expect(none.seen).toHaveLength(1);
	});

	it('a wrong picture answer is told apart from a refused password', async () => {
		const { server } = await registrar((iq) =>
			isGet(iq)
				? EJABBERD_CAPTCHA
				: error('reg2', 'not-acceptable', 'The CAPTCHA verification has failed')
		);
		expect(
			await registerXmpp(server, direct, 'morphitio', 'pw', async () => 'nope', 10_000)
		).toMatchObject({ ok: false, why: 'captcha_wrong' });
	});

	it('a clearnet server without TLS: no registration question is ever sent', async () => {
		const { x, seen, server } = await registrar(() => EJABBERD_OPEN, { offerStartTls: false });
		await expect(registerXmpp(server, direct, 'morphitio', 'pw', undefined, 5_000)).rejects.toThrow(
			/STARTTLS/
		);
		await expect(xmppRegistrationForm(server, direct, 5_000)).rejects.toThrow(/STARTTLS/);
		expect(seen).toHaveLength(0);
		expect(x.plain.join('')).not.toMatch(/jabber:iq:register|morphitio/);
	});
});

describe('turning the account’s message archive off', () => {
	async function archive(answer: (ns: string) => 'ok' | 'error') {
		const sets: Array<{ iq: string; authed: boolean }> = [];
		const x = keep(
			await fakeXmpp({
				iq: (iq, authed) => {
					const ns = /<prefs xmlns='([^']+)'/.exec(iq)?.[1];
					if (ns === undefined) return null;
					// Reading the setting back (as Prosody and ejabberd answer it).
					if (/type='get'/.test(iq))
						return `<iq type='result' id='${/id='([^']*)'/.exec(iq)?.[1]}'><prefs default='never' xmlns='${ns}'><always/><never/></prefs></iq>`;
					sets.push({ iq, authed });
					return answer(ns) === 'ok' ? result('mam1') : error('mam1', 'feature-not-implemented');
				}
			})
		);
		const cfg = {
			jid: 'bot@localhost',
			password: 'secret',
			host: '127.0.0.1',
			port: x.port,
			security: 'starttls' as const,
			ca: TEST_CERT
		};
		return { sets, got: await xmppArchiveOff(cfg, direct, 10_000) };
	}

	it('after logging in, asks the server to keep nothing (default: never)', async () => {
		const { sets, got } = await archive(() => 'ok');
		expect(got).toBe('off');
		expect(sets).toHaveLength(1);
		expect(sets[0]!.authed).toBe(true);
		expect(sets[0]!.iq).toContain("<prefs xmlns='urn:xmpp:mam:2' default='never'/>");
	});

	it('an older server: the older archive version; none at all: "unsupported"', async () => {
		const older = await archive((ns) => (ns === 'urn:xmpp:mam:1' ? 'ok' : 'error'));
		expect(older.got).toBe('off');
		expect(older.sets.map((s) => /mam:(\d)/.exec(s.iq)?.[1])).toEqual(['2', '1']);
		const none = await archive(() => 'error');
		expect(none.got).toBe('unsupported');
	});
});
