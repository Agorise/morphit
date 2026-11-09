/**
 * The brandable app shell (build/spa-shell.html) must be the signed index.html
 * byte for byte but for what branding writes, where it writes it (v1.23.5):
 * the <html> brand attributes, the theme colour, the naming metas' content,
 * the link-preview picture tags and the colour-theme <style>. Anything else —
 * including every trick that hides markup from one parser or another — is
 * refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shellMatchesIndex } from './shellIntegrity';

const ORIGIN = 'https://vigilante.example';

const INDEX = `<!doctype html>
<html lang="en" dir="ltr" class="dark">
<head>
	<meta charset="utf-8" />
	<!-- the theme-color value is byte-identical to CANONICAL_THEME_COLOR there. -->
	<!-- e.g. <meta name="og:title" content="sample"> on a prerendered page -->
	<meta name="theme-color" content="#00DA69" />
	<meta name="referrer" content="no-referrer" />
	<meta name="apple-mobile-web-app-title" content="Morphit" />
	<meta http-equiv="content-security-policy" content="default-src 'self'" />
	<title>Morphit</title>
	<link rel="icon" href="/favicon.svg" />
	<meta property="og:site_name" content="Morphit" />
	<meta property="og:title" content="Morphit — No-KYC P2P Marketplace to Buy &amp; Sell" />
	<meta name="twitter:title" content="Morphit — No-KYC P2P Marketplace to Buy &amp; Sell" />
	<meta name="twitter:description" content="The private, no-KYC way." />
	<link rel="modulepreload" href="/_app/immutable/entry/start.AbC.js" />
	<style>.x{color:red}</style>
	<noscript><style>.js-only{display:none}</style></noscript>
</head>
<body data-sveltekit-preload-data="hover">
	<div style="display: contents">
		<script>
			{ __sveltekit_x = { base: "" }; import("/_app/immutable/entry/start.AbC.js") }
			const card = \`<meta name="og:title" content="kept as is">\`;
		</script>
	</div>
	<template id="t"><p>inert</p></template>
	<img alt='<meta name="description" content="d"' src="/x.png" />
</body>
</html>`;

const IMAGE_TAGS = [
	`<meta property="og:image" content="${ORIGIN}/og-image.png" />`,
	'<meta property="og:image:type" content="image/png" />',
	'<meta property="og:image:width" content="1200" />',
	'<meta property="og:image:height" content="630" />',
	'<meta property="og:image:alt" content="Vigilante Trading — privacy-first P2P marketplace" />',
	`<meta name="twitter:image" content="${ORIGIN}/og-image.png" />`,
	'<meta name="twitter:image:alt" content="Vigilante Trading — privacy-first P2P marketplace" />'
]
	.map((tag) => `\n\t\t${tag}`)
	.join('');
const THEME =
	'<style id="morphit-theme">html:root{--brand-1-rgb:243 220 160;--grid-opacity:0.05}</style>';

/** What the build (stamp, preview picture), origin-slots (the address) and
 *  `morphit-ops branding apply` (name, colours) do to it. */
