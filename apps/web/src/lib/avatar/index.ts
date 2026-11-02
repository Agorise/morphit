/**
 * Morphit — user avatar processing.
 *
 * Two encoding paths, one unified output shape:
 *
 * 1. **SVG path** (preserveSvg). The user provides SVG text; we
 *    sanitize it against an allowlist and, if it survives, inline
 *    it into the profile op.
 *
 * 2. **Raster path** (reencodeRaster). The user provides any
 *    raster image (PNG/JPEG/GIF/WebP); we resize to 96×96 via
 *    Canvas and re-encode as WebP at quality 0.8, producing a
 *    small base64 data URI.
 *
 * Both paths enforce a size budget that fits comfortably inside
 * the 8 KB profile-metadata cap, with headroom for JSON escaping
 * and sibling fields (display_name, nostr_url, streaming_url).
 *
 * ─── SVG sanitization, in detail ────────────────────────────────
 *
 * Arbitrary SVG is **not** safe to inline. SVG is XML, and the XML
 * is executed by the browser as live content in the DOM. Threats
 * we actively strip:
 *
 *   - `<script>` elements — arbitrary JS
 *   - `on*=` attributes (onload, onclick, onerror, ...) — JS in
 *     attribute form; effectively unlimited across SVG element types
 *   - `href`, `xlink:href` with `javascript:` protocol — JS in link form
 *   - External refs (`<image href="https://...">`) — privacy leak,
 *     and a tracking / dead-drop vector for attacker-controlled servers
 *   - `<foreignObject>` — embeds arbitrary HTML including iframes,
 *     scripts, and event handlers not reachable via SVG tag allowlist
 *   - `<animate>` / `<set>` with `onbegin` / `onend` SMIL events, or that
 *     animate a link, an event handler, `style`, `class` or `id`, or animate
 *     to a value carrying a protocol or an outside `url()` (see
 *     {@link isSafeAnimation}: animation that only changes how the picture
 *     looks is kept, so an animated avatar stays animated)
 *   - `<feImage>` — it loads a picture from elsewhere or another part of the page
 *   - `<style>` elements (all of them) and `class` (with no stylesheet it
 *     does nothing here, and inlined it would pick up the page's own CSS)
 *   - a `style=""` declaration that is not a presentation property, or whose
 *     value names something outside the picture (see {@link cleanStyle})
 *   - `fill` / `stroke` / `clip-path` / `mask` / `marker-*` / `filter`
 *     pointing outside the picture (`url(https://…)`); `filter` is only ever
 *     `url(#id)` — never a CSS function like `blur(5000px)`
 *   - `<use>` with external fragments, a `<use>` of something that itself
 *     holds a `<use>` (fan-out: 5 levels of 10 froze a tab for seconds), and
 *     more than MAX_USE_ELEMENTS of them
 *   - filter numbers that would freeze every viewer's tab: blur, spread,
 *     shift, octaves and the filter region are held to a size that suits a
 *     picture of this size (see {@link boundFilters}), and nothing inside a
 *     `<filter>` is animated
 *   - an animation's own `href` (it would retarget it onto the page an
 *     inlined SVG sits in) and `begin` / `end` that wait on anything but a
 *     time or another animation in the same picture
 *   - CDATA sections, comments, XML processing instructions, DOCTYPEs
 *     (entity expansion / XXE). CDATA is not kept as text either: the
 *     minifier works on the serialized text, and a CDATA section is the one
 *     place serialized markup is not escaped
 *
 * Strategy: allowlist tags + allowlist attributes + validate href
 * protocol. Recursive walk of the parsed DOM, remove anything not
 * explicitly allowed. The finished output is then sanitized AGAIN and must
 * come out the same (a fixed point): whatever the minifier did to the text,
 * the result is something the sanitizer itself would keep.
 *
 * The allowlist below is intentionally narrow. It covers what
 * people need for a personal avatar (shapes, paths, gradients,
 * basic text, filters, SMIL animation) but refuses the esoteric
 * features. Animation and filters were added deliberately (an
 * animated avatar used to reach the chain as one still frame).
 */

/** Max byte size for the final avatar payload (SVG text or raster
 *  data URI). Sits under the 8 KB indexer/chain profile cap with
 *  room for display_name, URLs, and JSON-escape overhead — a maxed
 *  6 KB avatar plus fully-populated text fields lands near ~7.6 KB,
 *  still inside MAX_JSONB_BYTES_PROFILE. */
export const MAX_AVATAR_BYTES = 6144;

/** Max byte size for the INPUT file the user picks.  Decoupled
 *  from the output cap above: a 5 MB phone photo is fine — it'll
 *  be resized to 96×96.  But a 100 MB image would freeze the tab
 *  inside createImageBitmap before any of our checks could run.
 *  5 MB is generous for modern phone photos and tight enough to
 *  prevent tab-DoS on a paste of a huge file. */
export const MAX_INPUT_FILE_BYTES = 5 * 1024 * 1024;

// A small file can still be a pixel-bomb — e.g. a 2 MB PNG that decodes to
// 30000×30000 (2.7 GB in memory). The 5 MB file cap above does not catch that,
// and createImageBitmap would OOM/freeze the tab before any downstream check.
// So we read the dimensions from the file HEADER and reject an over-large image
// up front, with an accurate message (not the misleading "corrupt").
export const MAX_AVATAR_SOURCE_PIXELS = 40_000_000; // 40 MP
export const MAX_AVATAR_SOURCE_DIM = 12000; // per side

/** Read a raster image's intrinsic pixel dimensions from its header bytes,
 *  without decoding it. Handles PNG, GIF, JPEG, and WebP (VP8X). Returns null
 *  for an unrecognised/too-short header (caller then falls through to decode,
 *  whose try/catch is the backstop). PURE + testable. */
export function readRasterDimensions(b: Uint8Array): { width: number; height: number } | null {
	// PNG: \x89PNG\r\n\x1a\n then IHDR; width/height are BE uint32 at 16/20.
	if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		const be32 = (o: number): number =>
			((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
		return { width: be32(16), height: be32(20) };
	}
	// GIF: "GIF8" then LE uint16 width/height at 6/8.
	if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
		return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
	}
	// WebP: "RIFF"...."WEBP" then a chunk; VP8X carries 24-bit (dim-1) at 24/27.
	if (
		b.length >= 30 &&
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50 &&
		b[12] === 0x56 &&
		b[13] === 0x50 &&
		b[14] === 0x38 &&
		b[15] === 0x58
	) {
		const w = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1;
		const h = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1;
		return { width: w, height: h };
	}
	// JPEG: FFD8, then scan segments for an SOF marker carrying height/width BE.
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) {
				i++;
				continue;
			}
			const marker = b[i + 1]!;
			// SOF0..SOF15 carry dimensions, except DHT(C4)/JPG(C8)/DAC(CC).
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc
			) {
				return { width: (b[i + 7]! << 8) | b[i + 8]!, height: (b[i + 5]! << 8) | b[i + 6]! };
			}
			if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
				i += 2; // standalone markers, no length
				continue;
			}
			const len = (b[i + 2]! << 8) | b[i + 3]!;
			if (len < 2) break;
			i += 2 + len;
		}
	}
	return null;
}

