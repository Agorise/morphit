/**
 * Origin-enforcement middleware for fund-spending endpoints.
 *
 * Rationale: the existing `corsAllowlist` middleware is a
 * browser-side defense. It withholds `Access-Control-Allow-*`
 * headers from non-allowed origins, which causes browsers to
 * block the fetch — but only browsers. A `curl` invocation or
 * a non-browser client (custom-built signup bot, Postman, a
 * Node.js server-side fetch) ignores CORS entirely and can POST
 * to `/v1/account/create` regardless of origin. Without this
 * middleware, ANY internet-connected client can trigger an
 * account creation and drain relay funds.
 *
 * This middleware enforces the same allowlist server-side with
 * a 403 rejection, independent of browser CORS handling.
 *
 * Scope: apply ONLY to endpoints that spend funds
 * (`/v1/account/create`). Read-only endpoints like
 * `/v1/account/availability` and `/v1/health` stay permissive
 * so operators debugging from `curl` or other frontends
 * consulting availability aren't blocked.
 *
 * Policy decisions:
 *   1. Origin present + not allowed → 403.
 *      This is the primary case: a hostile or misconfigured
 *      frontend at frontend-B.example.com sending signup
 *      requests to this relay.
 *   2. Origin missing → 403.
 *      Modern browsers ALWAYS send Origin on same-origin or
 *      cross-origin POSTs. (Same-origin GETs omit Origin, but
 *      this endpoint is POST-only.) Missing Origin on a POST
 *      means either (a) non-browser client (curl, bot), (b)
 *      ancient browser we shouldn't accommodate for a fund-
 *      spending endpoint, or (c) a privacy extension stripping
 *      headers — in which case the user's frontend can't
 *      function anyway and rejecting is the safe call.
 *   3. Origin present + allowed → proceed.
 *
 * Observability: rejections are logged, but deduplicated per
 * (code, origin) within a 5-minute window so a sustained curl
 * storm doesn't flood journalctl. Disallowed-origin rejections
 * include the configured allowlist in the log payload so an
 * operator debugging "I set up my instance and signups fail"
 * can grep one line and see the exact fix needed.
 *
 * NOTE: Origin can still be forged by non-browser clients. This
 * middleware is NOT a bulletproof anti-DoS defense — it's a
 * reasonable guard against the "someone else's frontend
 * accidentally bills my relay" class of problem, plus it raises
 * the friction on intentional abuse. A stronger defense would
 * require a shared-secret token between frontend and relay;
 * that's a larger design change tracked separately.
 */

import type { MiddlewareHandler } from 'hono';

import { logger } from '$log';

const log = logger('relay-origin');

/** How often to re-emit a log line for the same (code, origin)
 *  pair. Five minutes is short enough that the operator sees a
 *  signal during live debugging, long enough that a sustained
 *  attack doesn't spam at scan-line rate. */
const LOG_DEDUP_WINDOW_MS = 5 * 60_000;

export function enforceOriginAllowlist(origins: readonly string[]): MiddlewareHandler {
	const allowed = new Set(origins);
	const allowedList = [...allowed]; // frozen copy for log payloads

	/** Dedup map: `${code}|${origin}` → expiry millis. Pruned
	 *  lazily on each rejection. Memory is bounded by the number
	 *  of distinct origins hitting this server in a 5-minute
	 *  window; in practice small enough to ignore. */
	const loggedRecently = new Map<string, number>();

	function shouldLog(code: string, origin: string): boolean {
		const now = Date.now();
		// Prune expired entries (cheap; avoids unbounded growth
		// under sustained distinct-origin attack).
		for (const [k, v] of loggedRecently) {
			if (v <= now) loggedRecently.delete(k);
		}
		const key = `${code}|${origin}`;
		const existing = loggedRecently.get(key);
		if (existing !== undefined && existing > now) return false;
		loggedRecently.set(key, now + LOG_DEDUP_WINDOW_MS);
		return true;
	}

	return async (c, next) => {
		// Preflight OPTIONS should already be handled by the CORS
		// middleware upstream (it short-circuits with 204). If one
		// slips through, let it proceed — this middleware only
		// gates the real request, not the preflight.
		if (c.req.method === 'OPTIONS') {
			await next();
			return;
		}

		const origin = c.req.header('origin');
		if (!origin) {
			if (shouldLog('origin_required', '')) {
				// Info level: missing-origin is almost always a non-
				// browser client (curl, bot). Not operator-
				// actionable by itself unless paired with a
				// legitimate-user complaint.
				log.info('rejected_missing_origin', {
					path: c.req.path
				});
			}
			return c.json(
				{
					status: 'rejected',
					code: 'origin_required',
					message: 'This endpoint requires an Origin header set to an operator-configured frontend.'
				},
				403
			);
		}
		if (!allowed.has(origin)) {
			if (shouldLog('origin_not_allowed', origin)) {
				// Warn level: this is the signal an operator looking
				// for "why can't my users sign up?" will grep. We
				// include the configured allowlist so the fix is
				// visible in one log line.
				log.warn('rejected_disallowed_origin', {
					origin,
					allowed_origins: allowedList,
					path: c.req.path,
					hint: 'If this origin is your own frontend, add it to MORPHIT_RELAY_ALLOWED_ORIGINS.'
				});
			}
			return c.json(
				{
					status: 'rejected',
					code: 'origin_not_allowed',
					message:
						'This relay only accepts account-creation requests from operator-configured frontends.'
				},
				403
			);
		}
		await next();
	};
}
