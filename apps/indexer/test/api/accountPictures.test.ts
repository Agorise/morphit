/**
 * GET /v1/avatars/:who (v1.23.3) — an account's Blurt profile picture, fetched
 * by this instance; 404 when the account has a Morphit avatar (the page shows
 * that one, from the profile, sanitized in the browser) or no picture at all.
 *
 * Review: the stored Morphit SVG is never served from here — raw, it skips the
 * browser sanitizer's bounds (<use> nesting, filters, timing).
 */

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { accountPicturesRoute, hasMorphitAvatar } from '$api/accountPictures';
import { security } from '$api/middleware/security';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
const WEBP_URI = 'data:image/webp;base64,UklGRgEAAABXRUJQCQ==';
const BOMB =
	'<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><defs><g id="a"><use href="#b"/><use href="#b"/></g></defs><image href="https://tracker.example/p.png"/></svg>';

function app(
	profiles: Record<string, Record<string, unknown>>,
	blurt: Record<string, Uint8Array> = {}
) {
	const pictureOf = vi.fn(async (who: string) =>
		blurt[who] ? { bytes: blurt[who]!, type: 'image/png' as const, at: 0 } : null
	);
	const db = {
		query: async (_sql: string, params: unknown[]) => {
			const meta = profiles[params[0] as string];
			return { rows: meta ? [{ json_metadata: meta }] : [] };
		}
	};
	const a = new Hono();
	a.use('*', security);
	a.route(
		'/v1/avatars',
		accountPicturesRoute({ pictureOf }, db as never, { resourceRatePerMin: 1000 })
	);
	return { a, pictureOf };
}

describe('/v1/avatars/:who (v1.23.3)', () => {
	it('no Morphit avatar: the Blurt picture, a public picture cached a quarter hour', async () => {
		const { a } = app({ carol: { display_name: 'Carol' } }, { carol: PNG });
		const r = await a.request('/v1/avatars/carol');
		expect(r.status).toBe(200);
		expect(r.headers.get('content-type')).toBe('image/png');
		expect(r.headers.get('x-content-type-options')).toBe('nosniff');
		expect(r.headers.get('cache-control')).toBe('public, max-age=900');
		expect(r.headers.get('content-security-policy')).toMatch(/^default-src 'none'/);
		expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
	});

	it('a Morphit avatar (raster or SVG): 404 and no fetch — the page shows it from the profile', async () => {
		for (const meta of [{ avatar_data_uri: WEBP_URI }, { avatar_svg: BOMB }]) {
			const { a, pictureOf } = app({ alice: meta }, { alice: PNG });
			const r = await a.request('/v1/avatars/alice');
			expect(r.status).toBe(404);
			expect(await r.text()).not.toContain('<svg');
			expect(pictureOf).not.toHaveBeenCalled();
		}
	});

	it('neither: 404, cached like a picture so a page of labels does not ask again; a bad name: 400', async () => {
		const { a } = app({});
		const r = await a.request('/v1/avatars/dave');
		expect(r.status).toBe(404);
		expect(r.headers.get('cache-control')).toBe('public, max-age=900');
		expect((await a.request('/v1/avatars/..%2Fetc')).status).toBe(400);
	});

	it('hasMorphitAvatar: only a non-empty stored avatar counts', () => {
		expect(hasMorphitAvatar({ avatar_svg: BOMB })).toBe(true);
		expect(hasMorphitAvatar({ avatar_data_uri: WEBP_URI })).toBe(true);
		expect(hasMorphitAvatar({ avatar_svg: '', avatar_data_uri: '' })).toBe(false);
		expect(hasMorphitAvatar({ display_name: 'x' })).toBe(false);
		expect(hasMorphitAvatar(null)).toBe(false);
	});

	it('the database failing: no picture (never a Blurt picture that might stand in for a Morphit avatar)', async () => {
		const pictureOf = vi.fn(async () => ({ bytes: PNG, type: 'image/png' as const, at: 0 }));
		const a = new Hono();
		a.route(
			'/v1/avatars',
			accountPicturesRoute(
				{ pictureOf },
				{ query: async () => Promise.reject(new Error('db down')) } as never,
				{ resourceRatePerMin: 1000 }
			)
		);
		expect((await a.request('/v1/avatars/erin')).status).toBe(404);
		expect(pictureOf).not.toHaveBeenCalled();
	});

	it('the fetch failing: no picture, never an error page', async () => {
		const pictureOf = vi.fn(async () => Promise.reject(new Error('down')));
		const a = new Hono();
		a.route(
			'/v1/avatars',
			accountPicturesRoute({ pictureOf }, { query: async () => ({ rows: [] }) } as never, {
				resourceRatePerMin: 1000
			})
		);
		expect((await a.request('/v1/avatars/erin')).status).toBe(404);
	});
});
