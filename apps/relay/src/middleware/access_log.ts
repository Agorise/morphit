/**
 * Per-request access logging middleware for the relay.
 *
 * Why this exists: incident triage during paid beta testing
 * needs a single grep-friendly line per request, so an operator
 * who hears "the site doesn't work" from a tester can answer
 * "did your request even reach the relay" in under a second by
 * grepping journalctl for the time window.
 *
 * What it logs (per request):
 *   - method  (POST, GET)
 *   - path    (the URL path; query strings stripped)
 *   - status  (the HTTP status code)
 *   - dur_ms  (handler duration in milliseconds)
 *   - code    (the response body's `code` field if the body is
 *             a JSON object with one — e.g., 'rate_limited',
 *             'invalid_pubkey', 'broadcast'.  Lets the operator
 *             distinguish "504 from chain timeout" vs
 *             "503 from kill switch" without reading the body.)
 *
 * What it deliberately does NOT log:
 *   - IP addresses (privacy commitment in PHASE-3a-DESIGN.md)
 *   - request bodies (they contain pubkeys + invite tokens)
 *   - response bodies in full (they may contain trx_id which
 *     pairs with the on-chain account name)
 *   - User-Agent strings (fingerprint surface; not actionable
 *     for triage)
 *
 * Format: standard structured log via `logger('access')`, so
 * an operator's existing logging pipeline (journalctl text or
 * jsonSink) renders it consistently.
 *
 * Performance: ~10µs overhead per request — a Date.now() pair
 * + a JSON parse of the response body (when the response is
 * JSON; otherwise skipped).  Negligible compared to the
 * handler's own work.
 */

import type { MiddlewareHandler } from 'hono';

import { logger } from '$log';

const log = logger('access');

export function accessLog(): MiddlewareHandler {
	return async (c, next) => {
		const startedAt = Date.now();
		await next();
		const durMs = Date.now() - startedAt;

		// Try to extract the response body's `code` field for
		// triage hints.  Hono caches the response body on the
		// context after the handler returns; we read it
		// non-destructively.
		let code: string | undefined;
		try {
			const respClone = c.res.clone();
			const text = await respClone.text();
			// Cheap shape check before parsing — most responses
			// either start with `{` (JSON) or aren't.
			if (text.length > 0 && text.length < 4096 && text.startsWith('{')) {
				const parsed = JSON.parse(text) as { code?: unknown; status?: unknown };
				if (typeof parsed.code === 'string') {
					code = parsed.code;
				} else if (typeof parsed.status === 'string') {
					// Health endpoint uses `status: 'ok'` / 'rejected'
					// instead of a `code` field.  Fall back.
					code = parsed.status;
				}
			}
		} catch {
			// Non-JSON response, malformed JSON, or stream-read
			// failure.  Skip the code field; the path + status are
			// still useful.
		}

		const path = c.req.path;
		const ctx: Record<string, unknown> = {
			method: c.req.method,
			path,
			status: c.res.status,
			dur_ms: durMs
		};
		if (code !== undefined) ctx.code = code;

		// Use info level for 2xx and 3xx; warn for 4xx; error for
		// 5xx.  Operators grepping for problems can filter by level.
		if (c.res.status >= 500) {
			log.error('request', ctx);
		} else if (c.res.status >= 400) {
			log.warn('request', ctx);
		} else {
			log.info('request', ctx);
		}
	};
}
