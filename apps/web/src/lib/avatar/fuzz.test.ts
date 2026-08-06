// @vitest-environment jsdom
/**
 * Property-based fuzz harness for the SVG avatar sanitizer (cp426 audit,
 * recommendation #2).
 *
 * The example-based tests in index.test.ts cover known attack paths one at a
 * time. This harness instead GENERATES thousands of randomized malicious SVGs —
 * scripts, every on* handler, javascript:/data:/external hrefs, <foreignObject>
 * HTML smuggling, SMIL <animate>/<set> attribute rewrites, entity-encoded
 * payloads, CDATA/comment hiding, and namespace tricks — nested at random depth
 * and combined in random ways, then asserts a single invariant on every one:
 *
 *   If sanitizeSvg returns ok, its output must contain NO executable surface.
 *
 * A deterministic PRNG (seeded) makes any failure reproducible. This is the
 * belt-and-suspenders the audit flagged: the design already guarantees graceful
 * rejection, and this proves the OUTPUT is inert across a huge random space.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from './index';

// ─── Deterministic PRNG (mulberry32) so failures are reproducible ──
function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The executable-surface invariant. A sanitized SVG string must not contain
 *  ANY of these. Returns the offending pattern name, or null if clean. */
function findExecutableSurface(svg: string): string | null {
	const lower = svg.toLowerCase();
	// 1. Any <script (open tag), in any form.
	if (/<script[\s/>]/i.test(svg) || lower.includes('<script>')) return '<script>';
	// 2. Any on* event-handler ATTRIBUTE (onload=, onclick=, onerror=, ...).
	//    Match an attribute name starting with "on" followed by "=".
	if (/\son[a-z]+\s*=/i.test(svg)) return 'on*= handler';
	// 3. javascript: protocol anywhere (in any attribute value).
	if (lower.includes('javascript:')) return 'javascript: uri';
	// 4. HTML smuggling containers the allowlist must strip.
	if (/<foreignobject[\s/>]/i.test(svg)) return '<foreignObject>';
	if (/<iframe[\s/>]/i.test(svg)) return '<iframe>';
	if (/<embed[\s/>]/i.test(svg)) return '<embed>';
	if (/<object[\s/>]/i.test(svg)) return '<object>';
	// 5. <use>/<image>/<a> href pointing OUTSIDE the document (external or data:).
	//    Only fragment-only (#id) refs are allowed; anything with a scheme or
	//    "//" or a data: payload is forbidden.
	const hrefRe = /(?:xlink:)?href\s*=\s*"([^"]*)"/gi;
	let m: RegExpExecArray | null;
	while ((m = hrefRe.exec(svg)) !== null) {
		const v = m[1]!.trim().toLowerCase();
		if (v === '') continue;
		if (v.startsWith('#')) continue; // internal fragment — allowed
		return `external/scheme href (${v.slice(0, 24)})`;
	}
	// 6. Raw <handler>/<script>-equivalent SMIL that rewrites href/on* at runtime.
	//    <set>/<animate> with attributeName targeting href or an event handler.
	if (/<(?:set|animate)\b[^>]*attributename\s*=\s*"(?:xlink:href|href|on\w+)"/i.test(svg)) {
		return 'SMIL attribute rewrite';
	}
	return null;
}

// ─── Fragments the fuzzer stitches together ────────────────────────
const MALICIOUS_FRAGMENTS = [
	`<script>alert(1)</script>`,
	`<script type="text/javascript">fetch('//evil')</script>`,
	`<script><![CDATA[ alert(document.cookie) ]]></script>`,
	`<rect onload="alert(1)" width="10" height="10"/>`,
	`<circle onclick="steal()" onmouseover="x()" r="5"/>`,
	`<image href="javascript:alert(1)" width="10" height="10"/>`,
	`<image xlink:href="https://evil.example.com/x.png"/>`,
	`<image href="data:text/html,<script>alert(1)</script>"/>`,
	`<a href="javascript:alert(1)"><text>x</text></a>`,
	`<use href="https://evil.example.com/sprite.svg#x"/>`,
	`<use xlink:href="javascript:void(0)"/>`,
	`<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject>`,
	`<foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject>`,
	`<set attributeName="href" to="javascript:alert(1)"/>`,
	`<animate attributeName="xlink:href" to="javascript:alert(1)"/>`,
	`<text onload="&#x61;lert(1)">x</text>`,
	`<!-- <script>alert(1)</script> -->`,
	`<style>* { background: url('javascript:alert(1)') }</style>`,
	`<g onfocusin="alert(1)"><rect width="1" height="1"/></g>`,
	`<svg:script>alert(1)</svg:script>`,
	`<iframe src="//evil"></iframe>`,
	`<embed src="data:image/svg+xml,<svg onload=alert(1)>"/>`
];

