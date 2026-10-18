/**
 * Offline notices — XMPP registration refusals never put the password on the
 * operator's screen, even when the server's words repeat it (v1.21.10
 * review). The words are cleaned (spaces folded, invisible characters turned into
 * spaces) and cut at 200 characters: the password must go before that, or a
 * password that cleaning changes, or one that crosses the cut, comes through.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { registerXmpp } from '../src/notify/channels/xmpp.ts';
import { TEST_CERT, fakeXmpp, type Listening } from './notifyFakes.ts';

const open: Listening[] = [];
afterEach(async () => {
	for (const l of open.splice(0)) await l.close();
});
const direct = { torSocks: '', hiddenOnly: false };

const esc = (s: string): string =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');

async function refusedWith(password: string, words: (pw: string) => string) {
	const x = await fakeXmpp({
		iq: (iq) => {
			if (/id='reg1'/.test(iq))
				return "<iq type='result' id='reg1'><query xmlns='jabber:iq:register'><username/><password/></query></iq>";
			if (/id='reg2'/.test(iq))
				return `<iq type='error' id='reg2'><error type='modify'><not-acceptable xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/><text xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'>${esc(words(password))}</text></error></iq>`;
			return null;
		}
	});
	open.push(x);
	return registerXmpp(
		{ domain: 'localhost', host: '127.0.0.1', port: x.port, security: 'starttls', ca: TEST_CERT },
		direct,
		'newbot',
		password,
		undefined,
		5_000
	);
}

/** Every run of 6 or more characters of the password, as the screen could show it. */
function leaks(text: string, password: string): string[] {
	const out: string[] = [];
	const folded = password.replace(/[\s\u0080-\u009f​-‏‪-‮⁦-⁩]+/g, ' ');
	for (const p of [password, folded])
		for (let i = 0; i + 6 <= p.length; i++)
			if (text.includes(p.slice(i, i + 6))) out.push(p.slice(i, i + 6));
	return out;
}

describe('the password repeated in a refusal never reaches the screen', () => {
	it.each([
		// A made password (24 characters, no spaces) that crosses the 200-character cut.
		[
			'a made password past the cut',
			'CtkHp-2jAyX%hYWi2-KcmPE=',
			(pw: string) => `${'x'.repeat(175)} the password ${pw} is weak`
		],
		// Typed passwords the wizard accepts, which cleaning changes.
		['two spaces inside', 'Tr4in  Lamp-Stone', (pw: string) => `Password "${pw}" is too weak`],
		[
			'a left-to-right mark inside',
			'Tr4in‎Lamp-Stone',
			(pw: string) => `Password "${pw}" is too weak`
		]
	])('%s', async (_name, password, words) => {
		const r = await refusedWith(password, words);
		expect(r.ok).toBe(false);
		const text = 'text' in r ? r.text : '';
		expect(leaks(text, password)).toEqual([]);
	});

	it('an ordinary refusal keeps its words', async () => {
		const r = await refusedWith('Tr4in-Lamp-Stone', () => 'The password is too weak');
		expect(r).toMatchObject({ ok: false, why: 'not_acceptable', text: 'The password is too weak' });
	});
});
