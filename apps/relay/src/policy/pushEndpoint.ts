/**
 * Morphit relay — which URLs the relay will POST a Web Push to.
 *
 * A push subscription's endpoint is a URL the BROWSER hands us, and the relay
 * later POSTs to it from its own address. Before, any URL passed
 * (`z.string().url()`): a signed-in user could register `http://127.0.0.1:5432/`
 * or `https://10.0.0.5/` and have the relay send requests to its own loopback
 * or LAN on every notification — a blind SSRF and port probe.
 *
 * A Web Push endpoint is always an https URL on the browser vendor's push
 * service, so the rule is narrow:
 *   - https, default port, no user info, a host NAME (no IP literal);
 *   - the host is one of the browser push services below, or one the
 *     operator added (MORPHIT_RELAY_PUSH_EXTRA_HOSTS);
 *   - at send time, every address the name resolves to must be public, and
 *     the connection goes to the address that was checked (pushAgent()).
 */

import { lookup as dnsLookup } from 'node:dns';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isNonPublicAddressLiteral } from '@morphit/hidden-transport';

/** Push services of the browsers in use. `*.` = any subdomain. */
export const DEFAULT_PUSH_SERVICE_HOSTS: readonly string[] = [
	'fcm.googleapis.com', // Chrome, Edge-on-Android, Brave, Opera, Samsung Internet
	'*.push.services.mozilla.com', // Firefox (updates.push.services.mozilla.com)
	'*.notify.windows.com', // Edge on Windows (WNS)
	'web.push.apple.com', // Safari / iOS
	'*.push.apple.com'
];

/** Does `host` match a pattern list entry? Exact, or `*.suffix` = any
 *  subdomain of suffix (not suffix itself). */
function hostMatches(host: string, pattern: string): boolean {
	const p = pattern.toLowerCase();
	if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
	return host === p;
}

/** Is this a URL the relay may deliver Web Push to? PURE. */
export function isAllowedPushEndpoint(
	endpoint: string,
	extraHosts: readonly string[] = []
): boolean {
	let u: URL;
	try {
		u = new URL(endpoint);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:') return false;
	if (u.username !== '' || u.password !== '') return false;
	if (u.port !== '' && u.port !== '443') return false;
	const host = u.hostname.toLowerCase().replace(/\.$/, '');
	if (host === '' || isIP(host.replace(/^\[|\]$/g, '')) !== 0) return false;
	return [...DEFAULT_PUSH_SERVICE_HOSTS, ...extraHosts].some((p) => hostMatches(host, p));
}

/** Parse MORPHIT_RELAY_PUSH_EXTRA_HOSTS ("push.example.org,*.push.example.net"). */
export function parsePushExtraHosts(raw: string | undefined): string[] {
	if (raw === undefined) return [];
	return raw
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter((h) =>
			/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)
		);
}

type Resolve = (
	host: string,
	cb: (
		err: NodeJS.ErrnoException | null,
		addresses: Array<{ address: string; family: number }>
	) => void
) => void;

const systemResolve: Resolve = (host, cb) => dnsLookup(host, { all: true }, cb);

/** A `lookup` for https.Agent: resolves the name, refuses if ANY answer is a
 *  non-public address, and hands the socket the address that was checked, so
 *  a second DNS answer cannot redirect the connection. */
export function publicOnlyLookup(resolve: Resolve = systemResolve): LookupFunction {
	return ((host: string, options: { all?: boolean } | number | undefined, callback: unknown) => {
		const cb = (typeof options === 'function' ? options : callback) as (
			err: NodeJS.ErrnoException | null,
			address: string | Array<{ address: string; family: number }>,
			family?: number
		) => void;
		const all = typeof options === 'object' && options !== null && options.all === true;
		resolve(host, (err, addresses) => {
			if (err) return cb(err, all ? [] : '', 0);
			const bad = addresses.find((a) => isNonPublicAddressLiteral(a.address));
			if (addresses.length === 0 || bad !== undefined) {
				const e = new Error(
					`push endpoint host ${host} resolves to a non-public address; not contacted`
				) as NodeJS.ErrnoException;
				e.code = 'EPUSHPRIVATE';
				return cb(e, all ? [] : '', 0);
			}
			if (all) return cb(null, addresses);
			return cb(null, addresses[0]!.address, addresses[0]!.family);
		});
	}) as LookupFunction;
}

let agent: https.Agent | null = null;

/** The https.Agent every push delivery uses (see publicOnlyLookup). */
export function pushAgent(): https.Agent {
	agent ??= new https.Agent({ keepAlive: true, lookup: publicOnlyLookup() });
	return agent;
}
