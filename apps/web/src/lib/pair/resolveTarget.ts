/**
 * web+morphit: protocol-handler payload → SAFE same-origin in-app path.
 *
 * `manifest.webmanifest` registers the `web+morphit` protocol handler with
 * `url: "/pair?%s"`. When the OS hands a `web+morphit:///…` link to the PWA,
 * it navigates to `/pair?<percent-encoded-full-url>`, and `routes/pair/
 * +page.svelte` calls this resolver with `window.location.search`.
 *
 * THREAT MODEL — the payload is ATTACKER-INFLUENCEABLE: any web page can mint
 * a `web+morphit://` link, so `/pair` must NOT become an open redirect or
 * allow navigation outside the closed set of intents `WriteBlockedReadOnly`
 * emits. Defenses, in order:
 *
 *   1. Decode exactly once, then require the literal `web+morphit:` scheme
 *      (rejects `javascript:`, `http(s):`, `//evil`, `web+anything-else:`).
 *   2. Require the empty-authority `web+morphit:///<path>` shape that
 *      WriteBlockedReadOnly always emits.
 *   3. Allowlist the PATHNAME against the exact intent set; parameterized
 *      segments (peer account, order permlink) must match a strict,
 *      slash-free / percent-free charset and are never `.`/`..`.
 *   4. The caller only ever builds `localePath(pathname) + search + hash`,
 *      which is ALWAYS same-origin (`/<locale><pathname>`) — so even a
 *      passed-through query/hash cannot redirect off-site.
 *
 * Anything that fails returns `null`; the route then lands the user on the
 * locale home page rather than erroring (same posture as the root `/` shell's
 * malformed-deeplink fallback). A rare URL-unsafe-but-legitimate permlink may
 * fall back to home rather than resolve — that is the safe direction to err.
 *
 * PURE (no DOM/SvelteKit imports) so it is unit-tested directly by
 * pair-target-resolve-smoke.
 */

/** Intents whose path is fixed (no parameters). Mirrors WriteBlockedReadOnly. */
const EXACT_PATHS: ReadonlySet<string> = new Set([
	'/', // "open the app"
	'/post',
	'/settings',
	'/onboarding/register-name',
	'/run-a-node',
	'/my/orders'
]);

/** Blurt account name: lowercase alnum + dot + hyphen, 3–31 chars. No slash,
 *  percent, whitespace, or uppercase — so it can't break out of its path
 *  segment or carry an injection. */
const ACCOUNT_RE = /^[a-z0-9][a-z0-9.-]{2,30}$/;

/** Order permlink / slug: URL-safe slug characters only. No slash or percent. */
const PERMLINK_RE = /^[A-Za-z0-9._-]{1,256}$/;

function safeSeg(seg: string, re: RegExp): boolean {
	return seg !== '.' && seg !== '..' && re.test(seg);
}

export interface PairTarget {
	/** Locale-less in-app pathname (passed to `localePath`). */
	readonly pathname: string;
	/** Query string including leading `?`, or '' . Passed through verbatim. */
	readonly search: string;
	/** Hash including leading `#`, or '' . Passed through verbatim. */
	readonly hash: string;
}

/**
 * Resolve the raw `window.location.search` of `/pair` into a safe target, or
 * `null` if the payload isn't a recognized, allowlisted `web+morphit:` intent.
 */
export function resolveWebMorphitTarget(rawQuery: string): PairTarget | null {
	if (typeof rawQuery !== 'string' || rawQuery.length === 0) return null;

	let decoded: string;
	try {
		decoded = decodeURIComponent(rawQuery.replace(/^\?/, ''));
	} catch {
		return null; // malformed percent-encoding
	}

	const SCHEME = 'web+morphit:';
	if (!decoded.startsWith(SCHEME)) return null;

	// WriteBlockedReadOnly always emits an empty authority: web+morphit:///path
	let rest = decoded.slice(SCHEME.length);
	if (!rest.startsWith('//')) return null;
	rest = rest.slice(2);
	if (!rest.startsWith('/')) return null;

	// Split off hash, then query, leaving the pathname.
	let hash = '';
	const hi = rest.indexOf('#');
	if (hi >= 0) {
		hash = rest.slice(hi);
		rest = rest.slice(0, hi);
	}
	let search = '';
	const qi = rest.indexOf('?');
	if (qi >= 0) {
		search = rest.slice(qi);
		rest = rest.slice(0, qi);
	}
	const pathname = rest;

	// Defense-in-depth: the PATH must not carry a backslash (Windows-path
	// folding) or a leftover percent (double-encoding) — both would mean a
	// crafted payload, never a real intent.
	if (/[\\%]/.test(pathname)) return null;

	if (EXACT_PATHS.has(pathname)) return { pathname, search, hash };

	let m = /^\/post\/edit\/([^/]+)$/.exec(pathname);
	if (m && safeSeg(m[1]!, PERMLINK_RE)) return { pathname, search, hash };

	m = /^\/chat\/([^/]+)$/.exec(pathname);
	if (m && safeSeg(m[1]!, ACCOUNT_RE)) return { pathname, search, hash };

	m = /^\/@([^/]+)$/.exec(pathname);
	if (m && safeSeg(m[1]!, ACCOUNT_RE)) return { pathname, search, hash };

	return null;
}
