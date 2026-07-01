/**
 * Morphit smoke — operator-only price-feed-health header strip.
 *
 * cp381 added a top-level `price_feeds` block to /v1/health that the
 * indexer emits ONLY when the request carries `X-Morphit-Local-Health: 1`.
 * The local ops-cli sends that header over the internal bridge; the
 * PUBLIC edge must STRIP it so an outside caller can never forge it and
 * read which of the operator's price feeds are momentarily down (a small
 * but real dent in the median-of-many price-manipulation opacity).
 *
 * This pins the strip on every edge surface that proxies the indexer's
 * /v1/health to the public, so a future config edit can't silently drop
 * it and re-open the leak. It guards the nginx inheritance trap too: a
 * `proxy_set_header` inside a `location` cancels inheritance of the
 * server-level ones, so a serving block that defines its own headers MUST
 * carry the strip inline. It also respects exact-match precedence — if a
 * surface has `location = /v1/health`, THAT block (not the `/v1/` prefix)
 * is what serves health.
 *
 * Output contract: emits `✓ all N scenarios passed` on the last line.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

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

/** The canonical strip directive (whitespace-tolerant). The value MUST be
 *  the empty string — anything else would forward a client-supplied value. */
const STRIP_RE = /proxy_set_header\s+X-Morphit-Local-Health\s+""\s*;/;

// Directive-anchored (line-start) so the word "location" inside a comment
// or prose never counts as an nginx `location` directive.
const ANY_LOCATION = /^[^\S\n]*location\s/m;
const V1_PREFIX = /^[^\S\n]*location\s+\/v1\/\s*\{/m;
const V1_HEALTH_EXACT = /^[^\S\n]*location\s+=\s+\/v1\/health\s*\{/m;

/** Everything before the first `location` DIRECTIVE = the server scope
 *  whose proxy_set_header directives are inherited by locations that
 *  define none of their own. */
function serverScope(text: string): string {
	const m = text.match(ANY_LOCATION);
	return m && m.index !== undefined ? text.slice(0, m.index) : text;
}

/** Body of the first location block whose header matches `headerRe`.
 *  These blocks carry no nested braces, so the next `}` ends the block. */
function blockBody(text: string, headerRe: RegExp): string | null {
	const m = text.match(headerRe);
	if (!m || m.index === undefined) return null;
	const open = text.indexOf('{', m.index);
	const close = text.indexOf('}', open);
	if (open === -1 || close === -1) return null;
	return text.slice(open + 1, close);
}

/** Is the operator-only header effectively stripped on this surface's
 *  /v1/health path?  Picks the block that actually serves health (exact
 *  `= /v1/health` wins over the `/v1/` prefix), then: if that block
 *  defines its own proxy_set_header the strip must be inline; otherwise it
 *  inherits, so the strip must be in server scope. */
function healthStripEffective(text: string): { ok: boolean; reason: string } {
	const exact = blockBody(text, V1_HEALTH_EXACT);
	const prefix = blockBody(text, V1_PREFIX);
	const serving = exact !== null ? exact : prefix;
	if (serving === null) return { ok: false, reason: 'no /v1/health or /v1/ location block found' };
	if (/proxy_set_header/.test(serving)) {
		return STRIP_RE.test(serving)
			? { ok: true, reason: 'inline in serving block' }
			: { ok: false, reason: 'serving block defines its own proxy_set_header but lacks the strip' };
	}
	return STRIP_RE.test(serverScope(text))
		? { ok: true, reason: 'inherited from server scope' }
		: { ok: false, reason: 'serving block inherits but server scope has no strip' };
}

console.log('\n── price-feed-health header-strip smoke ────────────────\n');

const SURFACES: Array<{ label: string; file: string }> = [
	{ label: 'A. web.conf', file: 'ops/nginx/web.conf' },
	{ label: 'B. bunkerweb frontend', file: 'ops/bunkerweb/frontend/nginx.conf' },
	{ label: 'C. OPERATIONS.md embedded block', file: 'docs/OPERATIONS.md' },
	{ label: 'D. indexer.conf', file: 'ops/nginx/indexer.conf' }
];

for (const s of SURFACES) {
	const res = healthStripEffective(read(s.file));
	if (res.ok) ok(`${s.label} strips X-Morphit-Local-Health on /v1/health (${res.reason})`);
	else bad(`${s.label} strips X-Morphit-Local-Health on /v1/health`, res.reason);
}

// ── E. Every strip uses the empty-string value (never forwards a
//      client-supplied value via a typo like `$http_...`). ──
{
	let leak: string | null = null;
	for (const s of SURFACES) {
		const text = read(s.file);
		const occ = text.match(/proxy_set_header\s+X-Morphit-Local-Health\s+([^;]+);/g) ?? [];
		for (const line of occ) {
			if (!/X-Morphit-Local-Health\s+""\s*$/.test(line.replace(/;$/, ''))) leak = `${s.file}: ${line.trim()}`;
		}
	}
	if (leak === null) ok('E. every X-Morphit-Local-Health strip uses the empty-string value');
	else bad('E. every X-Morphit-Local-Health strip uses the empty-string value', leak);
}

// ─── Report ──────────────────────────────────────────────────────────
console.log('');
console.log('──────────────────────────────────────────────────────');
if (fail > 0) {
	console.log(`✗ ${fail}/${pass + fail} scenarios failed`);
	process.exit(1);
}
console.log('✓ operator-only price-feed health header is stripped on every public edge surface');
console.log(`✓ all ${pass} scenarios passed`);
