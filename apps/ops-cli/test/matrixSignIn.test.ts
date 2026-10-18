/**
 * Signing in to a Matrix account for the site (offline-notify wizard): the
 * address the homeserver names in /.well-known is used when the one typed is
 * not a client API; a refusal says why, in the homeserver's words; the
 * account question is answered only from what the homeserver says.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	matrixAccountCheck,
	matrixClientBase,
	matrixSignIn,
	mintMatrixToken
} from '../src/lib/matrixBot.ts';

type Route = (url: string, init?: RequestInit) => { status: number; body?: unknown } | 'down';

/** A fetch that answers from `route`, and remembers every URL asked. */
function fakeFetch(route: Route): { f: typeof fetch; asked: string[]; bodies: unknown[] } {
	const asked: string[] = [];
	const bodies: unknown[] = [];
	const f = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		asked.push(url);
		if (init?.body) bodies.push(JSON.parse(String(init.body)));
		const r = route(url, init);
		if (r === 'down') throw new TypeError('fetch failed: ECONNREFUSED');
		return new Response(r.body === undefined ? 'not json' : JSON.stringify(r.body), {
			status: r.status
		});
	}) as typeof fetch;
	return { f, asked, bodies };
}

const VERSIONS = { status: 200, body: { versions: ['v1.11'] } };

describe('matrixClientBase', () => {
	it('keeps the address typed when it is a client API (no /.well-known asked)', async () => {
		const { f, asked } = fakeFetch((u) =>
			u.endsWith('/_matrix/client/versions') ? VERSIONS : { status: 404 }
		);
		expect(await matrixClientBase('https://matrix.org/', f)).toBe('https://matrix.org');
		expect(asked).toEqual(['https://matrix.org/_matrix/client/versions']);
	});

	it('uses the https:// address /.well-known names when the typed one is not a client API', async () => {
		const { f } = fakeFetch((u) => {
			if (u === 'https://example.org/.well-known/matrix/client')
				return {
					status: 200,
					body: { 'm.homeserver': { base_url: 'https://matrix-client.example.org/' } }
				};
			if (u === 'https://matrix-client.example.org/_matrix/client/versions') return VERSIONS;
			return { status: 404 };
		});
		expect(await matrixClientBase('https://example.org', f)).toBe(
			'https://matrix-client.example.org'
		);
	});

	it('never moves to an http:// address, nor to one that is not a client API either', async () => {
		// The named address would answer as a client API: only its scheme stops it.
		const named = (base: string) =>
			fakeFetch((u) => {
				if (u.endsWith('/.well-known/matrix/client'))
					return { status: 200, body: { 'm.homeserver': { base_url: base } } };
				if (u.startsWith('http://evil.example/')) return VERSIONS;
				return { status: 404 };
			}).f;
		expect(await matrixClientBase('https://example.org', named('http://evil.example'))).toBe(
			'https://example.org'
		);
		expect(await matrixClientBase('https://example.org', named('https://dead.example'))).toBe(
			'https://example.org'
		);
		expect(await matrixClientBase('https://example.org', named('not a url'))).toBe(
			'https://example.org'
		);
	});
});

describe('matrixAccountCheck', () => {
	const answer = (r: { status: number; body?: unknown } | 'down') => fakeFetch(() => r).f;
	it('"missing" only when the homeserver says the name is free', async () => {
		expect(
			await matrixAccountCheck(
				'https://m.org',
				'x',
				answer({ status: 200, body: { available: true } })
			)
		).toBe('missing');
		expect(
			await matrixAccountCheck(
				'https://m.org',
				'x',
				answer({ status: 400, body: { errcode: 'M_USER_IN_USE' } })
			)
		).toBe('exists');
		for (const r of [
			{ status: 403, body: { errcode: 'M_FORBIDDEN', error: 'Registration has been disabled' } },
			{ status: 404, body: { errcode: 'M_UNRECOGNIZED' } },
			{ status: 200, body: { available: false } },
			{ status: 200 },
			'down' as const
		])
			expect(await matrixAccountCheck('https://m.org', 'x', answer(r))).toBe('unknown');
	});

	it('asks for exactly that name, escaped', async () => {
		const { f, asked } = fakeFetch(() => ({ status: 200, body: { available: true } }));
		await matrixAccountCheck('https://m.org/', 'a&b=c', f);
		expect(asked).toEqual([
			'https://m.org/_matrix/client/v3/register/available?username=a%26b%3Dc'
		]);
	});
});