/** Soft warning threshold — UI shows a "getting large" hint above
 *  this, still accepts up to the hard cap. */

/** Pixel dimensions of the re-encoded raster output. 96 matches
 *  IdentityLabel's hero avatar size; anything larger is wasted
 *  bytes, anything smaller looks grainy when upscaled. */
export const AVATAR_RASTER_SIZE = 96;

/** Quality for WebP re-encode. 0.8 is a standard "good enough"
 *  photo quality — higher values produce noticeably larger output
 *  without visible improvement at 96×96. */
export const AVATAR_WEBP_QUALITY = 0.8;

export type AvatarResult =
	| { ok: true; value: string; byteLength: number; kind: 'svg' | 'raster' }
	| { ok: false; code: AvatarErrorCode };

export type AvatarErrorCode =
	| 'unsupported_type'
	| 'empty_file'
	| 'input_too_large'
	| 'image_dimensions_too_large'
	| 'parse_failed'
	| 'svg_no_root'
	| 'svg_too_large'
	| 'raster_too_large'
	| 'raster_decode_failed'
	| 'canvas_unavailable'
	| 'webp_unavailable'
	| 'load_failed';

/**
 * Minify SVG text. Lossless: no structural or visual changes, just
 * byte-level compaction to squeeze the payload under the size cap
 * and reduce on-chain storage cost.
 *
 * Operations applied (safe across all renderers):
 *   - Strip XML prolog (`<?xml ... ?>`) and UTF-8 BOM if present.
 *   - Collapse runs of whitespace between tags.
 *   - Strip whitespace inside tag brackets (between attributes).
 *   - Compact numeric attribute values: "0.50" → ".5", "1.0" → "1".
 *   - Drop empty <title>, <desc>, <metadata> elements (they round-trip
 *     to nothing visible but cost bytes).
 *
 * Operations deliberately NOT applied (preserve correctness):
 *   - No path-data rewriting. "M 10 10 L 20 20" stays as-is. Compact
 *     path encoders (M10,10L20,20) exist but have subtle edge cases
 *     around implicit commands after moveto — not worth the risk
 *     for a 5% byte savings.
 *   - No attribute reordering. Deterministic output order matters
 *     for the sanitizer's tests.
 *   - No whitespace stripping inside <text>, <tspan>, <title>,
 *     <desc> — those are user-visible character data.
 *   - No color hex shortening (#aabbcc → #abc). Only valid for
 *     colors with repeated nibbles; adds a branch we don't need.
 *
 * Runs AFTER sanitization on the already-cleaned DOM-serialized
 * output, so it never sees hostile input.
 */
export function minifySvg(svg: string): string {
	let out = svg;

	// Strip UTF-8 BOM if the browser's XMLSerializer added one.
	if (out.charCodeAt(0) === 0xfeff) {
		out = out.slice(1);
	}

	// Strip XML prolog. <?xml version="1.0" ... ?> is valid but not
	// required for inline SVG in an HTML document.
	out = out.replace(/^\s*<\?xml[^?]*\?>\s*/, '');

	// Drop empty <title/>, <desc/>, <metadata/>. These are useful
	// when populated (accessibility, provenance) but a11y is already
	// handled at the <span> wrapper level in the renderer, and
	// empty metadata is just bytes.
	out = out.replace(/<title\s*\/>/gi, '');
	out = out.replace(/<title>\s*<\/title>/gi, '');
	out = out.replace(/<desc\s*\/>/gi, '');
	out = out.replace(/<desc>\s*<\/desc>/gi, '');
	out = out.replace(/<metadata\s*\/>/gi, '');
	out = out.replace(/<metadata>[^<]*<\/metadata>/gi, '');

	// Collapse whitespace between tags (but preserve whitespace
	// inside text content). Matches `>  <` and similar.
	out = out.replace(/>\s+</g, '><');

	// Collapse runs of whitespace inside opening tags only
	// (between attributes). We need to be careful NOT to touch
	// quoted attribute values. A small state machine is simpler
	// and safer than a clever regex.
	out = compactTagWhitespace(out);

	// Trim leading/trailing whitespace of the whole document.
	out = out.trim();

	// Compact numeric attribute values: "0.5" → ".5", "1.0" → "1",
	// "10.00" → "10". Applied to every attribute="value" pair.
	out = out.replace(
		/(\s[\w:-]+=")([^"]*)(")/g,
		(_, pre, val, post) => pre + compactNumbers(val) + post
	);

	return out;
}

/** Walk the serialized SVG, compacting whitespace between attributes
 *  inside tag brackets but never inside attribute values. */
function compactTagWhitespace(s: string): string {
	const out: string[] = [];
	let i = 0;
	const n = s.length;
	while (i < n) {
		const c = s[i]!;
		if (c === '<') {
			// Find end of tag.
			const end = findTagEnd(s, i);
			if (end < 0) {
				out.push(s.slice(i));
				break;
			}
			out.push(compactInsideTag(s.slice(i, end + 1)));
			i = end + 1;
		} else {
			out.push(c);
			i++;
		}
	}
	return out.join('');
}

/** Find the closing '>' of a tag starting at index `start`, skipping
 *  over quoted attribute values and never matching a '>' inside them. */
function findTagEnd(s: string, start: number): number {
	let inQuote: '"' | "'" | null = null;
	for (let i = start + 1; i < s.length; i++) {
		const c = s[i]!;
		if (inQuote) {
			if (c === inQuote) inQuote = null;
		} else if (c === '"' || c === "'") {
			inQuote = c;
		} else if (c === '>') {
			return i;
		}
	}
	return -1;
}

/** Compact runs of whitespace inside a single tag, preserving
 *  quoted attribute values verbatim. */
function compactInsideTag(tag: string): string {
	const out: string[] = [];
	let inQuote: '"' | "'" | null = null;
	let lastWasSpace = false;
	for (let i = 0; i < tag.length; i++) {
		const c = tag[i]!;
		if (inQuote) {
			out.push(c);
			if (c === inQuote) inQuote = null;
			lastWasSpace = false;
		} else if (c === '"' || c === "'") {
			out.push(c);
			inQuote = c;
			lastWasSpace = false;
		} else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
			if (!lastWasSpace) out.push(' ');
			lastWasSpace = true;
		} else {
			// Trim the space right before '>' or '/>'.
			if (lastWasSpace && (c === '>' || c === '/')) {
				out.pop();
			}
			out.push(c);
			lastWasSpace = false;
		}
	}
	return out.join('');
}

