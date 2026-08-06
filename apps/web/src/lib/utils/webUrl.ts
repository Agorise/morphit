/**
 * Generic web-URL validation for the Settings profile links —
 * the "Website or Blog URL" card and the "Streaming URL" card.
 * Same return contract as nostrUrl.ts so the
 * Settings form (save side) and the profile-page render can share
 * one shape.
 *
 * Ken's rule for these cards: the ONLY validation is "is this a
 * valid URL" (empty is fine). So, unlike a host-locked validator, we do NOT
 * lock the host — any host is allowed (youtube.com, rumble.com,
 * twitch.tv, blurt.media, a personal blog, …). We DO keep the
 * XSS-safety every href-bound field needs: only http/https schemes
 * (javascript:, data:, vbscript:, file: rejected) and a length cap.
 * http is permitted alongside https because onion / I2P / Lokinet
 * sites and some personal blogs legitimately serve plain HTTP —
 * matching safeContactUrl's rationale (those inherit network-level
 * transport security, not TLS's).
 *
 *   - { ok: true, cleaned } — safe to store AND render.
 *   - { ok: false, reason } — rejected; reason is an i18n key fragment.
 *   - null                  — empty / whitespace. Not an error ("no URL set").
 */

export type WebUrlValidation =
	| { ok: true; cleaned: string }
	| { ok: false; reason: 'too_long' | 'invalid_scheme' | 'malformed' }
	| null;

const MAX_URL_LENGTH = 512;
const ALLOWED_SCHEMES = ['https:', 'http:'] as const;

export function validateWebUrl(raw: string | null | undefined): WebUrlValidation {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'string') return { ok: false, reason: 'malformed' };
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };

	// Reject a scheme missing its `//` authority (e.g. `https:example.com`).
	// The WHATWG URL parser silently rewrites that, so it would otherwise pass
	// even though the user clearly mistyped — require an explicit `scheme://`.
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		return { ok: false, reason: 'malformed' };
	}

	let u: URL;
	try {
		u = new URL(trimmed);
	} catch {
		return { ok: false, reason: 'malformed' };
	}

	if (!(ALLOWED_SCHEMES as readonly string[]).includes(u.protocol)) {
		return { ok: false, reason: 'invalid_scheme' };
	}
	// A scheme-only URL with no host (e.g. `https://`) is not a usable link.
	if (u.hostname.length === 0) {
		return { ok: false, reason: 'malformed' };
	}

	return { ok: true, cleaned: u.toString() };
}

/** Render-side helper: returns the cleaned string or null. Opaque about WHY —
 *  the profile page only needs "can I put this in an href or not". */
export function validateWebUrlForRender(raw: string | null | undefined): string | null {
	const result = validateWebUrl(raw);
	if (result && 'ok' in result && result.ok) return result.cleaned;
	return null;
}
