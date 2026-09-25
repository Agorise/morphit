/**
 * (v1.18.0 deep-deep, M1) A profile picture must stay inside its frame.
 *
 * The sanitizer keeps `style` and `class`, and SVG avatars were inlined into
 * the page with `{@html}`. So `<svg style="position:fixed;inset:0;…">` or
 * `<svg class="fixed inset-0 z-50">` escaped the round avatar frame and
 * covered the whole page with whatever that account drew — on every orderbook
 * card, chat bubble and feedback list that showed it.
 *
 * These cases render the REAL IdentityLabel (the component every one of those
 * surfaces uses) with hostile pictures and check what reaches the page: an
 * `<img>` whose source is the sanitized picture — never a live `<svg>` element.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { createRequire } from 'node:module';
import { sanitizeSvg } from './index';
import { svgAvatarImgSrc } from './imgSrc';
import IdentityLabel from '$lib/components/IdentityLabel.svelte';

const HOSTILE = [
	`<svg xmlns="http://www.w3.org/2000/svg" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:#fff" viewBox="0 0 100 100"><text x="5" y="20" style="font-size:6px">Payment verified on chain. Send to BLURT acct: mallory</text></svg>`,
	`<svg xmlns="http://www.w3.org/2000/svg" class="fixed inset-0 z-50 h-screen w-screen" id="chat-composer"><rect width="10" height="10"/></svg>`,
	`<svg viewBox="0 0 10 10" style="position:absolute;inset:-9999px"><text>ünïcødé ✓</text></svg>`
];

function sanitized(s: string): string {
	const r = sanitizeSvg(s);
	if (!r.ok) throw new Error(`sanitizer refused a test input: ${r.code}`);
	return r.value;
}

function decodeDataUri(uri: string): string {
	const b64 = uri.replace(/^data:image\/svg\+xml;base64,/, '');
	return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

// The component is rendered the way the server-side build renders it, and its
// HTML is then parsed by a real DOM; the sanitizer needs a DOMParser too.
// (jsdom ships no type declarations in this workspace, hence require + cast.)
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
	JSDOM: new (html: string) => { window: Window & typeof globalThis };
};
const { window } = new JSDOM('');
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;

function renderLabel(svg: string): Document {
	const { body } = render(IdentityLabel, { props: { account: 'mallory', avatarSvg: svg } });
	return new window.DOMParser().parseFromString(`<body>${body}</body>`, 'text/html');
}

describe('SVG avatars render as pictures, not as part of the page', () => {
	for (const [i, raw] of HOSTILE.entries()) {
		it(`hostile picture ${i + 1}: no live <svg> reaches the page; an <img> carries it`, () => {
			const svg = sanitized(raw);
			const doc = renderLabel(svg);
			// Nothing the account wrote is page markup: no svg element, and no
			// element carries the account's style or class.
			expect(doc.querySelectorAll('svg').length).toBe(0);
			for (const el of Array.from(doc.querySelectorAll('[style]'))) {
				expect(el.getAttribute('style') ?? '').not.toMatch(/position|z-index|100vw/);
			}
			for (const el of Array.from(doc.querySelectorAll('[class]'))) {
				expect(el.getAttribute('class') ?? '').not.toMatch(/\bfixed\b|\binset-0\b|h-screen/);
			}
			const imgs = Array.from(doc.querySelectorAll('img')).filter((im) =>
				(im.getAttribute('src') ?? '').startsWith('data:image/svg+xml;base64,')
			);
			expect(imgs.length).toBe(1);
			// …and the picture itself is intact inside it.
			const inside = new window.DOMParser().parseFromString(
				decodeDataUri(imgs[0]!.getAttribute('src')!),
				'image/svg+xml'
			);
			expect(inside.getElementsByTagName('parsererror').length).toBe(0);
			expect(inside.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
		});
	}

	it('the image source round-trips the sanitized SVG, adding the namespace an image needs', () => {
		const noNs = '<svg width="10" height="10"><rect width="10" height="10"/></svg>';
		const out = decodeDataUri(svgAvatarImgSrc(noNs));
		expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(out).toContain('<rect width="10" height="10"/>');
		const withNs = sanitized(HOSTILE[2]!);
		expect(decodeDataUri(svgAvatarImgSrc(withNs))).toBe(withNs);
	});
});
