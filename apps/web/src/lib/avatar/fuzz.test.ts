// @vitest-environment jsdom
/**
 * Property-based fuzz harness for the SVG avatar sanitizer (audit,
 * recommendation #2).
 *
 * The example-based tests in index.test.ts cover known attack paths one at a
 * time. This harness instead GENERATES thousands of randomized malicious SVGs —
 * scripts, every on* handler, javascript:/data:/external hrefs, <foreignObject>
 * HTML smuggling, SMIL <animate>/<set> attribute rewrites, entity-encoded
 * payloads, CDATA/comment hiding (also CDATA that the minifier would turn back
 * into markup), namespace tricks, filters and <use> copies that would freeze a
 * viewer's tab, and CSS that reaches outside the picture — nested at random
 * depth and combined in random ways, then asserts on every one:
 *
 *   If sanitizeSvg returns ok, its output contains NO executable surface,
 *   reaches nothing outside the picture, costs a bounded amount to draw
 *   (findStructuralProblem), and is a fixed point (sanitized again, the same).
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
	// 6. SMIL may only change how the picture looks. Every animation element
	//    names exactly one target (any letter case: an HTML parser restores it),
	//    and that target is a presentation or geometry attribute — never a link,
	//    an event handler, style, class or id.
	const animRe = /<(set|animate|animatetransform|animatemotion)\b([^>]*)>/gi;
	let a: RegExpExecArray | null;
	while ((a = animRe.exec(svg)) !== null) {
		const kind = a[1]!.toLowerCase();
		const attrs = a[2]!;
		const targets = [...attrs.matchAll(/\sattributename\s*=\s*"([^"]*)"/gi)].map((t) =>
			t[1]!.trim().toLowerCase()
		);
		if (kind === 'animatemotion') {
			if (targets.length > 0) return 'SMIL attribute rewrite (motion)';
		} else if (targets.length !== 1 || !SAFE_SMIL_TARGETS.has(targets[0]!)) {
			return `SMIL attribute rewrite (${targets.join('|') || 'none'})`;
		}
		// What it animates to carries no protocol, markup, escape or outside url().
		for (const v of attrs.matchAll(/\s(values|from|to|by|path)\s*=\s*"([^"]*)"/gi)) {
			const val = v[2]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
			if (/[:<>\\]/.test(val) || /url\(\s*[^\s#]/i.test(val))
				return `SMIL value (${val.slice(0, 24)})`;
		}
	}
	// 7. <feImage> loads a picture (from elsewhere, or another part of the page).
	if (/<feimage[\s/>]/i.test(svg)) return '<feImage>';
	// 8. No CDATA: the one place serialized markup is not escaped.
	if (lower.includes('<![cdata[')) return 'CDATA';
	// 9. No class (inlined, it would pick up the page's CSS) and no <style>.
	if (/\sclass\s*=/i.test(svg)) return 'class';
	if (/<style[\s/>]/i.test(svg)) return '<style>';
	// 10. Paint, references and style name nothing outside the picture: no CSS
	//     function but a colour or url(#id); no escape; style sets only
	//     presentation properties, never `filter`.
	for (const v of svg.matchAll(
		/\s(fill|stroke|clip-path|mask|filter|marker-start|marker-mid|marker-end|style)\s*=\s*"([^"]*)"/gi
	)) {
		const name = v[1]!.toLowerCase();
		const val = v[2]!
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&amp;/g, '&');
		if (/[<>\\]|\/\*/.test(val)) return `${name} escape/markup`;
		for (const f of val.matchAll(/([a-z][\w-]*)\s*\(/gi)) {
			const fn = f[1]!.toLowerCase();
			if (fn === 'url') {
				if (!/^url\(\s*(['"]?)#[^\s'"()]+\1\s*\)/i.test(val.slice(f.index)))
					return `${name} outside url()`;
			} else if (!['rgb', 'rgba', 'hsl', 'hsla'].includes(fn)) {
				return `${name} css function ${fn}()`;
			}
		}
		if (name === 'style') {
			for (const decl of val.split(';')) {
				const prop = decl.split(':')[0]!.trim().toLowerCase();
				if (prop !== '' && !SAFE_STYLE_PROPS.has(prop)) return `style property ${prop}`;
			}
		}
	}
	return null;
}

/** Style properties an avatar may set: presentation only, never `filter`,
 *  `position`, `animation`, `content`… The invariant's own list. */
const SAFE_STYLE_PROPS = new Set([
	'fill',
	'fill-opacity',
	'fill-rule',
	'stroke',
	'stroke-width',
	'stroke-linecap',
	'stroke-linejoin',
	'stroke-dasharray',
	'stroke-dashoffset',
	'stroke-opacity',
	'stroke-miterlimit',
	'opacity',
	'display',
	'visibility',
	'clip-path',
	'mask',
	'marker-start',
	'marker-mid',
	'marker-end',
	'color',
	'color-interpolation',
	'color-interpolation-filters',
	'font-family',
	'font-size',
	'font-weight',
	'font-style',
	'text-anchor',
	'dominant-baseline',
	'letter-spacing',
	'stop-color',
	'stop-opacity',
	'flood-color',
	'flood-opacity',
	'lighting-color'
]);

const SVG_NS = 'http://www.w3.org/2000/svg';
const ANIMATIONS = ['set', 'animate', 'animatetransform', 'animatemotion'];
const TIME = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:h|min|s|ms)?|[+-]?(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?`;

/**
 * The structural invariants, on the parsed output: what the picture costs a
 * viewer to draw is bounded, and nothing reaches outside it. (32 × 32
 * pictures here: an eighth is 4.)
 */
function findStructuralProblem(svg: string): string | null {
	const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
	const all = [root, ...Array.from(root.getElementsByTagName('*'))];
	const byId = new Map(all.filter((e) => e.id).map((e) => [e.id, e] as const));
	const animIds = new Set(
		all.filter((e) => ANIMATIONS.includes(e.nodeName.toLowerCase()) && e.id).map((e) => e.id)
	);
	const uses = all.filter((e) => e.nodeName.toLowerCase() === 'use');
	if (uses.length > 32) return `${uses.length} <use>`;
	for (const e of all) {
		const tag = e.nodeName.toLowerCase();
		if (e.namespaceURI !== SVG_NS) return `foreign element ${tag}`;
		const inRepeated = (() => {
			for (let p = e.parentElement; p; p = p.parentElement) {
				if (['marker', 'pattern', 'mask', 'clippath'].includes(p.nodeName.toLowerCase()))
					return true;
			}
			return false;
		})();
		if (tag === 'use') {
			if (inRepeated) return '<use> in repeated content';
			const t = byId.get((e.getAttribute('href') ?? '').slice(1));
			if (!t) return '<use> of nothing';
			if (t.nodeName.toLowerCase() === 'use' || t.getElementsByTagName('use').length > 0)
				return '<use> of a <use>';
		}
		if (e.hasAttribute('filter') && inRepeated) return 'filter in repeated content';
		if (ANIMATIONS.includes(tag)) {
			const parent = e.parentElement!.nodeName.toLowerCase();
			if (parent === 'filter' || parent.startsWith('fe')) return 'animation inside a filter';
			if (e.hasAttribute('href') || e.hasAttributeNS('http://www.w3.org/1999/xlink', 'href'))
				return 'animation href';
			const target = (e.getAttribute('attributeName') ?? '').toLowerCase();
			if (e.parentElement === root && ['x', 'y', 'width', 'height'].includes(target))
				return 'root frame animated';
			for (const name of ['begin', 'end']) {
				const v = e.getAttribute(name);
				if (v === null) continue;
				for (const item of v.split(';').map((x) => x.trim())) {
					if (new RegExp(`^(?:${TIME}|indefinite)$`).test(item)) continue;
					const sync = /^([A-Za-z_][\w-]*)\.(?:begin|end)/.exec(item);
					if (sync && animIds.has(sync[1]!)) continue;
					return `${name}="${v}"`;
				}
			}
		}
		if (tag === 'filter') {
			if (e.hasAttribute('filterUnits') || e.hasAttribute('primitiveUnits')) return 'filter units';
			for (const [a, lo, hi] of [
				['x', -1, 1],
				['y', -1, 1],
				['width', 0, 3],
				['height', 0, 3]
			] as const) {
				const raw = e.getAttribute(a);
				if (raw === null) continue;
				const n = parseFloat(raw) / (raw.trim().endsWith('%') ? 100 : 1);
				if (!(n >= lo && n <= hi)) return `filter ${a}=${raw}`;
			}
		}
		if (tag.startsWith('fe')) {
			for (const a of ['x', 'y', 'width', 'height']) {
				if (!tag.endsWith('light') && e.hasAttribute(a)) return `${tag} subregion`;
			}
			const nums = (a: string) =>
				(e.getAttribute(a) ?? '')
					.trim()
					.split(/[\s,]+/)
					.filter(Boolean)
					.map(Number);
			for (const a of ['stdDeviation', 'radius']) {
				if (nums(a).some((n) => !(n >= 0 && n <= 4))) return `${tag} ${a}`;
			}
			if (nums('numOctaves').some((n) => n > 4)) return 'numOctaves';
			if (nums('order').some((n) => n > 3)) return 'order';
		}
	}
	return null;
}

/** The attributes an avatar animation may change. Mirrors nothing: it is the
 *  invariant's own list, so a sanitizer that widens its own list past this one
 *  fails here first. */
const SAFE_SMIL_TARGETS = new Set([
	'opacity',
	'fill',
	'fill-opacity',
	'stroke',
	'stroke-width',
	'stroke-opacity',
	'stroke-dasharray',
	'stroke-dashoffset',
	'visibility',
	'display',
	'color',
	'stop-color',
	'stop-opacity',
	'offset',
	'd',
	'points',
	'cx',
	'cy',
	'r',
	'rx',
	'ry',
	'x',
	'y',
	'x1',
	'y1',
	'x2',
	'y2',
	'width',
	'height',
	'fx',
	'fy',
	'transform',
	'gradienttransform',
	'patterntransform',
	'dx',
	'dy',
	'font-size',
	'letter-spacing',
	'flood-color',
	'flood-opacity',
	'pathlength'
]);

// ─── Fragments the fuzzer stitches together ────────────────────────
const MALICIOUS_FRAGMENTS = [
	`<script>alert(1)</script>`,
	`<script type="text/javascript">fetch('//evil')</script>`,
	`<script><![CDATA[ alert(document.cookie) ]]></script>`,
	`<rect onload="alert(1)" width="10" height="10"/>`,
	`<circle onclick="steal()" onmouseover="x()" r="5"/>`,
	`<image href="javascript:alert(1)" width="10" height="10"/>`,
	`<image xlink:href="https://evil.example.com/x.png"/>`,
	`<image href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;"/>`,
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
	`<svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script>`,
	`<iframe src="//evil"></iframe>`,
	`<embed src="data:image/svg+xml,&lt;svg onload=alert(1)&gt;"/>`,
	`<set attributename="href" to="javascript:alert(1)"/>`,
	`<set attributeName="HREF" to="javascript:alert(1)"/>`,
	`<set attributeName="style" to="position:fixed;inset:0"/>`,
	`<set attributeName="class" to="fixed inset-0 z-50"/>`,
	`<animate attributeName="r" attributename="href" values="1;javascript:alert(1)" dur="1s"/>`,
	`<animate attributeName="fill" values="#000;url(https://evil.example.com/p.svg#g)" dur="1s"/>`,
	`<set attributeName="fill" to="url(data:image/svg+xml,x)"/>`,
	`<animate values="1;2" dur="1s" onbegin="alert(1)"/>`,
	`<animateTransform attributeName="onclick" type="scale" values="1;2" dur="1s"/>`,
	`<animateMotion attributeName="href" path="M0 0" dur="1s"><mpath href="https://evil.example.com/p#p"/></animateMotion>`,
	`<filter id="f"><feImage href="https://evil.example.com/t.png"/></filter>`,
	`<filter id="f"><feImage xlink:href="#dot" onload="x()"/></filter>`,
	// CDATA + the minifier: markup hidden in CDATA, with an empty <title/>,
	// <desc/> or <metadata> the minifier deletes from the serialized text.
	`<text><![CDATA[]]<title/>><script>alert(1)</script><![CDATA[]]></text>`,
	`<![CDATA[]]<desc/>><foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="//evil"/></foreignObject><![CDATA[]]>`,
	`<![CDATA[]]<metadata></metadata>><image href="https://evil.example.com/t.png"/><![CDATA[]]>`,
	`<g><![CDATA[]]<TITLE>  </title>><set attributeName="href" to="javascript:alert(1)"/><![CDATA[]]></g>`,
	// Filters and copies that freeze the viewer's tab.
	`<filter id="h"><feMorphology radius="5000"/><feGaussianBlur stdDeviation="1e9"/><feTurbulence numOctaves="1000000000"/><feConvolveMatrix order="40" kernelMatrix="1"/></filter><rect width="32" height="32" filter="url(#h)"/>`,
	`<filter id="h" filterUnits="userSpaceOnUse" x="-1e9" y="-1e9" width="2e9" height="2e9"><feGaussianBlur stdDeviation="3"><animate attributeName="stdDeviation" values="1;3000" dur=".1s" repeatCount="indefinite"/></feGaussianBlur><feOffset dx="1"><animate attributeName="dx" values="0;9" dur=".1s"/></feOffset></filter>`,
	`<defs><g id="u0"><rect width="1" height="1"/></g><g id="u1"><use href="#u0"/><use href="#u0"/></g><g id="u2"><use href="#u1"/><use href="#u1"/></g></defs><use href="#u2"/>`,
	`<marker id="mk"><rect width="9" height="9" filter="url(#b)"/><use href="#dot"/></marker>`,
	// Reaching outside the picture.
	`<rect width="4" height="4" filter="blur(5000px)" class="admin" style="position:fixed;filter:blur(99px);mask:image-set('https://evil.example.com/x.png' 1x);fill:url(https://evil.example.com/g#g)"/>`,
	`<rect width="4" height="4" fill="url(https://evil.example.com/g#g)" mask="image-set('//evil.example.com/x.png' 1x)" clip-path="url(//evil.example.com/c#c)"/>`,
	`<rect id="tgt" width="4" height="4"><set href="#tgt" attributeName="fill" to="lime" begin="tgt.click;accessKey(a);wallclock(2020-01-01T00:00:00Z)"/></rect>`,
	`<animate attributeName="width" values="1;1000000000" dur="1s"/>`,
	`<animate xmlns="http://www.w3.org/1999/xhtml" attributeName="fill" values="red"/>`
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
	`<polygon points="0,0 8,0 4,8"/>`,
	`<circle r="4"><animate attributeName="r" values="4;6;4" dur="2s" repeatCount="indefinite"/></circle>`,
	`<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -2;0 0" dur="2s" repeatCount="indefinite"/></g>`,
	`<filter id="b"><feGaussianBlur stdDeviation=".7"/></filter>`,
	`<rect width="4" height="4"><set attributeName="fill" to="url(#g)" begin="1s"/></rect>`,
	`<rect width="4" height="4" filter="url(#b)" style="fill:#c00;stroke:rgb(1,2,3)"/>`,
	`<circle r="3"><animate id="w1" attributeName="r" values="3;4" dur="1s"/><animate attributeName="r" values="4;3" dur="1s" begin="w1.end+0.5s"/></circle>`,
	`<filter id="s" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation=".7"/><feOffset dx="1"/></filter>`
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
				const again = sanitizeSvg(result.value);
				const surface =
					findExecutableSurface(result.value) ??
					findStructuralProblem(result.value) ??
					(again.ok && again.value === result.value ? null : 'not a fixed point');
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
		// Every fragment is well-formed XML, so every input reaches the cleaner:
		// an input refused unread tests nothing (3 malformed fragments used to
		// send a fifth of the runs to parse_failed).
		expect(rejected).toBe(0);
	});

	it('output re-parses as a single <svg> root (no smuggled siblings)', () => {
		const rng = makeRng(0x1234abcd);
		const parser = new DOMParser();
		for (let i = 0; i < 500; i++) {
			const result = sanitizeSvg(buildFuzzSvg(rng));
			if (!result.ok) continue;
			const doc = parser.parseFromString(result.value, 'image/svg+xml');
			// No parser error, and the document element is exactly one <svg>.
			expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
			expect(doc.documentElement.tagName.toLowerCase()).toBe('svg');
			// And no <script>/<foreignObject> survived anywhere in the tree.
			expect(doc.getElementsByTagName('script')).toHaveLength(0);
			expect(doc.getElementsByTagName('foreignObject')).toHaveLength(0);
			expect(doc.getElementsByTagName('iframe')).toHaveLength(0);
		}
	});
});
