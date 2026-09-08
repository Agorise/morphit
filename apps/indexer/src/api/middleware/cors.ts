/**
 * Morphit indexer — CORS middleware.
 *
 * Read-only API — allows GET + OPTIONS from ANY origin. The orderbook and other
 * /v1 reads are PUBLIC data with NO credentials (no cookies, no auth), so
 * `Access-Control-Allow-Origin: *` is safe — and it's REQUIRED for the
 * cross-instance features (the /compare orderbook diff fetches a *peer's*
 * /v1/orders from the browser; a per-instance allowlist could never scale to the
 * whole federation, which is why compare failed with a CORS NetworkError). We
 * never set Access-Control-Allow-Credentials, so `*` can't leak anything.
 *
 * `allowedOrigins` is kept for callers/tests but no longer gates the header —
 * a public read API has nothing to gate.
 */

import type { MiddlewareHandler } from 'hono';

export function cors(_allowedOrigins: readonly string[] = []): MiddlewareHandler {
	return async (c, next) => {
		c.header('access-control-allow-origin', '*');
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
