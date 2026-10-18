/** xmppAccount's validators, the made password, DNS SRV choices. */
import { describe, expect, it } from 'vitest';
import {
	checkXmppPassword,
	checkXmppUsername,
	makeXmppPassword,
	validJid,
	validXmppDomain,
	xmppEndpoint
} from '../src/lib/xmppAccount.ts';

type Srv = { name: string; port: number; priority: number; weight: number };
const srv = (map: Record<string, Srv[] | Error>) => async (name: string) => {
	const r = map[name];
	if (r === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
	if (r instanceof Error) throw r;
	return r;
};

describe('xmppEndpoint', () => {
	const C = '_xmpp-client._tcp.example.org';
	const S = '_xmpps-client._tcp.example.org';
	it.each([
		[
			'lowest priority wins',
			{
				[C]: [
					{ name: 'b.example.org', port: 5222, priority: 10, weight: 0 },
					{ name: 'a.example.org', port: 5269, priority: 5, weight: 0 }
				]
			},
			'a.example.org:5269 starttls'
		],
		[
			'same priority: higher weight',
			{
				[C]: [
					{ name: 'a.example.org', port: 1, priority: 5, weight: 1 },
					{ name: 'b.example.org', port: 2, priority: 5, weight: 9 }
				]
			},
			'b.example.org:2 starttls'
		],
		[
			'an IP target is skipped',
			{ [C]: [{ name: '192.0.2.1', port: 5222, priority: 0, weight: 0 }] },
			'example.org:5222 starttls'
		],
		[
			'a bad port is skipped',
			{
				[C]: [
					{ name: 'a.example.org', port: 0, priority: 0, weight: 0 },
					{ name: 'b.example.org', port: 70000, priority: 0, weight: 0 }
				]
			},
			'example.org:5222 starttls'
		],
		[
			'uppercase + trailing dot target',
			{ [C]: [{ name: 'XMPP.Example.ORG.', port: 5222, priority: 0, weight: 0 }] },
			'xmpp.example.org:5222 starttls'
		],
		[
			'no STARTTLS record: the TLS one',
			{ [S]: [{ name: 'tls.example.org', port: 443, priority: 0, weight: 0 }] },
			'tls.example.org:443 tls'
		],
		[
			'a junk target (spaces, underscores)',
			{ [C]: [{ name: 'evil host_.example.org', port: 5222, priority: 0, weight: 0 }] },
			'example.org:5222 starttls'
		],
		['DNS failure', { [C]: new Error('ETIMEOUT') }, 'example.org:5222 starttls']
	] as const)('%s', async (_n, map, want) => {
		const e = await xmppEndpoint('Example.org', srv(map as never));
		expect(`${e.host}:${e.port} ${e.security}`).toBe(want);
	});

	it('a "." target (service decidedly not available, RFC 2782): what happens', async () => {
		const e = await xmppEndpoint(
			'example.org',
			srv({
				[C]: [{ name: '.', port: 0, priority: 0, weight: 0 }],
				[S]: [{ name: '', port: 0, priority: 0, weight: 0 }]
			})
		);
		console.log('"." target →', e);
	});

	it('an .onion domain never asks DNS', async () => {
		let asked = 0;
		const e = await xmppEndpoint(`${'a'.repeat(56)}.onion`, async () => {
			asked++;
			return [];
		});
		expect(asked).toBe(0);
		expect(e.port).toBe(5222);
	});
});

describe('validators', () => {
	it.each([
		['og.im', true],
		['OG.IM', true],
		['og.im.', false],
		['xn--jbber-gra.de', true],
		['j\u00e4bber.de', false],
		['оg.im', false], // Cyrillic о
		['localhost', false],
		['192.0.2.1', false],
		['a.b', false],
		['-x.example', false],
		['x.example:5222', false],
		['https://x.example', false],
		[`${'b'.repeat(56)}.onion`, true]
	] as const)('validXmppDomain(%s) = %s', (d, ok) => {
		expect(validXmppDomain(d)).toBe(ok);
	});

	it.each([
		['me@example.org', true],
		['Me@Example.org', true],
		['me@example.org/res', false],
		['me@@example.org', false],
		['@example.org', false],
		["o'brien@example.org", false],
		['me@example.org.', false],
		['me@ex ample.org', false]
	] as const)('validJid(%s) = %s', (j, ok) => {
		expect(validJid(j)).toBe(ok);
	});

	it.each(['ab', 'a.b-c_d', '0x', 'z'.repeat(32)])('username ok: %s', (u) => {
		expect(checkXmppUsername(u).ok).toBe(true);
	});
	it.each(['a', 'z'.repeat(33), '.ab', 'ab.', 'a..b', 'a b', 'ünï', 'a@b'])(
		'username refused: %s',
		(u) => {
			expect(checkXmppUsername(u).ok).toBe(false);
		}
	);

	it('made passwords: 24 characters, safe alphabet, pass the check, and differ', () => {
		const seen = new Set<string>();
		for (let i = 0; i < 2000; i++) {
			const p = makeXmppPassword();
			expect(p).toMatch(/^[A-Za-z0-9\-_.!@#%+=]{24}$/);
			expect(checkXmppPassword(p, '')).toBeNull();
			seen.add(p);
		}
		expect(seen.size).toBe(2000);
	});

	it('a typed password wrapped in matching quotes is accepted by the check (the relay reads it without them)', () => {
		console.log('check of "Abcdef-1234":', checkXmppPassword('"Abcdef-1234"', 'bot'));
	});
});

describe('guard: a typed password the server would change (SASLprep) is refused before an account is made', () => {
	it.each([
		['Pass\u00a0Word-2026', 'no-break space'],
		['\ufb01le-Pass-2026X', 'ligature'],
		['Cafe\u0301-Pass-2026', 'decomposed accent'],
		['Soft\u00adHyphen-2026x', 'soft hyphen'],
		['Zero\u200bWidth-2026x', 'zero-width space']
	])('%s (%s)', (pw) => {
		expect(checkXmppPassword(pw, 'bot')).not.toBeNull();
	});
	it.each(['Caf\u00e9-Pass-2026', 'P\u00e4ssw\u00f6rd-2026x', 'Ab1-\u5bc6\u7801\u5bc6\u7801-xyz'])(
		'%s is fine (servers log it in as registered)',
		(pw) => {
			expect(checkXmppPassword(pw, 'bot')).toBeNull();
		}
	);
});
