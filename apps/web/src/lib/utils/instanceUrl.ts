/**
 * Validator for user-supplied Morphit instance URLs.
 *
 * Used by the /compare page (OPERATOR-TRUST-DESIGN.md item 3)
 * where the user enters another instance's URL and we fetch its
 * orderbook for a side-by-side diff. The input then gets passed
 * to `getOrderbookFromOrigin(origin, …)` which does a `new URL(…)`
 * and fetches from it.
 *
 * Rules:
 *   - Must parse as a URL
 *   - Protocol must be http: or https:. Zero-clearnet instances
 *     (.onion / .i2p / .loki) are served over http — the transport
 *     already encrypts — so http is accepted; clearnet is https.
 *     Other schemes (ftp:, javascript:, data:, …) are rejected.
 *   - A bare host with no scheme defaults to http:// for hidden-
 *     network suffixes, https:// otherwise.
 *   - Host must be non-empty and max 253 chars (RFC 1034)
 *   - No userinfo in the URL (`https://a:b@host` is suspicious)
 *   - Returns the canonical origin (scheme + host + optional
 *     port, no path/query/fragment) on success
 *
 * Matches the shape of `validateNostrUrl` in ./nostrUrl.ts so
 * the two validators are recognizably sibling code.
 */

export type InstanceUrlValidation =
	| { ok: true; origin: string }
	| { ok: false; reason: InstanceUrlError };

export type InstanceUrlError =
	| 'empty'
	| 'too_long'
	| 'malformed'
	| 'invalid_scheme'
	| 'has_userinfo'
	| 'bad_host';

/** Max characters we accept in the raw input. Generous — covers
 *  long onion / lokinet names while still bounded. */
const MAX_INPUT_CHARS = 256;

/** Max chars for a host — matches DNS limits. Applies after URL
 *  parsing has stripped scheme/port. */
const MAX_HOST_CHARS = 253;

/** Hidden-network host suffixes served over plain http (the transport
 *  encrypts). `.b32.i2p` ends in `.i2p`, so it's covered. */
const HIDDEN_NETWORK_TLDS = /\.(onion|i2p|loki)$/i;

export function validateInstanceUrl(raw: string): InstanceUrlValidation {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { ok: false, reason: 'empty' };
	if (trimmed.length > MAX_INPUT_CHARS) {
		return { ok: false, reason: 'too_long' };
	}

	// Prepend a scheme if the user didn't type one. Hidden-network hosts
	// (.onion/.i2p/.loki) are served over http, so default THOSE to http://;
	// everything else defaults to https://. A user who typed an explicit scheme
	// keeps it (re-validated below).
	let withScheme: string;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
		withScheme = trimmed;
	} else {
		const bareHost = trimmed.split(/[/?#]/, 1)[0] ?? trimmed;
		withScheme = (HIDDEN_NETWORK_TLDS.test(bareHost) ? 'http://' : 'https://') + trimmed;
	}

	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return { ok: false, reason: 'malformed' };
	}

	// Accept http AND https so zero-clearnet instances (.onion/.i2p over http)
	// and clearnet (https) both work. Reject anything else (ftp:, data:, …).
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return { ok: false, reason: 'invalid_scheme' };
	}

	// userinfo would be URL.username / URL.password — both should
	// be empty strings for a clean instance URL.
	if (url.username !== '' || url.password !== '') {
		return { ok: false, reason: 'has_userinfo' };
	}

	if (url.hostname.length === 0 || url.hostname.length > MAX_HOST_CHARS) {
		return { ok: false, reason: 'bad_host' };
	}

	return { ok: true, origin: url.origin };
}
