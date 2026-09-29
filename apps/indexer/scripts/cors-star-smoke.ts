/**
 * cors-star-smoke — the public API must send `Access-Control-Allow-Origin: *`,
 * not a per-instance allowlist, and must let other origins do nothing but read.
 *
 * v1.16.12 — a per-instance allowlist can never scale to the whole federation,
 * so the /compare orderbook diff (which fetches a PEER's /v1/orders from the
 * browser) failed cross-origin with a NetworkError. The reads carry no
 * credentials, so `*` is safe. This pins it so it can't silently regress.
 *
 * v1.20.0 fix wave 4 — BEHAVIOURAL, not a grep of the source. The old version
 * asserted "cors.ts never contains the word POST", which was never the
 * property: the indexer DOES serve POST routes (/v1/broadcast, the federation
 * push, /v1/chain, login pairing) to its own frontend and to peers, and the
 * middleware's own header comment says so. The property is what the browser
 * is TOLD: cross-origin, GET and OPTIONS only, `*`, never credentials. So the
 * real middleware is run through Hono and its headers are read.
 */
import { Hono } from 'hono';
import { cors } from '../src/api/middleware/cors.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) pass++;
	else {
		fail++;
		console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

// An allowlist is passed on purpose: it must NOT gate the header.
const app = new Hono();
app.use('*', cors(['https://morphit.io']));
app.get('/v1/orders', (c) => c.json({ ok: true }));
app.post('/v1/broadcast', (c) => c.json({ ok: true }));

const PEER = 'https://some-other-instance.example';
const methodsOf = (h: Headers): string[] =>
	(h.get('access-control-allow-methods') ?? '')
		.split(',')
		.map((m) => m.trim().toUpperCase())
		.filter(Boolean)
		.sort();

const get = await app.request('/v1/orders', { headers: { origin: PEER } });
check(
	'a cross-origin GET is answered with Access-Control-Allow-Origin: * (public read API)',
	get.status === 200 && get.headers.get('access-control-allow-origin') === '*',
	`status ${get.status}, allow-origin ${JSON.stringify(get.headers.get('access-control-allow-origin'))}`
);
check(
	'the allow-origin header is not gated on a per-origin allowlist (that broke cross-instance compare)',
	get.headers.get('access-control-allow-origin') === '*'
);
check(
	'never Access-Control-Allow-Credentials (so * is valid and leaks nothing)',
	!get.headers.has('access-control-allow-credentials')
);

// The preflight a cross-origin JSON POST needs.
const pre = await app.request('/v1/broadcast', {
	method: 'OPTIONS',
	headers: {
		origin: PEER,
		'access-control-request-method': 'POST',
		'access-control-request-headers': 'content-type'
	}
});
check('a preflight is answered 204 without routing', pre.status === 204, `status ${pre.status}`);
check(
	'cross-origin callers are allowed GET and OPTIONS only — never POST/PUT/DELETE/PATCH',
	JSON.stringify(methodsOf(pre.headers)) === JSON.stringify(['GET', 'OPTIONS']),
	`allow-methods ${JSON.stringify(pre.headers.get('access-control-allow-methods'))}`
);
check(
	'the preflight grants no credentials either',
	!pre.headers.has('access-control-allow-credentials')
);

if (fail === 0) {
	console.log(`✓ all ${pass} cors-star checks passed`);
} else {
	console.error(`✗ ${fail} of ${pass + fail} cors-star checks FAILED`);
	process.exit(1);
}
