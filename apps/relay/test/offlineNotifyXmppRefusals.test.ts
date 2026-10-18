/**
 * Offline notices — XMPP account making: what the operator is told must match
 * what the server meant. Refusals as real servers send them (ejabberd 23.10
 * answers a malformed name with jid-malformed), forms that ask more than the
 * picture check, and an archive setting that is only "off" when it really is.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { classifyRegistration, registerXmpp, xmppArchiveOff } from '../src/notify/channels/xmpp.ts';
import { TEST_CERT, fakeXmpp, type Listening } from './notifyFakes.ts';

const open: Listening[] = [];
afterEach(async () => {
	for (const l of open.splice(0)) await l.close();
});
const direct = { torSocks: '', hiddenOnly: false };
const isGet = (iq: string) => /type='get'/.test(iq);
const OPEN =
	"<iq type='result' id='reg1'><query xmlns='jabber:iq:register'><username/><password/></query></iq>";
const error = (id: string, cond: string, text = '', type = 'modify') =>
	`<iq type='error' id='${id}'><error type='${type}'><${cond} xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/>${text === '' ? '' : `<text xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'>${text}</text>`}</error></iq>`;

async function registrar(answer: (iq: string) => string | null) {
	const seen: string[] = [];
	const x = await fakeXmpp({
		iq: (iq) => {
			if (!/jabber:iq:register/.test(iq)) return null;
			seen.push(iq);
			return answer(iq);
		}
	});
	open.push(x);
	return {
		seen,
		server: {
			domain: 'localhost',
			host: '127.0.0.1',
			port: x.port,
			security: 'starttls' as const,
			ca: TEST_CERT
		}
	};
}

describe('a refusal is told as the server meant it', () => {
	it('a malformed name (ejabberd: jid-malformed) is a refused name, not "failed"', async () => {
		const { server } = await registrar((iq) =>
			isGet(iq) ? OPEN : error('reg2', 'jid-malformed', 'Malformed username')
		);
		expect(await registerXmpp(server, direct, 'a', 'pw', undefined, 10_000)).toMatchObject({
			ok: false,
			why: 'not_acceptable'
		});
	});

	it('the server repeating the password in its words does not put it on the screen', async () => {
		const pw = 'Zq8!vR2kL5xN9wM3';
		const { server } = await registrar((iq) =>
			isGet(iq) ? OPEN : error('reg2', 'not-acceptable', `The password ${pw} is too weak`)
		);
		const r = await registerXmpp(server, direct, 'morphitio', pw, undefined, 10_000);
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r)).not.toContain(pw);
	});
});

describe('a picture check that asks for more', () => {
	it('a captcha form that also requires an email address: needs_more, nothing sent', async () => {
		const form =
			"<iq type='result' id='reg1'><query xmlns='jabber:iq:register'><x xmlns='jabber:x:data' type='form'>" +
			"<field var='FORM_TYPE' type='hidden'><value>urn:xmpp:captcha</value></field>" +
			"<field var='challenge' type='hidden'><value>42</value></field>" +
			"<field var='username'><required/></field><field var='password' type='text-private'><required/></field>" +
			"<field var='email'><required/></field>" +
			"<field var='ocr'><media xmlns='urn:xmpp:media-element'><uri type='image/png'>https://x.example/c.png</uri></media><required/></field>" +
			'</x></query></iq>';
		expect(classifyRegistration(form)).toMatchObject({ status: 'needs_more', fields: ['email'] });
		const { seen, server } = await registrar((iq) =>
			isGet(iq) ? form : "<iq type='result' id='reg2'/>"
		);
		let asked = 0;
		const r = await registerXmpp(
			server,
			direct,
			'morphitio',
			'pw',
			async () => {
				asked++;
				return 'K7Q2X';
			},
			10_000
		);
		expect(r).toMatchObject({ ok: false, form: { status: 'needs_more' } });
		expect(asked).toBe(0);
		expect(seen).toHaveLength(1);
	});
});

describe('the picture check outlives the server’s patience', () => {
	it('the server closed the stream while the operator read the picture: "captcha_expired", no throw', async () => {
		// Real ejabberd 23.10 closes an unauthenticated stream about 30 s after it
		// opened (connection-timeout), whitespace keepalives or not.
		const form =
			"<iq type='result' id='reg1'><query xmlns='jabber:iq:register'><x xmlns='jabber:x:data' type='form'>" +
			"<field var='FORM_TYPE' type='hidden'><value>jabber:iq:register</value></field>" +
			"<field var='username'><required/></field><field var='password' type='text-private'><required/></field>" +
			"<field var='captcha-fallback-url' type='text-single'><value>https://x.example/captcha/1/image</value></field>" +
			"<field var='ocr'><required/></field></x></query></iq>";
		const x = await fakeXmpp({ iq: (iq) => (/jabber:iq:register/.test(iq) ? form : null) });
		const server = {
			domain: 'localhost',
			host: '127.0.0.1',
			port: x.port,
			security: 'starttls' as const,
			ca: TEST_CERT
		};
		const r = await registerXmpp(
			server,
			direct,
			'morphitio',
			'pw',
			async () => {
				await x.close(); // the server gives up while the operator reads
				return 'K7Q2X';
			},
			10_000
		).catch((e: Error) => e);
		expect(r).toMatchObject({ ok: false, why: 'captcha_expired' });
	});
});

describe('the archive is only "off" when it is', () => {
	async function archive(answer: (iq: string) => string | null) {
		const x = await fakeXmpp({
			iq: (iq, authed) => (authed && /<prefs /.test(iq) ? answer(iq) : null)
		});
		open.push(x);
		const cfg = {
			jid: 'bot@localhost',
			password: 'secret',
			host: '127.0.0.1',
			port: x.port,
			security: 'starttls' as const,
			ca: TEST_CERT
		};
		try {
			return await xmppArchiveOff(cfg, direct, 10_000);
		} catch (e) {
			return e as Error;
		}
	}
	const id = (iq: string) => /id='([^']*)'/.exec(iq)?.[1] ?? '';

	it('a server error that is not "no such setting" is not reported as "unsupported"', async () => {
		const got = await archive((iq) =>
			/mam:2/.test(iq)
				? error(id(iq), 'internal-server-error', '', 'wait')
				: error(id(iq), 'service-unavailable', '', 'cancel')
		);
		expect(got).not.toBe('unsupported');
		expect(got).not.toBe('off');
	});

	it('a server that takes the setting but reads back default=always: not "off"', async () => {
		const got = await archive((iq) =>
			/type='set'/.test(iq)
				? `<iq type='result' id='${id(iq)}'/>`
				: `<iq type='result' id='${id(iq)}'><prefs xmlns='urn:xmpp:mam:2' default='always'><always/><never/></prefs></iq>`
		);
		expect(got).not.toBe('off');
	});

	it('real servers read back default=never: "off"', async () => {
		const got = await archive((iq) =>
			/type='set'/.test(iq)
				? `<iq type='result' id='${id(iq)}'/>`
				: `<iq type='result' id='${id(iq)}'><prefs default='never' xmlns='urn:xmpp:mam:2'><always/><never/></prefs></iq>`
		);
		expect(got).toBe('off');
	});
});