/** Compact numeric representations inside an attribute value. Only
 *  touches standalone numeric tokens — preserves separators,
 *  commands, and non-numeric content. */
function compactNumbers(val: string): string {
	return val.replace(/(-?)(\d*)\.(\d+)/g, (_match, sign, intPart, decPart) => {
		// Strip leading zero before decimal: "0.5" → ".5".
		const i = intPart === '0' || intPart === '' ? '' : intPart;
		// Strip trailing zeros from decimal: "0.500" → ".5".
		const d = decPart.replace(/0+$/, '');
		if (d === '') {
			// Whole number masquerading as float ("1.0" → "1", "10.00" → "10").
			return sign + (intPart || '0');
		}
		return sign + i + '.' + d;
	});
}

// ─── Tag + attribute allowlists ─────────────────────────────────

const ALLOWED_TAGS = new Set([
	'svg',
	'g',
	'defs',
	'title',
	'desc',
	'path',
	'circle',
	'ellipse',
	'rect',
	'line',
	'polyline',
	'polygon',
	'text',
	'tspan',
	'lineargradient',
	'radialgradient',
	'stop',
	'use',
	'symbol',
	'clippath',
	'mask',
	'pattern',
	'marker',
	// SMIL animation — kept only when isSafeAnimation says so.
	'animate',
	'animatetransform',
	'animatemotion',
	'set',
	'mpath',
	// Filters. Not <feImage>: it loads a picture (from elsewhere, or another
	// part of the page when the SVG is inlined).
	'filter',
	'feblend',
	'fecolormatrix',
	'fecomponenttransfer',
	'fefunca',
	'fefuncb',
	'fefuncg',
	'fefuncr',
	'fecomposite',
	'feconvolvematrix',
	'fediffuselighting',
	'fedisplacementmap',
	'fedistantlight',
	'fedropshadow',
	'feflood',
	'fegaussianblur',
	'femerge',
	'femergenode',
	'femorphology',
	'feoffset',
	'fepointlight',
	'fespecularlighting',
	'fespotlight',
	'fetile',
	'feturbulence'
]);

/** Global attributes allowed on any allowed element. */
const ALLOWED_ATTRS_GLOBAL = new Set([
	'id',
	'style', // cleaned declaration by declaration (cleanStyle)
	'transform',
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
	'filter', // url(#id) of a <filter> in the same picture, nothing else (isSafeReference)
	'marker-start',
	'marker-mid',
	'marker-end',
	'color',
	'color-interpolation',
	'font-family',
	'font-size',
	'font-weight',
	'font-style',
	'text-anchor',
	'dominant-baseline',
	'letter-spacing'
]);

/** When an animation runs. No value here can load anything or run script
 *  (`begin="click"` waits for a click; it does not run code). Clock values
 *  ("00:00:02") contain a colon, so these are not checked like SMIL_VALUES. */
const SMIL_TIMING = [
	'begin',
	'dur',
	'end',
	'min',
	'max',
	'restart',
	'repeatcount',
	'repeatdur',
	'fill', // freeze | remove, on an animation
	'calcmode',
	'keytimes',
	'keysplines',
	'additive',
	'accumulate'
] as const;

/** What an animation animates TO: checked by isSafeAnimationValue. */
const SMIL_VALUES = ['values', 'from', 'to', 'by'] as const;

/** Attributes every filter primitive takes. `in` / `in2` / `result` name other
 *  primitives' results inside the same filter. No primitive subregion
 *  (`x` / `y` / `width` / `height`): the filter's own region, bounded by
 *  boundFilters, is the only one. */
const FE_COMMON = ['result', 'in', 'color-interpolation-filters'] as const;

/** The transfer functions of feComponentTransfer. */
const FE_FUNC = [
	'type',
	'tablevalues',
	'slope',
	'intercept',
	'amplitude',
	'exponent',
	'offset'
] as const;

/** What an avatar animation may change: how the picture looks, nothing else.
 *  Never a link (`href`), an event handler, `style`, `class` or `id` — set on
 *  an SVG that another reader inlines, those would turn it into a link, run
 *  script, or move it out of its frame over the page. */
