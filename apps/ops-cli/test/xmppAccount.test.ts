/**
 * The checks `sudo morphit-ops offline-notify` makes before it asks an XMPP
 * server for the site's account, the password it makes on request, and how
 * it finds an XMPP domain's server (DNS SRV, RFC 6120 §3.2 / XEP-0368).
 */
import { describe, expect, it } from 'vitest';
import {
	XMPP_SUGGESTED_SERVERS,
	checkXmppPassword,
	checkXmppUsername,
	makeXmppPassword,
	validJid,
	validXmppDomain,
	xmppEndpoint
} from '../src/lib/xmppAccount.ts';

describe('suggested servers', () => {
	it('og.im first, then openim.nl and jabber.de', () => {
		expect(XMPP_SUGGESTED_SERVERS).toEqual(['og.im', 'openim.nl', 'jabber.de']);
	});
});

describe('server names and addresses', () => {
	it('a DNS name with a dot, or an .onion address', () => {
		for (const ok of [
			'og.im',
			'openim.nl',
			'xmpp.jabber.de',
			'xn--bcher-kva.example',
			`${'a'.repeat(56)}.onion`
		])
			expect(validXmppDomain(ok), ok).toBe(true);
		for (const bad of [
			'localhost',
			'https://og.im',
			'og.im/',
			'me@og.im',
			'og..im',
			'-og.im',
			'og.i',
			'og.123',
			'a'.repeat(64) + '.im',
			'og im.org'
		])
			expect(validXmppDomain(bad), bad).toBe(false);
	});

	it('an XMPP address: one @, a name without spaces or /, a valid server', () => {
		for (const ok of ['me@og.im', 'Some.One@example.org', 'x_y-z@jabber.de'])
			expect(validJid(ok), ok).toBe(true);
		for (const bad of [
			'og.im',
			'@og.im',
			'me@',
			'me@og',
			'a@b@og.im',
			'me@og.im/phone',
			'my name@og.im',
			"o'neil@og.im"
		])
			expect(validJid(bad), bad).toBe(false);
	});
});

describe('the new account’s name', () => {
	it('lower-cased; 2–32 of a–z 0–9 . _ -, letter or digit at both ends, no two marks in a row', () => {
		expect(checkXmppUsername(' MorphitIO ')).toEqual({ ok: true, value: 'morphitio' });
		expect(checkXmppUsername('morphit.io-notes_1')).toEqual({
			ok: true,
			value: 'morphit.io-notes_1'
		});
		for (const [bad, why] of [
			['morphitio@og.im', /without @/],
			['m', /2 to 32/],
			['m'.repeat(33), /2 to 32/],
			['-morphit', /only letters/],
			['morphit.', /only letters/],
			['mörphit', /only letters/],
			['morph it', /only letters/],
			['morph..it', /two of/],
			['morph._it', /two of/]
		] as const) {
			const r = checkXmppUsername(bad);
			expect(r.ok, bad).toBe(false);
			expect(r.ok ? '' : r.why, bad).toMatch(why);
		}
	});
});

describe('a typed password', () => {
	it('12 to 128 characters, no username in it, varied, three kinds (or 20+), no control characters or end spaces', () => {
		expect(checkXmppPassword('Tr4in-Lamp-Stone', 'morphitio')).toBeNull();
		expect(checkXmppPassword('correct horse battery staple', 'morphitio')).toBeNull();
		for (const [bad, why] of [
			['Short1!', /at least 12 characters \(it has 7\)/],
			['A1!' + 'x'.repeat(126), /at most 128/],
			['Has-MORPHITIO-in-1', /contain the username/],
			['aaaaaaaaaaaaaaaaaaaaaaaa', /more different characters/],
			['abababababababababababab', /more different characters/],
			['onlylowercase', /Mix at least three/],
			['lowercase12345', /Mix at least three/],
			[' Tr4in-Lamp-Stone', /start or end with a space/],
			['Tr4in-Lamp\nStone', /line breaks/],
			['Tr4in-Lamp\tStone', /line breaks/]
		] as const)
			expect(checkXmppPassword(bad, 'morphitio'), JSON.stringify(bad)).toMatch(why);
	});

	it('a made password: 24 characters that pass every check, different each time', () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const pw = makeXmppPassword();
			expect(pw).toHaveLength(24);
			expect(checkXmppPassword(pw, 'morphitio')).toBeNull();
			expect(pw).toMatch(/[a-z]/);
			expect(pw).toMatch(/[A-Z]/);
			expect(pw).toMatch(/[0-9]/);
			// Kept in a settings file: nothing that needs quoting or escaping there.
			expect(pw).toMatch(/^[A-Za-z0-9\-_.!@#%+=]+$/);
			seen.add(pw);
		}
		expect(seen.size).toBe(200);
	});
});

describe('where an XMPP domain’s server is', () => {
	const dns =
		(
			records: Record<
				string,
				Array<{ name: string; port: number; priority: number; weight: number }>
			>
		) =>
		async (name: string) => {
			const r = records[name];
			if (r === undefined) throw Object.assign(new Error('queryNotFound'), { code: 'ENODATA' });
			return r;
		};

	it('its _xmpp-client record (STARTTLS): the best priority, then the heaviest weight', async () => {
		expect(
			await xmppEndpoint(
				'og.im',
				dns({
					'_xmpp-client._tcp.og.im': [
						{ name: 'backup.og.im', port: 5222, priority: 10, weight: 100 },
						{ name: 'light.og.im.', port: 5222, priority: 5, weight: 1 },
						{ name: 'XMPP.og.im.', port: 15222, priority: 5, weight: 50 }
					]
				})
			)
		).toEqual({ host: 'xmpp.og.im', port: 15222, security: 'starttls', via: 'srv' });
	});

	it('else its _xmpps-client record (TLS from the start); else the domain itself on 5222', async () => {
		expect(
			await xmppEndpoint(
				'openim.nl',
				dns({
					'_xmpps-client._tcp.openim.nl': [
						{ name: 'tls.openim.nl', port: 443, priority: 0, weight: 0 }
					]
				})
			)
		).toEqual({ host: 'tls.openim.nl', port: 443, security: 'tls', via: 'srv' });
		expect(await xmppEndpoint('jabber.de', dns({}))).toEqual({
			host: 'jabber.de',
			port: 5222,
			security: 'starttls',
			via: 'domain'
		});
	});

	it('records that say "no service here" or name nonsense are passed over', async () => {
		expect(
			await xmppEndpoint(
				'og.im',
				dns({
					'_xmpp-client._tcp.og.im': [
						{ name: '.', port: 0, priority: 0, weight: 0 },
						{ name: 'evil host', port: 5222, priority: 0, weight: 0 },
						{ name: 'ok.og.im', port: 70000, priority: 0, weight: 0 }
					]
				})
			)
		).toEqual({ host: 'og.im', port: 5222, security: 'starttls', via: 'domain' });
	});

	it('an .onion address is never looked up', async () => {
		let asked = 0;
		const onion = `${'c'.repeat(56)}.onion`;
		expect(
			await xmppEndpoint(onion, async () => {
				asked++;
				return [];
			})
		).toEqual({ host: onion, port: 5222, security: 'starttls', via: 'domain' });
		expect(asked).toBe(0);
	});
});
