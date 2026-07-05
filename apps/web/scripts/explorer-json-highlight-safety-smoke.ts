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

import { highlightJsonToHtml, expandNestedJsonStrings } from '../src/lib/explorer/jsonHighlight.ts';

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

// ── expandNestedJsonStrings (cp411): the tx op view parses JSON-in-strings
//    (e.g. a custom_json `json` field) before pretty-printing so nested keys
//    indent instead of showing one escaped line. Pin: it expands objects/arrays,
//    leaves ordinary/numeric strings alone, is bounded, and stays SAFE when its
//    output is fed back through the highlighter. ────────────────────────────
scenario("custom_json 'json' field expands into an indented object", () => {
	const op = {
		id: 'morphit_read_v1',
		json: '{"v":1,"peer":"kentest2","last_read_at":"2026-07-03T23:28:55.291Z","ts":1783121335}'
	};
	const out = JSON.stringify(expandNestedJsonStrings(op), null, 2);
	assert(/"json": \{/.test(out), 'json field should become a nested object');
	assert(/"peer": "kentest2"/.test(out), 'nested keys should be on their own lines');
	// The escaped one-liner must be gone.
	assert(!out.includes('\\"peer\\"'), 'nested JSON should no longer be an escaped string');
});

scenario('plain + numeric strings are NOT retyped; valid array string expands', () => {
	const v = expandNestedJsonStrings({
		memo: 'orange trees for sale',
		num: '42',
		arr: '[1,2,3]',
		notjson: '{oops'
	}) as Record<string, unknown>;
	assert(v.memo === 'orange trees for sale', 'memo stays a string');
	assert(v.num === '42', 'numeric string stays a string');
	assert(Array.isArray(v.arr), 'valid array-string expands to an array');
	assert(v.notjson === '{oops', 'invalid JSON stays the original string');
});

scenario('expander output stays safe through the highlighter (no raw <script>)', () => {
	const evil = { json: '{"x":"<script>alert(1)</script>"}' };
	const html = highlightJsonToHtml(JSON.stringify(expandNestedJsonStrings(evil), null, 2));
	assertNoRawHtml(stripAllowedSpans(html), 'expanded-then-highlighted evil op');
});

scenario('deeply nested input is depth-bounded (no throw/hang)', () => {
	// Nest well beyond the depth cap (8). Each level re-stringifies the prior,
	// so size grows ~2x/level — keep it modest (12) to stay under V8's max
	// string length while still exercising the cap.
	let s: unknown = { leaf: 1 };
	for (let i = 0; i < 12; i++) s = { inner: JSON.stringify(s) };
	// Must return without throwing; layers past the cap remain strings.
	const out = JSON.stringify(expandNestedJsonStrings(s), null, 2);
	assert(typeof out === 'string' && out.length > 0, 'expander should return a string');
	// Past the depth cap, at least one inner layer is still an escaped string.
	assert(out.includes('\\"inner\\"'), 'a layer past the cap should stay an escaped string');
});

scenario('multi-line string VALUES render with real line breaks (terms / post body)', () => {
	// cp422 — an order's `terms` and a post `body` are multi-line markdown.
	// The renderer shows their \n as REAL breaks (readable) while keeping
	// every literal character HTML-escaped, so a hostile </span><script>
	// pasted inside a multi-line value stays inert.
	const op = {
		body: '# H\n\n**bold** and *it*\n\n> quote\n\n1. one\n2. two\n\n</span><script>alert(1)</script>'
	};
	const html = highlightJsonToHtml(JSON.stringify(expandNestedJsonStrings(op), null, 2));
	assert(html.includes('# H\n'), 'value newlines must render as real line breaks');
	assert(!html.includes('# H\\n'), 'no literal \\n escape should remain after the header');
	assert(html.includes('&gt; quote'), 'blockquote > must render as &gt; (normal char, never rejected)');
	assert(!html.includes('<script>'), 'raw <script> in a multi-line value must be escaped');
	assert(html.includes('&lt;/span&gt;&lt;script&gt;'), 'the injected tags must be escaped, not literal');
	assertNoRawHtml(html, 'multiline-value');
});

console.log(`\n${'─'.repeat(56)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
