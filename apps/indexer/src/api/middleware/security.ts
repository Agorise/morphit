/**
 * Morphit indexer — security headers middleware.
 *
 * Posture identical to the relay (ADR-0006): we're a browser-facing
 * JSON API served over HTTPS via nginx. Headers applied to every
 * response, including error responses.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

/** Path parameters that carry an account name in the /v1 routes. */
export const ACCOUNT_ROUTE_PARAMS: ReadonlySet<string> = new Set([
	'account',
	'a',
	'b',
	'me',
	'peer',
	'owner',
	'operator',
	'sender'
]);
/** Query parameters that carry account names. */
const ACCOUNT_QUERY_PARAMS = ['account', 'accounts'] as const;

/**
 * Does this request name an account — in the path of the route that handled
 * it, or as `?account=` / `?accounts=`? Such an answer is about one user: who
 * they talk to, what they read, their settings, folders, blocks, orders, or
 * whom they looked up.
 */
export function namesAnAccount(c: Context): boolean {
	for (const r of matchedRoutes(c)) {
		if (r.method === 'ALL') continue; // middleware
		for (const m of r.path.matchAll(/:([A-Za-z_]+)/g)) {
			if (ACCOUNT_ROUTE_PARAMS.has(m[1]!)) return true;
		}
	}
	return ACCOUNT_QUERY_PARAMS.some((q) => (c.req.query(q) ?? '') !== '');
}

export const security: MiddlewareHandler = async (c, next) => {
	await next();
	c.header('x-content-type-options', 'nosniff');
	c.header('referrer-policy', 'no-referrer');
	// The indexer emits only JSON. A strict frame-options prevents any
	// hostile embedding even though we serve no HTML.
	c.header('x-frame-options', 'DENY');
	// `default-src 'none'` is defense-in-depth: the indexer is JSON-
	// only, so any accidental HTML response (misconfigured error
	// page, bad reverse-proxy rule) can't load any external resource.
	c.header(
		'content-security-policy',
		"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
	);
	// Resource sharing policy: this API is public-read, every origin
	// is welcome to fetch.
	c.header('cross-origin-resource-policy', 'cross-origin');
	// VT3-6: an answer that names an account is never stored — not by the
	// browser's disk cache, where it outlived Sign out (URL and body), and not
	// by any shared cache. This overrides whatever the route set.
	if (c.req.path.startsWith('/v1/') && namesAnAccount(c)) {
		c.header('cache-control', 'no-store');
		return;
	}
	// Everything else is public chain-derived data: the route's own value, or
	// a few seconds.
	c.header('cache-control', c.res.headers.get('cache-control') ?? 'public, max-age=3');
};
