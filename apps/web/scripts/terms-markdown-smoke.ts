/**
 * Terms restricted-markdown smoke (cp406).
 *
 * Locks two things:
 *  1. parseTermsMarkdown() — the pure parser behind TermsText.svelte. Covers
 *     the allowed subset (headings 1–3, bold, italics, ul/ol lists, hr, line
 *     feeds) and — critically — that NO raw HTML ever survives as markup:
 *     every leaf is plain text (rendered through Svelte escaping), so an
 *     attacker-authored `terms` string can never become live DOM. This is the
 *     highest-risk free-text input in the app, so the XSS invariant is
 *     regression-locked here.
 *  2. stripMarkdown() — the compact-card path (single plain line) now also
 *     strips headings and horizontal rules.
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
		if (b.type === 'heading' || b.type === 'paragraph') pushRuns(b.runs);
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
		if (block.type === 'heading' || block.type === 'paragraph') {
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
