/**
 * Allowlist SVG sanitizer for operator-supplied logos and icons
 * (docs/BRANDING.md). `morphit-ops branding apply` runs as root and publishes
 * the result on the instance's own origin — /brand/site-logo.svg,
 * /favicon.svg, … — where anyone can open it directly, as a document. A logo
 * must therefore be a DRAWING and nothing else: no script in any spelling, no
 * embedded HTML, no animation that can rewrite a link, no reference to any other
 * file or site, no CSS escape tricks.
 *
 * WHY AN ALLOWLIST. The first version refused known-bad patterns with regexes.
 * A deep-deep red team walked straight past it with a namespace prefix
 * (`<h:script xmlns:h="http://www.w3.org/1999/xhtml">` is a live script
 * element the regex `/<script\b/` never sees), CSS escapes (`url(\68ttps:…)`)
 * and protocol-relative URLs (`url(//host/…)`). So this parses the file into
 * elements and attributes, resolves namespaces, and RE-SERIALIZES only what is
 * on the list below. Nothing the list does not name can reach the output,
 * however it is spelled.
 *
 *  - HOSTILE content (script, foreignObject, event handlers, animation/set,
 *    HTML elements, external or javascript: references, CSS escapes/@import,
 *    DOCTYPE/entities, stylesheet processing instructions) → the whole file is
 *    REFUSED with the reason, so the operator knows it is unsuitable.
 *  - Harmless editor baggage (Inkscape/Illustrator/Sketch metadata, unknown
 *    attributes, comments) → silently dropped; it never affects the drawing.
 *    Anything else not on the list is dropped and reported in `removed`.
 *
 * Output: UTF-8, `<svg xmlns="http://www.w3.org/2000/svg" …>`, element names
 * without prefixes, every attribute value re-escaped. The drawing (geometry,
 * paint, gradients, text, transforms) is kept exactly.
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Editor metadata namespaces: their elements and attributes are dropped. */
const EDITOR_NS = [
	'http://www.inkscape.org/namespaces/inkscape',
	'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
	'http://inkscape.sourceforge.net/DTD/sodipodi-0.dtd',
	'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
	'http://creativecommons.org/ns#',
	'http://web.resource.org/cc/',
	'http://purl.org/dc/elements/1.1/',
	'http://ns.adobe.com/AdobeIllustrator/10.0/',
	'http://ns.adobe.com/AdobeSVGViewerExtensions/3.0/',
	'http://ns.adobe.com/Extensibility/1.0/',
	'http://ns.adobe.com/Graphs/1.0/',
	'http://ns.adobe.com/SaveForWeb/1.0/',
	'http://ns.adobe.com/Variables/1.0/',
	'http://ns.adobe.com/xap/1.0/',
	'http://www.bohemiancoding.com/sketch/ns',
	'http://www.serif.com/',
	'http://www.figma.com/figma/ns'
];

const ALLOWED_ELEMENTS = new Set([
	'svg',
	'g',
	'defs',
	'symbol',
	'use',
	'title',
	'desc',
	'path',
	'rect',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon',
	'text',
	'tspan',
	'textPath',
	'linearGradient',
	'radialGradient',
	'stop',
	'pattern',
	'clipPath',
	'mask',
	'filter',
	'marker',
	'style',
	'image',
	'feBlend',
	'feColorMatrix',
	'feComponentTransfer',
	'feComposite',
	'feConvolveMatrix',
	'feDiffuseLighting',
	'feDisplacementMap',
	'feDistantLight',
	'feDropShadow',
	'feFlood',
	'feFuncA',
	'feFuncB',
	'feFuncG',
	'feFuncR',
	'feGaussianBlur',
	'feMerge',
	'feMergeNode',
	'feMorphology',
	'feOffset',
	'fePointLight',
	'feSpecularLighting',
	'feSpotLight',
	'feTile',
	'feTurbulence'
]);

/** Local names that are refused outright, in ANY namespace. */
const HOSTILE_ELEMENTS = new Set(
	[
		'script',
		'foreignObject',
		'iframe',
		'frame',
		'frameset',
		'object',
		'embed',
		'applet',
		'handler',
		'listener',
		'animate',
		'animateMotion',
		'animateTransform',
		'animateColor',
		'set',
		'discard',
		'feImage',
		'a',
		'audio',
		'video',
		'canvas',
		'html',
		'body',
		'head',
		'link',
		'meta',
		'base',
		'form',
		'input',
		'button',
		'textarea',
		'select',
		'img',
		'template',
		'slot',
		'portal',
		'math'
	].map((n) => n.toLowerCase())
);

