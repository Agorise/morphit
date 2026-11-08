/**
 * Short page addresses people type by hand (v1.23.4).
 *
 * Owner, 2026-11-07: "many people manually type /about in their browser, so if
 * they do that, please direct them to …/en/about-this-instance automatically".
 *
 * Each key is the first path segment people type; the value is the page's real
 * segment. Both `/about` and `/<lang>/about` land on the real page: the bare one
 * through the locale redirect in `routes/[lang]/+layout.ts` (one hop, in the
 * visitor's language), the prefixed one through `routes/[lang]/about/+page.ts`.
 *
 * PURE.
 */

export const PAGE_ALIASES: Readonly<Record<string, string>> = {
	about: 'about-this-instance'
};

/** A locale-less path with its alias resolved: `/about` → `/about-this-instance`,
 *  `/about?x#y` → `/about-this-instance?x#y`. Only a path that IS the alias (one
 *  segment, an optional trailing slash) is rewritten; anything else comes back
 *  unchanged. */
export function resolvePageAlias(path: string): string {
	const m = /^\/([^/?#]+)\/?([?#].*)?$/.exec(path);
	if (!m) return path;
	const real = Object.prototype.hasOwnProperty.call(PAGE_ALIASES, m[1]!)
		? PAGE_ALIASES[m[1]!]
		: undefined;
	return real === undefined ? path : `/${real}${m[2] ?? ''}`;
}
