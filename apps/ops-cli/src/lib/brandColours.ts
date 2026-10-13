/**
 * The colours a logo is drawn in, so `branding setup` can offer a colour theme
 * taken from the operator's own logo (docs/BRANDING.md "Colours").
 *
 * Read from the SVG text: fill, stroke and gradient-stop colours, as attributes
 * or in style rules, written as hex (3, 4, 6 or 8 digits), rgb()/rgba(),
 * hsl()/hsla() or a CSS colour name. Ordered by how often they are used — a
 * proxy for "the logo's main colours" that needs no image converter. Colours
 * inside an embedded picture are not seen. PURE.
 *
 * v1.21.7: every pattern is bounded and the number parser is a plain split, so
 * the time grows with the file's size and no faster (review, 2026-10-12: a
 * 2 MB logo that `normalizeSvg` accepts kept `branding setup` busy for 9
 * minutes, and a 5 KB one for half a minute). Named, hsl() and 8-digit colours
 * were not read at all, so a logo drawn in them was called "no colour".
 */
import { normalizeHex } from '@morphit/operator-config/theme';

/** The CSS colour names (CSS Color Module Level 4). */
const NAMED: Record<string, string> = Object.fromEntries(
	(
		'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc ' +
		'bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a ' +
		'burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 ' +
		'cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b ' +
		'darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b ' +
		'darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 ' +
		'darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f ' +
		'darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff ' +
		'dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 ' +
		'forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 ' +
		'goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 ' +
		'hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa ' +
		'lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 ' +
		'lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 ' +
		'lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa ' +
		'lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 ' +
		'limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa ' +
		'mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 ' +
		'mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 ' +
		'midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead ' +
		'navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 ' +
		'orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 ' +
		'papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 ' +
		'purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 ' +
		'saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d ' +
		'silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa ' +
		'springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 ' +
		'turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 ' +
		'yellowgreen:9acd32'
	)
		.split(' ')
		.map((p) => {
			const [n, h] = p.split(':') as [string, string];
			return [n, `#${h}`];
		})
);

const PROP = '(?:fill|stroke|stop-color|flood-color|color)';
// Each alternative bounded: a "(" with no ")" is given up after 64 characters,
// instead of being scanned to the end of the file from every "rgb(".
const VALUE = '(#[0-9a-fA-F]{3,8}\\b|(?:rgba?|hsla?)\\([^)]{0,64}\\)|[a-zA-Z]{3,20}\\b)';
/** `fill="…"`, `fill='…'` and `fill: …` (style attribute or <style>). */
const COLOUR_RE = new RegExp(
	`(?<![\\w-])${PROP}[ \\t]{0,8}(?:=[ \\t]{0,8}["'][ \\t]{0,8}|:[ \\t]{0,8})${VALUE}`,
	'gi'
);

/** The numbers of an rgb()/hsl() argument list (commas, spaces or "/"). */
function args(inner: string): string[] {
	return inner
		.split(/[\s,/]+/)
		.map((x) => x.trim())
		.filter((x) => x.length > 0);
}

const num = (x: string): number => parseFloat(x);
const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n: number): string => clamp(n).toString(16).padStart(2, '0');

/** hsl → '#rrggbb'. */
function hslHex(h: number, s: number, l: number): string {
	const sat = Math.max(0, Math.min(1, s));
	const lig = Math.max(0, Math.min(1, l));
	const k = (n: number): number => (n + h / 30) % 12;
	const a = sat * Math.min(lig, 1 - lig);
	const f = (n: number): number =>
		lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return `#${hex2(f(0) * 255)}${hex2(f(8) * 255)}${hex2(f(4) * 255)}`;
}

/** One colour value as '#rrggbb', or null (transparent, unknown, malformed). */
function toHex(v: string): string | null {
	const s = v.trim().toLowerCase();
	if (s.startsWith('#')) {
		const d = s.slice(1);
		// #rgba / #rrggbbaa: a fully transparent colour is no colour.
		if (d.length === 4 || d.length === 8) {
			const alpha = d.length === 4 ? d[3]! + d[3]! : d.slice(6, 8);
			if (alpha === '00') return null;
			return normalizeHex(`#${d.length === 4 ? d.slice(0, 3) : d.slice(0, 6)}`);
		}
		return normalizeHex(s);
	}
	const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
	if (fn === null) return NAMED[s] ?? null;
	const a = args(fn[2]!);
	if (a.length < 3 || a.length > 4) return null;
	if (a.length === 4) {
		const alpha = a[3]!.endsWith('%') ? num(a[3]!) / 100 : num(a[3]!);
		if (!Number.isFinite(alpha) || alpha === 0) return null;
	}
	if (fn[1]!.startsWith('rgb')) {
		const ch = a.slice(0, 3).map((x) => (x.endsWith('%') ? (num(x) * 255) / 100 : num(x)));
		if (ch.some((n) => !Number.isFinite(n))) return null;
		return `#${ch.map(hex2).join('')}`;
	}
	const h = num(a[0]!.replace(/deg$/, ''));
	const sat = num(a[1]!) / 100;
	const lig = num(a[2]!) / 100;
	if (![h, sat, lig].every(Number.isFinite)) return null;
	return hslHex(((h % 360) + 360) % 360, sat, lig);
}

/** At most this many colours are handed on (most used first): a theme needs a
 *  few, and a logo with hundreds of thousands made the suggestion take ages. */
export const LOGO_COLOURS_MAX = 32;

/** The logo's colours as '#rrggbb', most used first, each once. */
export function logoColours(svg: string): string[] {
	const count = new Map<string, number>();
	for (const m of svg.matchAll(COLOUR_RE)) {
		const hex = toHex(m[1]!);
		if (hex !== null) count.set(hex, (count.get(hex) ?? 0) + 1);
	}
	// Map keeps first-seen order, and sort is stable: ties keep it.
	return [...count.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, LOGO_COLOURS_MAX)
		.map(([hex]) => hex);
}
