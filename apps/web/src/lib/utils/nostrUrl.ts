/**
 * Nostr URL validation — shared between IdentityLabel (render
 * side) and the Settings form (save side).
 *
 * Accepts:
 *   - `nostr:npub1<bech32>` — the nostr: URI scheme for
 *     pubkeys. Most Nostr clients register this scheme so the
 *     link opens the user's preferred Nostr app.
 *   - `https://` or `http://` — a public profile page on a
 *     Nostr web client (Primal, Iris, Snort, nostr.build, etc.).
 *
 * Rejects:
 *   - `javascript:`, `data:`, `file:`, `vbscript:` and any other
 *     scheme — these are XSS payload vectors even if the value
 *     is only ever rendered as an href.
 *   - Strings longer than 512 characters — no legitimate Nostr
 *     URL is anywhere near that long, and a bloated value is
 *     a signal that something's wrong.
 *   - Empty / whitespace-only input — treated as "no URL set,"
 *     not an error.
 *
 * Return contract:
 *   - `{ ok: true, cleaned }` — URL is safe to store AND render.
 *     `cleaned` is trim()'d and, for http(s), normalized by
 *     round-tripping through URL().
 *   - `{ ok: false, reason }` — URL is rejected. `reason` is an
 *     i18n key fragment so the form can show a useful message.
 *   - `null` — input was empty / whitespace. Not an error; the
 *     field is optional.
 */

export type NostrUrlValidation =
	| { ok: true; cleaned: string }
	| { ok: false; reason: 'too_long' | 'invalid_scheme' | 'malformed' }
	| null;

/** Max length chosen so legitimate nostr: + long-tail npub encodings
 *  fit comfortably, but obviously-bogus megabytes-of-junk payloads
 *  get rejected on sight. */
const MAX_URL_LENGTH = 512;

/** The indexer's own rule (apps/indexer handlers/profile.ts NOSTR_URI). */
const NOSTR_URI = /^nostr:(?:npub|nprofile)1[0-9a-z]{6,400}$/;

/** Validate a Nostr URL string. See file header for rules. */
export function validateNostrUrl(raw: string | null | undefined): NostrUrlValidation {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'string') return { ok: false, reason: 'malformed' };
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };

	// nostr: URI. Sent in the one form the indexer stores (from the consensus
	// activation time, 2026-11-01, it refuses anything else and the save is
	// silently lost): lower case, `npub1…` or `nprofile1…`, 6–400 data
	// characters. Bech32 is case-insensitive only when the whole string is in
	// ONE case, so `NPUB1…` is lowered and a mixed-case value is refused.
	const nostr = /^nostr:((?:npub|nprofile)1[0-9a-z]+)$/i.exec(trimmed);
	if (nostr) {
		const body = nostr[1]!;
		if (body !== body.toLowerCase() && body !== body.toUpperCase()) {
			return { ok: false, reason: 'malformed' };
		}
		const cleaned = `nostr:${body.toLowerCase()}`;
		return NOSTR_URI.test(cleaned) ? { ok: true, cleaned } : { ok: false, reason: 'malformed' };
	}

	// http(s) URL — parse with URL(), re-emit via toString() to
	// normalize. Explicitly reject any other scheme even though
	// URL() would accept it — javascript:, data:, file: etc. all
	// parse successfully but are unsafe as href values.
	try {
		const u = new URL(trimmed);
		if (u.protocol === 'https:' || u.protocol === 'http:') {
			const cleaned = u.toString();
			// The length the indexer checks is the length SENT: percent-encoding
			// can turn 120 typed characters into 700.
			if (cleaned.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };
			return { ok: true, cleaned };
		}
		return { ok: false, reason: 'invalid_scheme' };
	} catch {
		return { ok: false, reason: 'malformed' };
	}
}

/** Render-side helper: returns the cleaned string or null.
 *  Intentionally opaque about WHY — IdentityLabel only needs
 *  to know "can I put this in an href or not". */
export function validateNostrUrlForRender(raw: string | null | undefined): string | null {
	const result = validateNostrUrl(raw);
	if (result && 'ok' in result && result.ok) return result.cleaned;
	return null;
}
