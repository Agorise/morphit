/**
 * CORS middleware — exact-match origin allowlist.
 *
 * An unknown Origin gets no Access-Control-* headers on the response,
 * which means the browser blocks the fetch. This is intentional: the
 * list is what we've decided to trust, and anything outside should
 * NOT get a polite rejection header — it should get nothing.
 *
 * OPTIONS preflight is handled here so handlers never see it.
 */

import type { MiddlewareHandler } from 'hono';

export function corsAllowlist(origins: readonly string[]): MiddlewareHandler {
	const allowed = new Set(origins);

	return async (c, next) => {
		const origin = c.req.header('origin');
		const isPreflight = c.req.method === 'OPTIONS';

		if (origin && allowed.has(origin)) {
			c.header('Access-Control-Allow-Origin', origin);
			c.header('Vary', 'Origin');
			c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			c.header('Access-Control-Allow-Headers', 'Content-Type');
			c.header('Access-Control-Max-Age', '600');
		}

		if (isPreflight) {
			return c.body(null, 204);
		}
		await next();
	};
}