/** Presentation/geometry attributes kept (case-sensitive SVG names). */
const ALLOWED_ATTRS = new Set([
	'id',
	'class',
	'style',
	'transform',
	'version',
	'baseProfile',
	'viewBox',
	'preserveAspectRatio',
	'width',
	'height',
	'x',
	'y',
	'x1',
	'y1',
	'x2',
	'y2',
	'cx',
	'cy',
	'r',
	'rx',
	'ry',
	'fx',
	'fy',
	'fr',
	'd',
	'points',
	'pathLength',
	'dx',
	'dy',
	'rotate',
	'textLength',
	'lengthAdjust',
	'startOffset',
	'method',
	'spacing',
	'side',
	'fill',
	'fill-opacity',
	'fill-rule',
	'stroke',
	'stroke-width',
	'stroke-opacity',
	'stroke-linecap',
	'stroke-linejoin',
	'stroke-miterlimit',
	'stroke-dasharray',
	'stroke-dashoffset',
	'opacity',
	'color',
	'display',
	'visibility',
	'overflow',
	'clip',
	'clip-path',
	'clip-rule',
	'mask',
	'filter',
	'isolation',
	'mix-blend-mode',
	'paint-order',
	'vector-effect',
	'shape-rendering',
	'text-rendering',
	'image-rendering',
	'color-interpolation',
	'color-interpolation-filters',
	'color-rendering',
	'enable-background',
	'marker-start',
	'marker-mid',
	'marker-end',
	'markerWidth',
	'markerHeight',
	'markerUnits',
	'refX',
	'refY',
	'orient',
	'offset',
	'stop-color',
	'stop-opacity',
	'gradientUnits',
	'gradientTransform',
	'spreadMethod',
	'patternUnits',
	'patternContentUnits',
	'patternTransform',
	'clipPathUnits',
	'maskUnits',
	'maskContentUnits',
	'filterUnits',
	'primitiveUnits',
	'font-family',
	'font-size',
	'font-size-adjust',
	'font-stretch',
	'font-style',
	'font-variant',
	'font-weight',
	'letter-spacing',
	'word-spacing',
	'text-anchor',
	'text-decoration',
	'dominant-baseline',
	'alignment-baseline',
	'baseline-shift',
	'writing-mode',
	'direction',
	'unicode-bidi',
	'glyph-orientation-horizontal',
	'glyph-orientation-vertical',
	'kerning',
	'in',
	'in2',
	'result',
	'stdDeviation',
	'mode',
	'operator',
	'k1',
	'k2',
	'k3',
	'k4',
	'values',
	'type',
	'tableValues',
	'slope',
	'intercept',
	'amplitude',
	'exponent',
	'flood-color',
	'flood-opacity',
	'lighting-color',
	'surfaceScale',
	'diffuseConstant',
	'specularConstant',
	'specularExponent',
	'kernelMatrix',
	'kernelUnitLength',
	'order',
	'divisor',
	'bias',
	'targetX',
	'targetY',
	'edgeMode',
	'preserveAlpha',
	'radius',
	'scale',
	'xChannelSelector',
	'yChannelSelector',
	'baseFrequency',
	'numOctaves',
	'seed',
	'stitchTiles',
	'azimuth',
	'elevation',
	'z',
	'pointsAtX',
	'pointsAtY',
	'pointsAtZ',
	'limitingConeAngle',
	'role',
	'aria-label',
	'aria-hidden',
	'focusable',
	'media'
]);

/** Elements whose href may point at an element of the same file (`#id`). */
const FRAGMENT_HREF_ELEMENTS = new Set([
	'use',
	'textPath',
	'linearGradient',
	'radialGradient',
	'pattern',
	'filter',
	'mpath'
]);

/** A raster image embedded in the file itself (never a URL). */
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const FRAGMENT = /^#[A-Za-z_][\w.:-]*$/;

export class HostileSvgError extends Error {}

export interface SanitizedSvg {
	/** The re-serialized SVG. */
	readonly svg: string;
	/** Root `<svg>` attributes as kept (after sanitizing). */
	readonly rootAttrs: ReadonlyArray<readonly [string, string]>;
	/** Human-readable notes about harmless content that was dropped. */
	readonly removed: string[];
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'"
};

