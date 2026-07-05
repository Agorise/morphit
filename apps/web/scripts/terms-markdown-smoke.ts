/**
 * Terms restricted-markdown smoke (cp406).
 *
 * Locks two things:
 *  1. parseTermsMarkdown() — the pure parser behind TermsText.svelte. Covers
 *     the allowed subset (headings 1–3, bold, italics, ul/ol lists,
 *     blockquotes, hr, line feeds) and — critically — that NO raw HTML ever
 *     survives as markup: every leaf is plain text (rendered through Svelte
 *     escaping), so an attacker-authored `terms` string can never become live
 *     DOM. This is the highest-risk free-text input in the app, so the XSS
 *     invariant is regression-locked here.
 *  2. stripMarkdown() — the compact-card path (single plain line) now also
 *     strips headings, horizontal rules, and blockquote markers.
 *
 * cp413 — added blockquotes.
 *
 * Usage: tsx apps/web/scripts/terms-markdown-smoke.ts
 */

import { parseTermsMarkdown, type TermsBlock, type TermsInline } from '../src/lib/utils/termsMarkdown.ts';
import { stripMarkdown } from '../src/lib/seo/stripMarkdown.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assert(cond: boolean, label: string): void {
	if (!cond) throw new Error(label);
}

/** Concatenate every leaf's text across a block tree — used to prove no HTML
 *  markup ever appears as a tag (it's all inert text). */
function flatText(blocks: TermsBlock[]): string {
	const parts: string[] = [];
	const pushRuns = (runs: TermsInline[]) => {
		for (const r of runs) parts.push(r.v);
	};
	for (const b of blocks) {
		if (b.type === 'heading' || b.type === 'paragraph' || b.type === 'blockquote') pushRuns(b.runs);
		else if (b.type === 'ul' || b.type === 'ol') b.items.forEach(pushRuns);
	}
	return parts.join('\u0001');
}

console.log('terms-markdown-smoke: parseTermsMarkdown + stripMarkdown');

scenario('empty / null input → no blocks', () => {
	assert(parseTermsMarkdown('').length === 0, 'empty');
	assert(parseTermsMarkdown(null).length === 0, 'null');
	assert(parseTermsMarkdown(undefined).length === 0, 'undefined');
});

scenario('headings levels 1–3 (deeper capped at 3)', () => {
	const b = parseTermsMarkdown('# One\n\n## Two\n\n### Three\n\n###### Six');
	assert(b.length === 4, `count ${b.length}`);
	assert(b[0].type === 'heading' && b[0].level === 1, 'h1');
	assert(b[1].type === 'heading' && b[1].level === 2, 'h2');
	assert(b[2].type === 'heading' && b[2].level === 3, 'h3');
	assert(b[3].type === 'heading' && b[3].level === 3, 'h6 capped to 3');
});

scenario('bold + italic inline runs', () => {
	const b = parseTermsMarkdown('a **bold** and *italic* end');
	assert(b.length === 1 && b[0].type === 'paragraph', 'one paragraph');
	if (b[0].type !== 'paragraph') throw new Error('narrow');
	const kinds = b[0].runs.map((r) => r.t).join(',');
	assert(kinds.includes('bold'), 'has bold');
	assert(kinds.includes('italic'), 'has italic');
	const bold = b[0].runs.find((r) => r.t === 'bold');
	assert(bold?.v === 'bold', 'bold text');
});

scenario('unordered list gathers consecutive items', () => {
	const b = parseTermsMarkdown('intro\n\n- one\n- two\n- three');
	assert(b.length === 2, `count ${b.length}`);
	assert(b[1].type === 'ul', 'ul type');
	if (b[1].type !== 'ul') throw new Error('narrow');
	assert(b[1].items.length === 3, `items ${b[1].items.length}`);
});

scenario('ordered list gathers consecutive items', () => {
	const b = parseTermsMarkdown('1. first\n2. second');
	assert(b.length === 1 && b[0].type === 'ol', 'ol');
	if (b[0].type !== 'ol') throw new Error('narrow');
	assert(b[0].items.length === 2, `items ${b[0].items.length}`);
});

scenario('horizontal rule as its own block', () => {
	const b = parseTermsMarkdown('above\n\n---\n\nbelow');
	assert(b.some((x) => x.type === 'hr'), 'has hr');
});

scenario('blockquote: single line becomes a blockquote block', () => {
	const b = parseTermsMarkdown('> quoted text');
	assert(b.length === 1 && b[0].type === 'blockquote', `got ${b[0]?.type}`);
	if (b[0].type !== 'blockquote') throw new Error('narrow');
	assert(b[0].runs.map((r) => r.v).join('') === 'quoted text', 'marker stripped');
});

