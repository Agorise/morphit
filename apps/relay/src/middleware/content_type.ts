/**
 * Content-Type enforcement middleware.
 *
 * CORS treats `application/json` as a non-simple request, triggering
 * a preflight OPTIONS check. `text/plain` + JSON body would be a
 * "simple request" that bypasses preflight, which means a malicious
 * third-party page could submit a POST with a JSON body without our
 * CORS allowlist having a say.
 *
 * Requiring `application/json` on state-changing endpoints closes
 * that gap — browsers send preflight, the allowlist kicks in, and
 * unknown origins are rejected before the actual POST happens.
 */

import type { MiddlewareHandler } from 'hono';

export function requireJsonContentType(): MiddlewareHandler {
	return async (c, next) => {
		if (c.req.method === 'POST' || c.req.method === 'PUT') {
			const ct = c.req.header('content-type');
			if (!ct || !ct.toLowerCase().includes('application/json')) {
				return c.json(
					{
						status: 'rejected',
						code: 'malformed_request',
						message: 'Content-Type must be application/json for this endpoint.'
					},
					415
				);
			}
		}
		await next();
	};
}
