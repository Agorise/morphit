// @vitest-environment jsdom
/**
 * The avatar sanitizer's limits (v1.21.21 deep review): what a hostile avatar
 * must not get through, besides scripts and links (index.test.ts) — markup
 * smuggled past the minifier in CDATA, filters and copies that freeze every
 * viewer's tab, animations that reach outside the picture, CSS that loads
 * pictures. The payloads are the reviewer's, which ran in Chromium.
 */

import { describe, expect, it } from 'vitest';

import { cleanStyle, MAX_FILTER_COST, MAX_USE_ELEMENTS, minifySvg, sanitizeSvg } from './index';
import DUSK_BIRD from './fixtures/animated-dusk-bird.svg?raw';

const H = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">';

function clean(svg: string): string {
	const r = sanitizeSvg(svg);
	if (!r.ok) throw new Error(`refused: ${r.code}`);
	return r.value;
}

function parse(svg: string): Element {
	return new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
}

/** Every element name in the output, lowercased. */
function tags(svg: string): string[] {
	return Array.from(parse(svg).querySelectorAll('*')).map((e) => e.nodeName.toLowerCase());
}

describe('CDATA cannot smuggle markup past the minifier', () => {
	it.each([
		[
			'script + foreignObject via <title/>',
			`${H}<![CDATA[]]<title/>><script>alert(document.domain)</script><foreignObject width="96" height="96"><div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(1)">hi</div></foreignObject><![CDATA[]]></svg>`
		],
		[
			'style + feImage + javascript link via <desc/>',
			`${H}<![CDATA[]]<desc/>><style>*{animation:k 1ms infinite}</style><filter id="f"><feImage href="data:image/svg+xml;base64,PHN2Zy8+"/></filter><a href="javascript:alert(1)"><rect width="96" height="96" filter="url(#f)"/></a><![CDATA[]]></svg>`
		],
		[
			'tracking image via <metadata></metadata>',
			`${H}<![CDATA[]]<metadata></metadata>><image href="https://evil.example/track.png"/><![CDATA[]]></svg>`
		],
		[
			'set href via <TITLE>  </title> inside text',
			`${H}<text><![CDATA[]]<TITLE>  </title>><set attributeName="href" to="javascript:alert(1)"/><![CDATA[]]></text></svg>`
		]
	])('%s', (_name, payload) => {
		const r = sanitizeSvg(payload);
		if (!r.ok) return; // refusing is fine too
		expect(r.value).not.toMatch(
			/CDATA|script|foreignobject|feimage|<style|<a[\s>]|<image|<set|javascript|evil/i
		);
		for (const t of tags(r.value)) expect(['svg', 'text']).toContain(t);
	});

	it('what is stored is a fixed point: sanitized again it comes out the same', () => {
		// The last one needs a second pass: its spaces are minified away, and an
		// emptied <svg></svg> serializes as <svg/>.
		for (const input of [
			DUSK_BIRD,
			`${H}<circle r="4"/></svg>`,
			`${H}</svg>`,
			`${H}  \n  </svg>`
		]) {
			const once = clean(input);
			expect(clean(once)).toBe(once);
		}
	});

	it('the minifier really does turn CDATA text into markup — the reason CDATA goes', () => {
		// The trap the sanitizer now closes, shown on the minifier alone.
		expect(minifySvg('<svg><![CDATA[]]<title/>><b/><![CDATA[]]></svg>')).toContain(']]><b/>');
	});
});

