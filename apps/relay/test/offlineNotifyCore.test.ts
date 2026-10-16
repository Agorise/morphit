/**
 * Offline notices — the parts that keep her address safe and the notice
 * honest: the vault, address checks, the texts, the network rules, SCRAM.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	openVault,
	vaultFromKey,
	VaultUnavailableError,
	VAULT_KEY_FILE
} from '../src/notify/vault.ts';
import { normalizeAddress } from '../src/notify/addresses.ts';
import { cleanSiteName, NOTICE_LOCALES, render } from '../src/notify/text.ts';
import { httpRequest, NetRefusedError, openSocket, routeFor } from '../src/notify/net.ts';
import { scramClient, xmlEscape } from '../src/notify/channels/xmpp.ts';
import {
	linkOriginFromEnv,
	notifyConfigFromEnv,
	offeredChannels,
	siteNameFromEnv
} from '../src/notify/config.ts';
import { newSessionIdentity } from '../src/notify/channels/session.ts';
import { SmtpError } from '../src/notify/channels/smtp.ts';
import { errorClass } from '../src/notify/dispatch.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.restoreAllMocks();
});
const tmp = (): string => {
	const d = mkdtempSync(join(tmpdir(), 'notify-vault-'));
	dirs.push(d);
	return d;
};

describe('the vault: what a copy of the database holds', () => {
	it('an address is stored sealed: the bytes do not contain it, and only its own row opens it', () => {
		const v = vaultFromKey(Buffer.alloc(32, 7));
		const sealed = v.seal('grandma@example.net', 'alice', 'email', 'address');
		expect(sealed.includes(Buffer.from('grandma'))).toBe(false);
		expect(v.open(sealed, 'alice', 'email', 'address')).toBe('grandma@example.net');
		// Copied to another account's row, another channel, or used as a route: does not open.
		expect(v.open(sealed, 'bob', 'email', 'address')).toBeNull();
		expect(v.open(sealed, 'alice', 'xmpp', 'address')).toBeNull();
		expect(v.open(sealed, 'alice', 'email', 'route')).toBeNull();
		// Under another key (a database restored onto another box): does not open.
		expect(vaultFromKey(Buffer.alloc(32, 8)).open(sealed, 'alice', 'email', 'address')).toBeNull();
		// Two seals of the same address differ (random nonce): equal addresses are not visible as equal.
		expect(v.seal('grandma@example.net', 'alice', 'email', 'address').equals(sealed)).toBe(false);
	});

	it('every sealed value has the same size: a short address and the longest one look alike', () => {
		const v = vaultFromKey(Buffer.alloc(32, 7));
		const sizes = new Set(
			[
				'a@b.co',
				`${'x'.repeat(60)}@${'d'.repeat(180)}.example`,
				`@${'é'.repeat(200)}:hs.org`,
				'中'.repeat(254),
				'05' + 'ab'.repeat(32)
			].map((x) => v.seal(x, 'alice', 'email', 'address').length)
		);
		sizes.add(v.seal('!room:hs.org', 'alice', 'matrix', 'route').length);
		expect([...sizes]).toHaveLength(1);
		// …and the longest still opens.
		const long = '中'.repeat(254);
		expect(v.open(v.seal(long, 'alice', 'email', 'address'), 'alice', 'email', 'address')).toBe(
			long
		);
	});

	it('a keyed hash is stable, differs per key, and does not contain the address', () => {
		const a = vaultFromKey(Buffer.alloc(32, 1));
		const b = vaultFromKey(Buffer.alloc(32, 2));
		expect(a.mac('address', 'email', 'x@y.org').equals(a.mac('address', 'email', 'x@y.org'))).toBe(
			true
		);
		expect(a.mac('address', 'email', 'x@y.org').equals(b.mac('address', 'email', 'x@y.org'))).toBe(
			false
		);
		// Field boundaries are part of the hash: ("ab","c") is not ("a","bc").
		expect(a.mac('ab', 'c').equals(a.mac('a', 'bc'))).toBe(false);
	});

	it('the key file is created once, readable by its owner only, and reused', () => {
		const d = tmp();
		const first = openVault(d);
		expect(first.created).toBe(true);
		expect(statSync(join(d, VAULT_KEY_FILE)).mode & 0o777).toBe(0o600);
		const sealed = first.vault.seal('x@y.org', 'alice', 'email', 'address');
		const again = openVault(d);
		expect(again.created).toBe(false);
		expect(again.vault.open(sealed, 'alice', 'email', 'address')).toBe('x@y.org');
	});

	it('no key and a directory it cannot write: offline notices stay off, with the reason', () => {
		if (process.getuid?.() === 0) {
			// root writes anywhere; use a path under a FILE instead.
			const d = tmp();
			writeFileSync(join(d, 'f'), 'x');
			expect(() => openVault(join(d, 'f', 'sub'))).toThrow(VaultUnavailableError);
			return;
		}
		const d = tmp();
		mkdirSync(join(d, 'ro'));
		chmodSync(join(d, 'ro'), 0o500);
		expect(() => openVault(join(d, 'ro'))).toThrow(VaultUnavailableError);
	});
});

describe('what counts as an address', () => {
	it.each([
		['email', ' Grandma@Example.NET ', 'Grandma@example.net'],
		['matrix', '@Grandma:Matrix.org', '@grandma:matrix.org'],
		['xmpp', 'grandma@Jabber.example', 'grandma@jabber.example'],
		['session', '05' + 'A'.repeat(64), '05' + 'a'.repeat(64)]
	] as const)('%s %j → %j', (channel, raw, want) => {
		expect(normalizeAddress(channel, raw)).toBe(want);
	});

	it.each([
		['email', 'a@b.org\r\nBcc: victim@x.org'],
		['email', 'not-an-address'],
		['email', `${'a'.repeat(250)}@b.org`],
		['matrix', '#room:matrix.org'],
		['matrix', 'grandma:matrix.org'],
		['xmpp', 'grandma@jabber.example/resource'],
		['xmpp', "a'b@x.org"],
		['session', '04' + 'a'.repeat(64)],
		['session', '05' + 'a'.repeat(63)]
	] as const)('%s refuses %j', (channel, raw) => {
		expect(normalizeAddress(channel, raw)).toBeNull();
	});
});

describe('what is sent', () => {
	it('every language has every text, with its placeholders', () => {
		for (const l of NOTICE_LOCALES) {
			const n = render(l, 'notice', { site: 'Vigilante Trading', link: 'https://v.example/x' });
			expect(n).toContain('Vigilante Trading');
			expect(n).toContain('https://v.example/x');
			expect(n).not.toMatch(/\{(site|link|code)\}/);
			const c = render(l, 'code', { site: 'Vigilante Trading', code: '123456' });
			expect(c).toContain('123456');
			expect(c).toContain('Vigilante Trading');
			for (const k of ['notice_subject', 'code_subject', 'telegram_linked'] as const) {
				expect(render(l, k, { site: 'S', code: '1' })).not.toMatch(/\{(site|link|code)\}/);
			}
		}
	});

	it('the notice names the SITE, never "Morphit" on its own, never the sender', () => {
		for (const l of NOTICE_LOCALES) {
			for (const k of [
				'notice',
				'notice_subject',
				'code',
				'code_subject',
				'telegram_linked'
			] as const) {
				expect(render(l, k, { site: 'Libertad Latina', link: 'L', code: 'C' })).not.toMatch(
					/morphit/i
				);
			}
		}
		// There is no way to pass the sender: render takes the site, the link and the code only.
		expect(render('en', 'notice', { site: 'Libertad Latina', link: 'https://x' })).toBe(
			'Someone just sent you a chat message on Libertad Latina. Open it here to read it and reply: https://x'
		);
	});

	it('a site name cannot break a line (an email header, an XMPP stanza)', () => {
		expect(render('en', 'notice_subject', { site: 'Evil\r\nBcc: x@y.org' })).toBe(
			'New chat message on Evil Bcc: x@y.org'
		);
		// No control character of any kind survives, nor a name past 64 characters.
		expect(cleanSiteName('A\u0000B\u0007C\u001bD\u007fE\tF')).toBe('A B C D E F');
		expect(cleanSiteName('x'.repeat(100))).toHaveLength(64);
		expect(xmlEscape(`<body>&'"`)).toBe('&lt;body&gt;&amp;&apos;&quot;');
	});
});

describe('where the relay may connect', () => {
	const tor = { torSocks: '127.0.0.1:9050', hiddenOnly: false };
	const hidden = { torSocks: '127.0.0.1:9050', hiddenOnly: true };
	it('an .onion server always goes through Tor; without Tor it is refused', () => {
		expect(routeFor('abc.onion', tor, false)).toBe('tor');
		expect(() => routeFor('abc.onion', { torSocks: '', hiddenOnly: false }, false)).toThrow(
			NetRefusedError
		);
	});
	it('a zero-clearnet relay refuses every clearnet host, even through Tor', () => {
		expect(() => routeFor('smtp.example.org', hidden, false)).toThrow(NetRefusedError);
		expect(() => routeFor('api.telegram.org', hidden, true)).toThrow(NetRefusedError);
		expect(routeFor('xyz.onion', hidden, false)).toBe('tor');
	});
	it('…and refuses it before any connection is attempted', async () => {
		const spy = vi.spyOn(net, 'connect');
		await expect(openSocket('smtp.example.org', 587, hidden)).rejects.toThrow(NetRefusedError);
		expect(spy).not.toHaveBeenCalled();
	});
	it('a clearnet relay asked for Tor uses Tor; otherwise it connects directly', () => {
		expect(routeFor('seed1.getsession.org', tor, true)).toBe('tor');
		expect(routeFor('matrix.org', tor, false)).toBe('direct');
	});
	it('plain http only to an .onion or this machine', async () => {
		await expect(httpRequest('http://matrix.example.org/x', tor)).rejects.toThrow(NetRefusedError);
	});
});

describe('XMPP login (SCRAM) against the RFC test vectors', () => {
	it('SCRAM-SHA-1 (RFC 5802 §5)', () => {
		const s = scramClient('sha1', 'user', 'pencil', 'fyko+d2lbbFgONRv9qkxdawL');
		expect(s.first).toBe('n,,n=user,r=fyko+d2lbbFgONRv9qkxdawL');
		expect(s.final('r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096')).toBe(
			'c=biws,r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,p=v0X8v3Bz2T0CJGbJQyF0X+HI4Ts='
		);
		expect(s.verify('v=rmF9pqV8S7suAoZWja4dJRkFsKQ=')).toBe(true);
		expect(s.verify('v=AAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toBe(false);
	});
	it('SCRAM-SHA-256 (RFC 7677 §3)', () => {
		const s = scramClient('sha256', 'user', 'pencil', 'rOprNGfwEbeRWgbNEkqO');
		expect(
			s.final(
				'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096'
			)
		).toBe(
			'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ='
		);
		expect(s.verify('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=')).toBe(true);
	});
	it('a server nonce that does not extend ours is refused', () => {
		const s = scramClient('sha1', 'user', 'pencil', 'abc');
		expect(() => s.final('r=zzz,s=QSXCR+Q6sek8bf92,i=4096')).toThrow();
	});
});

describe('what this site offers (operator settings)', () => {
	const base = {
		MORPHIT_INSTANCE_ORIGIN: 'https://vigilante.trading',
		MORPHIT_INSTANCE_BRAND_NAME: 'Vigilante Trading'
	};
	it('names the site by its brand, links to its own origin', () => {
		expect(siteNameFromEnv(base)).toBe('Vigilante Trading');
		expect(siteNameFromEnv({ MORPHIT_INSTANCE_NAME: 'Libertad Latina' })).toBe('Libertad Latina');
		// A brand name the site's pages would refuse is not put in a note either.
		expect(
			siteNameFromEnv({
				MORPHIT_INSTANCE_BRAND_NAME: 'Bad\u202eName',
				MORPHIT_INSTANCE_NAME: 'Libertad Latina'
			})
		).toBe('Libertad Latina');
		expect(linkOriginFromEnv(base, false)).toBe('https://vigilante.trading');
	});
	it('a zero-clearnet site links to its .onion and offers only .onion servers', async () => {
		const onion = 'a'.repeat(56) + '.onion';
		const env = {
			...base,
			MORPHIT_INSTANCE_TOR_ADDRESS: onion,
			MORPHIT_NOTIFY_MATRIX_HOMESERVER: 'https://matrix.org',
			MORPHIT_NOTIFY_MATRIX_TOKEN: 't',
			MORPHIT_NOTIFY_MATRIX_USER_ID: '@bot:matrix.org',
			MORPHIT_NOTIFY_XMPP_JID: 'bot@xmpp.example',
			MORPHIT_NOTIFY_XMPP_PASSWORD: 'p',
			MORPHIT_NOTIFY_XMPP_HOST: 'b'.repeat(56) + '.onion',
			MORPHIT_NOTIFY_TELEGRAM_TOKEN: '123:' + 'A'.repeat(30),
			MORPHIT_NOTIFY_TELEGRAM_USERNAME: 'VigilanteBot',
			MORPHIT_NOTIFY_SESSION_MNEMONIC: (await newSessionIdentity()).mnemonic
		};
		const cfg = await notifyConfigFromEnv(env, { torSocks: '127.0.0.1:9050', hiddenOnly: true });
		expect(cfg.linkOrigin).toBe(`http://${onion}`);
		// Not even a link she asked for on the clearnet.
		expect(cfg.linkOrigins.clearnet).toBeNull();
		expect(offeredChannels(cfg)).toEqual(['xmpp']);
		expect(cfg.off).toEqual({
			matrix: 'zero_clearnet',
			telegram: 'zero_clearnet',
			session: 'zero_clearnet'
		});
	});
	it('all five are listed Matrix, Session, XMPP, Telegram, Email (the order the card shows)', async () => {
		const env = {
			...base,
			MORPHIT_NOTIFY_EMAIL_HOST: 'mail.example.org',
			MORPHIT_NOTIFY_EMAIL_USER: 'ops@example.org',
			MORPHIT_NOTIFY_EMAIL_PASSWORD: 'p',
			MORPHIT_NOTIFY_EMAIL_FROM: 'ops@example.org',
			MORPHIT_NOTIFY_MATRIX_HOMESERVER: 'https://matrix.org',
			MORPHIT_NOTIFY_MATRIX_TOKEN: 't',
			MORPHIT_NOTIFY_MATRIX_USER_ID: '@bot:matrix.org',
			MORPHIT_NOTIFY_XMPP_JID: 'bot@xmpp.example',
			MORPHIT_NOTIFY_XMPP_PASSWORD: 'p',
			MORPHIT_NOTIFY_TELEGRAM_TOKEN: '123:' + 'A'.repeat(30),
			MORPHIT_NOTIFY_TELEGRAM_USERNAME: 'VigilanteBot',
			MORPHIT_NOTIFY_SESSION_MNEMONIC: (await newSessionIdentity()).mnemonic
		};
		const cfg = await notifyConfigFromEnv(env, { torSocks: '127.0.0.1:9050', hiddenOnly: false });
		expect(offeredChannels(cfg)).toEqual(['matrix', 'session', 'xmpp', 'telegram', 'email']);
	});
	it('nothing offered without a link to put in the notice', async () => {
		const cfg = await notifyConfigFromEnv(
			{ MORPHIT_NOTIFY_XMPP_JID: 'bot@x.org', MORPHIT_NOTIFY_XMPP_PASSWORD: 'p' },
			{ torSocks: '', hiddenOnly: false }
		);
		expect(cfg.linkOrigin).toBeNull();
		expect(offeredChannels(cfg)).toEqual([]);
	});
});

describe('what reaches the log about a failed send', () => {
	it('only the kind of error — never its text, which may hold her address or a server reply', () => {
		const smtp = new SmtpError('RCPT TO:<grandma@example.net>', 550);
		expect(smtp.message).toContain('grandma@example.net');
		expect(errorClass(smtp)).toBe('SmtpError');
		expect(errorClass(new Error('could not reach @grandma:hs.org'))).toBe('Error');
		const odd = new Error('grandma@example.net');
		odd.name = '';
		expect(errorClass(odd)).toBe('Error');
		expect(errorClass('grandma@example.net')).toBe('string');
		expect(errorClass({ message: 'grandma@example.net' })).toBe('object');
	});
});
