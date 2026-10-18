/**
 * The site's XMPP account in `sudo morphit-ops offline-notify`: which public
 * servers are suggested, how a username and a password are checked before
 * anything is sent, a strong password made on request, and where an XMPP
 * domain's server really is (its DNS SRV records). PURE apart from the DNS
 * lookup, which is injectable.
 */
import { randomInt } from 'node:crypto';
import { resolveSrv as dnsResolveSrv } from 'node:dns/promises';

/** Free public servers (providers.xmpp.net, category A) that take new
 *  accounts from an app; each is asked live before it is offered. */
export const XMPP_SUGGESTED_SERVERS = ['og.im', 'openim.nl', 'jabber.de'] as const;

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A domain an XMPP account can live on: a DNS name with a dot (or .onion). */
export function validXmppDomain(raw: string): boolean {
	const d = raw.trim().toLowerCase();
	if (d.length < 4 || d.length > 253 || !d.includes('.')) return false;
	const labels = d.split('.');
	if (!/^[a-z]{2,63}$/.test(labels.at(-1)!) && !/^xn--[a-z0-9-]{2,59}$/.test(labels.at(-1)!))
		return false;
	return labels.every((l) => HOST_LABEL.test(l));
}

/** A whole XMPP address (name@domain), for test notes and existing accounts. */
export function validJid(raw: string): boolean {
	const t = raw.trim();
	const at = t.indexOf('@');
	if (at < 1 || at !== t.lastIndexOf('@') || t.includes('/')) return false;
	const local = t.slice(0, at);
	return (
		local.length <= 1023 &&
		!/[\s"&'/:<>@\u0000-\u001f\u007f]/.test(local) &&
		validXmppDomain(t.slice(at + 1))
	);
}

/** A new account's name: 2–32 of a–z, 0–9, `.`, `_`, `-`, starting and
 *  ending with a letter or digit (lower-cased; what every server accepts). */
export function checkXmppUsername(
	raw: string
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly why: string } {
	const v = raw.trim().toLowerCase();
	if (v.includes('@'))
		return { ok: false, why: 'Just the name, without @ and the server (e.g. morphitio).' };
	if (v.length < 2 || v.length > 32) return { ok: false, why: 'Use 2 to 32 characters.' };
	if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(v))
		return {
			ok: false,
			why: 'Use only letters a–z, digits, and . _ - (starting and ending with a letter or digit).'
		};
	if (/[._-]{2}/.test(v)) return { ok: false, why: 'No two of . _ - in a row.' };
	return { ok: true, value: v };
}

export const XMPP_PASSWORD_MIN = 12;
export const XMPP_PASSWORD_MAX = 128;

/**
 * Why a password is not good enough, or null. At least 12 characters (up to
 * 128); not containing the username; not one character repeated; and at
 * least three of: lower-case, upper-case, digits, other characters — unless
 * it is a long passphrase (20 characters or more). No line breaks or other
 * control characters (it is kept in a settings file).
 */
