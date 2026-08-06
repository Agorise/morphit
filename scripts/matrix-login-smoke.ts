/**
 * matrix-login-smoke.ts (cp600) — pins the PURE logic of the Matrix login
 * helper (apps/ops-cli/src/init/matrixLogin.ts) that lets the wizard set up
 * Matrix alerts FOR the operator (username+password -> access token) instead
 * of making them hunt for a raw token.
 *
 * The two network calls (well-known discovery + the login POST) can't run in
 * CI, but everything that shapes the request and interprets the response is
 * pure and MUST stay correct — a wrong login URL or a mis-mapped error code is
 * exactly the kind of silent breakage this guards.
 */
import {
	normalizeHomeserver,
	parseUserId,
	parseWellKnownBaseUrl,
	buildLoginRequest,
	mapLoginError
} from '../apps/ops-cli/src/init/matrixLogin.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

console.log('\u2500\u2500 matrix-login smoke (cp600) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

// ─── normalizeHomeserver ──────────────────────────────────────────
check('bare domain gets https://', normalizeHomeserver('matrix.org') === 'https://matrix.org');
check('trailing slash stripped', normalizeHomeserver('https://matrix.org/') === 'https://matrix.org');
check(
	'pasted /_matrix path reduced to origin',
	normalizeHomeserver('https://hs.example.com/_matrix/client/v3/login') === 'https://hs.example.com'
);
check('explicit http:// preserved (local homeserver)', normalizeHomeserver('http://localhost:8008') === 'http://localhost:8008');
check('empty stays empty', normalizeHomeserver('') === '');
check('whitespace trimmed', normalizeHomeserver('  matrix.org  ') === 'https://matrix.org');

// ─── parseUserId ──────────────────────────────────────────────────
const p = parseUserId('@alice:matrix.org');
check('full MXID splits into localpart + domain', p !== null && p.localpart === 'alice' && p.domain === 'matrix.org');
check('domain with port parses', (parseUserId('@bob:hs.example.com:8448')?.domain) === 'hs.example.com:8448');
check('bare localpart -> null', parseUserId('alice') === null);
check('missing @ -> null', parseUserId('alice:matrix.org') === null);

// ─── parseWellKnownBaseUrl ────────────────────────────────────────
check(
	'well-known base_url extracted + normalized',
	parseWellKnownBaseUrl({ 'm.homeserver': { base_url: 'https://matrix-client.matrix.org/' } }) ===
		'https://matrix-client.matrix.org'
);
check('missing m.homeserver -> null', parseWellKnownBaseUrl({ foo: 1 }) === null);
check('missing base_url -> null', parseWellKnownBaseUrl({ 'm.homeserver': {} }) === null);
check('non-object -> null', parseWellKnownBaseUrl('nope') === null);
check('null -> null', parseWellKnownBaseUrl(null) === null);

// ─── buildLoginRequest ────────────────────────────────────────────
const reqFull = buildLoginRequest('https://matrix.org', '@alice:matrix.org', 'hunter2');
check('login URL is client v3 login on the base URL', reqFull.url === 'https://matrix.org/_matrix/client/v3/login');
{
	const b = JSON.parse(reqFull.body);
	check('body type is m.login.password', b.type === 'm.login.password');
	check('identifier is m.id.user with the LOCALPART (from full MXID)', b.identifier?.type === 'm.id.user' && b.identifier?.user === 'alice');
	check('password carried through', b.password === 'hunter2');
	check('device display name defaults to a revocable Morphit label', typeof b.initial_device_display_name === 'string' && /Morphit/.test(b.initial_device_display_name));
}
{
	const b = JSON.parse(buildLoginRequest('https://hs', 'bob', 'pw').body);
	check('bare localpart passed through as-is', b.identifier?.user === 'bob');
}
{
	const b = JSON.parse(buildLoginRequest('https://hs', '@c:hs', 'pw', 'Custom Device').body);
	check('custom device display name honored', b.initial_device_display_name === 'Custom Device');
}

// ─── mapLoginError ────────────────────────────────────────────────
check('M_FORBIDDEN -> username/password message', /username or password/i.test(mapLoginError(403, { errcode: 'M_FORBIDDEN' })));
check('M_USER_DEACTIVATED -> deactivated message', /deactivated/i.test(mapLoginError(403, { errcode: 'M_USER_DEACTIVATED' })));
check('M_LIMIT_EXCEEDED -> rate-limit message', /wait/i.test(mapLoginError(429, { errcode: 'M_LIMIT_EXCEEDED' })));
check('SSO-only server -> suggests token fallback', /single-sign-on|access token/i.test(mapLoginError(400, { errcode: 'M_UNRECOGNIZED' })));
check('5xx -> transient message', /again/i.test(mapLoginError(502, {})));
check('unknown non-M error -> generic with status', /HTTP 418/.test(mapLoginError(418, { foo: 'bar' })));

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} matrix-login checks passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failed} of ${passed + failed} matrix-login checks failed`);
	process.exit(1);
}