const SAFE_ANIMATION_TARGETS = new Set([
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

/** An animated value must name nothing outside the picture: no protocol
 *  (javascript:, data:, https:), no outside `url()` — only `url(#id)` —, no
 *  markup and no CSS escape (which could spell either). Numbers, colours,
 *  path data and `#id` references all pass. */
function isSafeAnimationValue(value: string): boolean {
	if (/[:<>\\]/.test(value)) return false;
	return !/url\(\s*[^\s#]/i.test(value);
}

/**
 * Whether an animation element may stay. It must name exactly ONE target
 * attribute, in any letter case (XML treats `attributename` as a different
 * attribute, but an HTML parser that inlines the SVG restores the case, so a
 * second spelling would be a second target), that target must change only how
 * the picture looks, and every value it animates to must pass
 * isSafeAnimationValue. <animateMotion> moves its element along a path and
 * takes no target (its allowlist drops any `attributeName`). Anything else
 * removes the whole animation: one with its target or values stripped would do
 * nothing anyway. An animation inside a `<filter>` is never kept.
 */
function isSafeAnimation(el: Element, tag: string, parentTag: string): boolean {
	// Nothing in a filter moves: a filter re-run every frame, with its blur or
	// spread growing, is what froze a viewer's tab.
	if (parentTag === 'filter' || parentTag.startsWith('fe')) return false;
	const attrs = Array.from(el.attributes);
	if (tag !== 'animatemotion') {
		const targets = attrs
			.filter((a) => a.name.toLowerCase() === 'attributename')
			.map((a) => a.value.trim().toLowerCase());
		if (targets.length !== 1 || !SAFE_ANIMATION_TARGETS.has(targets[0]!)) return false;
		// The picture's own size and place stay put: inlined in a page, an
		// `<svg width>` animated to 1e9 would stretch the page.
		if (parentTag === 'svg' && ROOT_FRAME_ATTRS.has(targets[0]!)) return false;
	}
	return attrs
		.filter((a) => (SMIL_VALUES as readonly string[]).includes(a.name.toLowerCase()))
		.every((a) => isSafeAnimationValue(a.value));
}

const ANIMATION_TAGS = new Set(['animate', 'animatetransform', 'animatemotion', 'set']);

/** An `<svg>`'s own frame: not animated (isSafeAnimation). */
const ROOT_FRAME_ATTRS = new Set(['x', 'y', 'width', 'height']);

/** The elements an `#id` href means something on. */
const HREF_TAGS = new Set(['use', 'mpath', 'lineargradient', 'radialgradient', 'pattern']);

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An element of the SVG namespace (or of none: an `<svg>` written without
 *  xmlns, which gets it added). An `<animate>` in the XHTML namespace does
 *  nothing here, but an HTML parser that inlines the SVG ignores the
 *  namespace and makes it a live SVG animation again. */
function isSvgElement(el: Element): boolean {
	return el.namespaceURI === SVG_NS || el.namespaceURI === null;
}

/** Attributes whose value may point at another part of the picture with
 *  `url(#id)` — and never anywhere else. */
const REFERENCE_ATTRS = new Set([
	'fill',
	'stroke',
	'clip-path',
	'mask',
	'filter',
	'marker-start',
	'marker-mid',
	'marker-end'
]);

/** CSS functions a paint / reference value may use: colours, and `url()` of
 *  an `#id` in the picture. Anything else (`image-set("x.png" 1x)` in a
 *  `mask`, `cross-fade()`, `element()`, `blur()`…) could load a picture or
 *  get round the filter limits. */
const SAFE_CSS_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

/**
 * A paint / reference / style value that stays inside the picture: no markup
 * or CSS escape, and no function but a colour or `url(#id)` — so `filter` can
 * only name `<filter>`s of the picture: a CSS filter function (`blur(5000px)`)
 * would get round the limits boundFilters puts on the `<filter>` elements.
 */
function isSafeReference(value: string): boolean {
	if (/[<>\\]/.test(value)) return false;
	for (const m of value.matchAll(/([a-z][\w-]*)\s*\(/gi)) {
		const fn = m[1]!.toLowerCase();
		if (fn === 'url') {
			if (!/^url\(\s*(['"]?)#[^\s'"()]+\1\s*\)/i.test(value.slice(m.index))) return false;
		} else if (!SAFE_CSS_FUNCTIONS.has(fn)) {
			return false;
		}
	}
	// A `(` that is not a function call (`(` alone, `x (`) is not paint either.
	return (value.match(/\(/g) ?? []).length === [...value.matchAll(/[a-z][\w-]*\s*\(/gi)].length;
}

/** Properties a `style=""` may set: presentation properties only. */
const STYLE_PROPS = new Set([
	// Not `filter`: only the attribute, which boundFilters counts.
	...Array.from(ALLOWED_ATTRS_GLOBAL).filter(
		(a) => a !== 'id' && a !== 'style' && a !== 'transform' && a !== 'filter'
	),
	'stop-color',
	'stop-opacity',
	'flood-color',
	'flood-opacity',
	'lighting-color',
	'color-interpolation-filters'
]);

/**
 * Keep the declarations of a `style=""` that only change how the picture
 * looks; drop the rest (positioning, `animation`, `content`, `behavior`, CSS
 * filter functions, anything with an outside `url()`, a comment or an
 * escape). Returns the kept declarations, or '' for none.
 */
export function cleanStyle(value: string): string {
	if (/\/\*|\\/.test(value)) return '';
	const kept: string[] = [];
	for (const decl of value.split(';')) {
		const i = decl.indexOf(':');
		if (i < 0) continue;
		const prop = decl.slice(0, i).trim().toLowerCase();
		const val = decl.slice(i + 1).trim();
		if (!STYLE_PROPS.has(prop) || val.length === 0) continue;
		if (/[:;{}]/.test(val) || !isSafeReference(val)) continue;
		kept.push(`${prop}:${val}`);
	}
	return kept.join(';');
}

/** Elements whose content is drawn once per referrer (or, for a marker, once
 *  per point of the path): no `<use>` and no filter inside them, or one small
 *  element multiplies into hundreds of filter runs. */
const REPEATED_CONTENT_TAGS = new Set(['marker', 'pattern', 'mask', 'clippath']);

function drawnOnlyByUse(el: Element): boolean {
	for (let p: Element | null = el; p !== null; p = p.parentElement) {
		const t = p.nodeName.toLowerCase();
		if (t === 'defs' || t === 'symbol') return true;
	}
	return false;
}

function insideRepeatedContent(el: Element): boolean {
	for (let p = el.parentElement; p !== null; p = p.parentElement) {
		if (REPEATED_CONTENT_TAGS.has(p.nodeName.toLowerCase())) return true;
	}
	return false;
}

/** Every element under `root`. (Not querySelectorAll: in jsdom, where the
 *  tests and the fuzz run, it slows down with every document parsed — 2.9 s
 *  then 4.5 s per 1000 small documents, against a flat 70 ms for this.) */
function descendants(root: Element): Element[] {
	return Array.from(root.getElementsByTagName('*'));
}

/** The element a `<use>` copies, if it is in this picture. */
function useTarget(use: Element, byId: Map<string, Element>): Element | undefined {
	const ref = (use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '').trim();
	return ref.startsWith('#') ? byId.get(ref.slice(1)) : undefined;
}

function elementsById(root: Element): Map<string, Element> {
	const byId = new Map<string, Element>();
	for (const el of descendants(root).filter((e) => e.hasAttribute('id'))) {
		const id = el.getAttribute('id')!;
		if (!byId.has(id)) byId.set(id, el);
	}
	return byId;
}

/** At most this many `<use>` in one avatar (the owner's 5 KB scene has 11). */
export const MAX_USE_ELEMENTS = 32;

/**
 * `<use>` copies another part of the picture. A copy of something that itself
 * holds a `<use>` multiplies: 5 levels of 10 is 100 000 shapes from a 1.7 KB
 * file, seconds of frozen tab for every viewer. So a `<use>` may only copy
 * an element of this picture that holds no `<use>`, and there may be at most
 * MAX_USE_ELEMENTS of them; the rest are removed.
 */
function boundUses(root: Element): void {
	const byId = elementsById(root);
	let kept = 0;
	for (const use of Array.from(root.getElementsByTagName('use'))) {
		if (!use.isConnected) continue;
		if (insideRepeatedContent(use)) {
			use.parentNode?.removeChild(use);
			continue;
		}
		const target = useTarget(use, byId);
		const fans =
			target === undefined ||
			target.nodeName.toLowerCase() === 'use' ||
			target.getElementsByTagName('use').length > 0 ||
			target.contains(use);
		if (fans || kept >= MAX_USE_ELEMENTS) {
			use.parentNode?.removeChild(use);
			continue;
		}
		kept++;
	}
}

/** The picture's size in its own units: the smaller side of the viewBox, or
 *  of width / height, or the avatar size. Filter limits are shares of it. */
function pictureExtent(root: Element): number {
	const vb = (root.getAttribute('viewBox') ?? root.getAttribute('viewbox') ?? '')
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	if (vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) return Math.min(vb[2]!, vb[3]!);
	const w = parseFloat(root.getAttribute('width') ?? '');
	const h = parseFloat(root.getAttribute('height') ?? '');
	if (w > 0 && h > 0) return Math.min(w, h);
	return AVATAR_RASTER_SIZE;
}

/** Hold every number of a list attribute to [min, max]; a value that is not
 *  a number list is removed. */
function clampNumbers(el: Element, name: string, min: number, max: number, integer = false): void {
	const raw = el.getAttribute(name);
	if (raw === null) return;
	const parts = raw.trim().split(/[\s,]+/);
	const nums = parts.map(Number);
	if (parts.length === 0 || nums.some((n) => !Number.isFinite(n))) {
		el.removeAttribute(name);
		return;
	}
	if (nums.every((n) => n >= min && n <= max && (!integer || Number.isInteger(n)))) return;
	const held = nums.map((n) => {
		const c = Math.min(max, Math.max(min, n));
		return integer ? Math.floor(c) : c;
	});
	el.setAttribute(name, held.join(' '));
}

/** A filter region number: `-30%`, `1.6`. Held to [min, max] as a share of
 *  the filtered shape's box; anything else is removed (the default region,
 *  10% around the box, applies). */
function clampRegion(el: Element, name: string, min: number, max: number): void {
	const raw = el.getAttribute(name);
	if (raw === null) return;
	const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(%?)\s*$/i.exec(raw);
	if (!m) {
		el.removeAttribute(name);
		return;
	}
	const share = Number(m[1]) / (m[2] ? 100 : 1);
	if (share >= min && share <= max) return;
	el.setAttribute(name, String(Math.min(max, Math.max(min, share))));
}

/**
 * Filters cost the viewer's browser in proportion to their region and their
 * blur / spread sizes: `<feMorphology radius="5000">` in a 298-byte avatar
 * held 30 orderbook avatars to 3 frames in 4 s. These limits keep everything
 * a picture this size can show (a blur or spread up to an eighth of the
 * picture, a shadow or shift up to its width, a region up to three times the
 * shape) and nothing that only burns the viewer's CPU. MAX_FILTER_COST bounds
 * how often they run.
 */
/**
 * How much filter work one avatar may ask for. Every filtered element runs
 * each primitive of its filter once, and once more for every `<use>` that
 * copies it; each run costs FILTER_PRIMITIVE_COST of its primitive, and the
 * total may not pass MAX_FILTER_COST. Measured in Chromium (software
 * rendering, 30 avatars of one design on screen — one account with 30 orders
 * in the orderbook —, 4 s, the largest filter region allowed): any animation
 * anywhere in the picture re-runs every filter every frame, and 8 filtered
 * shapes × 3 heavy primitives held the page to 4 frames. Per run, a 5 × 5
 * convolution cost about 19 ms (it is held to 3 × 3 now), a morphology about
 * 8.5, specular lighting about 3, diffuse lighting and a drop shadow 2.5, a
 * blur 1.5, a displacement 0.75, the rest next to nothing. At this budget the
 * worst designs measured kept about 175–220 of 240 frames. The owner's 5 KB scene
 * (5 runs of one small blur) costs 10.
 * Over the budget the picture keeps its shapes and loses its filters: a
 * still, sharp avatar instead of a frozen tab for every viewer.
 */
export const MAX_FILTER_COST = 12;

const FILTER_PRIMITIVE_COST: Readonly<Record<string, number>> = {
	femorphology: 6,
	feconvolvematrix: 12,
	fegaussianblur: 2,
	fedropshadow: 3,
	fediffuselighting: 3,
	fespecularlighting: 4,
	fedisplacementmap: 2
};
/** Any other primitive (colour matrix, offset, flood, tile, merge, blend,
 *  composite, component transfer, turbulence). */
const CHEAP_PRIMITIVE_COST = 1;

function boundFilters(root: Element): void {
	// Filtered content inside markers / patterns / masks / clip paths is drawn
	// once per referrer or path point: no filter there.
	for (const el of descendants(root).filter((e) => e.hasAttribute('filter'))) {
		if (insideRepeatedContent(el)) el.removeAttribute('filter');
	}
	const byId = elementsById(root);
	const filtered = descendants(root).filter((e) => e.hasAttribute('filter'));
	/** What one run of the element's filter(s) costs (each url(#id) in it). */
	const costOf = (el: Element): number =>
		[...(el.getAttribute('filter') ?? '').matchAll(/#([^\s'"()]+)/g)].reduce((n, m) => {
			const f = byId.get(m[1]!);
			if (f === undefined || f.nodeName.toLowerCase() !== 'filter') return n;
			for (const c of Array.from(f.children)) {
				const t = c.nodeName.toLowerCase();
				if (t.startsWith('fe')) n += FILTER_PRIMITIVE_COST[t] ?? CHEAP_PRIMITIVE_COST;
			}
			return n;
		}, 0);
	// A shape in <defs> or a <symbol> is only drawn through a <use> (counted
	// below), never by itself.
	let cost = filtered.reduce((n, el) => (drawnOnlyByUse(el) ? n : n + costOf(el)), 0);
	for (const use of Array.from(root.getElementsByTagName('use'))) {
		const target = useTarget(use, byId);
		if (target === undefined) continue;
		for (const el of filtered) if (target.contains(el)) cost += costOf(el);
	}
	if (cost > MAX_FILTER_COST) {
		for (const el of filtered) el.removeAttribute('filter');
	}
	const extent = pictureExtent(root);
	const spread = extent / 8;
	for (const f of Array.from(root.getElementsByTagName('filter'))) {
		clampRegion(f, 'x', -1, 1);
		clampRegion(f, 'y', -1, 1);
		clampRegion(f, 'width', 0, 3);
		clampRegion(f, 'height', 0, 3);
	}
	for (const el of descendants(root)) {
		switch (el.nodeName.toLowerCase()) {
			case 'fegaussianblur':
				clampNumbers(el, 'stdDeviation', 0, spread);
				clampNumbers(el, 'stddeviation', 0, spread);
				break;
			case 'fedropshadow':
				clampNumbers(el, 'stdDeviation', 0, spread);
				clampNumbers(el, 'stddeviation', 0, spread);
				clampNumbers(el, 'dx', -extent, extent);
				clampNumbers(el, 'dy', -extent, extent);
				break;
			case 'femorphology':
				clampNumbers(el, 'radius', 0, spread);
				break;
			case 'feoffset':
				clampNumbers(el, 'dx', -extent, extent);
				clampNumbers(el, 'dy', -extent, extent);
				break;
			case 'fedisplacementmap':
				clampNumbers(el, 'scale', -extent, extent);
				break;
			case 'feturbulence':
				clampNumbers(el, 'numOctaves', 1, 4, true);
				clampNumbers(el, 'numoctaves', 1, 4, true);
				break;
			case 'feconvolvematrix':
				clampNumbers(el, 'order', 1, 3, true);
				break;
		}
	}
}

/** One `begin` / `end` item: a time offset (`-5s`, `2.5`, `200ms`), a clock
 *  value (`00:02`), `indefinite`, or another animation of this picture
 *  (`a.end`, `a.begin+1s`). */
const TIME_OFFSET = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:h|min|s|ms)?`;
const TIME_CLOCK = String.raw`[+-]?(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?`;
const TIME_ITEM_RE = new RegExp(`^(?:${TIME_OFFSET}|${TIME_CLOCK}|indefinite)$`);
const SYNCBASE_RE = new RegExp(
	`^([A-Za-z_][\\w-]*)\\.(?:begin|end)(?:\\s*[+-]\\s*(?:${TIME_OFFSET}|${TIME_CLOCK}))?$`
);

/**
 * When an animation starts or ends: only at a time, or relative to another
 * animation in the same picture. Never on an event (`x.click`, `accessKey(…)`)
 * or a wall clock: an SVG inlined in a page could otherwise wait on the
 * page's own elements. A `begin` / `end` that is anything else is removed
 * (the animation then simply starts at once / runs on).
 */
function boundTiming(root: Element): void {
	const animationIds = new Set<string>();
	for (const el of descendants(root).filter((e) => e.hasAttribute('id'))) {
		if (ANIMATION_TAGS.has(el.nodeName.toLowerCase())) animationIds.add(el.getAttribute('id')!);
	}
	for (const el of descendants(root)) {
		if (!ANIMATION_TAGS.has(el.nodeName.toLowerCase())) continue;
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (name !== 'begin' && name !== 'end') continue;
			const ok = attr.value.split(';').every((raw) => {
				const item = raw.trim();
				if (TIME_ITEM_RE.test(item)) return true;
				const sync = SYNCBASE_RE.exec(item);
				return sync !== null && animationIds.has(sync[1]!);
			});
			if (!ok) el.removeAttribute(attr.name);
		}
	}
}

/** Per-element attribute allowlists. Union with the global set. */
const ALLOWED_ATTRS_PER_TAG: Record<string, Set<string>> = {
	svg: new Set([
		'width',
		'height',
		'viewbox',
		'xmlns',
		'preserveaspectratio',
		'version',
		'role',
		'aria-label'
	]),
	g: new Set([]),
	defs: new Set([]),
	title: new Set([]),
	desc: new Set([]),
	path: new Set(['d', 'pathlength']),
	circle: new Set(['cx', 'cy', 'r']),
	ellipse: new Set(['cx', 'cy', 'rx', 'ry']),
	rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry']),
	line: new Set(['x1', 'y1', 'x2', 'y2']),
	polyline: new Set(['points']),
	polygon: new Set(['points']),
	text: new Set(['x', 'y', 'dx', 'dy', 'rotate', 'textlength', 'lengthadjust']),
	tspan: new Set(['x', 'y', 'dx', 'dy', 'rotate']),
	lineargradient: new Set([
		'x1',
		'y1',
		'x2',
		'y2',
		'gradientunits',
		'gradienttransform',
		'spreadmethod'
	]),
	radialgradient: new Set([
		'cx',
		'cy',
		'r',
		'fx',
		'fy',
		'gradientunits',
		'gradienttransform',
		'spreadmethod'
	]),
	stop: new Set(['offset', 'stop-color', 'stop-opacity']),
	use: new Set(['x', 'y', 'width', 'height', 'href', 'xlink:href']),
	symbol: new Set(['viewbox', 'preserveaspectratio']),
	clippath: new Set(['clippathunits']),
	mask: new Set(['x', 'y', 'width', 'height', 'maskunits', 'maskcontentunits']),
	pattern: new Set([
		'x',
		'y',
		'width',
		'height',
		'patternunits',
		'patterncontentunits',
		'patterntransform',
		'viewbox'
	]),
	marker: new Set([
		'markerunits',
		'markerwidth',
		'markerheight',
		'orient',
		'refx',
		'refy',
		'viewbox'
	]),
	animate: new Set([...SMIL_TIMING, ...SMIL_VALUES, 'attributename', 'attributetype']),
	animatetransform: new Set([
		...SMIL_TIMING,
		...SMIL_VALUES,
		'attributename',
		'attributetype',
		'type'
	]),
	animatemotion: new Set([...SMIL_TIMING, ...SMIL_VALUES, 'path', 'keypoints', 'rotate', 'origin']),
	set: new Set([...SMIL_TIMING, 'attributename', 'attributetype', 'to']),
	mpath: new Set([]),
	// No filterUnits / primitiveUnits: the region is always a share of the
	// filtered shape's box (bounded by boundFilters), and blur sizes are in the
	// picture's own units, which boundFilters holds to the picture's size.
	filter: new Set(['x', 'y', 'width', 'height', 'color-interpolation-filters']),
	feblend: new Set([...FE_COMMON, 'in2', 'mode']),
	fecolormatrix: new Set([...FE_COMMON, 'type', 'values']),
	fecomponenttransfer: new Set([...FE_COMMON]),
	fefunca: new Set(FE_FUNC),
	fefuncb: new Set(FE_FUNC),
	fefuncg: new Set(FE_FUNC),
	fefuncr: new Set(FE_FUNC),
	fecomposite: new Set([...FE_COMMON, 'in2', 'operator', 'k1', 'k2', 'k3', 'k4']),
	feconvolvematrix: new Set([
		...FE_COMMON,
		'order',
		'kernelmatrix',
		'divisor',
		'bias',
		'targetx',
		'targety',
		'edgemode',
		'preservealpha'
	]),
	fediffuselighting: new Set([...FE_COMMON, 'surfacescale', 'diffuseconstant', 'lighting-color']),
	fedisplacementmap: new Set([
		...FE_COMMON,
		'in2',
		'scale',
		'xchannelselector',
		'ychannelselector'
	]),
	fedistantlight: new Set(['azimuth', 'elevation']),
	fedropshadow: new Set([...FE_COMMON, 'dx', 'dy', 'stddeviation', 'flood-color', 'flood-opacity']),
	feflood: new Set([...FE_COMMON, 'flood-color', 'flood-opacity']),
	fegaussianblur: new Set([...FE_COMMON, 'stddeviation', 'edgemode']),
	femerge: new Set([...FE_COMMON]),
	femergenode: new Set(['in']),
	femorphology: new Set([...FE_COMMON, 'operator', 'radius']),
	feoffset: new Set([...FE_COMMON, 'dx', 'dy']),
	fepointlight: new Set(['x', 'y', 'z']),
	fespecularlighting: new Set([
		...FE_COMMON,
		'surfacescale',
		'specularconstant',
		'specularexponent',
		'lighting-color'
	]),
	fespotlight: new Set([
		'x',
		'y',
		'z',
		'pointsatx',
		'pointsaty',
		'pointsatz',
		'specularexponent',
		'limitingconeangle'
	]),
	fetile: new Set([...FE_COMMON]),
	feturbulence: new Set([
		...FE_COMMON,
		'basefrequency',
		'numoctaves',
		'seed',
		'stitchtiles',
		'type'
	])
};

/** Protocols safe to allow in href/xlink:href. Only fragment refs
 *  (internal `#id`) are useful for `<use>`, which is the primary
 *  legitimate consumer. All external protocols (http, https,
 *  data, javascript, file, ftp, etc.) are rejected. */
function isSafeHref(value: string): boolean {
	const trimmed = value.trim().toLowerCase();
	return trimmed.startsWith('#');
}

// ─── Byte counting ──────────────────────────────────────────────

const encoder = new TextEncoder();

function byteLength(s: string): number {
	return encoder.encode(s).byteLength;
}

// Its own tiny module, so components can show an
// SVG avatar without pulling the whole sanitizer into their bundle.
export { svgAvatarImgSrc } from './imgSrc';

// ─── SVG sanitization ───────────────────────────────────────────

/**
 * Sanitize SVG text. Returns the cleaned SVG source, ready to be
 * stored as-is. Avatars render through an `<img>` data URI
 * (svgAvatarImgSrc), which runs no script; the sanitizer still
 * strips everything active, because other readers of the chain
 * may inline the SVG. The caller MUST NOT pass the original
 * untrusted input anywhere — only the output of this function.
 *
 * Rejects (returns ok:false) if:
 *   - input has no `<svg>` root
 *   - resulting SVG exceeds MAX_AVATAR_BYTES
 *   - parse fails outright
 *
 * Strips (without rejecting) all disallowed tags, attributes, and
 * href protocols, plus any comments / processing instructions.
 */
export function sanitizeSvg(input: string): AvatarResult {
	// What is stored must be a FIXED POINT: sanitized again, it comes out the
	// same. The minifier edits serialized TEXT; if anything it did (or anything
	// the parser and serializer disagree on) produced something the sanitizer
	// would not keep, that shows here. A harmless difference settles in one
	// more pass (an emptied `<svg></svg>` serializes as `<svg/>`); one that
	// does not settle is refused rather than stored.
	let current = sanitizeSvgOnce(input);
	for (let pass = 0; pass < 3; pass++) {
		if (!current.ok) return current;
		const again = sanitizeSvgOnce(current.value);
		if (again.ok && again.value === current.value) return current;
		current = again;
	}
	return { ok: false, code: 'parse_failed' };
}

function sanitizeSvgOnce(input: string): AvatarResult {
	if (!input || input.trim().length === 0) {
		return { ok: false, code: 'empty_file' };
	}
	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(input, 'image/svg+xml');
	} catch {
		return { ok: false, code: 'parse_failed' };
	}
	// DOMParser returns a document with <parsererror> inside if the
	// input wasn't well-formed XML. Detect and reject.
	const parserError = doc.getElementsByTagName('parsererror')[0];
	if (parserError) {
		return { ok: false, code: 'parse_failed' };
	}
	const root = doc.documentElement;
	if (!root || root.nodeName.toLowerCase() !== 'svg' || !isSvgElement(root)) {
		return { ok: false, code: 'svg_no_root' };
	}

	cleanElement(root);
	boundUses(root);
	boundFilters(root);
	boundTiming(root);

	// Force dimensions: if the user's SVG doesn't declare them, set
	// a reasonable default. Matches the raster path size.
	if (!root.hasAttribute('width')) {
		root.setAttribute('width', String(AVATAR_RASTER_SIZE));
	}
	if (!root.hasAttribute('height')) {
		root.setAttribute('height', String(AVATAR_RASTER_SIZE));
	}
	// Always include xmlns — some parsers strip it, some sources
	// omit it. Without it the SVG won't render inline.
	if (!root.hasAttribute('xmlns')) {
		root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	}

	// Serialize, then minify. Order matters: sanitize first
	// (security), then minify (byte reduction). The minifier runs
	// on already-cleaned output so it never parses hostile input.
	const serialized = new XMLSerializer().serializeToString(root);
	const minified = minifySvg(serialized);
	const bytes = byteLength(minified);
	if (bytes > MAX_AVATAR_BYTES) {
		return { ok: false, code: 'svg_too_large' };
	}

	return { ok: true, value: minified, byteLength: bytes, kind: 'svg' };
}

/** Recursive in-place DOM cleanup. Removes disallowed children and
 *  strips disallowed attributes from allowed elements (including
 *  the element itself, not just descendants).
 *
 *  Audit 2026-05 finding 6-2: pre-fix, this stripped attributes
 *  from `el.children` only — meaning the root <svg>'s own onload /
 *  onclick / etc. were never removed.  An attacker uploading
 *  `<svg onload="alert(1)">...</svg>` defeated the entire
 *  sanitizer.  The fix is to apply the attribute-stripping pass
 *  to `el` itself first, then recurse into children.
 */
function cleanElement(el: Element): void {
	// Strip disallowed attributes on `el` itself (including the
	// root <svg>).
	const tag = el.nodeName.toLowerCase();
	const perTag = ALLOWED_ATTRS_PER_TAG[tag] ?? new Set<string>();
	const ownAttrs = Array.from(el.attributes);
	for (const attr of ownAttrs) {
		const name = attr.name.toLowerCase();
		// on* event handlers — always strip.
		if (name.startsWith('on')) {
			el.removeAttribute(attr.name);
			continue;
		}
		// href and xlink:href — strip unless protocol-safe, and unless this is an
		// element that uses one (HREF_TAGS). An animation never keeps one: it
		// would retarget the animation (inlined, onto the page).
		if (name === 'href' || name === 'xlink:href') {
			if (!isSafeHref(attr.value) || !HREF_TAGS.has(tag)) {
				el.removeAttribute(attr.name);
			}
			continue;
		}
		// Allowlist check.
		if (!perTag.has(name) && !ALLOWED_ATTRS_GLOBAL.has(name)) {
			el.removeAttribute(attr.name);
			continue;
		}
		if (name === 'style') {
			const kept = cleanStyle(attr.value);
			if (kept === '') el.removeAttribute(attr.name);
			else if (kept !== attr.value) el.setAttribute(attr.name, kept);
			continue;
		}
		if (REFERENCE_ATTRS.has(name) && !isSafeReference(attr.value)) {
			el.removeAttribute(attr.name);
		}
	}

	// Walk a snapshot of children — we mutate as we go.
	const children = Array.from(el.children);
	for (const child of children) {
		const childTag = child.nodeName.toLowerCase();
		if (!ALLOWED_TAGS.has(childTag) || !isSvgElement(child)) {
			// Drop the entire subtree.
			el.removeChild(child);
			continue;
		}
		// An animation that could change more than the look goes whole.
		if (ANIMATION_TAGS.has(childTag) && !isSafeAnimation(child, childTag, tag)) {
			el.removeChild(child);
			continue;
		}
		// Recurse — child attribute-stripping happens at the
		// top of cleanElement now.
		cleanElement(child);
	}
	// Keep only elements and plain text (childNodes, not children — children
	// is elements only): comments, processing instructions and CDATA sections
	// go. CDATA is the one place the serializer writes markup unescaped, and
	// the minifier edits that text, so markup hidden in it could come back as
	// real elements (CDATA + `<title/>` smuggled a <script> through).
	const nodes = Array.from(el.childNodes);
	for (const n of nodes) {
		if (n.nodeType !== 1 /* ELEMENT_NODE */ && n.nodeType !== 3 /* TEXT_NODE */) {
			el.removeChild(n);
		}
	}
}

// ─── Raster re-encode ───────────────────────────────────────────

/**
 * Load a raster image File, resize to AVATAR_RASTER_SIZE, and
 * re-encode as WebP at AVATAR_WEBP_QUALITY. Returns a data URI
 * on success.
 *
 * The caller passes a File or Blob from a file-input element.
 * No upload happens — all work is done in the browser, and the
 * data URI is placed directly into the profile op.
 */
export async function reencodeRaster(file: Blob): Promise<AvatarResult> {
	if (file.size === 0) {
		return { ok: false, code: 'empty_file' };
	}
	if (typeof document === 'undefined') {
		// SSR or test env with no DOM — callers should only invoke
		// this from the browser.
		return { ok: false, code: 'canvas_unavailable' };
	}

	// Reject a pixel-bomb (small file, enormous dimensions) BEFORE createImageBitmap
	// can OOM/freeze the tab — read the dimensions from the header, don't decode.
	try {
		const head = new Uint8Array(await file.slice(0, 131072).arrayBuffer());
		const dims = readRasterDimensions(head);
		if (
			dims &&
			(dims.width * dims.height > MAX_AVATAR_SOURCE_PIXELS ||
				dims.width > MAX_AVATAR_SOURCE_DIM ||
				dims.height > MAX_AVATAR_SOURCE_DIM)
		) {
			return { ok: false, code: 'image_dimensions_too_large' };
		}
	} catch {
		// Couldn't read the header — fall through; the decode try/catch is the backstop.
	}

	// Decode the input. createImageBitmap is the fastest path and
	// is available in every modern browser; fall back to <img> if
	// absent.
	let bitmap: ImageBitmap | HTMLImageElement;
	try {
		if (typeof createImageBitmap === 'function') {
			bitmap = await createImageBitmap(file);
		} else {
			bitmap = await loadViaImgElement(file);
		}
	} catch {
		return { ok: false, code: 'raster_decode_failed' };
	}

	// Draw to a 96×96 canvas. Preserve aspect ratio via a contain
	// fit (centered, with transparent background) so the square
	// output never distorts the user's source image.
	const canvas = document.createElement('canvas');
	canvas.width = AVATAR_RASTER_SIZE;
	canvas.height = AVATAR_RASTER_SIZE;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return { ok: false, code: 'canvas_unavailable' };
	}
	const srcW = 'width' in bitmap ? bitmap.width : 0;
	const srcH = 'height' in bitmap ? bitmap.height : 0;
	if (srcW === 0 || srcH === 0) {
		return { ok: false, code: 'raster_decode_failed' };
	}

	// Contain fit into 96×96.
	const scale = Math.min(AVATAR_RASTER_SIZE / srcW, AVATAR_RASTER_SIZE / srcH);
	const dstW = Math.round(srcW * scale);
	const dstH = Math.round(srcH * scale);
	const dx = Math.floor((AVATAR_RASTER_SIZE - dstW) / 2);
	const dy = Math.floor((AVATAR_RASTER_SIZE - dstH) / 2);

	// Use high-quality resampling.
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	try {
		ctx.drawImage(bitmap as CanvasImageSource, dx, dy, dstW, dstH);
	} catch {
		return { ok: false, code: 'raster_decode_failed' };
	}

	// Encode as WebP. toBlob is async; wrap in a promise.
	const blob = await canvasToBlob(canvas, 'image/webp', AVATAR_WEBP_QUALITY);
	if (!blob) {
		return { ok: false, code: 'webp_unavailable' };
	}

	// Convert to data URI (base64). Read as ArrayBuffer then base64-encode.
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const b64 = bytesToBase64(bytes);
	const dataUri = `data:image/webp;base64,${b64}`;

	const uriBytes = byteLength(dataUri);
	if (uriBytes > MAX_AVATAR_BYTES) {
		return { ok: false, code: 'raster_too_large' };
	}

	return {
		ok: true,
		value: dataUri,
		byteLength: uriBytes,
		kind: 'raster'
	};
}

/** Fallback image loader for environments without createImageBitmap. */
function loadViaImgElement(blob: Blob): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('load_failed'));
		};
		img.src = url;
	});
}

function canvasToBlob(
	canvas: HTMLCanvasElement,
	mime: string,
	quality: number
): Promise<Blob | null> {
	return new Promise((resolve) => {
		canvas.toBlob(
			(blob) => {
				resolve(blob);
			},
			mime,
			quality
		);
	});
}

/** Base64-encode a byte array. Uses btoa + binary-string shim,
 *  which is correct for all 0-255 byte values. */
function bytesToBase64(bytes: Uint8Array): string {
	let s = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		s += String.fromCharCode.apply(null, Array.from(chunk) as number[]);
	}
	return btoa(s);
}

// ─── Top-level dispatcher ───────────────────────────────────────

/** Supported MIME types for the raster path. WebP is both an
 *  input format (user has a modern phone) and the output format. */
export const RASTER_MIMES = new Set([
	'image/webp',
	'image/jpeg',
	'image/jpg',
	'image/png',
	'image/gif'
]);

export const SVG_MIMES = new Set(['image/svg+xml']);

/** Process an uploaded File into a size-capped avatar value ready
 *  for the profile op. Dispatches by MIME type to either the SVG
 *  sanitizer or the raster re-encoder. */
export async function processAvatarFile(file: File): Promise<AvatarResult> {
	// reject huge inputs BEFORE expensive decode.
	// A 100 MB JPEG handed to createImageBitmap can freeze the tab
	// for seconds before any of our downstream checks would catch
	// it.  5 MB is generous for modern phone photos (which get
	// downsampled to 96×96 anyway) and tight enough to prevent DoS.
	if (file.size > MAX_INPUT_FILE_BYTES) {
		return { ok: false, code: 'input_too_large' };
	}
	const mime = file.type.toLowerCase();
	if (SVG_MIMES.has(mime)) {
		const text = await file.text();
		return sanitizeSvg(text);
	}
	if (RASTER_MIMES.has(mime)) {
		return reencodeRaster(file);
	}
	return { ok: false, code: 'unsupported_type' };
}
