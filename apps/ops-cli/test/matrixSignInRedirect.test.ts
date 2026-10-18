/**
 * The Matrix sign-in never follows a redirect (it would send the password
 * again, to wherever it points — another host, or http:// in the clear), and
 * every failure reason it names (v1.21.10 review).
 */
import { createServer as createHttp, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { matrixAccountCheck, matrixClientBase, matrixSignIn } from '../src/lib/matrixBot.ts';

const servers: Server[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});
const listen = async (s: Server): Promise<number> => {
	servers.push(s);
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
	return (s.address() as { port: number }).port;
};

// Portable guard (no certificate needed): a loopback homeserver that redirects.
describe('guard: the sign-in never follows a redirect with the password', () => {
	for (const status of [301, 302, 303, 307, 308]) {
		it(`HTTP ${status} from /login: nothing sent to the redirect target, not signed in`, async () => {
			const got: string[] = [];
			const sink = await listen(
				createHttp((req, res) => {
					let b = '';
					req.on('data', (c) => (b += c));
					req.on('end', () => {
						got.push(`${req.method} ${req.url} ${b}`);
						res.writeHead(200, { 'content-type': 'application/json' });
						res.end('{"access_token":"from-elsewhere"}');
					});
				})
			);
			const hs = await listen(
				createHttp((req, res) => {
					res.writeHead(status, { location: `http://127.0.0.1:${sink}/elsewhere` });
					res.end();
				})
			);
			const r = await matrixSignIn(`http://127.0.0.1:${hs}`, 'bot', 'S3cret-Pass-Word', {
				discover: false
			});
			expect(got).toEqual([]);
			expect(r.ok).toBe(false);
		});
	}
});

type Route = (url: string, init?: RequestInit) => { status: number; body?: unknown } | 'down';
function fakeFetch(route: Route): { f: typeof fetch; asked: string[] } {
	const asked: string[] = [];
	const f = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		asked.push(`${init?.method ?? 'GET'} ${url}`);
		const r = route(url, init);
		if (r === 'down') throw new TypeError('fetch failed');
		return new Response(r.body === undefined ? 'not json' : JSON.stringify(r.body), {
			status: r.status
		});
	}) as typeof fetch;
	return { f, asked };
}
const V = { status: 200, body: { versions: ['v1.11'] } };

describe('matrixSignIn: every failure reason is reachable', () => {
	const cases: Array<[string, Route, string]> = [
		[
			'403 M_FORBIDDEN',
			(u, i) =>
				i?.method === 'POST'
					? { status: 403, body: { errcode: 'M_FORBIDDEN', error: 'Invalid' } }
					: V,
			'wrong_password'
		],
		[
			'403 M_USER_DEACTIVATED',
			(u, i) =>
				i?.method === 'POST'
					? { status: 403, body: { errcode: 'M_USER_DEACTIVATED', error: 'x' } }
					: V,
			'wrong_password'
		],
		[
			'429',
			(u, i) =>
				i?.method === 'POST'
					? { status: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1 } }
					: V,
			'rate_limited'
		],
		[
			'400 Unknown login type',
			(u, i) =>
				i?.method === 'POST'
					? {
							status: 400,
							body: { errcode: 'M_UNKNOWN', error: 'Unknown login type m.login.password' }
						}
					: V,
			'no_password_login'
		],
		[
			'flows without password',
			(u, i) =>
				i?.method === 'POST'
					? { status: 400, body: { errcode: 'M_BAD_JSON' } }
					: u.endsWith('/v3/login')
						? { status: 200, body: { flows: [{ type: 'm.login.sso' }] } }
						: V,
			'no_password_login'
		],
		['nothing Matrix there', (u, i) => ({ status: 404 }), 'not_homeserver'],
		['down', () => 'down', 'unreachable'],
		[
			'200 without a token',
			(u, i) => (i?.method === 'POST' ? { status: 200, body: {} } : V),
			'other'
		],
		[
			'500 on a client API that offers password',
			(u, i) =>
				i?.method === 'POST'
					? { status: 500, body: { errcode: 'M_UNKNOWN', error: 'Internal' } }
					: u.endsWith('/v3/login')
						? { status: 200, body: { flows: [{ type: 'm.login.password' }] } }
						: V,
			'other'
		]
	];
	for (const [name, route, why] of cases) {
		it(`${name} → ${why}`, async () => {
			const { f } = fakeFetch(route);
			const r = await matrixSignIn('https://hs.example', 'bot', 'pw', { fetch: f });
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.why).toBe(why);
		});
	}

	it('typed address answers /versions, /login lives elsewhere (404 M_UNRECOGNIZED)', async () => {
		const { f, asked } = fakeFetch((u, i) =>
			i?.method === 'POST' || u.endsWith('/v3/login')
				? { status: 404, body: { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' } }
				: V
		);
		const r = await matrixSignIn('https://hs.example', 'bot', 'pw', { fetch: f });
		expect(asked.some((a) => a.startsWith('POST'))).toBe(true);
		expect(r.ok).toBe(false);
	});
});

