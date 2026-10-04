/**
 * The `<img src>` for a sanitized SVG avatar.
 *
 * SVG avatars used to be inlined with `{@html}`. The sanitizer keeps `style`
 * and `class` (gradients, fonts and fills need them), and an inlined SVG is
 * part of the page: `<svg style="position:fixed;inset:0;z-index:…">` (or
 * `class="fixed inset-0 z-50"`, using the app's own CSS) escaped its round
 * frame and covered the whole screen with whatever the account drew — a fake
 * "payment verified" over a trade, say — for everyone who saw that picture.
 * Inside an `<img>`, an SVG is a picture: its styles and positions apply only
 * inside its own box, and it cannot run script or load anything. The CSP
 * already allows `data:` images (identicons use the same form).
 *
 * An SVG shown as an image needs its namespace declared, so add it if missing.
 */
export function svgAvatarImgSrc(svg: string): string {
	let src = svg.trim();
	const open = /^<svg\b[^>]*>/i.exec(src)?.[0];
	if (open !== undefined && !/\sxmlns\s*=/.test(open)) {
		src = src.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
	}
	const withXlink = /^<svg\b[^>]*>/i.exec(src)?.[0] ?? '';
	if (/\bxlink:/.test(src) && !/\sxmlns:xlink\s*=/.test(withXlink)) {
		src = src.replace(/^<svg\b/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
	}
	const bytes = new TextEncoder().encode(src);
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return `data:image/svg+xml;base64,${btoa(bin)}`;
}