scenario('blockquote: consecutive > lines gather into one block, newlines kept', () => {
	const b = parseTermsMarkdown('> line one\n> line two');
	assert(b.length === 1 && b[0].type === 'blockquote', `count ${b.length}`);
	if (b[0].type !== 'blockquote') throw new Error('narrow');
	const text = b[0].runs.map((r) => r.v).join('');
	assert(text.includes('line one') && text.includes('line two'), 'both lines');
	assert(text.includes('\n'), 'internal newline preserved');
});

scenario('blockquote: a non-> line ends the quote (paragraph follows)', () => {
	const b = parseTermsMarkdown('> quoted\nafter');
	assert(b.length === 2, `count ${b.length}`);
	assert(b[0].type === 'blockquote', 'first is blockquote');
	assert(b[1].type === 'paragraph', 'second is paragraph');
});

scenario('blockquote: inline emphasis + Blurt image link work inside a quote', () => {
	const b = parseTermsMarkdown('> see **bold** and https://img.blurt.blog/x.png');
	if (b[0].type !== 'blockquote') throw new Error('narrow');
	const kinds = b[0].runs.map((r) => r.t);
	assert(kinds.includes('bold'), 'bold inside quote');
	const link = b[0].runs.find((r) => r.t === 'link');
	assert(!!link && link.href.startsWith('https://img.blurt.blog/'), 'safe blurt link inside quote');
});

scenario('blockquote: a `>` mid-line does NOT start a quote', () => {
	const b = parseTermsMarkdown('price a > price b');
	assert(b.length === 1 && b[0].type === 'paragraph', `got ${b[0]?.type}`);
});

scenario('blockquote XSS: raw HTML inside a quote stays inert text', () => {
	const b = parseTermsMarkdown('> <script>alert(1)</script> <img src=x onerror=alert(2)>');
	assert(b[0]?.type === 'blockquote', 'is a blockquote');
	const flat = flatText(b);
	assert(flat.includes('<script>'), 'script preserved as text');
	assert(flat.includes('onerror='), 'onerror preserved as text');
	// Only inline run types the renderer knows how to escape may appear.
	if (b[0].type === 'blockquote') {
		for (const r of b[0].runs) assert(['text', 'bold', 'italic', 'link'].includes(r.t), `run ${r.t}`);
	}
});

scenario('line feeds preserved inside a paragraph', () => {
	const b = parseTermsMarkdown('line one\nline two');
	assert(b.length === 1 && b[0].type === 'paragraph', 'single paragraph');
	if (b[0].type !== 'paragraph') throw new Error('narrow');
	const text = b[0].runs.map((r) => r.v).join('');
	assert(text.includes('\n'), 'newline kept');
});

scenario('XSS: raw HTML stays inert text, never a markup node', () => {
	const evil = '<script>alert(1)</script> <img src=x onerror=alert(2)> **b**';
	const b = parseTermsMarkdown(evil);
	const flat = flatText(b);
	// The literal angle-bracket text must survive verbatim as TEXT (Svelte will
	// entity-escape it at render). There is no block/run type that emits tags.
	assert(flat.includes('<script>'), 'script tag preserved as text');
	assert(flat.includes('onerror='), 'onerror preserved as text');
	// No run type other than text/bold/italic/link exists — assert the union.
	for (const block of b) {
		if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'blockquote') {
			for (const r of block.runs) assert(['text', 'bold', 'italic', 'link'].includes(r.t), `run ${r.t}`);
		}
	}
});

scenario('Blurt image link becomes a link run; other urls stay text', () => {
	const b = parseTermsMarkdown('see https://img.blurt.blog/x.png here and https://evil.example/y');
	if (b[0].type !== 'paragraph') throw new Error('narrow');
	const link = b[0].runs.find((r) => r.t === 'link');
	assert(!!link, 'blurt image is a link run');
	assert(!!link && link.href.startsWith('https://img.blurt.blog/'), 'safe href');
	// The non-blurt url must NOT become a link.
	const other = b[0].runs.filter((r) => r.t === 'link');
	assert(other.length === 1, 'only the blurt url links');
});

scenario('hyperlink: [text](https url) becomes a link run with custom text', () => {
	const b = parseTermsMarkdown('Read [our FAQ](https://morphit.io/faq) first');
	if (b[0].type !== 'paragraph') throw new Error('narrow');
	const link = b[0].runs.find((r) => r.t === 'link');
	assert(!!link, 'has a link run');
	assert(link?.v === 'our FAQ', `label "${link?.v}"`);
	assert(link?.href === 'https://morphit.io/faq', `href "${link?.href}"`);
	// surrounding text preserved
	const text = b[0].runs.map((r) => r.v).join('');
	assert(text.includes('Read ') && text.includes(' first'), 'surrounding text kept');
});

scenario('hyperlink: safe schemes (http/mailto) link, others do not', () => {
	for (const [url, isLink] of [
		['https://a.example', true],
		['http://onion.example', true],
		['mailto:seller@example.com', true],
		['matrix:r/room:server', true]
	] as const) {
		const b = parseTermsMarkdown(`x [label](${url}) y`);
		const has = b[0].type === 'paragraph' && b[0].runs.some((r) => r.t === 'link');
		assert(has === isLink, `${url} → link=${has}`);
	}
});

