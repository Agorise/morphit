#!/usr/bin/env tsx
/**
 * scripts/csp-header-consistency-smoke.ts  (cp235)
 *
 * Guards the two security response headers that cp233 root-caused and
 * shipped — Content-Security-Policy and Permissions-Policy — against
 * SURFACE DRIFT.  Both headers live, by deliberate design (no build-time
 * templating across an nginx config + Markdown docs + a BunkerWeb env
 * file), as hand-maintained COPIES on four surfaces:
 *
 *   1. ops/nginx/web.conf                  (the shipped reverse-proxy)
 *   2. docs/RUN-A-MORPHIT-NODE.md §11      (the operator copies this)
 *   3. docs/OPERATIONS.md §15              (the reference copy)
 *   4. ops/bunkerweb/bunkerweb.env.example (the WAF deploy path)
 *
 * Why this exists.  cp233 verified all four BYTE-IDENTICAL by hand but
 * left no guard.  The most likely regression: an operator-facing tweak
 * lands in web.conf (the live config) and the three doc/WAF copies are
 * forgotten — so an operator who pastes the RUN-A snippet, or deploys via
 * BunkerWeb, ends up with a DIFFERENT policy than the shipped nginx.  For
 * the CSP that breakage is not cosmetic: drop `'wasm-unsafe-eval'` and the
 * in-browser argon2 KDF dies; drop a Blurt RPC origin from connect-src and
 * sign-in/price fetches fail; drop `frame-ancestors 'none'` and the site is
 * clickjackable.  For Permissions-Policy, lose `camera=(self)` and the
 * QR-login scanner (getUserMedia) stops working.
 *
 * What it checks:
 *   A. Every surface defines a CSP and a Permissions-Policy (none silently
 *      dropped the header entirely).
 *   B. Every CSP occurrence across every surface is byte-identical to one
 *      canonical value; likewise Permissions-Policy.  (web.conf carries the
 *      header on several blocks — main + SPA fallback + redirects — so this
 *      also catches one block drifting from the others within web.conf.)
 *   C. The canonical CSP still contains the SECURITY-CRITICAL directives, so
 *      a *uniform-but-weakened* edit (someone relaxes all four copies at
 *      once) is caught, not just cross-surface drift.
 *   D. The canonical Permissions-Policy keeps camera=(self) (QR scanner) and
 *      interest-cohort=() (FLoC opt-out).
 *   E. In web.conf, the CSP add_header count == the Permissions-Policy
 *      add_header count: the two headers are always emitted together on
 *      every HTML-serving block, so this catches "added CSP to a new block
 *      but forgot Permissions-Policy" without hardcoding a brittle block
 *      count.
 *
 * Output contract: emits `✓ all N scenarios passed` on the last line.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const WEB_CONF = 'ops/nginx/web.conf';
const RUN_A = 'docs/RUN-A-MORPHIT-NODE.md';
const OPERATIONS = 'docs/OPERATIONS.md';
const BUNKERWEB = 'ops/bunkerweb/bunkerweb.env.example';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  ✓ ${m}`);
};
const bad = (m: string, detail = '') => {
	fail++;
	console.log(`  ✗ ${m}`);
	if (detail) console.log(`      ${detail}`);
};

const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/**
 * Extract every `add_header <Header> "<value>" ...;` value from an nginx
 * config or a fenced nginx block inside Markdown.  Returns the list of
 * captured values (one per occurrence).  Prose mentions of the header name
 * that are NOT in the `add_header "..."` form do not match, so they're
 * naturally excluded.
 */
function nginxHeaderValues(text: string, header: string): string[] {
	const re = new RegExp(`add_header\\s+${header}\\s+"([^"]+)"`, 'g');
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) out.push(m[1]!);
	return out;
}

/** Extract `KEY=value` (rest of line) from a BunkerWeb env file. */
function envValue(text: string, key: string): string | null {
	const m = text.match(new RegExp(`^${key}=(.+)$`, 'm'));
	return m ? m[1]!.trim() : null;
}

console.log('\n── csp-header-consistency smoke ────────────────────────\n');

const webConf = read(WEB_CONF);
const runA = read(RUN_A);
const operations = read(OPERATIONS);
const bunkerweb = read(BUNKERWEB);

