/**
 * Morphit indexer — request body-size cap.
 *
 * The indexer is read-only (no POST endpoints in Phase 3b), but
 * this middleware is in the default chain to defend future
 * endpoints by default. Reject oversized bodies based on
 * content-length before the handler runs.
 *
 * Audit 2026-05 finding NEW-9-9 hardening: previously this check
 * was Content-Length-only, which a chunked-transfer request
 * could bypass. We now also reject any body-bearing method
 * (POST/PUT/PATCH) that arrives without a Content-Length header
 * — every legitimate client sets one for JSON payloads, and the
 * indexer should refuse to read an unbounded chunked stream
 * before it has any way to enforce a size cap. This is a
 * structural defense, not a precise byte cap; once the indexer
 * grows POST endpoints, those handlers should pair this with a
 * streaming size-counting body reader (the federationProbe
 * fetchJson pattern from finding NEW-9-11).
 */

import type { MiddlewareHandler } from 'hono';

const BODY_BEARING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export function bodyCap(maxBytes: number): MiddlewareHandler {
	return async (c, next) => {
		const method = c.req.method.toUpperCase();
		const isBodyBearing = BODY_BEARING_METHODS.has(method);
		const lengthHeader = c.req.header('content-length');

		if (lengthHeader) {
			// Strict numeric parse: parseInt() silently accepts trailing
			// garbage ("999000abc" → 999000), which could let a hostile
			// client smuggle a misdeclared Content-Length past the cap.
			// Require pure-digits before parsing.  Empty string and
			// whitespace are also rejected.
			if (!/^\d+$/.test(lengthHeader)) {
				return c.json(
					{
						status: 'error',
						code: 'bad_request',
						message: 'Malformed Content-Length header'
					},
					400
				);
			}
			const length = Number(lengthHeader);
			if (!Number.isFinite(length) || length < 0) {
				return c.json(
					{
						status: 'error',
						code: 'bad_request',
						message: 'Malformed Content-Length header'
					},
					400
				);
			}
			if (length > maxBytes) {
				return c.json(
					{
						status: 'error',
						code: 'bad_request',
						message: `Request body too large (max ${maxBytes} bytes)`
					},
					413
				);
			}
		} else if (isBodyBearing) {
			// Body-bearing method without Content-Length means either
			// chunked transfer-encoding or a malformed client. We
			// can't enforce a byte cap without reading the stream, so
			// we refuse outright. Legitimate JSON clients always set
			// Content-Length.
			const transferEncoding = c.req.header('transfer-encoding');
			if (transferEncoding !== undefined) {
				return c.json(
					{
						status: 'error',
						code: 'bad_request',
						message:
							'Chunked transfer-encoding is not supported on this endpoint; set Content-Length.'
					},
					411
				);
			}
			// No Content-Length AND no Transfer-Encoding on a
			// body-bearing method: technically allowed by HTTP/1.1
			// (means "no body"), so we let it pass — the handler's
			// JSON parse will reject empty bodies on its own.
		}
		await next();
	};
}