/** A code point XML 1.0 allows in a document (Char production). Anything else
 *  — C0 controls other than tab/LF/CR, surrogates, U+FFFE/U+FFFF — makes a
 *  browser reject the whole served SVG, so the logo would silently vanish. */
function isXmlChar(cp: number): boolean {
	return (
		cp === 0x9 ||
		cp === 0xa ||
		cp === 0xd ||
		(cp >= 0x20 && cp <= 0xd7ff) ||
		(cp >= 0xe000 && cp <= 0xfffd) ||
		(cp >= 0x10000 && cp <= 0x10ffff)
	);
}
// eslint-disable-next-line no-control-regex
const NON_XML_CHAR =
	/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function decodeEntities(s: string, where: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g, (m, ent: string) => {
		if (!m.endsWith(';'))
			throw new HostileSvgError(`${where}: a malformed character reference (${m})`);
		if (ent[0] === '#') {
			const cp =
				ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
			if (!Number.isFinite(cp) || !isXmlChar(cp)) {
				throw new HostileSvgError(`${where}: an invalid character reference (${m})`);
			}
			return String.fromCodePoint(cp);
		}
		const v = NAMED_ENTITIES[ent];
		if (v === undefined) throw new HostileSvgError(`${where}: an unknown entity (&${ent};)`);
		return v;
	});
}

function escapeText(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
	return escapeText(s).replace(/"/g, '&quot;');
}

/** Normalize for scheme sniffing: drop whitespace and control characters. */
function squash(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/[\s\u0000-\u001f\u007f]+/g, '').toLowerCase();
}

/** CSS (a style attribute or a <style> element) must be self-contained. */
function checkCss(css: string, where: string): void {
	// Check the text with its comments removed as well: `url/**/(…)` is not a
	// url() to a browser today, but nothing that could read as one may pass.
	const bare = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '');
	if (bare !== css) checkCss(bare, where);
	const c = squash(css);
	if (css.includes('\\')) throw new HostileSvgError(`${where}: a CSS escape (\\)`);
	if (c.includes('@import')) throw new HostileSvgError(`${where}: a CSS @import`);
	if (c.includes('@font-face'))
		throw new HostileSvgError(`${where}: an embedded font (@font-face)`);
	if (
		c.includes('expression(') ||
		c.includes('javascript:') ||
		c.includes('-moz-binding') ||
		c.includes('behavior:')
	) {
		throw new HostileSvgError(`${where}: script in CSS`);
	}
	// Every url(...) must point inside this file: url(#id).
	for (const m of c.matchAll(/url\(([^)]*)\)/g)) {
		const target = m[1]!.replace(/^['"]|['"]$/g, '');
		if (!target.startsWith('#'))
			throw new HostileSvgError(`${where}: a url() pointing outside the file`);
	}
	if (/url\([^)]*$/.test(c)) throw new HostileSvgError(`${where}: an unterminated url()`);
}

/** Any presentation attribute value: no script schemes, only url(#id). */
function checkValue(v: string, where: string): void {
	const c = squash(v);
	if (/(?:java|vb)script:/.test(c) || c.includes('data:text') || c.includes('expression(')) {
		throw new HostileSvgError(`${where}: a script value`);
	}
	if (c.includes('url(')) checkCss(v, where);
}

interface Tag {
	readonly kind: 'start' | 'end';
	readonly name: string;
	readonly attrs: Array<[string, string]>;
	readonly selfClosing: boolean;
}

const NAME = '[A-Za-z_][\\w.\\-]*(?::[A-Za-z_][\\w.\\-]*)?';
const START_TAG = new RegExp(
	`^<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`
);
const ATTR = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'g');
const END_TAG = new RegExp(`^</(${NAME})\\s*>`);

interface Frame {
	readonly local: string;
	readonly ns: Map<string, string>;
	/** Output this element (false inside a dropped subtree). */
	readonly keep: boolean;
}

function splitName(qname: string): [string | null, string] {
	const i = qname.indexOf(':');
	return i < 0 ? [null, qname] : [qname.slice(0, i), qname.slice(i + 1)];
}

/**
 * Sanitize an SVG document. Throws HostileSvgError (with a reason fit to show
 * the operator) for hostile or unparseable content.
 */