export function checkXmppPassword(pw: string, username: string): string | null {
	if (/[\u0000-\u001f\u007f]/.test(pw)) return 'It cannot contain line breaks or tabs.';
	if (pw.length < XMPP_PASSWORD_MIN)
		return `Use at least ${XMPP_PASSWORD_MIN} characters (it has ${pw.length}).`;
	if (pw.length > XMPP_PASSWORD_MAX) return `Use at most ${XMPP_PASSWORD_MAX} characters.`;
	if (pw.trim() !== pw) return 'It cannot start or end with a space.';
	// The server stores the password as SASLprep (RFC 4013) makes it, the
	// relay logs in with it as typed: a password SASLprep changes (a no-break
	// or zero-width space, a soft hyphen, a ligature, an accent typed as a
	// separate mark) would make an account that cannot be logged in to.
	if (
		pw.normalize('NFKC') !== pw ||
		/[\u00ad\u034f\u1680\u1806\u180b-\u180d\u200b-\u200d\u2060\ufe00-\ufe0f\ufeff]/.test(pw)
	)
		return 'Use plain characters: no special spaces, invisible characters or ligatures.';
	// …nor characters SASLprep refuses outright (RFC 4013 §2.3, §2.4: control,
	// format, private-use and unassigned characters, and right-to-left letters
	// mixed with others): the server turns the account down for them (Prosody:
	// "password fails SASLprep"; ejabberd: "unacceptable characters").
	if (
		/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\u2ff0-\u2ffb\ufff9-\ufffd]/u.test(pw) ||
		/[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/.test(pw)
	)
		return 'Use plain characters: no invisible or control characters, and no right-to-left letters.';
	// The relay drops one pair of quotes around a setting (relayReadsSame).
	if (/^(['"]).*\1$/.test(pw)) return 'It cannot start and end with the same quote mark.';
	if (username.length >= 2 && pw.toLowerCase().includes(username.toLowerCase()))
		return 'It cannot contain the username.';
	if (new Set(pw).size < 5) return 'Use more different characters.';
	const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
	if (pw.length < 20 && kinds < 3)
		return 'Mix at least three of: small letters, capitals, digits, other characters — or use 20 characters or more.';
	return null;
}

const PW_CHARS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PW_SYMBOLS = '-_.!@#%+=';

/** A strong password: 24 characters, with every kind checkXmppPassword asks
 *  for (and, given the account's username, not containing it). */
export function makeXmppPassword(username = ''): string {
	for (;;) {
		let pw = '';
		for (let i = 0; i < 24; i++) {
			const pool = i % 6 === 5 ? PW_SYMBOLS : PW_CHARS;
			pw += pool[randomInt(pool.length)];
		}
		if (
			/[a-z]/.test(pw) &&
			/[A-Z]/.test(pw) &&
			/[0-9]/.test(pw) &&
			checkXmppPassword(pw, username) === null
		)
			return pw;
	}
}

export interface XmppEndpoint {
	readonly host: string;
	readonly port: number;
	readonly security: 'starttls' | 'tls';
	/** 'srv': from the domain's DNS records; 'domain': the domain itself. */
	readonly via: 'srv' | 'domain';
}

type SrvRecord = { name: string; port: number; priority: number; weight: number };

/**
 * Where an XMPP domain's server is (RFC 6120 §3.2, XEP-0368): its
 * _xmpp-client._tcp record (STARTTLS), else its _xmpps-client._tcp record
 * (TLS from the first byte), else the domain itself on 5222. Never asked for
 * an .onion address (no DNS for those, and none on a zero-clearnet box).
 */
export async function xmppEndpoint(
	domain: string,
	resolveSrv: (name: string) => Promise<SrvRecord[]> = dnsResolveSrv
): Promise<XmppEndpoint> {
	const d = domain.trim().toLowerCase();
	const plain: XmppEndpoint = { host: d, port: 5222, security: 'starttls', via: 'domain' };
	if (d.endsWith('.onion')) return plain;
	const best = async (name: string): Promise<SrvRecord | null> => {
		try {
			const rs = (await resolveSrv(name))
				.filter(
					(r) =>
						r.name !== '.' &&
						r.name !== '' &&
						Number.isInteger(r.port) &&
						r.port > 0 &&
						r.port < 65536 &&
						validXmppDomain(r.name.replace(/\.$/, ''))
				)
				.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
			return rs[0] ?? null;
		} catch {
			return null;
		}
	};
	const starttls = await best(`_xmpp-client._tcp.${d}`);
	if (starttls !== null)
		return {
			host: starttls.name.replace(/\.$/, '').toLowerCase(),
			port: starttls.port,
			security: 'starttls',
			via: 'srv'
		};
	const direct = await best(`_xmpps-client._tcp.${d}`);
	if (direct !== null)
		return {
			host: direct.name.replace(/\.$/, '').toLowerCase(),
			port: direct.port,
			security: 'tls',
			via: 'srv'
		};
	return plain;
}
