#!/usr/bin/env tsx
/**
 * external-link-hygiene smoke — cp297.
 *
 * PRIVACY + SECURITY. Every anchor that points at a literal external
 * https(s) URL MUST open in a fresh tab (`target="_blank"`) and carry
 * `rel="noopener noreferrer"`:
 *   - `noreferrer` keeps the destination from learning WHICH Morphit page
 *     the user came from (defense-in-depth on top of the site-wide
 *     `Referrer-Policy: no-referrer` header + the app.html referrer meta).
 *   - `noopener` stops the opened page from reaching back through
 *     `window.opener` (reverse-tabnabbing).
 *   - `target="_blank"` is the operator's explicit ask that repo / doc
 *     links don't navigate away from the app.
 *
 * SCOPE: only anchors with a LITERAL `href="https?://host..."` are
 * checked. Same-origin/relative links (`/canary.txt`), the project's own
 * `morphit.io`, XML/JSON-LD namespace IRIs (w3.org, schema.org), and
 * example/test placeholders are intentionally exempt. Dynamic hrefs
 * (`href={safeContact}`) are governed by their own validators + the
 * global no-referrer policy and are not statically checkable here.
 *
 * Tamper test: a synthetic external anchor missing target/rel must be
 * flagged.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(__dirname, '..', 'src');

const EXEMPT_HOST = /(?:^|\/\/|@|\.)(?:morphit\.io|w3\.org|schema\.org|example\.com|example\.org|morphit\.local|localhost|tracker\.example)(?:[/"'>]|$)|\.invalid|\.example\b/;

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...walk(p));
		else if (p.endsWith('.svelte')) out.push(p);
	}
	return out;
}

/** Find external-literal-http anchors lacking target=_blank + noopener+noreferrer.
 *  Returns a list of "file:line  host" offender strings. */
function findOffenders(text: string, label: string): string[] {
	const offenders: string[] = [];
	const re = /<a\b[^>]*?href=("|\{?[`"'])?\s*https?:\/\/[^>]*?>/gs;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const tag = m[0];
		if (EXEMPT_HOST.test(tag)) continue;
		const okBlank = tag.includes('target="_blank"') || tag.includes("target='_blank'");
		const okRel = tag.includes('noopener') && tag.includes('noreferrer');
		if (!(okBlank && okRel)) {
			const line = text.slice(0, m.index).split('\n').length;
			const host = /https?:\/\/([a-z0-9.-]+)/i.exec(tag);
			offenders.push(`${label}:${line}  host=${host ? host[1] : '?'}`);
		}
	}
	return offenders;
}

let pass = 0;
let fail = 0;
const ok = (m: string): void => {
	console.log(`  \u2713 ${m}`);
	pass++;
};
const bad = (m: string): void => {
	console.error(`  \u2717 ${m}`);
	fail++;
};

const files = walk(WEB_SRC);
const allOffenders: string[] = [];
for (const f of files) {
	allOffenders.push(...findOffenders(readFileSync(f, 'utf8'), relative(WEB_SRC, f)));
}

if (allOffenders.length === 0) {
	ok(`all external <a https> links across ${files.length} components open in a new tab with noopener+noreferrer`);
} else {
	bad(`${allOffenders.length} external link(s) missing target=_blank and/or rel="noopener noreferrer":`);
	for (const o of allOffenders) console.error(`      - ${o}`);
}

// ── Targeted guard for the download page's source-mirror cards. ──
// They render one anchor per mirror via a DYNAMIC href ({m.url}), which
// the literal-href scan above intentionally skips — but they ARE the
// off-site link surface (every source-code mirror: GitHub, Codeberg, …),
// and privacy is priority #1, so they must carry the same target + rel.
// Assert it directly so a future edit that drops the rel is caught here
// rather than silently leaking a Referer from the download page.
{
	const dlPath = join(WEB_SRC, 'routes', '[lang]', 'download', '+page.svelte');
	let dl = '';
	try {
		dl = readFileSync(dlPath, 'utf8');
	} catch {
		bad(`download page not found at ${relative(WEB_SRC, dlPath)} — did the route move?`);
	}
	const anchor = /<a\b[^>]*href=\{m\.url\}[^>]*>/s.exec(dl);
	if (!anchor) {
		bad('download source-mirror anchor (href={m.url}) not found — did the {#each MIRRORS} loop change?');
	} else {
		const tag = anchor[0];
		const good =
			(tag.includes('target="_blank"') || tag.includes("target='_blank'")) &&
			tag.includes('noopener') &&
			tag.includes('noreferrer');
		if (good) {
			ok('download source-mirror cards (dynamic href={m.url}) carry target=_blank + noopener+noreferrer');
		} else {
			bad(`download source-mirror cards missing privacy rel: ${tag.replace(/\s+/g, ' ').slice(0, 140)}`);
		}
	}
}

// ── Tamper test: a synthetic offender must be caught. ──
{
	const offending = '<a href="https://tracker.evil-cdn.net/pixel.gif" class="x">leak</a>';
	const caught = findOffenders(offending, 'synthetic').length === 1;
	if (caught) ok('tamper caught: a synthetic external link without target/rel is flagged');
	else bad('tamper NOT caught: synthetic external link without target/rel slipped through (toothless)');
}
// ── Tamper test: a compliant synthetic anchor must NOT be flagged (no false positive). ──
{
	const compliant = '<a href="https://tracker.evil-cdn.net/pixel.gif" target="_blank" rel="noopener noreferrer">ok</a>';
	const clean = findOffenders(compliant, 'synthetic').length === 0;
	if (clean) ok('no false positive: a compliant external link passes');
	else bad('false positive: a compliant external link was wrongly flagged');
}

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`\u2713 all ${pass} scenarios passed`);
