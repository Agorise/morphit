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
 * and sibling fields (display_name, nostr_url, blurt_media_url).
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
 *   - `<animate>` / `<set>` with `onbegin` / `onend` SMIL events
 *   - `<style>` with CSS `expression()` or `url()` containing
 *     `javascript:` — rare in modern browsers but historically abused
 *   - `<use>` with external fragments
 *   - XML processing instructions, DOCTYPEs (entity expansion / XXE)
 *
 * Strategy: allowlist tags + allowlist attributes + validate href
 * protocol. Recursive walk of the parsed DOM, remove anything not
 * explicitly allowed.
 *
 * Note: we deliberately allow inline `<style>` ONLY when the style
 * body is empty (i.e., we strip style element children). Style
 * injection is subtle enough to warrant blanket-removal rather
 * than parsing CSS ourselves.
 *
 * The allowlist below is intentionally narrow. It covers what
 * people need for a personal avatar (shapes, paths, gradients,
 * basic text) but refuses the esoteric features. If a future
 * use case needs filters, we can widen the list deliberately.
 */

/** Max byte size for the final avatar payload (SVG text or raster
 *  data URI). Well under the 8 KB indexer cap so display_name,
 *  URLs, and JSON-escape overhead all fit comfortably. */
export const MAX_AVATAR_BYTES = 3072;

/** Soft warning threshold — UI shows a "getting large" hint above
 *  this, still accepts up to the hard cap. */
export const SOFT_WARN_AVATAR_BYTES = 2048;

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
	'marker'
]);

/** Global attributes allowed on any allowed element. */
const ALLOWED_ATTRS_GLOBAL = new Set([
	'id',
	'class',
	'style',
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
	'filter', // allowed only if no <filter> element — we block filter elements below
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

// ─── SVG sanitization ───────────────────────────────────────────

/**
 * Sanitize SVG text. Returns the cleaned SVG source, ready to be
 * stored as-is and later rendered via `{@html}` in Svelte. The
 * caller MUST NOT pass the original untrusted input to the DOM —
 * only the output of this function.
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
	if (!root || root.nodeName.toLowerCase() !== 'svg') {
		return { ok: false, code: 'svg_no_root' };
	}

	cleanElement(root);

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
		// href and xlink:href — strip unless protocol-safe.
		if (name === 'href' || name === 'xlink:href') {
			if (!isSafeHref(attr.value)) {
				el.removeAttribute(attr.name);
			}
			continue;
		}
		// Allowlist check.
		if (!perTag.has(name) && !ALLOWED_ATTRS_GLOBAL.has(name)) {
			el.removeAttribute(attr.name);
		}
	}

	// Walk a snapshot of children — we mutate as we go.
	const children = Array.from(el.children);
	for (const child of children) {
		const childTag = child.nodeName.toLowerCase();
		if (!ALLOWED_TAGS.has(childTag)) {
			// Drop the entire subtree.
			el.removeChild(child);
			continue;
		}
		// Recurse — child attribute-stripping happens at the
		// top of cleanElement now.
		cleanElement(child);
	}
	// Also strip comments and processing instructions (childNodes,
	// not children — children is elements only).
	const nodes = Array.from(el.childNodes);
	for (const n of nodes) {
		if (n.nodeType === 8 /* COMMENT_NODE */) {
			el.removeChild(n);
		} else if (n.nodeType === 7 /* PROCESSING_INSTRUCTION_NODE */) {
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
