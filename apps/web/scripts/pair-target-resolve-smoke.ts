/**
 * pair-target-resolve-smoke (cp214).
 *
 * `/pair` is the `web+morphit:` protocol-handler landing route. The payload
 * is attacker-influenceable (any page can mint a `web+morphit://` link), so
 * `resolveWebMorphitTarget` is the security boundary: it must accept ONLY the
 * closed set of intents WriteBlockedReadOnly emits and reject everything else
 * (off-scheme, off-allowlist path, traversal, bad account/permlink) so `/pair`
 * can never become an open redirect.
 *
 * Inputs are built the way the OS does it — `?` + encodeURIComponent(url) —
 * to exercise the decode path too. Plus structural wiring on the route.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWebMorphitTarget } from '../src/lib/pair/resolveTarget.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};

/** Simulate the manifest `/pair?%s` substitution: %s = percent-encoded URL. */
const q = (url: string) => '?' + encodeURIComponent(url);

// ── Valid intents → exact same-origin target pieces ──────────────────
interface Expect {
	url: string;
	pathname: string;
	search?: string;
	hash?: string;
}
const VALID: Expect[] = [
	{ url: 'web+morphit:///', pathname: '/' },
	{ url: 'web+morphit:///post', pathname: '/post' },
	{ url: 'web+morphit:///post/edit/order-abc-123', pathname: '/post/edit/order-abc-123' },
	{ url: 'web+morphit:///chat/alice.morphit', pathname: '/chat/alice.morphit' },
	{ url: 'web+morphit:///chat/bob?order=xyz-1', pathname: '/chat/bob', search: '?order=xyz-1' },
	{ url: 'web+morphit:///@carol', pathname: '/@carol' },
	{ url: 'web+morphit:///settings', pathname: '/settings' },
	{ url: 'web+morphit:///onboarding/register-name', pathname: '/onboarding/register-name' },
	{ url: 'web+morphit:///run-a-node', pathname: '/run-a-node' },
	{ url: 'web+morphit:///my/orders', pathname: '/my/orders' },
	{ url: 'web+morphit:///my/orders#feature=p-1', pathname: '/my/orders', hash: '#feature=p-1' },
	{ url: 'web+morphit:///my/orders#feedback=p-2', pathname: '/my/orders', hash: '#feedback=p-2' }
];
for (const e of VALID) {
	const r = resolveWebMorphitTarget(q(e.url));
	const want = { pathname: e.pathname, search: e.search ?? '', hash: e.hash ?? '' };
	if (r && r.pathname === want.pathname && r.search === want.search && r.hash === want.hash) {
		ok(`VALID ${e.url} → ${want.pathname}${want.search}${want.hash}`);
	} else {
		bad(`VALID ${e.url}`, `got ${JSON.stringify(r)} want ${JSON.stringify(want)}`);
	}
}

// ── Malicious / invalid → null ───────────────────────────────────────
const INVALID: Array<{ url: string; why: string }> = [
	{ url: 'https://evil.com/post', why: 'off-scheme https' },
	{ url: 'http://evil.com/', why: 'off-scheme http' },
	{ url: 'javascript:alert(1)', why: 'javascript: scheme' },
	{ url: '//evil.com', why: 'protocol-relative' },
	{ url: 'web+evil:///post', why: 'wrong custom scheme' },
	{ url: 'web+morphit:///etc/passwd', why: 'off-allowlist path' },
	{ url: 'web+morphit:///admin', why: 'off-allowlist path' },
	{ url: 'web+morphit:///../secret', why: 'traversal' },
	{ url: 'web+morphit:////post', why: 'non-empty authority' },
	{ url: 'web+morphit:///chat/UPPER', why: 'uppercase account' },
	{ url: 'web+morphit:///@a', why: 'account too short' },
	{ url: 'web+morphit:///@..', why: 'dotdot account' },
	{ url: 'web+morphit:///chat/a/b', why: 'slash in chat segment' },
	{ url: 'web+morphit:///post/edit/', why: 'empty permlink' }
];
for (const e of INVALID) {
	const r = resolveWebMorphitTarget(q(e.url));
	if (r === null) ok(`INVALID rejected (${e.why}): ${e.url}`);
	else bad(`INVALID should reject (${e.why}): ${e.url}`, `got ${JSON.stringify(r)}`);
}

// Empty / degenerate inputs → null
for (const raw of ['', '?']) {
	if (resolveWebMorphitTarget(raw) === null) ok(`empty input rejected: ${JSON.stringify(raw)}`);
	else bad('empty input should reject', JSON.stringify(raw));
}

// An allowlisted path under the WRONG scheme must STILL be rejected.
if (resolveWebMorphitTarget(q('http:///post')) === null) ok('allowlisted path under wrong scheme rejected');
else bad('allowlisted path under wrong scheme should reject');

// ── Structural wiring on the /pair route ─────────────────────────────
{
	const page = join(WEB, 'src', 'routes', 'pair', '+page.svelte');
	const opts = join(WEB, 'src', 'routes', 'pair', '+page.ts');
	const pageSrc = existsSync(page) ? readFileSync(page, 'utf8') : '';
	const optsSrc = existsSync(opts) ? readFileSync(opts, 'utf8') : '';
	if (/resolveWebMorphitTarget\(\s*window\.location\.search\s*\)/.test(pageSrc))
		ok('WIRE /pair page resolves window.location.search via resolveWebMorphitTarget');
	else bad('WIRE /pair page', 'does not call resolveWebMorphitTarget(window.location.search)');

	if (/window\.location\.replace\(/.test(pageSrc))
		ok('WIRE /pair page redirects with window.location.replace (no history pollution)');
	else bad('WIRE /pair page', 'does not use window.location.replace');

	if (/export const ssr = false/.test(optsSrc) && /export const prerender = true/.test(optsSrc))
		ok('WIRE /pair +page.ts is prerendered + client-only (ssr=false)');
	else bad('WIRE /pair +page.ts', 'missing prerender=true / ssr=false');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 pair-target-resolve smoke FAILED');
	process.exit(1);
}
console.log('\u2713 web+morphit: payloads resolve to allowlisted same-origin targets; everything else rejected');
console.log(`\u2713 all ${pass} pair-target-resolve scenarios passed`);
