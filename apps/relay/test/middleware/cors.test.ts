/**
 * The relay's CORS allowlist: only a listed origin gets Access-Control-*
 * headers. A relay that reflected any Origin would let any website call the
 * signup and push endpoints from its visitors' browsers, and read the answers —
 * the allowlist is what keeps other sites out.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { corsAllowlist } from '../../src/middleware/cors.ts';

function app(): Hono {
	const a = new Hono();
	a.use('*', corsAllowlist(['https://morphit.example', 'http://abcdefghijklmnop.onion']));
	a.post('/v1/account/create', (c) => c.json({ ok: true }));
	return a;
}

const req = (origin: string | null, method = 'POST') =>
	app().request('/v1/account/create', {
		method,
		headers: origin === null ? {} : { origin }
	});

describe('relay CORS allowlist', () => {
	it('a listed origin gets exactly its own origin back', async () => {
		const r = await req('https://morphit.example');
		expect(r.headers.get('access-control-allow-origin')).toBe('https://morphit.example');
		expect(r.headers.get('vary')).toContain('Origin');
	});

	it.each([
		'https://evil.example',
		'https://morphit.example.evil.example',
		'null',
		'https://MORPHIT.example'
	])('an unlisted origin %s gets no CORS headers at all', async (origin) => {
		const r = await req(origin);
		expect(r.headers.get('access-control-allow-origin')).toBeNull();
		expect(r.headers.get('access-control-allow-methods')).toBeNull();
	});

	it('a preflight from an unlisted origin is answered without CORS headers', async () => {
		const r = await req('https://evil.example', 'OPTIONS');
		expect(r.status).toBe(204);
		expect(r.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('no Origin header, no CORS headers', async () => {
		const r = await req(null);
		expect(r.headers.get('access-control-allow-origin')).toBeNull();
	});
});