describe('filters are held to what a picture this size needs', () => {
	const filtered = (prims: string, attrs = '') =>
		`${H}<filter id="f"${attrs}>${prims}</filter><rect width="96" height="96" filter="url(#f)"/></svg>`;
	const attr = (svg: string, tag: string, name: string) =>
		parse(svg).getElementsByTagName(tag)[0]?.getAttribute(name);

	it('blur, spread, shift, octaves and kernel size are clamped (96 × 96: an eighth is 12)', () => {
		const out = clean(
			filtered(
				'<feGaussianBlur stdDeviation="1e9 3"/><feMorphology radius="5000"/><feDropShadow stdDeviation="99" dx="-1e6" dy="5"/><feOffset dx="1e6"/><feTurbulence numOctaves="1000000000" baseFrequency=".9"/><feConvolveMatrix order="40" kernelMatrix="1"/><feDisplacementMap scale="1e9"/>'
			)
		);
		expect(attr(out, 'feGaussianBlur', 'stdDeviation')).toBe('12 3');
		expect(attr(out, 'feMorphology', 'radius')).toBe('12');
		expect(attr(out, 'feDropShadow', 'stdDeviation')).toBe('12');
		expect(attr(out, 'feDropShadow', 'dx')).toBe('-96');
		expect(attr(out, 'feDropShadow', 'dy')).toBe('5');
		expect(attr(out, 'feOffset', 'dx')).toBe('96');
		expect(attr(out, 'feTurbulence', 'numOctaves')).toBe('4');
		expect(attr(out, 'feConvolveMatrix', 'order')).toBe('3');
		expect(attr(out, 'feDisplacementMap', 'scale')).toBe('96');
	});

	it('the limits follow the picture’s own units (a 1 × 1 viewBox allows 0.125)', () => {
		const out = clean(
			'<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 1 1"><filter id="f"><feGaussianBlur stdDeviation="5"/></filter><rect width="1" height="1" filter="url(#f)"/></svg>'
		);
		expect(attr(out, 'feGaussianBlur', 'stdDeviation')).toBe('.125');
	});

	it('the region stays a share of the shape (≤ 3 times it), in no other units', () => {
		const out = clean(
			filtered(
				'<feGaussianBlur stdDeviation="1"/>',
				' filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="-1e9" y="-30%" width="2e9" height="260%"'
			)
		);
		expect(attr(out, 'filter', 'filterUnits')).toBeNull();
		expect(attr(out, 'filter', 'primitiveUnits')).toBeNull();
		expect(attr(out, 'filter', 'x')).toBe('-1');
		expect(attr(out, 'filter', 'y')).toBe('-30%');
		expect(attr(out, 'filter', 'width')).toBe('3');
		expect(attr(out, 'filter', 'height')).toBe('260%');
	});

	it('a primitive has no region of its own', () => {
		const out = clean(filtered('<feFlood x="-1e9" y="-1e9" width="2e9" height="2e9"/>'));
		expect(parse(out).getElementsByTagName('feFlood')[0]!.attributes).toHaveLength(0);
	});

	it('nothing inside a filter is animated', () => {
		const out = clean(
			filtered(
				'<feGaussianBlur stdDeviation="2"><animate attributeName="stdDeviation" values="1;3000" dur=".01s" repeatCount="indefinite"/></feGaussianBlur><feOffset dx="1"><animate attributeName="dx" values="0;5" dur=".5s" repeatCount="indefinite"/></feOffset><feFlood><set attributeName="flood-opacity" to=".5"/></feFlood>'
			)
		);
		expect(tags(out)).not.toContain('animate');
	});

	it('the owner’s scene is within the budget: its 3 filtered shapes keep their filter', () => {
		const out = clean(DUSK_BIRD);
		expect((out.match(/filter="url\(#a\)"/g) ?? []).length).toBe(3);
	});

	it(`over the budget (${MAX_FILTER_COST}), every filter goes and every shape stays`, () => {
		// 8 shapes × 3 heavy primitives: 4 frames in 4 s for 30 of these.
		const rects = Array.from(
			{ length: 8 },
			(_, i) => `<rect x="${i}" width="96" height="96" filter="url(#f)"/>`
		).join('');
		const out = clean(
			`${H}<filter id="f"><feMorphology radius="9"/><feGaussianBlur stdDeviation="9"/><feDropShadow stdDeviation="9"/></filter>${rects}</svg>`
		);
		expect(out).not.toContain('filter="');
		expect((out.match(/<rect/g) ?? []).length).toBe(8);
	});

	it('the budget counts every <use> copy of a filtered shape', () => {
		const build = (copies: number) =>
			`${H}<defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter><g id="g"><rect width="9" height="9" filter="url(#f)"/></g></defs>${'<use href="#g"/>'.repeat(copies)}</svg>`;
		// blur costs 2: 6 copies = 12 (in), 7 copies = 14 (out).
		expect(clean(build(6))).toContain('filter="url(#f)"');
		expect(clean(build(7))).not.toContain('filter="');
	});

	it('no filter inside a marker, pattern, mask or clip path (drawn once per point / referrer)', () => {
		for (const wrap of ['marker', 'pattern', 'mask', 'clipPath']) {
			const out = clean(
				`${H}<filter id="f"><feGaussianBlur stdDeviation="2"/></filter><${wrap} id="m"><rect width="9" height="9" filter="url(#f)"/></${wrap}></svg>`
			);
			expect(out, wrap).not.toContain('filter="');
		}
	});

	it('`filter` names a <filter> of the picture, never a CSS function or an outside file', () => {
		for (const v of [
			'blur(5000px)',
			'url(#f) blur(9px)',
			'url(https://evil.example/f.svg#f)',
			'drop-shadow(0 0 99px red)'
		]) {
			expect(clean(`${H}<rect width="9" height="9" filter="${v}"/></svg>`), v).not.toContain(
				'filter='
			);
		}
		expect(clean(filtered('<feFlood/>'))).toContain('filter="url(#f)"');
	});
});

