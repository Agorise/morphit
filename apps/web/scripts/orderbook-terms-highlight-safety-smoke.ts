#!/usr/bin/env tsx
/**
 * orderbook-terms-highlight-safety smoke — HIGH-SECURITY regression net.
 *
 * The orderbook's free-text "Order details" filter (cp411) highlights the
 * searched word(s) inside each card's terms preview by rendering
 * `highlightMatches(...)` output via `{@html}`. Order terms are user-authored
 * and attacker-controllable, so this smoke pins the security contract so a
 * later change can't quietly make the highlighter unsafe:
 *
 *   1. adversarial terms (`<script>`, `<img onerror=…>`, `&`, quotes) are fully
 *      HTML-escaped — no raw `<`/`>` survives outside the one `<mark>` wrapper;
 *   2. the ONLY markup emitted is `<mark class="…">` with a STATIC class (no
 *      attacker bytes ever land in a tag or attribute);
 *   3. matching is correct: case-insensitive, multi-token, phrase-priority
 *      (a longer phrase wins over its constituent words), regex-special tokens
 *      are treated literally, and empty tokens are a no-op passthrough.
 */

import { highlightMatches } from '../src/lib/utils/highlightMatches.ts';

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

/** Remove the whitelisted <mark> wrappers; anything left with a raw `<`/`>` is
 *  a leak. */
function stripMarks(html: string): string {
	return html.replace(/<mark class="[^"]*">/g, '').replace(/<\/mark>/g, '');
}
function assertNoRawHtml(html: string, label: string): void {
	const stripped = stripMarks(html);
	assert(!/[<>]/.test(stripped), `raw < or > survived escaping in: ${label}`);
}

scenario('adversarial terms are escaped; only <mark> is injected', () => {
	const html = highlightMatches('<script>alert(1)</script> selling orange trees', ['orange']);
	assert(!html.includes('<script>'), 'raw <script> must not survive');
	assert(html.includes('&lt;script&gt;'), 'script tag should be escaped');
	assert(html.includes('<mark class="'), 'the match should be marked');
	assertNoRawHtml(html, 'script payload in terms');
});

scenario('an <img onerror> payload in terms cannot inject an attribute', () => {
	const html = highlightMatches('<img src=x onerror=alert(1)> car wash', ['car wash']);
	assert(!/onerror=/.test(stripMarks(html)) || html.includes('&lt;img'), 'img tag must be escaped');
	assertNoRawHtml(html, 'img onerror in terms');
	// The only tags present are <mark>/</mark>.
	const strayTag = /<(?!mark class="[^"]*">|\/mark>)/.test(html);
	assert(!strayTag, 'a tag other than <mark> was emitted');
});

scenario('a token that is itself markup is escaped inside the mark', () => {
	const html = highlightMatches('a <b> tag', ['<b>']);
	assert(!html.includes('<b>'), 'raw <b> must not survive even as the matched token');
	assert(html.includes('<mark class="') && html.includes('&lt;b&gt;'), 'matched token escaped in mark');
});

scenario('phrase beats its constituent words (single span)', () => {
	const html = highlightMatches('Selling orange trees near the park', ['orange trees']);
	assert((html.match(/<mark/g) || []).length === 1, 'phrase should be one mark');
	assert(html.includes('>orange trees</mark>'), 'phrase content marked');
});

scenario('multi-token, case-insensitive matching', () => {
	const html = highlightMatches('CAR WASH and Dog Walking', ['car wash', 'dog walking']);
	assert((html.match(/<mark/g) || []).length === 2, 'both phrases marked');
});

scenario('regex-special tokens are literal', () => {
	const html = highlightMatches('price is $5 (firm) not .50', ['$5', '(firm)', '.50']);
	assert(html.includes('>$5</mark>'), '$5 matched literally');
	assert(html.includes('>(firm)</mark>'), '(firm) matched literally');
	assert(html.includes('>.50</mark>'), '.50 matched literally');
});

scenario('empty tokens → escaped passthrough, no marks', () => {
	const html = highlightMatches('a & b < c > d', []);
	assert(!html.includes('<mark'), 'no marks when no tokens');
	assert(html === 'a &amp; b &lt; c &gt; d', 'text still fully escaped');
});

scenario('non-latin terms/tokens work (Russian example)', () => {
	const html = highlightMatches('Выгул собак в парке', ['собак']);
	assert(html.includes('>собак</mark>'), 'cyrillic token marked');
	assertNoRawHtml(html, 'cyrillic terms');
});

console.log(`\n${'─'.repeat(56)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
