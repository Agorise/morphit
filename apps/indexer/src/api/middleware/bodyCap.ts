/**
 * Morphit indexer — request body-size cap.
 *
 * Reject oversized bodies based on content-length before the
 * handler runs. This middleware is in the default chain so every
 * endpoint is defended by default — including the two that now
 * accept POSTs (`/v1/broadcast` and `/v1/federation/chat-fast`),
 * each of which is special-cased below because a read-sized cap
 * would 413 its legitimate traffic.
 *
 * Audit 2026-05 finding NEW-9-9 hardening: previously this check
 * was Content-Length-only, which a chunked-transfer request
 * could bypass. We now also reject any body-bearing method
 * (POST/PUT/PATCH) that arrives without a Content-Length header
 * — every legitimate client sets one for JSON payloads, and the
 * indexer should refuse to read an unbounded chunked stream
 * before it has any way to enforce a size cap. This is a
 * structural defense, not a precise byte cap; the POST endpoints
 * it now has should pair this with a streaming size-counting body
 * reader (the federationProbe fetchJson pattern from finding
 * NEW-9-11).
 */

import type { MiddlewareHandler } from 'hono';

const BODY_BEARING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export function bodyCap(
	defaultMax: number,
	broadcastMax?: number,
	federationMax?: number
): MiddlewareHandler {
	return async (c, next) => {
		// Two endpoints carry far more than a read query, and each gets its own
		// (larger) cap so the small read default doesn't 413 legitimate traffic:
		//
		//   /v1/broadcast   — an avatar (base64 image) + a signed, possibly
		//                     multi-op tx. (the maintainer/timeapp: a 4 KB default silently
		//                     rejected every avatar upload as 413.)
		//   /v1/federation  — a BATCH of signed chat transactions pushed by a peer
		//                     instance. Batching is what makes per-peer throughput
		//                     viable over a hidden transport, and on the read
		//                     default a batch of more than ONE maximum-length
		//                     message — or about three ordinary ones — was 413'd,
		//                     so the fast path worked while idle and shut itself
		//                     off under exactly the load it exists for.
		//
		// The federation prefix ends at a path SEPARATOR on purpose. Without it
		// `/v1/federational` would match, and — more to the point — the next route
		// mounted under that prefix would silently inherit a cap nobody chose for
		// it. A body limit should be something a route is given, not something it
		// catches.
		//
		// `/v1/broadcast` is matched as a bare prefix because it has no sub-routes
		// and predates this reasoning. If one is ever added, give it the same
		// treatment rather than assuming the cap is right for it.
		const path = c.req.path;
		const maxBytes =
			broadcastMax !== undefined && path.startsWith('/v1/broadcast')
				? broadcastMax
				: federationMax !== undefined && path.startsWith('/v1/federation/')
					? federationMax
					: defaultMax;
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