scenario('hyperlink XSS: javascript:/data:/vbscript: schemes are NEVER links (stay inert text)', () => {
	for (const url of [
		'javascript:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'vbscript:msgbox(1)',
		'file:///etc/passwd'
	]) {
		const b = parseTermsMarkdown(`click [here](${url})`);
		assert(b[0]?.type === 'paragraph', 'paragraph');
		if (b[0].type !== 'paragraph') throw new Error('narrow');
		// NO link run — the dangerous scheme must not produce an href.
		assert(!b[0].runs.some((r) => r.t === 'link'), `${url} must not link`);
		// It survives as inert text (Svelte will entity-escape it at render).
		const flat = flatText(b);
		assert(flat.includes('[here]'), `${url} left as literal text`);
	}
});

scenario('hyperlink: works inside a blockquote; a bad scheme there is also inert', () => {
	const ok = parseTermsMarkdown('> see [site](https://example.com)');
	assert(ok[0]?.type === 'blockquote' && ok[0].runs.some((r) => r.t === 'link'), 'safe link in quote');
	const bad = parseTermsMarkdown('> see [x](javascript:alert(1))');
	assert(
		bad[0]?.type === 'blockquote' && !bad[0].runs.some((r) => r.t === 'link'),
		'bad scheme in quote is inert'
	);
});

scenario('parser is total on odd markers (never throws)', () => {
	for (const s of ['*', '**', '***', '# ', '- ', '1.', '   ', '*a', 'a*', '__x']) {
		parseTermsMarkdown(s); // must not throw
	}
});

// ── stripMarkdown extension: headings + hr (cp406) ──────────────────────────
scenario('stripMarkdown drops heading markers', () => {
	assert(stripMarkdown('# Title') === 'Title', `got "${stripMarkdown('# Title')}"`);
	assert(stripMarkdown('### Sub head') === 'Sub head', `got "${stripMarkdown('### Sub head')}"`);
});
scenario('stripMarkdown drops horizontal rules', () => {
	const out = stripMarkdown('a\n\n---\n\nb');
	assert(!out.includes('---'), `hr leaked: "${out}"`);
	assert(out.includes('a') && out.includes('b'), 'text kept');
});
scenario('stripMarkdown drops blockquote markers', () => {
	const out = stripMarkdown('> quoted line');
	assert(!out.includes('>'), `blockquote marker leaked: "${out}"`);
	assert(out.includes('quoted line'), 'quoted text kept');
});
scenario('stripMarkdown drops ordered-list markers (N.)', () => {
	const out = stripMarkdown('1. first\n2. second\n3. third');
	assert(!/\d+\.\s/.test(out), `ordered marker leaked: "${out}"`);
	assert(out.includes('first') && out.includes('third'), 'items kept');
});
scenario('stripMarkdown drops star + dash bullets (incl. first line)', () => {
	const star = stripMarkdown('* one\n* two');
	assert(!/[*]/.test(star), `star bullet leaked: "${star}"`);
	const dash = stripMarkdown('- a\n- b');
	assert(!/(^|\s)-\s/.test(dash), `dash bullet leaked: "${dash}"`);
});
scenario('stripMarkdown: NO markdown marker survives a kitchen-sink (OrderCard slice is always clean)', () => {
	const out = stripMarkdown(
		'# H1\n\n## H2\n\n**bold** and *italic* and `code`\n\n1. num one\n2. num two\n* star\n- dash\n\n> a quote\n\n---\n\nsee [our FAQ](https://morphit.io/faq) and https://img.blurt.blog/x.png'
	);
	// single line
	assert(!out.includes('\n'), 'collapsed to one line');
	// no surviving markdown syntax markers
	assert(!/[#*`]/.test(out), `emphasis/heading/code marker leaked: "${out}"`);
	assert(!/\]\(/.test(out), `raw link syntax leaked: "${out}"`);
	assert(!/(^|\s)-\s|\d+\.\s|(^|\s)>\s/.test(out), `list/quote marker leaked: "${out}"`);
	// content survives as plain text
	assert(out.includes('bold') && out.includes('our FAQ'), 'text content kept');
});
scenario('stripMarkdown collapses to a single line', () => {
	const out = stripMarkdown('# H\n\n- one\n- two\n\n**bold** *ital*');
	assert(!out.includes('\n'), 'single line');
	assert(!out.includes('#') && !out.includes('*'), `markers leaked: "${out}"`);
});

console.log(`\nterms-markdown-smoke: ${scenarios - failures}/${scenarios} passed`);
if (failures > 0) {
	console.log(`terms-markdown-smoke: ${failures} FAILED`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} terms-markdown scenarios passed`);
