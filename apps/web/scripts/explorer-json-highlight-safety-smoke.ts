#!/usr/bin/env tsx
/**
 * explorer-json-highlight-safety smoke — HIGH-SECURITY regression net.
 *
 * The explorer renders `highlightJsonToHtml(...)` output via `{@html}`. The
 * JSON it highlights is chain-derived and attacker-controlled (an op's string
 * values — and even key names — can be anything). This smoke pins the security
 * contract so a later change can't quietly make the highlighter unsafe:
 *
 *   1. adversarial content (`<script>`, `</span>`, `&`, quotes, `onerror=`)
 *      is fully HTML-escaped — no raw `<`/`>` survives outside the whitelisted
 *      `<span class="json-…">` / `</span>` wrappers;
 *   2. the ONLY markup emitted is spans with a fixed set of static class names
 *      (no attacker bytes ever land in a tag or attribute);
 *   3. the transform is lossless — stripping the spans and unescaping returns
 *      the exact input (so highlighting never corrupts what the operator sees);
 *   4. benign tokens get the right classes (key / string / number / bool / null).
 */

import { highlightJsonToHtml } from '../src/lib/explorer/jsonHighlight.ts';

let failures = 0;
let scenarios = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${e instanceof Error ? e.message : String(e)}`);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const ALLOWED_SPAN = /<span class="json-(?:key|string|num|bool|null)">/g;

/** Remove the whitelisted wrappers; anything left with a raw `<`/`>` is a leak. */
function stripAllowedSpans(html: string): string {
	return html.replace(ALLOWED_SPAN, '').replace(/<\/span>/g, '');
}
function assertNoRawHtml(html: string, label: string): void {
	const residue = stripAllowedSpans(html);
	assert(
		!/[<>]/.test(residue),
		`${label}: a raw < or > survived escaping (XSS leak). Residue: ${residue.slice(0, 140)}`
	);
}
/** Inverse of the highlighter's escaping, for the lossless round-trip check. */
function unhighlight(html: string): string {
	return stripAllowedSpans(html)
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

const ADVERSARIAL = {
	'</span><script>alert(1)</script>': '<img src=x onerror="alert(document.cookie)">',
	note: 'a & b < c > d "quoted" \'apostrophe\'',
	amount: 12345,
	enabled: true,
	missing: null,
	nested: { '<b>key</b>': ['<script>', '&amp;', 42, false] }
};

scenario('adversarial values + keys are fully escaped (no raw HTML tag leaks)', () => {
	const html = highlightJsonToHtml(JSON.stringify(ADVERSARIAL, null, 2));
	assert(!html.includes('<script>'), 'raw <script> present');
	assert(!html.includes('</script>'), 'raw </script> present');
	assert(!html.includes('onerror="'), 'raw onerror attribute present');
	assert(!html.includes('<img'), 'raw <img present');
	assert(html.includes('&lt;script&gt;'), 'expected escaped &lt;script&gt;');
	assertNoRawHtml(html, 'adversarial');
});

scenario('an injected </span> in a key cannot break out of its wrapper', () => {
	const html = highlightJsonToHtml(JSON.stringify({ '</span><b>x</b>': 1 }, null, 2));
	assertNoRawHtml(html, 'span-breakout');
	assert(html.includes('&lt;/span&gt;'), 'the injected close tag must be escaped, not literal');
});

scenario('only whitelisted json-* span classes appear (no other tags/attrs)', () => {
	const html = highlightJsonToHtml(JSON.stringify(ADVERSARIAL, null, 2));
	const strayTag = /<(?!span class="json-(?:key|string|num|bool|null)">|\/span>)/.test(html);
	assert(!strayTag, 'a tag other than the whitelisted json-* spans was emitted');
});

scenario('transform is lossless (strip + unescape === input)', () => {
	for (const input of [
		JSON.stringify(ADVERSARIAL, null, 2),
		JSON.stringify({ a: 1, b: 'two', c: [true, false, null], d: -3.14e2 }, null, 2),
		JSON.stringify('a bare string', null, 2),
		JSON.stringify(42, null, 2),
		'{}'
	]) {
		assert(unhighlight(highlightJsonToHtml(input)) === input, `not lossless for: ${input.slice(0, 60)}`);
	}
});

scenario('benign tokens get the right classes', () => {
	const html = highlightJsonToHtml(JSON.stringify({ key: 'val', n: 7, b: true, z: null }, null, 2));
	assert(html.includes('<span class="json-key">"key"</span>'), 'key class');
	assert(html.includes('<span class="json-string">"val"</span>'), 'string class');
	assert(html.includes('<span class="json-num">7</span>'), 'number class');
	assert(html.includes('<span class="json-bool">true</span>'), 'bool class');
	assert(html.includes('<span class="json-null">null</span>'), 'null class');
});

console.log(`\n${'─'.repeat(56)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