describe('<use> cannot fan out', () => {
	it('a copy of something that holds a <use> goes (5 levels of 10 froze a tab for seconds)', () => {
		let s = `${H}<defs><g id="g0"><rect width="1" height="1"/></g>`;
		for (let l = 1; l <= 5; l++) {
			s += `<g id="g${l}">${`<use href="#g${l - 1}"/>`.repeat(10)}</g>`;
		}
		const out = clean(`${s}</defs><use href="#g5"/></svg>`);
		// What is left copies nothing that holds a <use>: no copy of a copy.
		const el = parse(out);
		const uses = Array.from(el.getElementsByTagName('use'));
		expect(uses.length).toBeLessThanOrEqual(MAX_USE_ELEMENTS);
		for (const u of uses) {
			const target = el.querySelector(u.getAttribute('href')!)!;
			expect(target.getElementsByTagName('use')).toHaveLength(0);
		}
		// … and the top-level copy of the whole tree is gone.
		expect(Array.from(el.children).some((c) => c.nodeName === 'use')).toBe(false);
	});

	it(`at most ${MAX_USE_ELEMENTS} of them`, () => {
		const out = clean(
			`${H}<defs><rect id="r" width="1" height="1"/></defs>${'<use href="#r"/>'.repeat(40)}</svg>`
		);
		expect((out.match(/<use/g) ?? []).length).toBe(MAX_USE_ELEMENTS);
	});

	it('a <use> of itself, of a missing id, or inside a marker / pattern / mask / clip path goes', () => {
		expect(clean(`${H}<g id="a"><use href="#a"/></g></svg>`)).not.toContain('<use');
		expect(clean(`${H}<use href="#nope"/></svg>`)).not.toContain('<use');
		for (const wrap of ['marker', 'pattern', 'mask', 'clipPath']) {
			expect(
				clean(`${H}<rect id="r"/><${wrap} id="m"><use href="#r"/></${wrap}></svg>`),
				wrap
			).not.toContain('<use');
		}
	});

	it('the owner’s scene keeps all 11 of its <use>', () => {
		expect((clean(DUSK_BIRD).match(/<use/g) ?? []).length).toBe(11);
	});
});

