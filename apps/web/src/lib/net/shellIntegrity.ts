/**
 * Morphit — the brandable app shell against the signed one (v1.23.5).
 *
 * The web server answers `/` and every page the app draws in the browser (a
 * profile, an order, a chat) with build/spa-shell.html when the build has it:
 * a copy of index.html that per-instance branding names the site in
 * (scripts/build-brand-slots.mjs, apps/web/scripts/origin-slots.mjs,
 * `morphit-ops branding apply`). index.html is on the signed release's hash
 * manifest; the copy cannot be (branding rewrites it), so the hash check
 * (releaseHashCheck.ts) also asks for /spa-shell.html and requires it to be
 * the signed index.html BYTE FOR BYTE but for exactly what those steps write,
 * where they write it:
 *
 *   - before the `>` of the first `<html` tag: ` data-brand-name="…"
 *     data-brand-beta="on"` (the build's stamp, with the name branding gives);
 *   - the content of the first theme-color meta: a #rrggbb colour;
 *   - the content of the naming meta tags (og:*, twitter:*,
 *     apple-mobile-web-app-title, application-name, description);
 *   - right after the first twitter:description meta (or, without one, right
 *     before the first `</head>`): the link-preview picture tags, exactly as
 *     the build writes them;
 *   - right before the first `</head>`: one `<style id="morphit-theme">`
 *     holding only `html:root{--name:value;…}` with numeric values.
 *
 * What may be written in those places holds no `"`, `'`, `<` or `>` and no
 * entity but `&amp;` (no site name or address does), so it cannot end the
 * attribute, the tag, the comment or the raw text it sits in (wherever the
 * pattern found it); and none is inside a script or style of the signed
 * page. Everything else must be the signed bytes: however a parser — this one
 * or the page's, with scripting on — reads the copy, it reads what it would
 * read in index.html but for those values. (A server without the copy answers
 * /spa-shell.html with index.html itself, which matches.)
 */

/** A value branding writes: no quote of either kind, no angle bracket,
 *  `&amp;` the only entity (a site name has none: its ' is written ’). */
const VALUE = `(?:[^"'<>&]|&amp;)*`;
const HEX = '#[0-9a-fA-F]{6}';
const THEME_DECL = '--[a-z0-9-]{1,48}:[0-9. ]{1,32}';
const THEME = `<style id="morphit-theme">html:root\\{${THEME_DECL}(?:;${THEME_DECL})*;?\\}</style>`;
const BRAND_ATTRS = ` data-brand-name="${VALUE}" data-brand-beta="on"`;
/** The link-preview picture tags as scripts/build-brand-slots.mjs
 *  (spaShellText) writes them (no character in them is special in a regular
 *  expression but the value holes). */
const PICTURE_TAGS = [
	`<meta property="og:image" content="${VALUE}" />`,
	'<meta property="og:image:type" content="image/png" />',
	'<meta property="og:image:width" content="1200" />',
	'<meta property="og:image:height" content="630" />',
	`<meta property="og:image:alt" content="${VALUE}" />`,
	`<meta name="twitter:image" content="${VALUE}" />`,
	`<meta name="twitter:image:alt" content="${VALUE}" />`
];
/** After the twitter:description meta: each tag on its own line. */
const PICTURE = PICTURE_TAGS.map((l) => `\\n\\t\\t${l}`).join('');
/** Before </head> (an index.html without that meta): the same, then a newline. */
const PICTURE_BEFORE_HEAD = `${PICTURE_TAGS.join('\\n\\t\\t')}\\n`;

const NAMING_META =
	/<meta (?:name|property)="(?:og:[^"]*|twitter:[^"]*|apple-mobile-web-app-title|application-name|description)" content="([^"]*)"/g;
const PREVIEW_ANCHOR = /<meta name="twitter:description" content="[^"]*" \/>/;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** [start, end) of the bodies of the signed page's <script> and <style>
 *  elements (the signed page is trusted text). */
function rawRegions(html: string): [number, number][] {
	const out: [number, number][] = [];
	const re = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		const body = m.index + m[0].indexOf('>') + 1;
		out.push([body, body + m[2]!.length]);
	}
	return out;
}

/** The pattern every shell copy of `indexHtml` matches (see the header). */
export function shellPattern(indexHtml: string): RegExp {
	const raw = rawRegions(indexHtml);
	const inRaw = (pos: number): boolean => raw.some(([a, b]) => pos >= a && pos < b);
	/** [start, end, pattern]: indexHtml[start, end) may be what pattern matches. */
	const holes: [number, number, string][] = [];
	const html = /<html\b[^>]*>/i.exec(indexHtml);
	if (html !== null && !inRaw(html.index)) {
		const end = html.index + html[0].length - 1;
		holes.push([end, end, BRAND_ATTRS]);
	}
	const colour = /<meta name="theme-color" content="#[0-9a-fA-F]{6}"/.exec(indexHtml);
	if (colour !== null && !inRaw(colour.index)) {
		const at = colour.index + colour[0].length - 8;
		holes.push([at, at + 7, HEX]);
	}
	for (const m of indexHtml.matchAll(NAMING_META)) {
		if (inRaw(m.index)) continue;
		const at = m.index + m[0].length - 1 - m[1]!.length;
		holes.push([at, at + m[1]!.length, VALUE]);
	}
	const anchor = PREVIEW_ANCHOR.exec(indexHtml);
	if (anchor !== null && !inRaw(anchor.index)) {
		const at = anchor.index + anchor[0].length;
		holes.push([at, at, `(?:${PICTURE})?`]);
	}
	const head = indexHtml.search(/<\/head\s*>/i);
	if (head >= 0 && !inRaw(head)) {
		const picture = anchor === null ? `(?:${PICTURE_BEFORE_HEAD})?` : '';
		holes.push([head, head, `${picture}(?:${THEME})?`]);
	}
	holes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let out = '';
	let pos = 0;
	for (const [start, end, pattern] of holes) {
		if (start < pos) continue; // overlapping holes: never in the shipped page
		out += escape(indexHtml.slice(pos, start)) + pattern;
		pos = end;
	}
	out += escape(indexHtml.slice(pos));
	return new RegExp(`^${out}$`);
}

/** True when the shell copy is the signed index.html but for what branding
 *  writes (see the header). */
export function shellMatchesIndex(indexHtml: string, shellHtml: string): boolean {
	return shellHtml === indexHtml || shellPattern(indexHtml).test(shellHtml);
}
