/**
 * Morphit indexer — CORS middleware.
 *
 * Read-only API — allows GET + OPTIONS from configured origins.
 * No credentials (no cookies, no auth), so Access-Control-Allow-
 * Credentials is not set and the frontend can reuse the default
 * fetch mode.
 */

import type { MiddlewareHandler } from 'hono';

export function cors(allowedOrigins: readonly string[]): MiddlewareHandler {
	const allowSet = new Set(allowedOrigins);

	return async (c, next) => {
		const origin = c.req.header('origin');
		const allowed = origin && allowSet.has(origin);

		if (allowed && origin) {
			c.header('access-control-allow-origin', origin);
			c.header('vary', 'Origin');
		}
		c.header('access-control-allow-methods', 'GET, OPTIONS');
		c.header('access-control-allow-headers', 'content-type');
		c.header('access-control-max-age', '600');

		if (c.req.method === 'OPTIONS') {
			// Preflight — respond 204 immediately without routing.
			return new Response(null, {
				status: 204,
				headers: c.res.headers
			});
		}

		await next();
	};
}
