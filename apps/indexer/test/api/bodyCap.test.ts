/**
 * Tests for body-cap middleware.
 *
 * Coverage:
 *   - Valid Content-Length within budget passes through
 *   - Valid Content-Length over budget rejected with 413
 *   - Malformed Content-Length rejected with 400
 *
 * cp70-D1 regression: parseInt() silently accepts trailing garbage
 * ("999000abc" → 999000), which would let a hostile client smuggle
 * a misdeclared Content-Length past the cap.  The middleware now
 * uses strict /^\d+$/ validation BEFORE parsing.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bodyCap } from '$api/middleware/bodyCap';

function buildApp(maxBytes: number): Hono {
	const app = new Hono();
	app.use('*', bodyCap(maxBytes));
	app.post('/post', (c) => c.json({ ok: true }));
	app.get('/get', (c) => c.json({ ok: true }));
	return app;
}

describe('bodyCap middleware', () => {
	it('accepts a POST with Content-Length within budget', async () => {
		const app = buildApp(1_000_000);
		const res = await app.request('/post', {
			method: 'POST',
			headers: { 'content-length': '100' },
			body: '{"x":1}'
		});
		expect(res.status).toBe(200);
	});

	it('rejects a POST with Content-Length over budget', async () => {
		const app = buildApp(1_000);
		const res = await app.request('/post', {
			method: 'POST',
			headers: { 'content-length': '999999' },
			body: '{"x":1}'
		});
		expect(res.status).toBe(413);
	});

	// ─── cp70-D1 regression: trailing-garbage smuggling ───────────

	it('rejects Content-Length with trailing garbage ("999000abc")', async () => {
		const app = buildApp(1_000_000);
		const res = await app.request('/post', {
			method: 'POST',
			headers: { 'content-length': '999000abc' },
			body: '{"x":1}'
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe('bad_request');
	});

	it('rejects Content-Length with leading garbage ("abc100")', async () => {
		const app = buildApp(1_000_000);
		const res = await app.request('/post', {
			method: 'POST',
			headers: { 'content-length': 'abc100' },
			body: '{"x":1}'
		});
		expect(res.status).toBe(400);
	});

	it('rejects Content-Length with embedded whitespace ("1 23")', async () => {
		// parseInt("1 23") = 1 (silently strips trailing chars from
		// the first non-digit).  Pure /^\d+$/ rejects.  Note:
		// LEADING-only or TRAILING-only whitespace is normalized away
		// by Node's Headers implementation before our middleware
		// sees the header, so we can't easily test those values in
		// isolation, but embedded whitespace survives normalization.
		const app = buildApp(1_000_000);
		const res = await app.request('/post', {
			method: 'POST',
			headers: { 'content-length': '1 23' },
			body: '{"x":1}'
		});
		expect(res.status).toBe(400);
	});

	it('rejects Content-Length with a hex sentinel ("0xFF")', async () => {
		// parseInt("0xFF", 10) = 0 (silently parses just "0"), which
		// would have erroneously passed the bodyCap check before the
		// fix.  Now we require pure digits, so this is correctly
		// rejected as malformed.
		const app = buildApp(1_000_000);
		const res = await app.request('/post', {
			method: 'POST',
			headers: { 'content-length': '0xFF' },
			body: '{"x":1}'
		});
		expect(res.status).toBe(400);
	});

	it('rejects Content-Length with a sign ("+100" / "-100")', async () => {
		// parseInt accepts "+100" → 100 and "-100" → -100.  Our regex
		// rejects both, then the negative check would catch -100 even
		// if the regex didn't.  Defense-in-depth.
		const app = buildApp(1_000_000);
		const resPlus = await app.request('/post', {
			method: 'POST',
			headers: { 'content-length': '+100' },
			body: '{"x":1}'
		});
		expect(resPlus.status).toBe(400);
		const resMinus = await app.request('/post', {
			method: 'POST',
			headers: { 'content-length': '-100' },
			body: '{"x":1}'
		});
		expect(resMinus.status).toBe(400);
	});

	it('rejects Content-Length with scientific notation ("1e3")', async () => {
		// parseInt("1e3", 10) = 1 (silently parses just "1"), so a
		// hostile client could declare a tiny size and ship a
		// 1000-byte body.  /^\d+$/ rejects 'e'.
		const app = buildApp(1_000_000);
		const res = await app.request('/post', {
			method: 'POST',
			headers: { 'content-length': '1e3' },
			body: '{"x":1}'
		});
		expect(res.status).toBe(400);
	});

	it('accepts a body-bearing method without Content-Length and without Transfer-Encoding (HTTP/1.1 "no body")', async () => {
		const app = buildApp(1_000_000);
		const res = await app.request('/post', {
			method: 'POST'
		});
		expect(res.status).toBe(200);
	});

	it('rejects chunked transfer-encoding on body-bearing methods (411)', async () => {
		const app = buildApp(1_000_000);
		const res = await app.request('/post', {
			method: 'POST',
			headers: { 'transfer-encoding': 'chunked' }
		});
		expect(res.status).toBe(411);
	});

	it('passes GET through (no body-bearing check)', async () => {
		const app = buildApp(1_000);
		const res = await app.request('/get', { method: 'GET' });
		expect(res.status).toBe(200);
	});
});