describe('animations stay inside the picture', () => {
	it('an animation keeps no href (inlined, it would retarget onto the page), <mpath> keeps its own', () => {
		const out = clean(
			`${H}<path id="p" d="M0 0L9 9"/><rect id="r"><set href="#r" attributeName="fill" to="lime"/><animate xlink:href="#r" xmlns:xlink="http://www.w3.org/1999/xlink" attributeName="x" values="1;2" dur="1s"/><animateMotion dur="1s"><mpath href="#p"/></animateMotion></rect></svg>`
		);
		const el = parse(out);
		for (const t of ['set', 'animate']) {
			const a = el.getElementsByTagName(t)[0]!;
			expect(a.getAttribute('href'), t).toBeNull();
			expect(a.getAttributeNS('http://www.w3.org/1999/xlink', 'href'), t).toBeNull();
		}
		expect(el.getElementsByTagName('mpath')[0]!.getAttribute('href')).toBe('#p');
	});

	it('href is kept only where it means something (use, mpath, gradients, pattern)', () => {
		const out = clean(
			`${H}<linearGradient id="b"/><linearGradient id="g" href="#b"/><filter id="f" href="#g"><feTile href="#g"/></filter><rect href="#g"/></svg>`
		);
		const el = parse(out);
		expect(el.querySelector('#g')!.getAttribute('href')).toBe('#b');
		for (const t of ['filter', 'feTile', 'rect']) {
			expect(el.getElementsByTagName(t)[0]!.getAttribute('href'), t).toBeNull();
		}
	});

	it.each([
		['-5s', true],
		['0;2.5s', true],
		['00:02', true],
		['indefinite', true],
		['200ms', true],
		['a1.end', true],
		['a1.begin+1s', true],
		['r.click', false],
		['click', false],
		['accessKey(a)', false],
		['wallclock(2020-01-01T00:00:00Z)', false],
		['nothere.end', false],
		['r.end', false], // r is a rect, not an animation
		['-5s;r.mouseover', false],
		['javascript:alert(1)', false]
	] as const)('begin="%s" kept: %s', (begin, kept) => {
		const out = clean(
			`${H}<rect id="r"><animate id="a1" attributeName="opacity" values="0;1" dur="1s"/><animate id="a2" attributeName="opacity" values="0;1" dur="1s" begin="${begin}" end="${begin}"/></rect></svg>`
		);
		const a2 = parse(out).querySelector('#a2')!;
		expect(a2.getAttribute('begin') === begin).toBe(kept);
		expect(a2.getAttribute('end') === begin).toBe(kept);
	});

	it('the picture’s own frame is not animated (inlined, it would stretch the page)', () => {
		for (const t of ['width', 'height', 'x', 'y']) {
			expect(
				clean(`${H}<animate attributeName="${t}" values="1;1e9" dur="1s"/></svg>`),
				t
			).not.toContain('<animate');
		}
		// The same attribute on a shape is fine.
		expect(
			clean(`${H}<rect><animate attributeName="width" values="1;9" dur="1s"/></rect></svg>`)
		).toContain('<animate');
	});

	it('value attributes are checked in any letter case (an HTML parser lowercases TO=)', () => {
		const out = clean(
			`${H}<rect><set attributeName="fill" TO="javascript:alert(1)"/><animate attributeName="fill" FROM="url(https://evil/x#g)" to="red" dur="1s"/><animate attributeName="fill" By="&lt;b&gt;" dur="1s"/></rect></svg>`
		);
		expect(out).not.toMatch(/<set|<animate/);
	});

	it('an element in another namespace goes (an HTML parser would make it live SVG again)', () => {
		const out = clean(
			`${H}<animate xmlns="http://www.w3.org/1999/xhtml" attributeName="fill" values="red"/><x:rect xmlns:x="urn:other" width="9"/></svg>`
		);
		expect(tags(out)).toEqual([]);
	});
});

describe('style and paint stay inside the picture', () => {
	it.each([
		['fill:red', 'fill:red'],
		['fill: url(#g); stroke:#000', 'fill:url(#g);stroke:#000'],
		['fill:rgb(1, 2, 3)', 'fill:rgb(1, 2, 3)'],
		["font-family:'Space Grotesk'", "font-family:'Space Grotesk'"],
		['position:absolute;top:0;fill:red', 'fill:red'],
		['filter:blur(500px)', ''],
		['filter:url(#f)', ''], // only the attribute, which the budget counts
		["mask:image-set('https://evil.example/x.png' 1x)", ''],
		['fill:url(https://evil.example/g#g)', ''],
		['fill:url( //evil.example/g#g)', ''],
		['animation:k 1ms infinite', ''],
		['fill:red/**/;stroke:blue', ''],
		['fill:\\72 ed', ''],
		['behavior:url(x.htc)', ''],
		['transform:scale(1e9)', '']
	])('style="%s" → "%s"', (input, kept) => {
		expect(cleanStyle(input)).toBe(kept);
	});

	it('an empty style is removed, a cleaned one rewritten', () => {
		const out = clean(
			`${H}<rect style="position:fixed"/><circle style="fill:red;content:'x'"/></svg>`
		);
		expect(out).toContain('<rect/>');
		expect(out).toContain('style="fill:red"');
	});

	it.each([
		['fill', 'url(#g)', true],
		['fill', "url('#g')", true],
		['fill', 'rgb(1,2,3)', true],
		['fill', '#abc', true],
		['fill', 'none', true],
		['fill', 'url(https://evil.example/g#g)', false],
		['fill', 'url(#g) url(https://e/x)', false],
		['mask', "image-set('https://evil.example/x.png' 1x)", false],
		['clip-path', 'url(//evil.example/c#c)', false],
		['marker-end', 'cross-fade(url(#a), url(#b))', false],
		['stroke', 'element(#x)', false]
	] as const)('%s="%s" kept: %s', (name, value, kept) => {
		const out = clean(`${H}<defs><linearGradient id="g"/></defs><rect ${name}="${value}"/></svg>`);
		expect(parse(out).getElementsByTagName('rect')[0]!.hasAttribute(name)).toBe(kept);
	});

	it('class goes: with no stylesheet it does nothing, inlined it would pick up the page’s CSS', () => {
		expect(clean(`${H}<rect class="admin-banner"/></svg>`)).not.toContain('class');
	});
});
