/**
 * Tests for enforceOriginAllowlist middleware.
 *
 * Scope: server-side Origin rejection on fund-spending
 * endpoints. Verifies the 403 behavior independently of the
 * downstream handler so regressions in this middleware don't
 * hide behind handler-layer noise.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { enforceOriginAllowlist } from '../src/middleware/origin_enforcement.ts';

/** Small harness: build an app with the middleware and a
 *  passthrough POST handler that returns 200 `{ passed: true }`.
 *  If the response is anything other than 200 the middleware
 *  rejected. */
function buildApp(allowed: readonly string[]): Hono {
	const app = new Hono();
	app.use('/v1/account/create', enforceOriginAllowlist(allowed));
	app.post('/v1/account/create', (c) => c.json({ passed: true }));
	app.options('/v1/account/create', (c) => c.body(null, 204));
	return app;
}

async function post(app: Hono, opts: { origin?: string | null } = {}): Promise<Response> {
	const headers: Record<string, string> = {
		'content-type': 'application/json'
	};
	if (opts.origin !== null && opts.origin !== undefined) {
		headers['origin'] = opts.origin;
	}
	return app.fetch(
		new Request('http://localhost/v1/account/create', {
			method: 'POST',
			headers,
			body: '{}'
		})
	);
}

describe('enforceOriginAllowlist', () => {
	it('allows request with Origin in allowlist', async () => {
		const app = buildApp(['https://morphit.example.com']);
		const res = await post(app, { origin: 'https://morphit.example.com' });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ passed: true });
	});

	it('rejects request with Origin not in allowlist (403 origin_not_allowed)', async () => {
		const app = buildApp(['https://morphit.example.com']);
		const res = await post(app, { origin: 'https://attacker.example.org' });
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe('origin_not_allowed');
	});

	it('rejects request with no Origin header (403 origin_required)', async () => {
		const app = buildApp(['https://morphit.example.com']);
		const res = await post(app, { origin: null });
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe('origin_required');
	});

	it('rejects with empty allowlist no matter the Origin', async () => {
		const app = buildApp([]);
		// Even a plausible-looking origin is rejected because the
		// allowlist is empty.
		const res = await post(app, { origin: 'https://morphit.example.com' });
		expect(res.status).toBe(403);
	});

	it('matches origin exactly — scheme + host + port all must match', async () => {
		const app = buildApp(['https://morphit.example.com']);

		// Different scheme → rejected
		const r1 = await post(app, { origin: 'http://morphit.example.com' });
		expect(r1.status).toBe(403);

		// Subdomain → rejected (no wildcard support)
		const r2 = await post(app, { origin: 'https://sub.morphit.example.com' });
		expect(r2.status).toBe(403);

		// Explicit port → rejected (different origin)
		const r3 = await post(app, { origin: 'https://morphit.example.com:8443' });
		expect(r3.status).toBe(403);

		// Exact match → allowed
		const r4 = await post(app, { origin: 'https://morphit.example.com' });
		expect(r4.status).toBe(200);
	});

	it('allows any of multiple allowed origins', async () => {
		const app = buildApp([
			'https://morphit.example.com',
			'https://mirror.example.org',
			'http://localhost:5173'
		]);
		for (const origin of [
			'https://morphit.example.com',
			'https://mirror.example.org',
			'http://localhost:5173'
		]) {
			const res = await post(app, { origin });
			expect(res.status, `origin=${origin}`).toBe(200);
		}
	});

	it('lets OPTIONS preflight through untouched', async () => {
		const app = buildApp(['https://morphit.example.com']);
		// OPTIONS with no Origin — middleware should not gate it
		// so the CORS layer upstream can do its preflight handling.
		const res = await app.fetch(
			new Request('http://localhost/v1/account/create', { method: 'OPTIONS' })
		);
		expect(res.status).toBe(204);
	});
});