// ─── Collect CSP values from every surface ───────────────────────────
const cspWeb = nginxHeaderValues(webConf, 'Content-Security-Policy');
const cspRunA = nginxHeaderValues(runA, 'Content-Security-Policy');
const cspOps = nginxHeaderValues(operations, 'Content-Security-Policy');
const cspBw = envValue(bunkerweb, 'CONTENT_SECURITY_POLICY');

// ─── Collect Permissions-Policy values from every surface ────────────
const ppWeb = nginxHeaderValues(webConf, 'Permissions-Policy');
const ppRunA = nginxHeaderValues(runA, 'Permissions-Policy');
const ppOps = nginxHeaderValues(operations, 'Permissions-Policy');
const ppBw = envValue(bunkerweb, 'PERMISSIONS_POLICY');

// ── A. every surface defines each header ─────────────────────────────
const cspSurfaces: Array<[string, string[]]> = [
	[WEB_CONF, cspWeb],
	[RUN_A, cspRunA],
	[OPERATIONS, cspOps],
	[BUNKERWEB, cspBw === null ? [] : [cspBw]]
];
for (const [name, vals] of cspSurfaces) {
	if (vals.length > 0) ok(`CSP present on surface: ${name} (${vals.length} occurrence(s))`);
	else bad(`CSP MISSING from surface: ${name}`, 'every surface must carry the Content-Security-Policy');
}
const ppSurfaces: Array<[string, string[]]> = [
	[WEB_CONF, ppWeb],
	[RUN_A, ppRunA],
	[OPERATIONS, ppOps],
	[BUNKERWEB, ppBw === null ? [] : [ppBw]]
];
for (const [name, vals] of ppSurfaces) {
	if (vals.length > 0) ok(`Permissions-Policy present on surface: ${name} (${vals.length} occurrence(s))`);
	else bad(`Permissions-Policy MISSING from surface: ${name}`, 'every surface must carry the Permissions-Policy');
}

// ── B. all CSP occurrences byte-identical; all Permissions-Policy too ─
const allCsp = [...cspWeb, ...cspRunA, ...cspOps, ...(cspBw === null ? [] : [cspBw])];
const distinctCsp = [...new Set(allCsp)];
if (allCsp.length > 0 && distinctCsp.length === 1) {
	ok(`all ${allCsp.length} CSP occurrences are byte-identical across all 4 surfaces`);
} else {
	bad(
		`CSP DRIFT — ${distinctCsp.length} distinct CSP values found (expected exactly 1)`,
		distinctCsp.map((v, i) => `[${i}] ${v.slice(0, 90)}…`).join('\n      ')
	);
}

const allPp = [...ppWeb, ...ppRunA, ...ppOps, ...(ppBw === null ? [] : [ppBw])];
const distinctPp = [...new Set(allPp)];
if (allPp.length > 0 && distinctPp.length === 1) {
	ok(`all ${allPp.length} Permissions-Policy occurrences are byte-identical across all 4 surfaces`);
} else {
	bad(
		`Permissions-Policy DRIFT — ${distinctPp.length} distinct values found (expected exactly 1)`,
		distinctPp.join('\n      ')
	);
}

