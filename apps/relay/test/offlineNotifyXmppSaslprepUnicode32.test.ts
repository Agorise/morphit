/**
 * SASLprep (RFC 4013) is defined on Unicode 3.2 (RFC 3454): a character
 * Unicode 3.2 did not have is left as it is, even where today's NFKC would
 * change it. Real Prosody 0.12 stores such a password unchanged (checked
 * live: "⅐" U+2150, "ᴬ" U+1D2C, "爫" U+FA70 — the relay of v1.21.9, which
 * sent the password as typed, logged in; a relay that NFKCs it with today's
 * Unicode is refused at every login). v1.21.10 review.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { registerXmpp, saslPrep, sendXmpp } from '../src/notify/channels/xmpp.ts';
import { TEST_CERT, fakeXmpp, type Listening } from './notifyFakes.ts';

const open: Listening[] = [];
afterEach(async () => {
	for (const l of open.splice(0)) await l.close();
});
const direct = { torSocks: '', hiddenOnly: false };

describe('characters newer than Unicode 3.2 stay as they are', () => {
	for (const pw of [
		'Frac⅐-Pass-2026xQ',
		'Modᴬ-Pass-2026xQ',
		'Cjk並-Pass-2026xQ',
		'Dig\u{1f101}-Pass-2026xQ'
	])
		it(`${JSON.stringify(pw)}: kept, and the login works where the server kept it`, async () => {
			expect(saslPrep(pw)).toBe(pw);
			for (const mechs of [['SCRAM-SHA-256'], ['PLAIN']]) {
				const x = await fakeXmpp({ mechs, password: pw });
				open.push(x);
				await sendXmpp(
					{
						jid: 'bot@localhost',
						password: pw,
						host: '127.0.0.1',
						port: x.port,
						security: 'starttls',
						ca: TEST_CERT
					},
					direct,
					'grandma@example.org',
					'hi',
					10_000
				);
				expect(x.messages, mechs[0]).toHaveLength(1);
			}
		});

	it('the characters around them are still prepared', () => {
		expect(saslPrep('ﬁ⅐ x­')).toBe('fi⅐ x');
		expect(saslPrep('é⅐é')).toBe('é⅐é');
	});
});

/**
 * A password SASLprep forbids (a private-use or C1 control character, or
 * Latin letters mixed with Hebrew or Arabic ones) is refused by real Prosody
 * 0.12 with feature-not-implemented "password fails SASLprep" (captured
 * live). That is a refused password, not "this server takes no new account":
 * the wizard must ask for another password, not send the operator away.
 */
describe("a password the server's SASLprep refuses", () => {
	it('is a refused password (not_acceptable), as Prosody says it', async () => {
		const x = await fakeXmpp({
			iq: (iq) => {
				if (/id='reg1'/.test(iq))
					return "<iq type='result' id='reg1'><query xmlns='jabber:iq:register'><username/><password/></query></iq>";
				if (/id='reg2'/.test(iq))
					return "<iq from='localhost' type='error' id='reg2'><error type='cancel'><feature-not-implemented xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/><text xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'>password fails SASLprep</text></error></iq>";
				return null;
			}
		});
		open.push(x);
		const r = await registerXmpp(
			{ domain: 'localhost', host: '127.0.0.1', port: x.port, security: 'starttls', ca: TEST_CERT },
			direct,
			'newbot',
			'\u05e9\u05dc\u05d5\u05dd-Pass-2026xQ',
			undefined,
			5_000
		);
		expect(r).toMatchObject({ ok: false, why: 'not_acceptable' });
	});
});

/**
 * The non-ASCII spaces (RFC 3454 C.1.2) are mapped to a space by SASLprep
 * itself, not only by NFKC: NFKC already turns U+00A0, U+2000–200A, U+202F,
 * U+205F and U+3000 into a space, but not U+1680 OGHAM SPACE MARK. Real
 * Prosody 0.12 registered "Ogham Space-…" and took the login only with
 * the space (checked live). The NBSP case alone does not guard the mapping.
 */
describe('a non-ASCII space NFKC leaves alone', () => {
	it('U+1680 becomes a space, and the login works', async () => {
		const typed = 'Ogham Space-2026xQ';
		const kept = 'Ogham Space-2026xQ';
		expect(saslPrep(typed)).toBe(kept);
		const x = await fakeXmpp({ mechs: ['SCRAM-SHA-256'], password: kept });
		open.push(x);
		await sendXmpp(
			{
				jid: 'bot@localhost',
				password: typed,
				host: '127.0.0.1',
				port: x.port,
				security: 'starttls',
				ca: TEST_CERT
			},
			direct,
			'grandma@example.org',
			'hi',
			10_000
		);
		expect(x.messages).toHaveLength(1);
	});
});
