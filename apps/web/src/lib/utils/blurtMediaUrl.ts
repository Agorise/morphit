/**
 * Blurt.media URL validation — shared between IdentityLabel
 * (render side) and the Settings form (save side).
 *
 * Blurt.media is a popular Blurt web frontend; users often want
 * to link to their profile there from their Morphit identity.
 *
 * Accepts:
 *   - `https://blurt.media/@<account>` and sub-paths under that
 *     (post links are fine too — the user might prefer to link to
 *     a specific post or tag page). Hostname MUST be blurt.media
 *     exactly, to prevent this field from being used as a
 *     redirect to arbitrary sites.
 *
 * Rejects:
 *   - Any other scheme (http:, ftp:, javascript:, data:, file:,
 *     vbscript:) — XSS-safe by design.
 *   - Any hostname other than blurt.media (including subdomains
 *     like evil.blurt.media). A leading dot / subdomain
 *     confusion attack (`blurt.media.evil.com`) is rejected
 *     because `new URL().hostname` returns the full host.
 *   - Strings longer than 512 characters.
 *   - Empty / whitespace-only input — treated as "no URL set,"
 *     not an error.
 *
 * Return contract matches nostrUrl.ts:
 *   - `{ ok: true, cleaned }` — URL is safe to store AND render.
 *   - `{ ok: false, reason }` — URL is rejected; reason is an
 *     i18n key fragment.
 *   - `null` — input was empty / whitespace. Not an error.
 */

export type BlurtMediaUrlValidation =
	| { ok: true; cleaned: string }
	| {
			ok: false;
			reason: 'too_long' | 'invalid_scheme' | 'wrong_host' | 'malformed';
	  }
	| null;

const MAX_URL_LENGTH = 512;
const ALLOWED_HOST = 'blurt.media';

export function validateBlurtMediaUrl(raw: string | null | undefined): BlurtMediaUrlValidation {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'string') return { ok: false, reason: 'malformed' };
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };

	// Reject a scheme that's missing its `//` authority, e.g.
	// `https:blurt.media/@me`. The WHATWG URL parser is lenient and
	// silently rewrites that into `https://blurt.media/@me`, so it would
	// otherwise pass validation and show "Looks good" even though the user
	// clearly mistyped the URL. Require an explicit `scheme://`. (http://
	// still parses here and is then rejected by the https-only check below,
	// preserving the more specific invalid_scheme reason.)
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		return { ok: false, reason: 'malformed' };
	}

	// Parse with URL() and normalize via toString(). Explicitly
	// reject any non-https scheme (http: too — blurt.media is
	// TLS-enabled; accepting http: would downgrade users).
	let u: URL;
	try {
		u = new URL(trimmed);
	} catch {
		return { ok: false, reason: 'malformed' };
	}

	if (u.protocol !== 'https:') {
		return { ok: false, reason: 'invalid_scheme' };
	}

	// Hostname must be EXACTLY blurt.media — no subdomains, no
	// lookalikes. `new URL('https://blurt.media.evil.com/...').hostname`
	// returns `blurt.media.evil.com`, which fails this check.
	if (u.hostname.toLowerCase() !== ALLOWED_HOST) {
		return { ok: false, reason: 'wrong_host' };
	}

	return { ok: true, cleaned: u.toString() };
}

/** Render-side helper: returns the cleaned string or null.
 *  Intentionally opaque about WHY — IdentityLabel only needs
 *  to know "can I put this in an href or not". */
export function validateBlurtMediaUrlForRender(raw: string | null | undefined): string | null {
	const result = validateBlurtMediaUrl(raw);
	if (result && 'ok' in result && result.ok) return result.cleaned;
	return null;
}