// ── C. canonical CSP keeps the security-critical directives ──────────
const canonicalCsp = distinctCsp[0] ?? '';
const REQUIRED_CSP_TOKENS: Array<[string, string]> = [
	["default-src 'self'", 'baseline lockdown'],
	["'wasm-unsafe-eval'", 'in-browser argon2 KDF needs WASM compilation'],
	['img-src \'self\' data: blob:', 'identicon avatars are data:/blob:'],
	["worker-src 'self' blob:", 'chat crypto worker'],
	["frame-ancestors 'none'", 'clickjacking defense'],
	["base-uri 'self'", 'base-tag injection defense'],
	["object-src 'none'", 'plugin/embed defense'],
	["form-action 'self'", 'form-hijack defense']
];
for (const [tok, why] of REQUIRED_CSP_TOKENS) {
	if (canonicalCsp.includes(tok)) ok(`CSP retains \`${tok}\` (${why})`);
	else bad(`CSP MISSING required directive \`${tok}\` (${why})`, 'a uniform-but-weakened CSP edit was detected');
}
// ── C2. connect-src RPC origins are EXACTLY the canonical default pool ──
// Derived from @morphit/operator-config (the single source of truth that
// rpc-endpoint-canon-smoke also pins frontend + both env examples against),
// so adding or removing a Blurt RPC endpoint there automatically updates what
// this guard requires.  A hand-maintained subset would fall behind the CSP —
// exactly how the two cp261 additions (rpc.drakernoise.com, blurtrpc.dagobert.uk)
// were left un-pinned even though they were correctly added to all 4 surfaces.
{
	const connectSrc = canonicalCsp.match(/connect-src([^;]*)/i)?.[1] ?? '';
	const cspOrigins = new Set(
		(connectSrc.match(/https:\/\/[^\s;'"]+/g) ?? []).map((o) => o.replace(/\/+$/, ''))
	);
	const canonOrigins = DEFAULT_BLURT_RPC_ENDPOINTS.map((e) => e.replace(/\/+$/, ''));
	for (const origin of canonOrigins) {
		if (cspOrigins.has(origin)) ok(`CSP connect-src includes canonical RPC origin ${origin}`);
		else
			bad(
				`CSP connect-src MISSING canonical RPC origin ${origin}`,
				'a uniform CSP edit dropped a Blurt RPC node from every surface — sign-in/price via that node breaks silently and no surface-drift check would catch it'
			);
	}
	// No EXTRA https origin beyond the canonical pool: catches a stale origin
	// left behind after an endpoint removal, and a sneaked-in third-party origin.
	const extra = [...cspOrigins].filter((o) => !canonOrigins.includes(o));
	if (extra.length === 0) ok('CSP connect-src carries no https origin beyond the canonical RPC pool');
	else
		bad(
			`CSP connect-src has ${extra.length} non-canonical https origin(s): ${extra.join(', ')}`,
			"connect-src must equal 'self' + the canonical Blurt RPC pool only (privacy + parity)"
		);
}
// connect-src must NOT silently re-admit an external price API (privacy —
// cp233 dropped CoinGecko; the client provider is unwired).  Catch a
// re-introduction of the most likely candidate.
if (!/connect-src[^;]*coingecko/i.test(canonicalCsp))
	ok('CSP connect-src does not re-admit coingecko (privacy — cp233)');
else bad('CSP connect-src re-admits coingecko', 'cp233 removed it; the client provider is unwired');

// ── D. canonical Permissions-Policy keeps camera + FLoC opt-out ──────
const canonicalPp = distinctPp[0] ?? '';
if (/camera=\(self\)/.test(canonicalPp)) ok('Permissions-Policy keeps camera=(self) (QR-login scanner)');
else bad('Permissions-Policy lost camera=(self)', 'the QR-login getUserMedia scanner would break');
if (/interest-cohort=\(\)/.test(canonicalPp)) ok('Permissions-Policy keeps interest-cohort=() (FLoC opt-out)');
else bad('Permissions-Policy lost interest-cohort=()', 'FLoC/Topics opt-out');
// camera is the ONLY capability granted; mic + geo must stay disabled.
if (/microphone=\(\)/.test(canonicalPp) && /geolocation=\(\)/.test(canonicalPp))
	ok('Permissions-Policy keeps microphone=() and geolocation=() disabled');
else bad('Permissions-Policy unexpectedly grants microphone or geolocation', canonicalPp);

// ── E. web.conf emits CSP and Permissions-Policy on the SAME blocks ──
if (cspWeb.length === ppWeb.length && cspWeb.length >= 1) {
	ok(
		`web.conf emits CSP (${cspWeb.length}) and Permissions-Policy (${ppWeb.length}) on the same ` +
			`number of blocks — the two security headers travel together`
	);
} else {
	bad(
		`web.conf CSP block count (${cspWeb.length}) != Permissions-Policy block count (${ppWeb.length})`,
		'a HTML-serving block has one security header but not the other'
	);
}

// ─── Report ──────────────────────────────────────────────────────────
console.log('');
console.log('──────────────────────────────────────────────────────');
if (fail > 0) {
	console.log(`✗ ${fail}/${pass + fail} scenarios failed`);
	process.exit(1);
}
console.log('✓ CSP + Permissions-Policy byte-identical across web.conf / RUN-A / OPERATIONS / BunkerWeb,');
console.log('✓ and the canonical policies retain every security-critical directive');
console.log(`✓ all ${pass} scenarios passed`);
