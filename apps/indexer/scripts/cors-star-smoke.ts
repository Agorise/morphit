/**
 * cors-star-smoke — the public API must send `Access-Control-Allow-Origin: *`,
 * not a per-instance allowlist, and must let other origins do nothing but read.
 *
 * v1.16.12 — a per-instance allowlist can never scale to the whole federation,
 * so the /compare orderbook diff (which fetches a PEER's /v1/orders from the
 * browser) failed cross-origin with a NetworkError. The reads carry no
 * credentials, so `*` is safe. This pins it so it can't silently regress.
 *
 * BEHAVIOURAL, not a grep of the source. The old version
 * asserted "cors.ts never contains the word POST", which was never the
 * property: the indexer DOES serve POST routes (/v1/broadcast, the federation
 * push, /v1/chain, login pairing) to its own frontend and to peers, and the
 * middleware's own header comment says so. The property is what the browser
 * is TOLD: cross-origin, GET and OPTIONS only, `*`, never credentials. So the
 * real middleware is run through Hono and its headers are read.
 *
 * and a WRITE is not cross-origin at all: its response carries no
 * Allow-Origin (unreadable to another origin), and a write that is not
 * application/json — what a browser sends cross-origin WITHOUT a preflight —
 * is refused with 415 by middleware/jsonWrites.ts before any route runs.
 */
import { Hono } from 'hono';
import { cors } from '../src/api/middleware/cors.ts';
import { jsonWrites } from '../src/api/middleware/jsonWrites.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) pass++;
	else {
		fail++;
		console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

// Wired as main.ts wires it.
const app = new Hono();
app.use('*', cors());
app.use('*', jsonWrites());
app.get('/v1/orders', (c) => c.json({ ok: true }));
let writesReached = 0;
app.post('/v1/broadcast', (c) => {
	writesReached++;
	return c.json({ ok: true });
});

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
	'cross-origin callers are allowed GET, HEAD and OPTIONS only — never POST/PUT/DELETE/PATCH',
	JSON.stringify(methodsOf(pre.headers)) === JSON.stringify(['GET', 'HEAD', 'OPTIONS']),
	`allow-methods ${JSON.stringify(pre.headers.get('access-control-allow-methods'))}`
);
check(
	'the preflight grants no credentials either',
	!pre.headers.has('access-control-allow-credentials')
);

// What a page on another origin can send WITHOUT a preflight: text/plain, and
// a bodyless POST.
for (const [label, init] of [
	[
		'text/plain',
		{ method: 'POST', headers: { origin: PEER, 'content-type': 'text/plain' }, body: '{}' }
	],
	['bodyless', { method: 'POST', headers: { origin: PEER } }],
	[
		'form-encoded',
		{
			method: 'POST',
			headers: { origin: PEER, 'content-type': 'application/x-www-form-urlencoded' },
			body: 'a=1'
		}
	]
] as const) {
	const r = await app.request('/v1/broadcast', init);
	check(`a cross-origin ${label} POST is refused 415`, r.status === 415, `status ${r.status}`);
	check(
		`...and its answer is unreadable to the other origin (no Allow-Origin on a write)`,
		!r.headers.has('access-control-allow-origin')
	);
}
check('none of them reached the route', writesReached === 0, `reached ${writesReached}`);
const same = await app.request('/v1/broadcast', {
	method: 'POST',
	headers: { 'content-type': 'application/json; charset=utf-8' },
	body: '{}'
});
check(
	'a same-origin JSON POST still works',
	same.status === 200 && writesReached === 1,
	`status ${same.status}`
);
check(
	'...and carries no Allow-Origin either (the frontend needs none)',
	!same.headers.has('access-control-allow-origin')
);

if (fail === 0) {
	console.log(`✓ all ${pass} cors-star checks passed`);
} else {
	console.error(`✗ ${fail} of ${pass + fail} cors-star checks FAILED`);
	process.exit(1);
}