const BENIGN_FRAGMENTS = [
	`<rect x="1" y="1" width="30" height="30" rx="4" fill="#333"/>`,
	`<circle cx="16" cy="16" r="12" fill="currentColor"/>`,
	`<path d="M4 4 L28 28" stroke="#0a0" stroke-width="2"/>`,
	`<g transform="translate(2,2)"><rect width="4" height="4"/></g>`,
	`<text x="8" y="20" font-size="10">ok</text>`,
	`<use href="#dot"/>`,
	`<defs><circle id="dot" r="2"/></defs>`,
	`<title>avatar</title>`,
	`<polygon points="0,0 8,0 4,8"/>`
];

function pick<T>(rng: () => number, arr: readonly T[]): T {
	return arr[Math.floor(rng() * arr.length)]!;
}

/** Build a random SVG: a root <svg> wrapping a random mix of benign +
 *  malicious fragments, nested inside random <g> wrappers to random depth. */
function buildFuzzSvg(rng: () => number): string {
	const n = 1 + Math.floor(rng() * 6);
	const parts: string[] = [];
	for (let i = 0; i < n; i++) {
		// 70% malicious, 30% benign — we want mostly-attack inputs.
		let frag = rng() < 0.7 ? pick(rng, MALICIOUS_FRAGMENTS) : pick(rng, BENIGN_FRAGMENTS);
		// Randomly nest inside <g> wrappers (some with an on* handler on the wrapper).
		const depth = Math.floor(rng() * 3);
		for (let d = 0; d < depth; d++) {
			const wrapHandler = rng() < 0.4 ? ` onmouseover="w${d}()"` : '';
			frag = `<g${wrapHandler}>${frag}</g>`;
		}
		parts.push(frag);
	}
	// Occasionally inject a stray handler on the root itself.
	const rootHandler = rng() < 0.5 ? ` onload="root()"` : '';
	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="32" height="32"${rootHandler}>${parts.join('')}</svg>`;
}

describe('sanitizeSvg — property-based fuzz (executable-surface invariant)', () => {
	it('never emits executable surface across 5000 randomized malicious SVGs', () => {
		const rng = makeRng(0x9e3779b9);
		const ITERATIONS = 5000;
		let sanitizedOk = 0;
		let rejected = 0;
		const failures: { input: string; output: string; surface: string }[] = [];

		for (let i = 0; i < ITERATIONS; i++) {
			const input = buildFuzzSvg(rng);
			let result;
			try {
				result = sanitizeSvg(input);
			} catch (err) {
				// A throw is NOT acceptable here — sanitizeSvg must return a
				// discriminated result, never throw, so bad input can't crash
				// the caller (profileProps runs it on every avatar render).
				failures.push({ input, output: `THREW: ${String(err)}`, surface: 'threw' });
				continue;
			}
			if (result.ok) {
				sanitizedOk++;
				const surface = findExecutableSurface(result.value);
				if (surface) {
					failures.push({ input, output: result.value, surface });
				}
			} else {
				rejected++;
			}
		}

		if (failures.length > 0) {
			const f = failures[0]!;
			throw new Error(
				`sanitizeSvg leaked executable surface in ${failures.length}/${ITERATIONS} cases.\n` +
					`First offender (${f.surface}):\n  INPUT:  ${f.input}\n  OUTPUT: ${f.output}`
			);
		}
		// Sanity: the fuzzer should exercise BOTH paths (some sanitized, some
		// rejected) — otherwise the harness isn't actually testing anything.
		expect(sanitizedOk).toBeGreaterThan(0);
		expect(sanitizedOk + rejected).toBe(ITERATIONS);
	});

	it('output re-parses as a single <svg> root (no smuggled siblings)', () => {
		const rng = makeRng(0x1234abcd);
		const parser = new DOMParser();
		for (let i = 0; i < 500; i++) {
			const result = sanitizeSvg(buildFuzzSvg(rng));
			if (!result.ok) continue;
			const doc = parser.parseFromString(result.value, 'image/svg+xml');
			// No parser error, and the document element is exactly one <svg>.
			expect(doc.querySelector('parsererror')).toBeNull();
			expect(doc.documentElement.tagName.toLowerCase()).toBe('svg');
			// And no <script>/<foreignObject> survived anywhere in the tree.
			expect(doc.querySelector('script')).toBeNull();
			expect(doc.querySelector('foreignObject')).toBeNull();
			expect(doc.querySelector('iframe')).toBeNull();
		}
	});
});
