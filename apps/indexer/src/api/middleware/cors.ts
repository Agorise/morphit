/**
 * Morphit indexer — CORS middleware.
 *
 * A public READ API: `Access-Control-Allow-Origin: *` on GET, HEAD and the
 * OPTIONS preflight, and never `Access-Control-Allow-Credentials` (there are
 * no cookies or auth to send). The reads are public data, and `*` is required
 * for the cross-instance features: the /compare orderbook diff fetches a
 * PEER's /v1/orders from the browser, and a per-instance allowlist could never
 * cover the whole federation.
 *
 * Writes are NOT cross-origin. /v1/broadcast, /v1/chain (condenser, key
 * references), /v1/pairing/forward, login-pairing delivery, order views, fee
 * checks and the federation push are called same-origin (the instance's own
 * frontend) or server-to-server (peers), neither of which needs CORS. So a
 * write's response carries no Allow-Origin header — a page on another origin
 * cannot read it — and every write must be `application/json`
 * (middleware/jsonWrites.ts), which a cross-origin page can only send after a
 * preflight this middleware does not grant for POST. Without both, a
 * `text/plain` or bodyless POST needs no preflight, and any website could use
 * its visitors' browsers as clients of the write endpoints.
 */

import type { MiddlewareHandler } from 'hono';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function cors(): MiddlewareHandler {
	return async (c, next) => {
		if (!READ_METHODS.has(c.req.method)) {
			await next();
			return;
		}
		c.header('access-control-allow-origin', '*');
		c.header('access-control-allow-methods', 'GET, HEAD, OPTIONS');
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
