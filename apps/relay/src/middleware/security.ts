/**
 * Defensive HTTP middleware for the relay.
 *
 * Neither of these depends on Blurt — both are stock web-security
 * patterns. The relay also has an nginx vhost in front that sets
 * similar headers; we keep these as defence-in-depth for the case
 * where someone runs the relay without nginx (dev, or a small
 * community mirror).
 */

import type { MiddlewareHandler } from 'hono';

/**
 * Reject requests with bodies larger than `limit` bytes. Checked via
 * Content-Length header before any body is read, so oversized payloads
 * don't consume memory.
 *
 * Audit 2026-05 hardening (mirrors indexer bodyCap NEW-9-9): for
 * body-bearing methods (POST/PUT/PATCH), if the client uses
 * Transfer-Encoding: chunked instead of Content-Length, we reject
 * outright with 411. Without this gate, a chunked-encoded body has
 * no upstream byte cap. Hono's per-handler size enforcement is the
 * residual defense for chunked-but-no-encoding-header requests.
 */
const BODY_BEARING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export function maxBodyBytes(limit: number): MiddlewareHandler {
	return async (c, next) => {
		const method = c.req.method.toUpperCase();
		const isBodyBearing = BODY_BEARING_METHODS.has(method);
		const lenHeader = c.req.header('content-length');

		if (lenHeader) {
			const n = Number(lenHeader);
			if (!Number.isFinite(n) || n < 0) {
				return c.json({ status: 'bad_request', code: 'malformed_request' }, 400);
			}
			if (n > limit) {
				return c.json({ status: 'request_too_large' }, 413);
			}
		} else if (isBodyBearing) {
			const transferEncoding = c.req.header('transfer-encoding');
			if (transferEncoding !== undefined) {
				return c.json(
					{
						status: 'bad_request',
						code: 'chunked_unsupported',
						message: 'Chunked transfer-encoding is not supported; set Content-Length.'
					},
					411
				);
			}
		}
		await next();
	};
}

/**
 * Baseline response security headers. These are belt-and-braces
 * alongside nginx (which sets them too) — belts and braces are how
 * you keep your pants up when one breaks.
 */
export function securityHeaders(): MiddlewareHandler {
	return async (c, next) => {
		await next();
		c.header('X-Content-Type-Options', 'nosniff');
		c.header('Referrer-Policy', 'no-referrer');
		c.header('X-Frame-Options', 'DENY');
		c.header('Permissions-Policy', 'interest-cohort=()');
		// The relay is JSON-only — `default-src 'none'` makes sure
		// any accidental HTML response (e.g. a misconfigured error
		// page) can't load anything at all.
		c.header(
			'Content-Security-Policy',
			"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
		);
	};
}
