/**
 * GET /v1/witnesses, /v1/witnesses/votes/:account, /v1/witnesses/avatar/:owner
 * (v1.23.0) — the HTTP layer over a stubbed WitnessService.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { witnessesRoute } from '$api/witnesses';
import { security } from '$api/middleware/security';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

function app(over: Partial<Parameters<typeof witnessesRoute>[0]> = {}) {
	const service = {
		getList: async () => ({ network: 'morphit', witnesses: [] }) as never,
		getVotes: async (a: string) => ({ account: a, votes: ['khrom'], proxy: null, max_votes: 30 }),
		getAvatar: async (o: string) =>
			o === 'khrom' ? { bytes: PNG, type: 'image/png' as const } : null,
		...over
	};
	const a = new Hono();
	// The real security middleware, as main.ts mounts it on every route: it
	// rewrites cache and CSP headers on answers that name an account.
	a.use('*', security);
	a.route(
		'/v1/witnesses',
		witnessesRoute(service, { listRatePerMin: 1000, resourceRatePerMin: 1000 })
	);
	return a;
}

describe('/v1/witnesses', () => {
	it('serves the list; 502 when the chain cannot be read', async () => {
		const ok = await app().request('/v1/witnesses');
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { network: string }).network).toBe('morphit');
		const bad = await app({ getList: async () => Promise.reject(new Error('down')) }).request(
			'/v1/witnesses'
		);
		expect(bad.status).toBe(502);
	});

	it('votes: 400 on a bad name, 404 for no such account, never cached', async () => {
		expect((await app().request('/v1/witnesses/votes/NOT%20A%20NAME')).status).toBe(400);
		expect(
			(await app({ getVotes: async () => null }).request('/v1/witnesses/votes/nobody')).status
		).toBe(404);
		const r = await app().request('/v1/witnesses/votes/kencode');
		expect(r.status).toBe(200);
		expect(r.headers.get('cache-control')).toBe('no-store');
		expect(((await r.json()) as { votes: string[] }).votes).toEqual(['khrom']);
	});

	it('pictures: the sniffed type, nosniff, cached an hour, a default-src none CSP; 404 when there is none', async () => {
		const r = await app().request('/v1/witnesses/avatar/khrom?v=abc');
		expect(r.status).toBe(200);
		expect(r.headers.get('content-type')).toBe('image/png');
		expect(r.headers.get('x-content-type-options')).toBe('nosniff');
		// A public picture: cached by the browser (the `?v=` tag changes with the
		// URL), not forced to no-store as an account's answer would be.
		expect(r.headers.get('cache-control')).toBe('public, max-age=3600');
		expect(r.headers.get('content-security-policy')).toMatch(/^default-src 'none'/);
		expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
		expect((await app().request('/v1/witnesses/avatar/saboin')).status).toBe(404);
		expect((await app().request('/v1/witnesses/avatar/..%2Fetc')).status).toBe(400);
		const threw = await app({ getAvatar: async () => Promise.reject(new Error('x')) }).request(
			'/v1/witnesses/avatar/khrom'
		);
		expect(threw.status).toBe(404);
	});
});