describe('matrixSignIn', () => {
	const server =
		(login: { status: number; body?: unknown } | 'down'): Route =>
		(u) => {
			if (u.endsWith('/_matrix/client/versions')) return VERSIONS;
			if (u.endsWith('/_matrix/client/v3/login')) return login;
			return { status: 404 };
		};

	it('signs in for a fresh device, asks no refresh token, and returns the token and the address used', async () => {
		const { f, bodies } = fakeFetch(
			server({ status: 200, body: { access_token: 'syt_ok', user_id: '@n:m.org' } })
		);
		const r = await matrixSignIn('https://m.org', 'notices', 'pw', { fetch: f });
		expect(r).toEqual({ ok: true, token: 'syt_ok', homeserver: 'https://m.org' });
		const body = bodies[0] as Record<string, unknown>;
		expect(body.type).toBe('m.login.password');
		expect(body.identifier).toEqual({ type: 'm.id.user', user: 'notices' });
		expect(body.password).toBe('pw');
		expect(String(body.initial_device_display_name)).toMatch(/^morphit-alerts-\d+$/);
		// Asking for a refresh token makes a MAS homeserver hand out a token that expires.
		expect('refresh_token' in body).toBe(false);
	});

	it('a 403 is a wrong username or password, with the homeserver’s words', async () => {
		const { f } = fakeFetch(
			server({ status: 403, body: { errcode: 'M_FORBIDDEN', error: 'Invalid username/password' } })
		);
		expect(await matrixSignIn('https://m.org', 'n', 'pw', { fetch: f })).toEqual({
			ok: false,
			why: 'wrong_password',
			detail: 'M_FORBIDDEN: Invalid username/password',
			homeserver: 'https://m.org'
		});
	});

	it('429 → rate_limited; no answer → unreachable; a 200 without a token → other', async () => {
		const rl = fakeFetch(
			server({ status: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 5000 } })
		).f;
		expect(await matrixSignIn('https://m.org', 'n', 'pw', { fetch: rl })).toMatchObject({
			ok: false,
			why: 'rate_limited'
		});
		const down = fakeFetch((u) => (u.endsWith('/v3/login') ? 'down' : VERSIONS)).f;
		const d = await matrixSignIn('https://m.org', 'n', 'pw', { fetch: down });
		expect(d).toMatchObject({ ok: false, why: 'unreachable' });
		expect(d.ok === false && d.detail).toMatch(/ECONNREFUSED/);
		const empty = fakeFetch(server({ status: 200, body: {} })).f;
		expect(await matrixSignIn('https://m.org', 'n', 'pw', { fetch: empty })).toMatchObject({
			ok: false,
			why: 'other'
		});
	});

	it('a homeserver without password sign-in says so', async () => {
		const byCode = fakeFetch(
			server({
				status: 400,
				body: { errcode: 'M_UNKNOWN', error: 'Unknown login type m.login.password' }
			})
		).f;
		expect(await matrixSignIn('https://m.org', 'n', 'pw', { fetch: byCode })).toMatchObject({
			why: 'no_password_login'
		});
		const byFlows = fakeFetch((u, init) => {
			if (u.endsWith('/_matrix/client/versions')) return VERSIONS;
			if (u.endsWith('/v3/login'))
				return init?.method === 'POST'
					? { status: 400, body: { errcode: 'M_BAD_JSON' } }
					: { status: 200, body: { flows: [{ type: 'm.login.sso' }] } };
			return { status: 404 };
		}).f;
		expect(await matrixSignIn('https://m.org', 'n', 'pw', { fetch: byFlows })).toMatchObject({
			why: 'no_password_login'
		});
	});

	it('an address that is no homeserver says so', async () => {
		const { f } = fakeFetch(() => ({ status: 404 }));
		expect(await matrixSignIn('https://www.example.org', 'n', 'pw', { fetch: f })).toMatchObject({
			ok: false,
			why: 'not_homeserver'
		});
	});

	it('signs in at the address /.well-known names — unless told not to look', async () => {
		const route: Route = (u) => {
			if (u === 'https://example.org/.well-known/matrix/client')
				return { status: 200, body: { 'm.homeserver': { base_url: 'https://mc.example.org' } } };
			if (u === 'https://mc.example.org/_matrix/client/versions') return VERSIONS;
			if (u === 'https://mc.example.org/_matrix/client/v3/login')
				return { status: 200, body: { access_token: 'syt_mc' } };
			return { status: 404 };
		};
		const a = fakeFetch(route);
		expect(await matrixSignIn('https://example.org', 'n', 'pw', { fetch: a.f })).toEqual({
			ok: true,
			token: 'syt_mc',
			homeserver: 'https://mc.example.org'
		});
		const b = fakeFetch(route);
		const r = await matrixSignIn('https://example.org', 'n', 'pw', { fetch: b.f, discover: false });
		expect(r.ok).toBe(false);
		expect(b.asked[0]).toBe('https://example.org/_matrix/client/v3/login');
		expect(b.asked.some((u) => u.includes('.well-known'))).toBe(false);
	});
});

describe('mintMatrixToken (the matrix-bot wizard, which saves the address as typed)', () => {
	afterEach(() => vi.unstubAllGlobals());
	it('signs in at the address typed, never at one /.well-known names', async () => {
		const { f, asked } = fakeFetch((u) => {
			if (u === 'https://example.org/.well-known/matrix/client')
				return { status: 200, body: { 'm.homeserver': { base_url: 'https://mc.example.org' } } };
			if (u === 'https://mc.example.org/_matrix/client/versions') return VERSIONS;
			if (u === 'https://mc.example.org/_matrix/client/v3/login')
				return { status: 200, body: { access_token: 'syt_mc' } };
			if (u === 'https://example.org/_matrix/client/v3/login')
				return { status: 200, body: { access_token: 'syt_typed' } };
			return { status: 404 };
		});
		vi.stubGlobal('fetch', f);
		expect(await mintMatrixToken('https://example.org', 'n', 'pw')).toBe('syt_typed');
		expect(asked).toEqual(['https://example.org/_matrix/client/v3/login']);
	});
});
