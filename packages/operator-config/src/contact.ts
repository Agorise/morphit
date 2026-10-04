// ─────────────────────────────────────────────────────────────────────────
// Contact-URL protocols (v1.16.2)  —  BROWSER-SAFE MODULE
//
// Split out of index.ts so the web frontend can import the contact detector +
// allowlist WITHOUT pulling index.ts's Node-only env-loader (node:fs/path/util)
// into the browser bundle. index.ts re-exports everything here, so Node
// consumers importing the package root are unchanged; the web imports
// `@morphit/operator-config/contact` (the ./contact export) directly.
//
// This file MUST stay free of Node built-ins (no node:fs / node:path /
// node:util / process access) — it is bundled for the browser.
//
// An operator's `contact_url` is rendered as a clickable "Contact this
// operator" link. This is the SINGLE canonical allowlist + protocol detector,
// imported by every consumer so they can never drift: the on-chain gate
// (indexer handler), the two entry validators (ops-cli register prompt + the
// web register flow), and the render sanitizer (safeContactUrl). A parity
// smoke pins that they all use this list.
//
// SECURITY: only `https:` (web deep-links) + safe app-handoff URI schemes are
// allowed. `http:` is deliberately EXCLUDED (downgrade/fingerprinting vector —
// the on-chain gate has always been https-only) and script/data schemes
// (javascript:, data:, vbscript:, file:) can never match, so a malicious
// `contact_url` can't XSS the directory.
// ─────────────────────────────────────────────────────────────────────────

/** The messaging/contact protocols a `contact_url` can point at. */
export type ContactProtocol =
	| 'matrix'
	| 'telegram'
	| 'discord'
	| 'keybase'
	| 'signal'
	| 'simplex'
	| 'xmpp'
	| 'briar'
	| 'cwtch'
	| 'jami'
	| 'session'
	| 'email'
	| 'nostr'
	| 'web';

export interface ContactProtocolInfo {
	readonly id: ContactProtocol;
	/**
	 * true  → render as a clickable `<a href>` (a web deep-link, or an
	 *         app-handoff URI the OS opens in the messenger).
	 * false → no URL handler exists for this address form (a Session ID, a
	 *         Cwtch address), so render it as a labeled, COPYABLE address
	 *         instead of a dead link.
	 */
	readonly clickable: boolean;
}

/** https hosts that map to a known messenger (order-independent). */
const CONTACT_HTTPS_HOSTS: ReadonlyArray<readonly [RegExp, ContactProtocol]> = [
	[/^t\.me$/i, 'telegram'],
	[/^(discord\.com|discord\.gg|discordapp\.com)$/i, 'discord'],
	[/^keybase\.io$/i, 'keybase'],
	[/^signal\.me$/i, 'signal'],
	[/^simplex\.chat$/i, 'simplex'],
	[/^matrix\.to$/i, 'matrix']
];

/**
 * Classify a `contact_url` into a protocol + whether it's a clickable link.
 * Returns null when the URL is unparseable or its scheme is NOT allowlisted
 * (this doubles as the scheme gate — see `isAllowedContactUrl`).
 */
export function detectContactProtocol(raw: string | null | undefined): ContactProtocolInfo | null {
	if (raw === null || raw === undefined) return null;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	let scheme: string;
	let host = '';
	try {
		const u = new URL(trimmed);
		scheme = u.protocol.toLowerCase();
		host = u.hostname.toLowerCase();
		// v16-2: reject userinfo (`https://user:pw@host/`). Phishing pattern —
		// the visible prefix can impersonate a trusted host (e.g.
		// `https://matrix.to@evil.com`) while navigation goes to `host`. This
		// mirrors the on-chain gate's O1.2 check; folding it into the shared
		// detector makes isAllowedContactUrl + both entry validators enforce it
		// too, so the "single canonical gate" no longer drifts from the handler.
		if (u.username !== '' || u.password !== '') return null;
	} catch {
		// URI schemes with an opaque body that WHATWG-URL may reject
		// (e.g. `session:05ab…`): fall back to a manual scheme extract.
		const colon = trimmed.indexOf(':');
		if (colon <= 0) return null;
		scheme = trimmed.slice(0, colon + 1).toLowerCase();
	}
	switch (scheme) {
		case 'mailto:':
			return { id: 'email', clickable: true };
		case 'xmpp:':
			return { id: 'xmpp', clickable: true };
		case 'matrix:':
			return { id: 'matrix', clickable: true };
		case 'nostr:':
			return { id: 'nostr', clickable: true };
		case 'simplex:':
			return { id: 'simplex', clickable: true };
		case 'briar:':
			return { id: 'briar', clickable: true };
		case 'jami:':
			return { id: 'jami', clickable: true };
		case 'sgnl:':
			return { id: 'signal', clickable: true };
		case 'tg:':
			return { id: 'telegram', clickable: true };
		case 'session:':
			return { id: 'session', clickable: false }; // Session ID — copy-only
		case 'cwtch:':
			return { id: 'cwtch', clickable: false }; // Cwtch address — copy-only
		case 'https:': {
			for (const [re, id] of CONTACT_HTTPS_HOSTS) if (re.test(host)) return { id, clickable: true };
			return { id: 'web', clickable: true }; // any other https profile page
		}
		default:
			return null; // scheme not allowlisted (incl. http:, javascript:, data:, …)
	}
}

/** The canonical set of allowed `contact_url` schemes (mirrors the detector's
 *  switch — the parity smoke asserts they stay in lockstep). */
export const CONTACT_URL_SCHEMES = [
	'https:',
	'mailto:',
	'matrix:',
	'xmpp:',
	'nostr:',
	'simplex:',
	'briar:',
	'jami:',
	'sgnl:',
	'tg:',
	'session:',
	'cwtch:'
] as const;

/** True if `raw` is a contact_url with an allowlisted scheme (safe to store +
 *  render). The single gate for the on-chain handler + both entry validators. */
export function isAllowedContactUrl(raw: string | null | undefined): boolean {
	return detectContactProtocol(raw) !== null;
}

/**
 * Coerce a raw contact value into a safe, allowlisted contact URL, or undefined.
 *
 * - already a valid contact URL → returned unchanged;
 * - a BARE email (`user@host.tld`, no scheme) → repaired to `mailto:user@host.tld`
 *   (the #1 operator mistake — a bare email typed into the branding step, which
 *   is NOT a URL and used to fail the indexer's config validation and brick the
 *   whole instance, v1.16.7);
 * - anything else invalid → undefined (dropped), never an error.
 *
 * Shared by the indexer (lenient runtime load), the `edit → branding` input
 * validator, and the upgrade auto-repair, so all three agree.
 */
export function normalizeContactUrl(raw: string | null | undefined): string | undefined {
	const trimmed = (raw ?? '').trim();
	if (trimmed === '') return undefined;
	if (isAllowedContactUrl(trimmed)) return trimmed;
	// Bare email with no scheme → try mailto:.
	if (/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(trimmed)) {
		const asMailto = `mailto:${trimmed}`;
		if (isAllowedContactUrl(asMailto)) return asMailto;
	}
	return undefined;
}