function brand(html: string): string {
	return html
		.replace(
			'class="dark">',
			'class="dark" data-brand-name="Vigilante Trading" data-brand-beta="on">'
		)
		.replace('content="#00DA69"', 'content="#bb872f"')
		.replace(/content="Morphit/g, 'content="Vigilante Trading')
		.replace(
			'<meta name="twitter:description" content="The private, no-KYC way." />',
			`<meta name="twitter:description" content="The private, no-KYC way." />${IMAGE_TAGS}`
		)
		.replace('</head>', `${THEME}</head>`);
}
const BRANDED = brand(INDEX);

describe('shellMatchesIndex', () => {
	it('what branding writes leaves the copy matching; so does no branding', () => {
		expect(BRANDED).not.toBe(INDEX);
		expect(shellMatchesIndex(INDEX, BRANDED)).toBe(true);
		expect(shellMatchesIndex(INDEX, INDEX)).toBe(true);
		// A shell copy built without a picture (no build origin), unbranded.
		const stamped = INDEX.replace(
			'class="dark">',
			'class="dark" data-brand-name="Morphit" data-brand-beta="on">'
		);
		expect(shellMatchesIndex(INDEX, stamped)).toBe(true);
	});

	const refused: [string, (h: string) => string][] = [
		['a script added', (h) => h.replace('</body>', '<script src="/x.js"></script></body>')],
		['a SCRIPT in capitals', (h) => h.replace('</body>', '<SCRIPT src="/x.js"></SCRIPT></body>')],
		[
			'a script in an svg',
			(h) => h.replace('</body>', '<svg><script href="/x.js"></script></svg></body>')
		],
		['the inline script changed', (h) => h.replace('base: ""', 'base: "/x"')],
		['the entry point changed', (h) => h.replaceAll('start.AbC.js', 'start.Evil.js')],
		['a script attribute changed', (h) => h.replace('<script>', '<script type="module">')],
		['a link added', (h) => h.replace('<title>', '<link rel="stylesheet" href="/e.css" /><title>')],
		['a link removed', (h) => h.replace('<link rel="icon" href="/favicon.svg" />', '')],
		['the CSP changed', (h) => h.replace(`default-src 'self'`, 'default-src *')],
		['the referrer policy changed', (h) => h.replace('no-referrer', 'unsafe-url')],
		[
			'a refresh hidden behind a quoted >',
			(h) =>
				h.replace(
					'<title>',
					'<meta content=">" http-equiv="refresh" content="0;url=https://e" /><title>'
				)
		],
		[
			'a script after an abrupt comment',
			(h) => h.replace('</body>', '<!--><script src=/e.js></script><!-- --></body>')
		],
		[
			'a script hidden in a noscript comment',
			(h) => h.replace('<noscript>', '<noscript><!-- </noscript><script src=/e.js></script> -->')
		],
		['a comment added', (h) => h.replace('</body>', '<!-- hello --></body>')],
		[
			'a handler let out of a single-quoted attribute through a value in it',
			(h) => h.replace(`content="d"'`, `content="d' onerror='x()"'`)
		],
		[
			'a naming meta that breaks out of its value',
			(h) =>
				h.replace(
					'content="Vigilante Trading — No',
					'content="x" http-equiv="refresh" content="0;url=//e" data-x="No'
				)
		],
		[
			'a script let out of a comment through a value in it',
			(h) => h.replace('content="sample"', 'content="--><script src=/e.js></script><!--"')
		],
		['a script after the end of the page', (h) => `${h}<script src="/e.js"></script>`],
		[
			'an attribute after the brand attributes',
			(h) => h.replace('data-brand-beta="on">', 'data-brand-beta="on" onclick="x()">')
		],
		[
			'the script text that looks like a naming meta changed',
			(h) => h.replace('content="kept as is"', 'content="${x()}"')
		],
		['a dot in the script changed', (h) => h.replace('start.AbC.js") }', 'start/AbC.js") }')],
		[
			'the preview picture before the end of the head',
			(h) => h.replace(IMAGE_TAGS, '').replace(THEME, `${IMAGE_TAGS.trimStart()}\n${THEME}`)
		],
		['whitespace between tags changed', (h) => h.replaceAll('/>\n\t<', '/>\n\n\t\t<')],
		[
			'the title changed',
			(h) => h.replace('<title>Morphit</title>', '<title>Vigilante Trading</title>')
		],
		[
			'an entity in a naming meta',
			(h) => h.replace('content="Vigilante Trading — No', 'content="&lt;b&gt; No')
		],
		[
			'the preview picture moved',
			(h) =>
				h
					.replace(IMAGE_TAGS, '')
					.replace('<link rel="icon"', `${IMAGE_TAGS.trimStart()}\n\t<link rel="icon"`)
		],
		[
			'a script hidden behind an html tag in the noscript',
			(h) =>
				h.replace(
					'<noscript>',
					'<noscript><html data-brand-name="</noscript><script src=/e.js></script><noscript>">'
				)
		],
		[
			'a script hidden behind a stray end tag in the noscript',
			(h) => h.replace('<noscript>', '<noscript></x a="</noscript><script src=/e.js></script>">')
		],
		[
			'a script hidden behind a head tag in the noscript',
			(h) => h.replace('<noscript>', '<noscript><head a="</noscript><script src=/e.js></script>">')
		],
		['a noscript added', (h) => h.replace('</body>', '<noscript><p>hi</p></noscript></body>')],
		['the noscript changed in case only', (h) => h.replace('<noscript>', '<NOSCRIPT>')],
		[
			'markup in the title',
			(h) =>
				h.replace('<title>Morphit</title>', '<title>&lt;/title&gt;&lt;script src=/e.js&gt;</title>')
		],
		[
			'markup in a naming meta',
			(h) => h.replace('content="Vigilante Trading — No', 'content="x&gt;&lt;script&gt; No')
		],
		['the stylesheet changed', (h) => h.replace('.x{color:red}', '.tamper-banner{display:none}')],
		[
			'a style added',
			(h) => h.replace('</body>', '<style>.tamper-banner{display:none}</style></body>')
		],
		[
			'a theme style with a url',
			(h) => h.replace('--grid-opacity:0.05', '--grid-opacity:url(//e)')
		],
		[
			'a theme style that imports',
			(h) => h.replace(THEME, '<style id="morphit-theme">@import "//e";</style>')
		],
		['two theme styles', (h) => h.replace('</head>', `${THEME}</head>`)],
		[
			'the theme style moved into the body',
			(h) => h.replace(THEME, '').replace('</body>', `${THEME}</body>`)
		],
		[
			'the theme style under another id',
			(h) => h.replace('<style id="morphit-theme">', '<style id="other">')
		],
		[
			'a preview tag with an extra attribute',
			(h) =>
				h.replace(
					'<meta property="og:image:type" content="image/png" />',
					'<meta property="og:image:type" content="image/png" itemprop="x" />'
				)
		],
		['the doctype changed', (h) => h.replace('<!doctype html>', '<!doctype svg>')],
		['a theme style outside the head', (h) => h.replace('</body>', `${THEME}</body>`)],
		['an event handler on the body', (h) => h.replace('<body ', '<body onload="x()" ')],
		[
			'an image with an error handler',
			(h) => h.replace('</body>', '<img src=x onerror="x()"></body>')
		],
		['a base added', (h) => h.replace('<title>', '<base href="//e/" /><title>')],
		['an iframe added', (h) => h.replace('</body>', '<iframe src="//e"></iframe></body>')],
		['a form added', (h) => h.replace('</body>', '<form action="//e"></form></body>')],
		['body text added', (h) => h.replace('</body>', '<p>Send your coins to …</p></body>')],
		[
			'a preview tag of another kind added',
			(h) => h.replace(IMAGE_TAGS, `${IMAGE_TAGS}<meta property="og:url" content="//e" />`)
		],
		[
			'a preview tag with more attributes',
			(h) =>
				h.replace(
					'<meta property="og:image:type" content="image/png" />',
					'<meta property="og:image:type" content="image/png" http-equiv="refresh" />'
				)
		],
		['a theme colour that is not a colour', (h) => h.replace('content="#bb872f"', 'content="red"')],
		['the inert template changed', (h) => h.replace('<p>inert</p>', '<img src=x onerror="x()">')],
		[
			'an html attribute other than the brand changed',
			(h) => h.replace('lang="en"', 'lang="en" onclick="x()"')
		]
	];
	it.each(refused)('%s: refused', (_name, change) => {
		const tampered = change(BRANDED);
		expect(tampered).not.toBe(BRANDED);
		expect(shellMatchesIndex(INDEX, tampered)).toBe(false);
	});
});

async function sri(text: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	let s = '';
	for (const b of new Uint8Array(d)) s += String.fromCharCode(b);
	return `sha256-${btoa(s)}`;
}

describe('the build-integrity check asks for the shell copy too', () => {
	let served: Record<string, string>;
	let status: Record<string, number>;
	let asked: { path: string; cache: RequestCache | undefined }[];

	beforeEach(() => {
		served = { '/index.html': INDEX, '/spa-shell.html': BRANDED };
		status = {};
		asked = [];
		vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/en` });
		vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
			const path = new URL(String(input), ORIGIN).pathname;
			asked.push({ path, cache: init?.cache });
			if (status[path] !== undefined) return new Response('', { status: status[path] });
			const body = served[path];
			return body === undefined ? new Response('', { status: 404 }) : new Response(body);
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	const check = async () => {
		const { checkManifestAgainstRunningBundle } = await import('./releaseHashCheck');
		return checkManifestAgainstRunningBundle({ '/index.html': await sri(INDEX) });
	};

	it('a branded copy: ok, asked for from the server', async () => {
		expect((await check()).kind).toBe('ok');
		expect(asked).toEqual([
			{ path: '/index.html', cache: 'no-cache' },
			{ path: '/spa-shell.html', cache: 'no-cache' }
		]);
	});

	it('a copy that runs something else: a mismatch naming it', async () => {
		served['/spa-shell.html'] = BRANDED.replace('</body>', '<script src="/x.js"></script></body>');
		const r = await check();
		expect(r.kind === 'mismatch' && r.mismatches.map((m) => m.path)).toEqual(['/spa-shell.html']);
	});

	it('a server without the copy (it answers with index.html, or 404): ok', async () => {
		served['/spa-shell.html'] = INDEX;
		expect((await check()).kind).toBe('ok');
		delete served['/spa-shell.html'];
		expect((await check()).kind).toBe('ok');
	});

	it('the copy unreadable (a server error): no verdict', async () => {
		status['/spa-shell.html'] = 500;
		const r = await check();
		expect(r.kind === 'fetch_failed' && r.path).toBe('/spa-shell.html');
	});

	it('index.html itself changed: that mismatch alone, the copy not asked for', async () => {
		served['/index.html'] = INDEX.replace('base: ""', 'base: "/x"');
		const r = await check();
		expect(r.kind === 'mismatch' && r.mismatches.map((m) => m.path)).toEqual(['/index.html']);
		expect(asked.map((a) => a.path)).toEqual(['/index.html']);
	});
});
