// @vitest-environment jsdom
/**
 * Avatar sanitization tests.
 *
 * The SVG path is security-critical — the app renders avatars through
 * an `<img>` data URI, but the sanitized SVG is published on chain,
 * where another reader may inline it as live DOM content. Every test in
 * the sanitizer block represents an attack path that must be blocked.
 *
 * The raster path isn't testable without a real Canvas (JSDOM's
 * canvas is either absent or very limited), so those tests stay
 * shallow — we verify the dispatcher + error codes only. The
 * encoding logic is exercised at runtime in the browser.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeSvg, processAvatarFile, minifySvg, MAX_AVATAR_BYTES } from './index';
import DUSK_BIRD from './fixtures/animated-dusk-bird.svg?raw';

// ─── SVG sanitizer — threat-model coverage ──────────────────────

describe('sanitizeSvg — script and event-handler stripping', () => {
	it('strips <script> elements', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<script>alert('xss')</script>
			<circle cx="16" cy="16" r="10" fill="red"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toContain('<script');
		expect(result.value).not.toContain('alert');
		expect(result.value).toContain('<circle');
	});

	it('strips onload handler attributes', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" onload="alert(1)">
			<circle cx="16" cy="16" r="10" onclick="evil()"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toContain('onload');
		expect(result.value).not.toContain('onclick');
		expect(result.value).not.toContain('alert');
		expect(result.value).not.toContain('evil');
	});

	it('strips all on* handlers across various elements', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<rect width="10" height="10" onfocus="x()" onblur="y()" onmouseover="z()"/>
			<path d="M0 0 L10 10" onmousemove="pwn()"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toMatch(/on\w+=/);
	});
});

describe('sanitizeSvg — href protocol filtering', () => {
	it('strips href with javascript: protocol', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<use href="javascript:alert(1)"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toContain('javascript:');
	});

	it('strips href with external http(s) URL', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<use href="https://evil.example.com/x.svg#icon"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toContain('evil.example.com');
		expect(result.value).not.toContain('https://');
	});

	it('allows fragment-only href (internal ref) on <use>', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<defs><circle id="dot" cx="5" cy="5" r="3"/></defs>
			<use href="#dot"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toContain('href="#dot"');
	});

	it('strips xlink:href with javascript:', () => {
		// Older SVG uses xlink:href; same protocol filter applies.
		const input = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="32" height="32">
			<use xlink:href="javascript:evil()"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toContain('javascript:');
	});

	it('strips href with data: protocol', () => {
		// data: URIs in href can encode HTML/JS. External image data:
		// URIs are never needed inside an avatar SVG.
		// Note: the data-URI value is entity-escaped here because raw
		// `<` inside an XML attribute is malformed; any compliant XML
		// parser (real browser DOMParser, jsdom) returns parsererror
		// before the sanitizer sees the input. The escaped form
		// preserves the test's intent (data: protocol must be
		// stripped) without tripping the parser-strictness gate.
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<use href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toContain('data:');
	});
});

describe('sanitizeSvg — dangerous elements', () => {
	it('strips <foreignObject> (HTML injection vector)', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<foreignObject width="10" height="10">
				<iframe src="javascript:alert(1)"></iframe>
			</foreignObject>
			<circle cx="16" cy="16" r="10"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toContain('foreignObject');
		expect(result.value).not.toContain('iframe');
		expect(result.value).toContain('<circle');
	});

	it('strips <image> elements entirely (external ref vector)', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<image href="https://tracker.example.com/pixel.png" width="32" height="32"/>
			<circle cx="16" cy="16" r="10"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// <image> is not on the allowed-tags list, so it gets dropped entirely.
		expect(result.value).not.toContain('<image');
		expect(result.value).not.toContain('tracker.example.com');
	});

	it('strips <feImage> (it can load a picture from elsewhere)', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<filter id="x"><feImage href="https://evil.example.com/t.png"/><feGaussianBlur stdDeviation="2"/></filter>
			<circle cx="16" cy="16" r="10" filter="url(#x)"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toMatch(/feImage/i);
		expect(result.value).not.toContain('evil');
		expect(result.value).toContain('<feGaussianBlur stdDeviation="2"');
	});
});

// ─── Animated avatars (SMIL) and filters ────────────────────────
//
// An animated SVG avatar used to lose every <animate>/<animateTransform> and
// its <filter> at upload, so the chain got one still frame. Animation is now
// kept when it can only change how the picture LOOKS: what it animates is a
// presentation or geometry attribute, and what it animates to carries no
// protocol and no outside url(). Anything else drops the whole animation.

function signature(svg: string): string[] {
	const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
	const out: string[] = [];
	const walk = (el: Element, depth: number): void => {
		const attrs = Array.from(el.attributes)
			.map((a) => a.name)
			.filter((n) => n !== 'xmlns')
			.sort();
		const target = el.getAttribute('attributeName');
		out.push(`${depth}:${el.nodeName}[${attrs.join(',')}]${target ? `→${target}` : ''}`);
		for (const c of Array.from(el.children)) walk(c, depth + 1);
	};
	walk(doc.documentElement, 0);
	return out;
}

describe('sanitizeSvg — animated avatars keep their animation', () => {
	it('a real animated avatar comes through whole: every element, attribute and animation target', () => {
		const result = sanitizeSvg(DUSK_BIRD);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(signature(result.value)).toEqual(signature(DUSK_BIRD));
		expect(result.byteLength).toBeLessThanOrEqual(MAX_AVATAR_BYTES);
		// The pieces that make it move, counted.
		expect(result.value.match(/<animate /g)?.length).toBe(DUSK_BIRD.match(/<animate /g)?.length);
		expect(result.value.match(/<animateTransform /g)?.length).toBe(
			DUSK_BIRD.match(/<animateTransform /g)?.length
		);
		expect(result.value).toContain('<filter id="a"');
		expect(result.value).toContain('<feGaussianBlur stdDeviation=".7"');
	});

	it('keeps each kind of animation that only changes the look', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<defs><path id="p" d="M0 0h10"/></defs>
			<circle cx="16" cy="16" r="10" fill="#0a0">
				<animate attributeName="r" values="10;14;10" dur="2s" repeatCount="indefinite" calcMode="spline" keyTimes="0;.5;1" keySplines=".4 0 .6 1;.4 0 .6 1"/>
				<set attributeName="fill" to="#f00" begin="1s"/>
				<animateMotion dur="3s" repeatCount="indefinite"><mpath href="#p"/></animateMotion>
			</circle>
			<g><animateTransform attributeName="transform" type="rotate" values="0 16 16;360 16 16" dur="4s" repeatCount="indefinite"/></g>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(signature(result.value)).toEqual(signature(input));
	});

	it('an animation is still stripped of its event handlers', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<circle cx="16" cy="16" r="10">
				<animate attributeName="r" values="10;20;10" dur="2s" onbegin="evil()"/>
				<set attributeName="fill" to="red" onend="pwn()"/>
			</circle>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toContain('<animate attributeName="r"');
		expect(result.value).not.toContain('evil');
		expect(result.value).not.toContain('pwn');
	});

	it.each([
		['a link', `<set attributeName="href" to="javascript:alert(1)"/>`],
		[
			'an xlink link',
			`<animate attributeName="xlink:href" values="#a;javascript:alert(1)" dur="1s"/>`
		],
		[
			'a link, lower-case name (an HTML parser restores the case)',
			`<set attributename="href" to="#x"/>`
		],
		['a link, upper-case value', `<set attributeName="HREF" to="javascript:alert(1)"/>`],
		['an event handler', `<set attributeName="onclick" to="alert(1)"/>`],
		['the style', `<set attributeName="style" to="position:fixed;inset:0"/>`],
		['the class', `<set attributeName="class" to="fixed inset-0 z-50"/>`],
		['the id', `<set attributeName="id" to="chat-composer"/>`],
		['nothing named', `<animate values="1;2" dur="1s"/>`],
		[
			'two targets at once',
			`<animate attributeName="r" attributename="href" values="1;2" dur="1s"/>`
		],
		[
			'a transform with a link target',
			`<animateTransform attributeName="href" type="scale" values="1;2" dur="1s"/>`
		]
	])('drops an animation that targets %s', (_label, frag) => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle r="5">${frag}</circle></svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toMatch(/<(set|animate|animateTransform)\b/);
		expect(result.value).toContain('<circle');
	});

	it.each([
		['a protocol', `<set attributeName="fill" to="javascript:alert(1)"/>`],
		[
			'an outside paint',
			`<animate attributeName="fill" values="#000;url(https://evil.example.com/p.svg#g)" dur="1s"/>`
		],
		[
			'an outside paint, spaced',
			`<set attributeName="stroke" to="url( //evil.example.com/p.svg#g)"/>`
		],
		[
			'a data URI',
			`<animate attributeName="fill" from="#000" to="url(data:image/svg+xml,x)" dur="1s"/>`
		],
		[
			'a CSS escape spelling url( with no colon',
			`<set attributeName="fill" to="u\\72l(//evil.example.com/p.svg#g)"/>`
		],
		['markup', `<animate attributeName="fill" by="&lt;b&gt;" dur="1s"/>`],
		[
			'a motion path to elsewhere',
			`<animateMotion path="M0 0" dur="1s"><mpath href="https://evil.example.com/p.svg#p"/></animateMotion>`
		]
	])('drops an animation whose value carries %s', (_label, frag) => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle r="5">${frag}</circle></svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toMatch(/evil|javascript|data:|&lt;b/);
		expect(result.value).toContain('<circle');
	});

	it('an inside paint server is fine to animate to', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><circle r="5"><set attributeName="fill" to="url(#g)" begin="1s"/></circle></svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toContain('<set attributeName="fill" to="url(#g)"');
	});

	it('a clock value in dur/begin is kept (02:30 is a time, not a protocol)', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle r="5"><animate attributeName="r" values="5;9;5" dur="00:00:02" begin="0:01"/></circle></svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toContain('dur="00:00:02"');
	});
});

describe('sanitizeSvg — comments, DOCTYPE, processing instructions', () => {
	it('strips comments', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<!-- comment that might contain stuff -->
			<circle cx="16" cy="16" r="10"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toContain('<!--');
		expect(result.value).not.toContain('comment that might');
	});

	it('rejects DOCTYPE declarations (entity-expansion risk)', () => {
		// DOCTYPEs with entity declarations are a classic XXE vector.
		// Our parser is set to image/svg+xml, so most of these never
		// reach the DOM — but we assert they don't round-trip either.
		const input = `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<circle cx="16" cy="16" r="10"/>
		</svg>`;
		const result = sanitizeSvg(input);
		// We accept the SVG if it parses — but nothing from the
		// DOCTYPE / entities leaks into the output.
		if (result.ok) {
			expect(result.value).not.toContain('DOCTYPE');
			expect(result.value).not.toContain('ENTITY');
			expect(result.value).not.toContain('xxe');
			expect(result.value).not.toContain('passwd');
		}
	});
});

describe('sanitizeSvg — structural validation', () => {
	it('rejects empty input', () => {
		const result = sanitizeSvg('');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe('empty_file');
	});

	it('rejects whitespace-only input', () => {
		const result = sanitizeSvg('   \n\t  ');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe('empty_file');
	});

	it('rejects non-SVG root element', () => {
		const result = sanitizeSvg('<html><body>hi</body></html>');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// DOMParser may parse this as HTML + report a parserror; either
		// way, it's not a valid <svg> root.
		expect(['svg_no_root', 'parse_failed']).toContain(result.code);
	});

	it('rejects garbage input', () => {
		const result = sanitizeSvg('this is not xml at all!@#$');
		expect(result.ok).toBe(false);
	});

	it('rejects if output would exceed MAX_AVATAR_BYTES', () => {
		// Build a very long valid SVG via a path with many commands.
		const bigPath = 'M0 0 ' + 'L1 1 '.repeat(2000);
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
			<path d="${bigPath}"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe('svg_too_large');
	});
});

describe('sanitizeSvg — output shape', () => {
	it('returns byteLength equal to UTF-8 byte length of value', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
			<circle cx="16" cy="16" r="10"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const actualBytes = new TextEncoder().encode(result.value).byteLength;
		expect(result.byteLength).toBe(actualBytes);
		expect(result.byteLength).toBeLessThan(MAX_AVATAR_BYTES);
	});

	it('stays under MAX_AVATAR_BYTES for reasonable avatars', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
			<defs><linearGradient id="g"><stop offset="0" stop-color="#8EEF26"/><stop offset="1" stop-color="#02A6B2"/></linearGradient></defs>
			<circle cx="48" cy="48" r="40" fill="url(#g)"/>
			<text x="48" y="52" text-anchor="middle" fill="white" font-size="20">M</text>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.byteLength).toBeLessThan(MAX_AVATAR_BYTES);
		expect(result.kind).toBe('svg');
	});

	it('preserves legitimate shape/styling attributes', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
			<circle cx="48" cy="48" r="40" fill="#8EEF26" stroke="black" stroke-width="2" opacity="0.9"/>
		</svg>`;
		const result = sanitizeSvg(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toContain('fill="#8EEF26"');
		expect(result.value).toContain('stroke="black"');
		expect(result.value).toContain('stroke-width="2"');
		// Post-minification, "0.9" is written as ".9" — leading-zero
		// stripping is a standard lossless SVG byte win.
		expect(result.value).toContain('opacity=".9"');
	});

	it('adds default xmlns and dimensions if missing', () => {
		// Without xmlns, browsers won't render inline SVG.
		const input = `<svg><circle cx="16" cy="16" r="10"/></svg>`;
		const result = sanitizeSvg(input);
		if (result.ok) {
			expect(result.value).toContain('xmlns="http://www.w3.org/2000/svg"');
			expect(result.value).toMatch(/width=/);
			expect(result.value).toMatch(/height=/);
		}
	});
});

// ─── Dispatcher — MIME type handling ────────────────────────────

describe('processAvatarFile — MIME dispatch', () => {
	it('rejects unsupported MIME types', async () => {
		const file = new File(['hello'], 'test.txt', { type: 'text/plain' });
		const result = await processAvatarFile(file);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe('unsupported_type');
	});

	it('rejects BMP and TIFF (not in our allowlist)', async () => {
		const bmp = new File([new Uint8Array([1, 2, 3])], 'a.bmp', {
			type: 'image/bmp'
		});
		const result = await processAvatarFile(bmp);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe('unsupported_type');
	});

	it('routes image/svg+xml to the SVG sanitizer', async () => {
		const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="10"/></svg>`;
		const file = new File([svgText], 'a.svg', { type: 'image/svg+xml' });
		const result = await processAvatarFile(file);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.kind).toBe('svg');
	});
});

// ─── Minifier — byte compaction correctness ─────────────────────

describe('minifySvg — byte compaction', () => {
	it('strips XML prolog', () => {
		const input = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>`;
		const out = minifySvg(input);
		expect(out).not.toContain('<?xml');
		expect(out).toContain('<svg');
	});

	it('collapses whitespace between tags', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg">
	<g>
		<circle r="5"/>
	</g>
</svg>`;
		const out = minifySvg(input);
		expect(out).not.toMatch(/>\s+</);
	});

	it('collapses whitespace between attributes inside a tag', () => {
		const input = `<svg   xmlns="http://www.w3.org/2000/svg"
	width="96"
	height="96"><circle r="5"/></svg>`;
		const out = minifySvg(input);
		expect(out).not.toMatch(/\s\s+/);
		expect(out).toContain('width="96"');
		expect(out).toContain('height="96"');
	});

	it('strips leading zeros from decimal values', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="0.5" cy="0.25" r="5" opacity="0.75"/></svg>`;
		const out = minifySvg(input);
		expect(out).toContain('cx=".5"');
		expect(out).toContain('cy=".25"');
		expect(out).toContain('opacity=".75"');
	});

	it('strips trailing zeros from decimal values', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg"><circle r="5" opacity="0.900"/></svg>`;
		const out = minifySvg(input);
		expect(out).toContain('opacity=".9"');
	});

	it('converts "1.0" and "10.00" to integer form', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg"><rect x="1.0" y="10.00" width="2.0" height="3.000"/></svg>`;
		const out = minifySvg(input);
		expect(out).toContain('x="1"');
		expect(out).toContain('y="10"');
		expect(out).toContain('width="2"');
		expect(out).toContain('height="3"');
	});

	it('handles negative decimals correctly', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="-0.5" cy="-1.500"/></svg>`;
		const out = minifySvg(input);
		expect(out).toContain('cx="-.5"');
		expect(out).toContain('cy="-1.5"');
	});

	it('does NOT touch quoted attribute values that look like tag content', () => {
		// Note: a malformed XML input (< in text content should
		// be &lt;), but we parse via XMLSerializer output not user input,
		// so we just verify the minifier handles well-formed input without
		// accidentally truncating.
		const well = `<svg xmlns="http://www.w3.org/2000/svg"><text>hello world</text></svg>`;
		const out = minifySvg(well);
		expect(out).toContain('hello world');
	});

	it('preserves text content inside <text> exactly', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="20">  spaces  matter  </text></svg>`;
		const out = minifySvg(input);
		// The text node's leading/trailing spaces are preserved.
		expect(out).toContain('>  spaces  matter  <');
	});

	it('removes empty <title>, <desc>, <metadata>', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg"><title></title><desc></desc><metadata></metadata><circle r="5"/></svg>`;
		const out = minifySvg(input);
		expect(out).not.toContain('<title');
		expect(out).not.toContain('<desc');
		expect(out).not.toContain('<metadata');
	});

	it('preserves non-empty <title> and <desc>', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg"><title>My avatar</title><circle r="5"/></svg>`;
		const out = minifySvg(input);
		expect(out).toContain('<title>My avatar</title>');
	});

	it('is idempotent (minify(minify(x)) === minify(x))', () => {
		const input = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
	<circle cx="48" cy="48" r="40" fill="#8EEF26" opacity="0.5"/>
</svg>`;
		const first = minifySvg(input);
		const second = minifySvg(first);
		expect(first).toBe(second);
	});

	it('reduces byte size on a realistic input', () => {
		// A typical hand-authored SVG with generous whitespace + float
		// formatting. Expect at least 15% reduction.
		const input = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="96"
     height="96"
     viewBox="0 0 96 96">
	<defs>
		<linearGradient id="g" x1="0.0" y1="0.0" x2="1.00" y2="1.00">
			<stop offset="0.0" stop-color="#8EEF26"/>
			<stop offset="1.00" stop-color="#02A6B2"/>
		</linearGradient>
	</defs>
	<circle cx="48.0" cy="48.0" r="40.0" fill="url(#g)" opacity="0.90"/>
</svg>`;
		const out = minifySvg(input);
		const inputBytes = new TextEncoder().encode(input).byteLength;
		const outBytes = new TextEncoder().encode(out).byteLength;
		expect(outBytes).toBeLessThan(inputBytes);
		// Sanity check on how much we reduced.
		expect(outBytes).toBeLessThan(inputBytes * 0.85);
	});
});