describe('matrixAccountCheck: what the homeserver says', () => {
	const cases: Array<[string, { status: number; body?: unknown } | 'down', string]> = [
		['200 available', { status: 200, body: { available: true } }, 'missing'],
		['400 M_USER_IN_USE', { status: 400, body: { errcode: 'M_USER_IN_USE' } }, 'exists'],
		['403 registration disabled', { status: 403, body: { errcode: 'M_FORBIDDEN' } }, 'unknown'],
		[
			'400 M_INVALID_USERNAME (uppercase)',
			{ status: 400, body: { errcode: 'M_INVALID_USERNAME' } },
			'unknown'
		],
		['404 (MAS)', { status: 404, body: { errcode: 'M_UNRECOGNIZED' } }, 'unknown'],
		['200 available:"true" string', { status: 200, body: { available: 'true' } }, 'unknown'],
		['200 not JSON', { status: 200 }, 'unknown'],
		['429', { status: 429, body: { errcode: 'M_LIMIT_EXCEEDED' } }, 'unknown'],
		['down', 'down', 'unknown']
	];
	for (const [name, ans, want] of cases) {
		it(`${name} → ${want}`, async () => {
			const { f, asked } = fakeFetch(() => ans);
			expect(await matrixAccountCheck('https://hs.example/', 'a b&c', f)).toBe(want);
			expect(asked[0]).toBe(
				'GET https://hs.example/_matrix/client/v3/register/available?username=a%20b%26c'
			);
		});
	}
});

describe('matrixClientBase: discovered address constraints', () => {
	const wk = (base_url: unknown) =>
		fakeFetch((u) => {
			if (u === 'https://example.org/.well-known/matrix/client')
				return { status: 200, body: { 'm.homeserver': { base_url } } };
			if (u.endsWith('/_matrix/client/versions') && !u.startsWith('https://example.org/')) return V;
			return { status: 404 };
		});
	for (const [b, want] of [
		['https://user:pw@hs.example', 'https://example.org'],
		['https://hs.example/?x=1', 'https://example.org'],
		['https://hs.example/#frag', 'https://example.org'],
		['https://hs.example/sub/', 'https://hs.example/sub'],
		['HTTPS://HS.EXAMPLE', 'https://hs.example'],
		['https://127.0.0.1:8448', 'https://127.0.0.1:8448'],
		['https://abc.onion', 'https://abc.onion'],
		['ftp://hs.example', 'https://example.org'],
		[42, 'https://example.org']
	] as const) {
		it(`${String(b)} → ${want}`, async () => {
			const { f } = wk(b);
			const got = await matrixClientBase('https://example.org', f);
			expect(got).toBe(want);
		});
	}
});
