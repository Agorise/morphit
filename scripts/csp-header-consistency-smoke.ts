#!/usr/bin/env tsx
/**
 * scripts/csp-header-consistency-smoke.ts
 *
 * Guards the two security response headers that root-caused and
 * shipped — Content-Security-Policy and Permissions-Policy — against
 * SURFACE DRIFT.  Both headers live, by deliberate design (no build-time
 * templating across an nginx config + Markdown docs + a BunkerWeb env
 * file), as hand-maintained COPIES on three surfaces:
 *
 *   1. ops/nginx/web.conf                  (the shipped reverse-proxy)
 *   2. docs/OPERATIONS.md §15              (the reference copy)
 *   3. ops/bunkerweb/bunkerweb.env.example (the WAF deploy path)
 *   4. ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2 (what an
 *      Ansible/`morphit-ops install` BunkerWeb box is actually given —
 *      v1.20.0, H-11: this smoke used to check only the .example, and the
 *      deployed template carried no CSP at all)
 *   5. ops/bunkerweb/frontend/nginx.conf (the container every BunkerWeb and
 *      tor-only box serves from; Tor/I2P visitors reach it directly, so it
 *      must send the headers itself — v1.20.0, C2). Its page CSP comes from a
 *      `map $host $morphit_csp` whose one value, for every name, is the
 *      canonical CSP (v1.21.14 final review: the browser contacts nothing but
 *      its own site, so .onion and .i2p names need no node list of their own).
 *
 * (RUN-A-MORPHIT-NODE.md is now grandma-only — the verbatim security
 * headers live in OPERATIONS.md §15, not in the friendly quick-start.)
 *
 * Why this exists.  A later change verified all four BYTE-IDENTICAL by hand but
 * left no guard.  The most likely regression: an operator-facing tweak
 * lands in web.conf (the live config) and the three doc/WAF copies are
 * forgotten — so an operator who pastes the OPERATIONS.md snippet, or deploys
 * via BunkerWeb, ends up with a DIFFERENT policy than the shipped nginx.  For
 * the CSP that breakage is not cosmetic: drop `'wasm-unsafe-eval'` and the
 * in-browser argon2 KDF dies; widen connect-src and the browser may reach a
 * third party again; drop `frame-ancestors 'none'` and the site is
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
 *   C2. connect-src is exactly 'self': the browser talks to this site only.
 *   F. The frontend container: every name (clearnet, .onion, .i2p) gets the
 *      canonical CSP; every location repeats the security headers.
 *   H. script-src allows no inline script and no eval on any surface or
 *      origin ('wasm-unsafe-eval' stays: the keystore runs WebAssembly).
 *   I. Every nginx config hides its version (server_tokens off), and every
 *      location of the two web configs that proxies to Morphit clears the
 *      headers no upstream may receive from a visitor (X-Morphit-Local-Health,
 *      X-I2P-DestB64/B32/Hash).
 *   J. X-DNS-Prefetch-Control: off goes wherever the CSP goes: every server
 *      and location of web.conf and the frontend container that sends a CSP
 *      (nginx inheritance: a block with add_header lines of its own inherits
 *      none), the OPERATIONS.md reference copy, and both BunkerWeb env files
 *      (a CUSTOM_HEADER_<n>: BunkerWeb 1.5 has no setting of its own for it).
 *      A browser may look up the name of a link on a page before a click,
 *      mostly on plain-http .onion/.i2p pages; the CSP does not cover that.
 *
 * Output contract: emits `✓ all N scenarios passed` on the last line.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addHeaders, findBlocks, mapEntries, parseNginx } from './lib/nginx-conf';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const WEB_CONF = 'ops/nginx/web.conf';
const OPERATIONS = 'docs/OPERATIONS.md';
const BUNKERWEB = 'ops/bunkerweb/bunkerweb.env.example';
const BUNKERWEB_J2 = 'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2';
const FRONTEND = 'ops/bunkerweb/frontend/nginx.conf';

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

// MORPHIT_CSP_ROOT=<another tree> checks that tree's files (watch it fail on an
// older release); the hidden RPC list always comes from this checkout.
const ROOT = process.env.MORPHIT_CSP_ROOT ?? REPO;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

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
const operations = read(OPERATIONS);
const bunkerweb = read(BUNKERWEB);
const bunkerwebJ2 = read(BUNKERWEB_J2);
const frontendTree = parseNginx(read(FRONTEND));
const frontendServer = findBlocks(frontendTree, 'server')[0]?.block ?? [];
const frontendCspMap = mapEntries(frontendTree, '$morphit_csp');

// ─── Collect CSP values from every surface ───────────────────────────
// SVGs are served under their own, stricter policy (v1.19.0: an operator's
// brand SVG opened directly must not run anything, docs/BRANDING.md). It is
// not a page policy, so it is checked on its own below and kept out of the
// page-CSP parity check.
const SVG_IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
const cspWebAll = nginxHeaderValues(webConf, 'Content-Security-Policy');
const cspWeb = cspWebAll.filter((v) => v !== SVG_IMAGE_CSP);
{
	// v1.21.12: the API (/v1/, /relay/) is no longer matched by it (dotted account names).
	const svgBlock = /location ~\* \^\/\(\?!_app\/\|v1\/\|relay\/\)\.\*\\\.svg\$ \{([\s\S]*?)\n {4}\}/.exec(webConf)?.[1] ?? '';
	const inBlock = nginxHeaderValues(svgBlock, 'Content-Security-Policy');
	if (
		cspWebAll.length - cspWeb.length === 1 &&
		inBlock.length === 1 &&
		inBlock[0] === SVG_IMAGE_CSP &&
		nginxHeaderValues(svgBlock, 'Permissions-Policy').length === 1
	) {
		ok('the strict SVG-image CSP appears once, only in the `.svg` location (with the other security headers)');
	} else {
		bad(
			'SVG-image CSP misplaced',
			`expected exactly one "${SVG_IMAGE_CSP}", inside \`location ~* ^/(?!_app/|v1/|relay/).*\\.svg$\` in ${WEB_CONF}`
		);
	}
}
const cspOps = nginxHeaderValues(operations, 'Content-Security-Policy');
const cspBw = envValue(bunkerweb, 'CONTENT_SECURITY_POLICY');
const cspBwJ2 = envValue(bunkerwebJ2, 'CONTENT_SECURITY_POLICY');
// The frontend's page CSP for every clearnet name = the map's default.
const cspFe = frontendCspMap?.get('default') ?? null;

// ─── Collect Permissions-Policy values from every surface ────────────
const ppWeb = nginxHeaderValues(webConf, 'Permissions-Policy');
const ppOps = nginxHeaderValues(operations, 'Permissions-Policy');
const ppBw = envValue(bunkerweb, 'PERMISSIONS_POLICY');
const ppBwJ2 = envValue(bunkerwebJ2, 'PERMISSIONS_POLICY');
const ppFe = addHeaders(frontendServer).get('permissions-policy') ?? null;

// ── A. every surface defines each header ─────────────────────────────
const cspSurfaces: Array<[string, string[]]> = [
	[WEB_CONF, cspWeb],
	[OPERATIONS, cspOps],
	[BUNKERWEB, cspBw === null ? [] : [cspBw]],
	[BUNKERWEB_J2, cspBwJ2 === null ? [] : [cspBwJ2]],
	[`${FRONTEND} (map $morphit_csp default)`, cspFe === null ? [] : [cspFe]]
];
for (const [name, vals] of cspSurfaces) {
	if (vals.length > 0) ok(`CSP present on surface: ${name} (${vals.length} occurrence(s))`);
	else bad(`CSP MISSING from surface: ${name}`, 'every surface must carry the Content-Security-Policy');
}
const ppSurfaces: Array<[string, string[]]> = [
	[WEB_CONF, ppWeb],
	[OPERATIONS, ppOps],
	[BUNKERWEB, ppBw === null ? [] : [ppBw]],
	[BUNKERWEB_J2, ppBwJ2 === null ? [] : [ppBwJ2]],
	[`${FRONTEND} (server level)`, ppFe === null ? [] : [ppFe]]
];
for (const [name, vals] of ppSurfaces) {
	if (vals.length > 0) ok(`Permissions-Policy present on surface: ${name} (${vals.length} occurrence(s))`);
	else bad(`Permissions-Policy MISSING from surface: ${name}`, 'every surface must carry the Permissions-Policy');
}

// ── B. all CSP occurrences byte-identical; all Permissions-Policy too ─
const allCsp = [
	...cspWeb,
	...cspOps,
	...(cspBw === null ? [] : [cspBw]),
	...(cspBwJ2 === null ? [] : [cspBwJ2]),
	...(cspFe === null ? [] : [cspFe])
];
const distinctCsp = [...new Set(allCsp)];
if (allCsp.length > 0 && distinctCsp.length === 1) {
	ok(`all ${allCsp.length} CSP occurrences are byte-identical across all ${cspSurfaces.length} surfaces`);
} else {
	bad(
		`CSP DRIFT — ${distinctCsp.length} distinct CSP values found (expected exactly 1)`,
		distinctCsp.map((v, i) => `[${i}] ${v.slice(0, 90)}…`).join('\n      ')
	);
}

const allPp = [
	...ppWeb,
	...ppOps,
	...(ppBw === null ? [] : [ppBw]),
	...(ppBwJ2 === null ? [] : [ppBwJ2]),
	...(ppFe === null ? [] : [ppFe])
];
const distinctPp = [...new Set(allPp)];
if (allPp.length > 0 && distinctPp.length === 1) {
	ok(`all ${allPp.length} Permissions-Policy occurrences are byte-identical across all ${cspSurfaces.length} surfaces`);
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
// ── C2. connect-src is this site only ──────────────────────────────
// Every chain read, broadcast and the release check go through the instance
// (the release check by POST /v1/chain/agreed — v1.21.14 final review), so the
// browser needs no other origin, on any surface or name. Any other source is a
// third party the browser could reach with the visitor's address.
{
	const connectSrc = (canonicalCsp.match(/connect-src([^;]*)/i)?.[1] ?? '').trim();
	if (connectSrc === "'self'") ok("CSP connect-src is exactly 'self' — the browser talks to this site only");
	else
		bad(
			`CSP connect-src is "${connectSrc}", not 'self'`,
			'the browser contacts nothing but its own site; an extra source lets it reach a third party'
		);
}

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
if (cspWebAll.length === ppWeb.length && cspWeb.length >= 1) {
	ok(
		`web.conf emits CSP (${cspWebAll.length}) and Permissions-Policy (${ppWeb.length}) on the same ` +
			`number of blocks — the two security headers travel together`
	);
} else {
	bad(
		`web.conf CSP block count (${cspWebAll.length}) != Permissions-Policy block count (${ppWeb.length})`,
		'a HTML-serving block has one security header but not the other'
	);
}

// ── F. the frontend container (Tor/I2P path + BunkerWeb upstream) ───
{
	// F1. every name gets the one canonical policy: no per-name map entry
	// (an .onion or .i2p entry was how a node list for hidden names got in).
	const entries = [...(frontendCspMap?.entries() ?? [])];
	if (entries.length === 1 && entries[0]![0] === 'default' && entries[0]![1] === canonicalCsp)
		ok(`${FRONTEND}: every name (clearnet, .onion, .i2p) gets the canonical CSP`);
	else
		bad(
			`${FRONTEND}: the CSP map has ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${entries.map(([k]) => k).join(', ')})`,
			'one value for every name — the canonical CSP'
		);
	// F2. server-level header set; no HSTS (plain-http hidden services).
	const srv = addHeaders(frontendServer);
	const want: Array<[string, string]> = [
		['content-security-policy', '$morphit_csp'],
		['x-frame-options', 'DENY'],
		['x-content-type-options', 'nosniff'],
		['referrer-policy', 'no-referrer']
	];
	for (const [h, v] of want) {
		if (srv.get(h) === v) ok(`${FRONTEND}: server level sends ${h}: ${v}`);
		else bad(`${FRONTEND}: server level does not send ${h}: ${v}`, `got ${String(srv.get(h))}`);
	}
	const hsts = findBlocks(frontendTree, 'server').concat(findBlocks(frontendTree, 'location'))
		.some((b) => addHeaders(b.block).has('strict-transport-security'));
	if (!hsts) ok(`${FRONTEND}: no Strict-Transport-Security (its Tor/I2P hop is plain http)`);
	else bad(`${FRONTEND}: sends Strict-Transport-Security`, 'HSTS on a plain-http hidden service is wrong; BunkerWeb adds it on https');
	// F3. every location with its own add_header repeats the full set (nginx
	// drops server-level add_header inheritance there). SVG locations use the
	// sandbox policy instead of the page policy.
	const locs = findBlocks(frontendServer, 'location').filter((l) => addHeaders(l.block).size > 0);
	for (const l of locs) {
		const h = addHeaders(l.block);
		const isSvg = h.get('content-security-policy') === SVG_IMAGE_CSP;
		const cspOk = isSvg || h.get('content-security-policy') === '$morphit_csp';
		const rest =
			h.get('x-frame-options') === 'DENY' &&
			h.get('x-content-type-options') === 'nosniff' &&
			h.get('referrer-policy') === 'no-referrer' &&
			h.get('permissions-policy') === canonicalPp;
		if (cspOk && rest) ok(`${FRONTEND}: location ${l.args.join(' ')} repeats every security header${isSvg ? ' (SVG sandbox CSP)' : ''}`);
		else bad(`${FRONTEND}: location ${l.args.join(' ')} drops a security header`, JSON.stringify([...h.keys()]));
	}
	// F4. the SVG sandbox covers both SVG-serving locations (brand + any .svg).
	const svgLocs = locs.filter((l) => addHeaders(l.block).get('content-security-policy') === SVG_IMAGE_CSP).map((l) => l.args.join(' '));
	if (svgLocs.some((a) => a.includes('.svg$') && a.includes('_app')) && svgLocs.some((a) => a.includes('brand/')))
		ok(`${FRONTEND}: the SVG sandbox CSP covers the brand location and every SVG outside /_app/`);
	else bad(`${FRONTEND}: SVG sandbox CSP missing from the brand or .svg location`, svgLocs.join(' | '));
}

// ── G. the BunkerWeb env files carry the other two headers ───────────
for (const [rel, text] of [
	[BUNKERWEB, bunkerweb],
	[BUNKERWEB_J2, bunkerwebJ2]
] as const) {
	const rp = envValue(text, 'REFERRER_POLICY');
	const xf = envValue(text, 'X_FRAME_OPTIONS');
	if (rp === 'no-referrer' && xf === 'DENY') ok(`${rel}: REFERRER_POLICY=no-referrer and X_FRAME_OPTIONS=DENY`);
	else bad(`${rel}: REFERRER_POLICY / X_FRAME_OPTIONS not set`, `REFERRER_POLICY=${rp} X_FRAME_OPTIONS=${xf} (BunkerWeb's defaults leak the origin cross-site)`);
}

// ── H. no inline script, no eval — on every surface and origin ──────────
{
	const scriptSrcOf = (csp: string): string[] =>
		(/(?:^|;)\s*script-src([^;]*)/i.exec(csp)?.[1] ?? '').trim().split(/\s+/);
	const pageCsps: Array<[string, string]> = [
		...allCsp.map((v, i) => [`page CSP #${i + 1}`, v] as [string, string]),
		...[...(frontendCspMap ?? new Map<string, string>())].map(
			([k, v]) => [`${FRONTEND} map ${k}`, v] as [string, string]
		)
	];
	const loose = pageCsps.filter(([, v]) =>
		scriptSrcOf(v).some((t) => t === "'unsafe-inline'" || t === "'unsafe-eval'")
	);
	if (pageCsps.length > 0 && loose.length === 0)
		ok(`script-src allows no inline script and no eval in all ${pageCsps.length} page policies`);
	else bad(`script-src allows inline script or eval`, loose.map(([n]) => n).join(', '));
	if (scriptSrcOf(canonicalCsp).includes("'wasm-unsafe-eval'")) ok("script-src keeps 'wasm-unsafe-eval' (WebAssembly only)");
	else bad("script-src lost 'wasm-unsafe-eval'", 'the keystore runs as WebAssembly');
}

// ── I. version hidden; visitor-supplied headers cleared on every proxy ───
{
	const NGINX = [FRONTEND, WEB_CONF, 'ops/nginx/relay.conf', 'ops/nginx/indexer.conf'];
	for (const rel of NGINX) {
		const servers = findBlocks(parseNginx(read(rel)), 'server');
		const tls = servers.filter((sv) =>
			sv.block.some((d) => d.name === 'location' || d.name === 'proxy_pass' || d.name === 'root')
		);
		const hidden = tls.every((sv) => sv.block.some((d) => d.name === 'server_tokens' && d.args[0] === 'off'));
		if (tls.length > 0 && hidden) ok(`${rel}: server_tokens off (no nginx version in headers or error pages)`);
		else bad(`${rel}: a server block shows the nginx version`, 'add `server_tokens off;`');
	}
	const MUST_CLEAR = ['x-morphit-local-health', 'x-i2p-destb64', 'x-i2p-destb32', 'x-i2p-desthash'];
	for (const rel of [FRONTEND, WEB_CONF, 'ops/nginx/relay.conf', 'ops/nginx/indexer.conf']) {
		const tree = parseNginx(read(rel));
		for (const sv of findBlocks(tree, 'server')) {
			const serverSet = sv.block.filter((d) => d.name === 'proxy_set_header');
			for (const loc of findBlocks(sv.block, 'location')) {
				if (!loc.block.some((d) => d.name === 'proxy_pass')) continue;
				const own = loc.block.filter((d) => d.name === 'proxy_set_header');
				// nginx: a location with any proxy_set_header of its own inherits none.
				const eff = new Map((own.length > 0 ? own : serverSet).map((d) => [String(d.args[0]).toLowerCase(), d.args[1] ?? '']));
				const missing = MUST_CLEAR.filter((h) => eff.get(h) !== '');
				if (missing.length === 0) ok(`${rel}: location ${loc.args.join(' ')} clears the visitor-supplied headers`);
				else bad(`${rel}: location ${loc.args.join(' ')} passes ${missing.join(', ')} through`, 'add `proxy_set_header <name> "";`');
			}
		}
	}
}

// ── J. X-DNS-Prefetch-Control: off wherever the CSP is ───────────────────
{
	type Dir = { name: string; args: string[]; block: Dir[] | null };
	for (const rel of [WEB_CONF, FRONTEND]) {
		const lacking: string[] = [];
		let withCsp = 0;
		const walk = (list: readonly Dir[], inherited: Map<string, string>): void => {
			for (const d of list) {
				if (!d.block) continue;
				const own = addHeaders(d.block);
				const eff = own.size > 0 ? own : inherited;
				if ((d.name === 'server' || d.name === 'location') && eff.has('content-security-policy')) {
					withCsp++;
					if (eff.get('x-dns-prefetch-control') !== 'off') lacking.push(`${d.name} ${d.args.join(' ')}`.trim());
				}
				walk(d.block, eff);
			}
		};
		walk(parseNginx(read(rel)) as Dir[], new Map());
		if (withCsp > 0 && lacking.length === 0)
			ok(`${rel}: all ${withCsp} blocks that send the CSP also send X-DNS-Prefetch-Control: off`);
		else bad(`${rel}: a block sends the CSP without X-DNS-Prefetch-Control: off`, lacking.join(' | ') || 'no block sends a CSP');
	}
	if (nginxHeaderValues(operations, 'X-DNS-Prefetch-Control').includes('off'))
		ok(`${OPERATIONS}: the reference headers include X-DNS-Prefetch-Control "off"`);
	else bad(`${OPERATIONS}: the reference headers lack X-DNS-Prefetch-Control "off"`);
	for (const [rel, text] of [
		[BUNKERWEB, bunkerweb],
		[BUNKERWEB_J2, bunkerwebJ2]
	] as const) {
		if (/^CUSTOM_HEADER(?:_\d+)?=X-DNS-Prefetch-Control: off$/m.test(text))
			ok(`${rel}: CUSTOM_HEADER sends X-DNS-Prefetch-Control: off`);
		else bad(`${rel}: no CUSTOM_HEADER sends X-DNS-Prefetch-Control: off`, 'BunkerWeb 1.5 has no setting of its own for it: CUSTOM_HEADER_<n>=X-DNS-Prefetch-Control: off');
	}
}

// ─── Report ──────────────────────────────────────────────────────────
console.log('');
console.log('──────────────────────────────────────────────────────');
if (fail > 0) {
	console.log(`✗ ${fail}/${pass + fail} scenarios failed`);
	process.exit(1);
}
console.log('✓ CSP + Permissions-Policy byte-identical across web.conf / OPERATIONS / both BunkerWeb env files / the frontend container,');
console.log('✓ and the canonical policies retain every security-critical directive');
console.log(`✓ all ${pass} scenarios passed`);
