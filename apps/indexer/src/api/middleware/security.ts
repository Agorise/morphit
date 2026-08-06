/**
 * Morphit indexer — security headers middleware.
 *
 * Posture identical to the relay (ADR-0006): we're a browser-facing
 * JSON API served over HTTPS via nginx. Headers applied to every
 * response, including error responses.
 */

import type { MiddlewareHandler } from 'hono';

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
	// is welcome to cache and fetch.
	c.header('cross-origin-resource-policy', 'cross-origin');
	// We never set cookies; an explicit Set-Cookie of nothing clarifies
	// that to caches.
	c.header('cache-control', c.res.headers.get('cache-control') ?? 'public, max-age=3');
};
