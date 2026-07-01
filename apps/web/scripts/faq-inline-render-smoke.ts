#!/usr/bin/env tsx
/**
 * apps/web/scripts/faq-inline-render-smoke.ts  (cp218)
 *
 * FAQ answers are authored with light inline markdown (`**bold**`,
 * `*italic*`, `` `code` ``, the odd `[text](url)`). The visible answer used to
 * print that markup as literal text; renderFaqInline() now turns it into safe
 * HTML (the JSON-LD path keeps using stripMarkdown — see
 * faq-jsonld-no-markdown-smoke). This pins:
 *   - each inline construct renders to the right tag
 *   - it is XSS-safe (input escaped first; unsafe link schemes left inert)
 *   - code spans are NOT emphasis-processed (so `/v1/*` stays a literal path)
 *   - and a CORPUS check that the renderer consumes every bold / code / link
 *     marker actually present in all 10 locales (no literal markup leaks).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFaqInline } from '../src/lib/faq/renderInline.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = resolve(HERE, '..', 'src', 'lib', 'i18n', 'locales');

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

// ── Per-construct rendering ──────────────────────────────────────────
{
	const r = renderFaqInline('This is **bold** here.');
	if (r === 'This is <strong>bold</strong> here.') ok('bold → <strong>');
	else bad('bold render wrong', r);
}
{
	const r = renderFaqInline('Sign with your *posting* key.');
	if (r === 'Sign with your <em>posting</em> key.') ok('italic → <em>');
	else bad('italic render wrong', r);
}
{
	const r = renderFaqInline('Hit `/v1/orderbook` now.');
	if (r === 'Hit <code>/v1/orderbook</code> now.') ok('code → <code>');
	else bad('code render wrong', r);
}
{
	const r = renderFaqInline('See [the docs](https://example.com/api).');
	if (
		r.includes('<a href="https://example.com/api"') &&
		r.includes('target="_blank"') &&
		r.includes('rel="noopener noreferrer"') &&
		r.includes('>the docs</a>')
	)
		ok('external link → <a target=_blank rel=noopener>');
	else bad('external link render wrong', r);
}
{
	const r = renderFaqInline('See [the FAQ](/faq).');
	if (r.includes('<a href="/faq"') && !r.includes('target="_blank"') && r.includes('>the FAQ</a>'))
		ok('internal link → <a> without target');
	else bad('internal link render wrong', r);
}

// ── XSS / safety ─────────────────────────────────────────────────────
{
	const r = renderFaqInline('<script>alert(1)</script> & <b>x</b>');
	if (!r.includes('<script>') && r.includes('&lt;script&gt;') && r.includes('&amp;'))
		ok('HTML is escaped (no raw <script>, & → &amp;)');
	else bad('HTML escaping failed', r);
}
{
	const r = renderFaqInline('[click](javascript:alert(1))');
	if (!/<a[\s>]/.test(r) && !/href=/.test(r)) ok('unsafe javascript: link left inert (no anchor)');
	else bad('unsafe link was turned into an anchor', r);
}
{
	const r = renderFaqInline('[x](vbscript:msgbox(1))');
	if (!/<a[\s>]/.test(r) && !/href=/.test(r)) ok('unsafe vbscript: link left inert (no anchor)');
	else bad('vbscript link turned into an anchor', r);
}
{
	// `*` inside code is a literal path wildcard, NOT italic.
	const r = renderFaqInline('Anything under `/v1/*` is stable.');
	if (r === 'Anything under <code>/v1/*</code> is stable.') ok('code wildcard `/v1/*` not italicized');
	else bad('code wildcard mishandled', r);
}
{
	// Markup inside code must stay literal (escaped), not bold/italic.
	const r = renderFaqInline('Run `git commit -m "**wip**"`.');
	if (r.includes('<code>') && !r.includes('<strong>') && r.includes('**wip**'))
		ok('bold markers inside code stay literal');
	else bad('code content was emphasis-processed', r);
}
{
	// Newlines are preserved verbatim (caller renders with pre-line).
	const r = renderFaqInline('Line one.\n\nLine two.');
	if (r === 'Line one.\n\nLine two.') ok('newlines preserved verbatim');
	else bad('newlines altered', JSON.stringify(r));
}
{
	const r = renderFaqInline('');
	if (r === '') ok('empty input → empty output');
	else bad('empty input wrong', r);
}

// ── Corpus: every bold/code/link marker in all 10 locales is consumed ─
const files = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));
let leftover = 0;
const samples: string[] = [];
for (const f of files) {
	const json = JSON.parse(readFileSync(join(LOCALES_DIR, f), 'utf8')) as {
		faq?: { entries?: Record<string, { a?: string }> };
	};
	const entries = json.faq?.entries ?? {};
	for (const [key, v] of Object.entries(entries)) {
		const html = renderFaqInline(v.a ?? '');
		// After rendering there must be no leftover bold markers, no backticks
		// (all code became <code>), and no leftover [text](url) link syntax.
		if (html.includes('**') || /`/.test(html) || /\[[^\]\n]+\]\([^)\n]+\)/.test(html)) {
			leftover++;
			if (samples.length < 5) samples.push(`${f}:${key}`);
		}
	}
}
if (leftover === 0)
	ok(`no leftover bold/code/link markup in rendered answers across ${files.length} locales`);
else bad(`${leftover} rendered answers still contain literal markup`, samples.join(', '));

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 faq-inline-render smoke FAILED');
	process.exit(1);
}
console.log('\u2713 inline markdown renders to safe HTML; code/link protected; corpus clean');
console.log(`\u2713 all ${pass} faq-inline-render scenarios passed`);
