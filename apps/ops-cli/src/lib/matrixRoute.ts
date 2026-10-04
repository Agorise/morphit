/**
 * How the Matrix alert bot reaches its homeserver, as the bot itself judges it
 * on a tor-only node (apps/matrix-bot/src/config.ts): only a homeserver on this
 * machine, or a .onion one reached through Tor's SOCKS port, keeps the node
 * off the clearnet. PURE; no imports, so the install wizard can use it too.
 */

/** An env flag the bot reads as on (1 / true / yes). PURE. */
export function envFlagOn(raw: string): boolean {
	return /^(1|true|yes)$/i.test(raw.trim());
}

/**
 * How the bot reaches a homeserver URL: on this machine ('loopback'), a Tor
 * onion service ('onion'), anything else ('clearnet'), or not a URL. PURE.
 */
export function homeserverRoute(raw: string): 'loopback' | 'onion' | 'clearnet' | 'invalid' {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		return 'invalid';
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'invalid';
	const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h)) return 'loopback';
	if (/^[a-z2-7]{56}\.onion$/.test(h)) return 'onion';
	return 'clearnet';
}

/** The SOCKS URL the bot takes for Tor's SocksPort (host:port). PURE. */
export function torSocksUrl(hostPort: string): string {
	return `socks5h://${hostPort}`;
}
