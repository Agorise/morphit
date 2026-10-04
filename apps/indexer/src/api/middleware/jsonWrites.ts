/**
 * Morphit indexer — every write is `application/json`.
 *
 * A POST (or PUT/PATCH/DELETE) whose Content-Type is not `application/json`
 * is answered 415 before any route sees it. Browsers send `text/plain`,
 * form-encoded and bodyless POSTs cross-origin WITHOUT a preflight, so
 * without this a page on any website could drive the write endpoints from
 * its visitors' browsers (see cors.ts). Every Morphit client — the frontend,
 * peer instances, morphit-ops — already sends JSON.
 */

import type { MiddlewareHandler } from 'hono';

const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function jsonWrites(): MiddlewareHandler {
	return async (c, next) => {
		if (WRITE_METHODS.has(c.req.method)) {
			const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
			if (type !== 'application/json') {
				return c.json(
					{
						status: 'error',
						code: 'unsupported_media_type',
						message: 'Requests that change anything must be sent as application/json.'
					},
					415
				);
			}
		}
		await next();
	};
}