export function sanitizeSvg(input: string, label: string): SanitizedSvg {
	let text = input.replace(/^﻿/, '');
	const removed = new Set<string>();
	const fail = (why: string): never => {
		throw new HostileSvgError(
			`${label}: contains ${why} — refused (logos must be self-contained drawings)`
		);
	};
	if (NON_XML_CHAR.test(text)) {
		throw new HostileSvgError(
			`${label}: contains a control character that SVG files may not contain — re-export it from your editor`
		);
	}
	// A bare SVG DOCTYPE (older Illustrator/Inkscape exports) only names the
	// public DTD, which no browser fetches — drop it. One with an internal
	// subset ("[ <!ENTITY … ]") can define entities: refused.
	text = text.replace(/^(\s*<\?xml\s[^?]*\?>)?\s*<!DOCTYPE\s+svg\b[^[>]*>/i, '$1');
	if (/<!DOCTYPE|<!ENTITY|<!ATTLIST|<!ELEMENT/i.test(text)) fail('a DOCTYPE or entity declaration');

	// Leading XML declaration only (no other processing instructions: an
	// <?xml-stylesheet?> loads CSS from elsewhere).
	text = text.replace(/^\s*<\?xml\s[^?]*\?>/, '');
	if (/<\?/.test(text)) fail('a processing instruction (<?…?>)');

	const out: string[] = [];
	const stack: Frame[] = [];
	let rootAttrs: Array<[string, string]> = [];
	let sawRoot = false;
	let rootClosed = false;
	let i = 0;
	const inStyle = (): boolean => stack.length > 0 && stack[stack.length - 1]!.local === 'style';
	const keeping = (): boolean => stack.length === 0 || stack[stack.length - 1]!.keep;

	while (i < text.length) {
		const rest = text.slice(i);
		if (rest.startsWith('<!--')) {
			const end = text.indexOf('-->', i + 4);
			if (end < 0) fail('an unterminated comment');
			i = end + 3;
			continue;
		}
		if (rest.startsWith('<![CDATA[')) {
			const end = text.indexOf(']]>', i + 9);
			if (end < 0) fail('an unterminated CDATA section');
			const data = text.slice(i + 9, end);
			if (rootClosed || !sawRoot) {
				if (data.trim() !== '') fail('content outside the <svg> element');
			} else if (keeping()) {
				if (inStyle()) checkCss(data, `${label} <style>`);
				out.push(escapeText(data));
			}
			i = end + 3;
			continue;
		}
		if (rest.startsWith('<!')) fail('a markup declaration (<!…>)');
		if (rest.startsWith('</')) {
			const m = END_TAG.exec(rest);
			if (!m) fail('a malformed closing tag');
			const top = stack.pop();
			if (!top) fail('an unexpected closing tag');
			const [, local] = splitName(m![1]!);
			if (local !== top!.local) fail(`mismatched tags (<${top!.local}> closed by </${local}>)`);
			if (top!.keep) out.push(`</${top!.local}>`);
			if (stack.length === 0) rootClosed = true;
			i += m![0].length;
			continue;
		}
		if (rest.startsWith('<')) {
			const m = START_TAG.exec(rest);
			if (!m) fail('a malformed tag (attributes must be name="value")');
			const qname = m![1]!;
			const rawAttrs: Array<[string, string]> = [];
			for (const a of m![2]!.matchAll(ATTR)) rawAttrs.push([a[1]!, a[2] ?? a[3] ?? '']);
			const selfClosing = m![3] === '/';
			i += m![0].length;
			if (rootClosed) fail('content after the </svg> element');

			// Namespace scope: inherit, then apply this element's xmlns declarations.
			const parentNs =
				stack.length > 0 ? stack[stack.length - 1]!.ns : new Map<string, string>([['xml', XML_NS]]);
			const ns = new Map(parentNs);
			for (const [n, v] of rawAttrs) {
				if (n === 'xmlns') ns.set('', decodeEntities(v, label));
				else if (n.startsWith('xmlns:')) ns.set(n.slice(6), decodeEntities(v, label));
			}
			const [prefix, local] = splitName(qname);
			if (prefix !== null && !ns.has(prefix))
				fail(`an element with an undeclared prefix (<${qname}>)`);
			const elNs =
				prefix === null
					? (ns.get('') ?? (stack.length === 0 ? SVG_NS : undefined))
					: ns.get(prefix);
			if (HOSTILE_ELEMENTS.has(local.toLowerCase())) fail(`a <${qname}> element`);
			if (stack.length === 0) {
				if (sawRoot) fail('more than one root element');
				if (local !== 'svg' || elNs !== SVG_NS)
					fail(`a <${qname}> root element (not an SVG document)`);
				sawRoot = true;
				if (prefix === null && !ns.has('')) ns.set('', SVG_NS);
			}
			const parentKeep = keeping();
			let keep = parentKeep;
			if (keep) {
				if (elNs !== SVG_NS) {
					keep = false;
					if (!EDITOR_NS.includes(elNs ?? '') && elNs !== undefined)
						removed.add(`<${qname}> (not SVG)`);
				} else if (!ALLOWED_ELEMENTS.has(local)) {
					keep = false;
					if (local !== 'metadata' && local !== 'sodipodi:namedview') removed.add(`<${local}>`);
				}
			}

			// Attributes — every one is checked even inside a dropped subtree, so a
			// hostile handler hidden in metadata still refuses the file.
			const kept: Array<[string, string]> = [];
			for (const [aname, rawValue] of rawAttrs) {
				const where = `${label} <${local} ${aname}>`;
				const value = decodeEntities(rawValue, where);
				const [aprefix, alocal] = splitName(aname);
				if (/^on/i.test(alocal)) fail(`an event-handler attribute (${aname})`);
				if (aname === 'xmlns' || aprefix === 'xmlns') continue; // re-emitted by us
				const aNs = aprefix === null ? null : ns.get(aprefix);
				if (alocal === 'href' && (aprefix === null || aNs === XLINK_NS)) {
					const v = value.trim();
					const ok =
						(FRAGMENT.test(v) && FRAGMENT_HREF_ELEMENTS.has(local)) ||
						(local === 'image' && DATA_IMAGE.test(v));
					if (!ok) fail(`a reference to another file or site (${aname}="${v.slice(0, 60)}")`);
					kept.push([aprefix === null ? 'href' : 'xlink:href', v]);
					continue;
				}
				if (aprefix !== null && aNs === undefined)
					fail(`an attribute with an undeclared prefix (${aname})`);
				if (aprefix !== null && aNs !== XML_NS) {
					checkValue(value, where); // still refuse script in editor attributes
					continue; // editor/unknown-namespace attribute: dropped
				}
				if (aprefix !== null) {
					// xml:space / xml:lang only.
					if (alocal === 'space' || alocal === 'lang') kept.push([aname, value]);
					continue;
				}
				if (alocal === 'style') {
					checkCss(value, where);
					kept.push([aname, value]);
					continue;
				}
				checkValue(value, where);
				if (ALLOWED_ATTRS.has(alocal)) kept.push([alocal, value]);
			}
			if (local === 'image' && keep && !kept.some(([n]) => n === 'href' || n === 'xlink:href')) {
				keep = false;
			}
			if (stack.length === 0) rootAttrs = kept;
			if (keep) {
				const usesXlink = kept.some(([n]) => n.startsWith('xlink:'));
				let tag = `<${local}`;
				if (stack.length === 0) {
					tag += ` xmlns="${SVG_NS}"`;
				}
				if (usesXlink) tag += ` xmlns:xlink="${XLINK_NS}"`;
				for (const [n, v] of kept) tag += ` ${n}="${escapeAttr(v)}"`;
				out.push(selfClosing ? `${tag}/>` : `${tag}>`);
			}
			if (!selfClosing) stack.push({ local, ns, keep });
			else if (stack.length === 0) rootClosed = true;
			continue;
		}
		// Text.
		const next = text.indexOf('<', i);
		const chunk = next < 0 ? text.slice(i) : text.slice(i, next);
		i = next < 0 ? text.length : next;
		if (!sawRoot || rootClosed) {
			if (chunk.trim() !== '') fail('content outside the <svg> element');
			continue;
		}
		const decoded = decodeEntities(chunk, `${label} text`);
		if (inStyle()) checkCss(decoded, `${label} <style>`);
		if (keeping()) out.push(escapeText(decoded));
	}
	if (!sawRoot) fail('no <svg> element');
	if (stack.length > 0) fail('an unclosed element');
	return { svg: out.join(''), rootAttrs, removed: [...removed] };
}
