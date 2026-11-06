/**
 * Morphit indexer — /v1/witnesses (v1.23.0): the data behind the /witnesses
 * page ("Blurt Nodes").
 *
 *   GET /v1/witnesses                  the ranked list (indexer/witnessRanking.ts)
 *   GET /v1/witnesses/votes/:account   whom an account votes for, and its proxy
 *   GET /v1/witnesses/avatar/:witness  a witness's picture, fetched by THIS
 *                                      instance (indexer/witnessService.ts)
 *
 * Public, no auth. The browser never contacts a Blurt node or a picture host
 * itself: everything comes through its own instance, like every other read.
 */

import { Hono } from 'hono';

import { rateLimit } from '$api/middleware/ratelimit';
import { errorBody, isAccountName } from '$api/shared';
import type { WitnessService } from '$indexer/witnessService';

export function witnessesRoute(
	service: Pick<WitnessService, 'getList' | 'getVotes' | 'getAvatar'>,
	limits: { readonly listRatePerMin: number; readonly resourceRatePerMin: number }
): Hono {
	const app = new Hono();

	app.get('/', rateLimit('list', limits.listRatePerMin), async (c) => {
		try {
			const body = await service.getList();
			c.header('Cache-Control', 'public, max-age=30');
			return c.json(body);
		} catch {
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
		}
	});

	app.get('/votes/:account', rateLimit('list', limits.listRatePerMin), async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}
		let body;
		try {
			body = await service.getVotes(account);
		} catch {
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
		}
		if (body === null) return c.json(errorBody('not_found', 'no such account on chain'), 404);
		c.header('Cache-Control', 'no-store');
		return c.json(body);
	});

	// The parameter is `:witness`, not `:owner`: `owner` is in the security
	// middleware's ACCOUNT_ROUTE_PARAMS, which forces `no-store` (and its own
	// CSP) on any answer naming an account — a public picture is not one.
	app.get('/avatar/:witness', rateLimit('witness-avatar', limits.resourceRatePerMin), async (c) => {
		const owner = c.req.param('witness');
		if (!isAccountName(owner)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}
		let pic;
		try {
			pic = await service.getAvatar(owner);
		} catch {
			pic = null;
		}
		if (pic === null) return c.json(errorBody('not_found', 'no picture for this witness'), 404);
		return new Response(pic.bytes, {
			status: 200,
			headers: {
				'Content-Type': pic.type,
				'Content-Length': String(pic.bytes.byteLength),
				// The path carries a tag of the picture's URL (?v=), so a new URL is a
				// new path; the same URL is fetched again here once a day.
				'Cache-Control': 'public, max-age=3600',
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': "default-src 'none'; sandbox",
				'Content-Disposition': 'inline'
			}
		});
	});

	return app;
}
