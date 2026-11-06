/**
 * `?next=` — where to go after signing in, checked once for every page that
 * honours it (v1.23.0: /login had the check inline; the import flow now needs
 * it too, so a visitor who clicks a vote button on /witnesses on a new device
 * comes back to /witnesses after importing their key, not to the orderbook).
 *
 * SECURITY — open-redirect guard: `next` is attacker-influenceable (a crafted
 * `/login?next=//evil.example` link), so resolve it against our OWN origin and
 * accept it only if it stays same-origin. This defeats protocol-relative
 * (`//host`), backslash (`/\host`), `scheme:` and other redirect tricks in one
 * check. PURE.
 */

/** The same-origin path + query + hash `raw` names, or null when it is absent,
 *  malformed or leaves `origin`. */
export function safeNextPath(raw: string | null | undefined, origin: string): string | null {
	if (!raw) return null;
	try {
		const u = new URL(raw, origin);
		if (u.origin !== origin) return null;
		// A path that starts with `//` (or `/\`) is protocol-relative: used as
		// an href or for location it would leave the origin. `/.//evil.example`
		// and `/en/..//evil.example` normalise to exactly that (review, v1.23.0).
		if (/^\/[/\\]/.test(u.pathname)) return null;
		return u.pathname + u.search + u.hash;
	} catch {
		return null;
	}
}

/** `path` with the current page's checked `next` carried along (for a link
 *  from /login into the import flow). */
export function withNext(path: string, rawNext: string | null | undefined, origin: string): string {
	const next = safeNextPath(rawNext, origin);
	if (next === null) return path;
	return `${path}${path.includes('?') ? '&' : '?'}next=${encodeURIComponent(next)}`;
}
