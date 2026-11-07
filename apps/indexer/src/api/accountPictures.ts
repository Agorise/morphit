/**
 * Morphit indexer — /v1/avatars/:who (v1.23.3): an account's Blurt profile
 * picture, for the pages of a visitor who turned pictures on.
 *
 * Owner, 2026-11-06: an account's Blurt profile picture should show across the
 * site, and "if that user logs in and sets a custom avatar on their settings
 * page, then i want their custom avatar to show everywhere on the site
 * instead, including the witnesses page, federation-wide." So:
 *
 *   - an account with a MORPHIT avatar gets 404 here: the page shows that
 *     avatar from the account's profile (/v1/profiles), which every page that
 *     shows the account reads — re-sanitized there, in the browser. Never
 *     served from here (review, v1.23.3: the stored SVG is raw; the browser's
 *     sanitizer bounds its <use> nesting, filters and timing, and an SVG it
 *     refuses must not come back unsanitized through this door);
 *   - else its BLURT profile picture, fetched by this instance
 *     (indexer/accountPictures.ts; a PNG, JPEG, GIF or WebP by its bytes; never
 *     on a hidden-only instance);
 *   - else 404, and the page draws the identicon.
 *
 * A page asks only when the visitor turned Blurt pictures on (off until then:
 * the Blurt Nodes page's "display", or Settings), and only once it knows the
 * account has no Morphit avatar.
 *
 * Public, no auth; a public picture, so the parameter is `:who` — not one of
 * the security middleware's ACCOUNT_ROUTE_PARAMS, which force `no-store` on an
 * answer about one user's private matters. The middleware's own CSP
 * (`default-src 'none'`) applies to it like to every answer.
 */

import { Hono } from 'hono';

import { rateLimit } from '$api/middleware/ratelimit';
import { errorBody, isAccountName } from '$api/shared';
import type { Database } from '$db/pool';
import type { AccountPictures } from '$indexer/accountPictures';
import { sanitizeStoredProfileMetadata } from '$indexer/handlers/profile';

/** Whether a stored profile's json_metadata sets a Morphit avatar (one the
 *  profile endpoint would serve). PURE. */
export function hasMorphitAvatar(meta: unknown): boolean {
	const m = sanitizeStoredProfileMetadata(meta);
	for (const k of ['avatar_svg', 'avatar_data_uri'] as const) {
		const v = m[k];
		if (typeof v === 'string' && v.trim().length > 0) return true;
	}
	return false;
}

/** How long a browser keeps an answer (a picture, or "none" — so a page of
 *  labels does not ask again for each). */
const PICTURE_MAX_AGE_S = 900;

export function accountPicturesRoute(
	pictures: Pick<AccountPictures, 'pictureOf'>,
	db: Pick<Database, 'query'>,
	limits: { readonly resourceRatePerMin: number }
): Hono {
	const app = new Hono();

	app.get('/:who', rateLimit('account-avatar', limits.resourceRatePerMin), async (c) => {
		const who = c.req.param('who');
		if (!isAccountName(who)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}
		const none = () => {
			c.header('Cache-Control', `public, max-age=${PICTURE_MAX_AGE_S}`);
			return c.json(errorBody('not_found', 'no picture for this account'), 404);
		};
		try {
			const r = await db.query<{ json_metadata: unknown }>(
				'SELECT json_metadata FROM profiles WHERE account = $1',
				[who]
			);
			// A Morphit avatar wins: the page shows it from the profile.
			if (hasMorphitAvatar(r.rows[0]?.json_metadata)) return none();
		} catch {
			// Not known now: answer nothing rather than a Blurt picture that might
			// stand in for a Morphit avatar.
			return none();
		}
		let pic;
		try {
			pic = await pictures.pictureOf(who);
		} catch {
			pic = null;
		}
		if (pic === null) return none();
		return new Response(pic.bytes, {
			status: 200,
			headers: {
				'Content-Type': pic.type,
				'Content-Length': String(pic.bytes.byteLength),
				// A changed Blurt picture shows within PICTURE_MAX_AGE_S; a Morphit
				// avatar set meanwhile shows at once (the page reads the profile).
				'Cache-Control': `public, max-age=${PICTURE_MAX_AGE_S}`,
				'X-Content-Type-Options': 'nosniff',
				'Content-Disposition': 'inline'
			}
		});
	});

	return app;
}
