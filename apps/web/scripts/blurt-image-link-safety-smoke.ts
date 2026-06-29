#!/usr/bin/env tsx
/**
 * blurt-image-link-safety smoke — cp388.
 *
 * HIGH-SECURITY regression net for the order-`terms` Blurt-image
 * link feature. Order terms are public, on-chain, attacker-controlled
 * free text; they render as PLAIN TEXT except that an https link to an
 * image on Blurt's own image server (`img.blurt.blog`) becomes a
 * clickable external link (opens a fresh tab; never an inline <img>,
 * so the viewer's IP never leaks on render).
 *
 * This smoke pins the security model so a later checkpoint cannot
 * loosen it without a red CI:
 *   - the validator accepts ONLY https + exact host img.blurt.blog +
 *     image extension + no userinfo + default port;
 *   - the validator REJECTS every host-spoof / scheme / port / ext /
 *     userinfo trick;
 *   - the linkifier flags ONLY validator-approved URLs (a non-Blurt or
 *     non-image URL stays inert plain text — no arbitrary external
 *     links in public terms);
 *   - an XSS-shaped run is never turned into a link;
 *   - the render path is wired into all four terms-display views via
 *     `<TermsText>`, binds the href through the safe builder, never
 *     uses `{@html}`, and carries the privacy anchor attributes;
 *   - href-xss-smoke recognises `safeBlurtImageUrl` as a safe builder.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeBlurtImageUrl, linkifyBlurtImageSegments } from '../src/lib/utils/blurtImageLink';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(msg: string) {
	pass++;
	console.log(`  \u2713 ${msg}`);
}
function bad(msg: string) {
	fail++;
	console.error(`  \u2717 ${msg}`);
}
function expect(cond: boolean, msg: string) {
	if (cond) ok(msg);
	else bad(msg);
}

// ── 1. Validator ACCEPTS legitimate Blurt-image URLs ──
const ACCEPT = [
	'https://img.blurt.blog/blurtimage/saboin/c034057d522b2a4cd356e1e1a01b2bd6c33774c5.png',
	'https://img.blurt.blog/blurtimage/alice/abc.jpg',
	'https://img.blurt.blog/blurtimage/alice/abc.jpeg',
	'https://img.blurt.blog/blurtimage/alice/abc.gif',
	'https://img.blurt.blog/blurtimage/alice/abc.webp',
	'https://img.blurt.blog/blurtimage/alice/ABC.PNG', // uppercase ext
	'https://IMG.BLURT.BLOG/blurtimage/alice/abc.png', // host case-normalized by URL()
	'https://img.blurt.blog/640x480/https://other.example/x.jpg', // proxy form, ends in image ext
	'https://img.blurt.blog/blurtimage/alice/abc.png?cache=1', // query preserved, path ends in ext
	'https://imgp.blurt.blog/768x0/https://img.blurt.blog/blurtimage/alice/abc.png', // proxy host, condenser resize form
	'https://imgp.blurt.blog/blurtimage/alice/abc.webp', // proxy host, direct
	'https://IMGP.BLURT.BLOG/768x0/x.jpg' // proxy host case-normalized by URL()
];
for (const u of ACCEPT) expect(safeBlurtImageUrl(u) !== null, `accepts ${u}`);

// ── 2. Validator REJECTS every spoof / scheme / port / ext / userinfo trick ──
const REJECT: Array<[string, string]> = [
	['http://img.blurt.blog/blurtimage/a/x.png', 'http (not https)'],
	['https://img.blurt.blog.evil.com/x.png', 'host suffix attack'],
	['https://imgp.blurt.blog.evil.com/x.png', 'proxy host suffix attack'],
	['https://evil.img.blurt.blog/x.png', 'left-extended host (not exact)'],
	['https://imgpXblurt.blog/x.png', 'proxy lookalike host'],
	['https://imgXblurt.blog/x.png', 'lookalike host'],
	['https://evil.example/x.png', 'unrelated host'],
	['https://blurt.blog/images/logo.png', 'apex blurt.blog (site assets, not user images)'],
	['https://img.blurt.blog/x.txt', 'non-image extension'],
	['https://img.blurt.blog/x.svg', 'svg excluded (can carry script)'],
	['https://img.blurt.blog/page', 'no extension'],
	['https://img.blurt.blog/blurtimage/a/x', 'no extension (blurtimage path)'],
	['https://evil.example@img.blurt.blog/x.png', 'userinfo present'],
	['https://img.blurt.blog:8080/x.png', 'non-default port'],
	['javascript:alert(1)//img.blurt.blog/x.png', 'javascript: scheme'],
	['data:image/png;base64,AAAA', 'data: scheme'],
	['', 'empty string'],
	['   ', 'whitespace only'],
	['not a url', 'unparseable']
];
for (const [u, why] of REJECT)
	expect(safeBlurtImageUrl(u) === null, `rejects (${why}): ${u || '∅'}`);
expect(safeBlurtImageUrl(null) === null, 'rejects null');
expect(safeBlurtImageUrl(undefined) === null, 'rejects undefined');

// ── 3. Linkifier flags ONLY validator-approved URLs ──
{
	const segs = linkifyBlurtImageSegments(
		'photo of the bike: https://img.blurt.blog/blurtimage/me/bike.jpg — thanks'
	);
	const links = segs.filter((s) => s.link);
	expect(links.length === 1, 'one link segment for a single Blurt image URL');
	expect(
		links[0]?.value === 'https://img.blurt.blog/blurtimage/me/bike.jpg',
		'link segment carries the exact URL'
	);
	expect(
		segs.map((s) => s.value).join('') ===
			'photo of the bike: https://img.blurt.blog/blurtimage/me/bike.jpg — thanks',
		'segments reassemble to the original text (no data loss)'
	);
}
{
	const segs = linkifyBlurtImageSegments('contact me at https://evil.example/track.png please');
	expect(
		segs.every((s) => !s.link),
		'non-Blurt URL is NOT linkified (stays plain text)'
	);
}
{
	const segs = linkifyBlurtImageSegments(
		'good https://img.blurt.blog/blurtimage/a/x.png bad https://evil.example/y.png'
	);
	const links = segs.filter((s) => s.link);
	expect(
		links.length === 1 && links[0].value.includes('img.blurt.blog'),
		'mixed: only the Blurt URL links'
	);
}
{
	// trailing punctuation peeled off the link
	const segs = linkifyBlurtImageSegments('see https://img.blurt.blog/blurtimage/a/x.png.');
	const link = segs.find((s) => s.link);
	expect(
		link?.value === 'https://img.blurt.blog/blurtimage/a/x.png',
		'trailing period peeled from the link value'
	);
	expect(
		segs.some((s) => !s.link && s.value === '.'),
		'peeled period kept as plain text'
	);
}
expect(linkifyBlurtImageSegments('').length === 0, 'empty text → no segments');
expect(
	linkifyBlurtImageSegments('no links here at all').every((s) => !s.link),
	'plain text with no URL → no link segments'
);

// ── 4. XSS-shaped run is never turned into a link ──
{
	const payload = 'https://img.blurt.blog/x.png"><script>alert(1)</script>';
	expect(safeBlurtImageUrl(payload) === null, 'validator rejects an XSS-tail URL');
	const segs = linkifyBlurtImageSegments(`look ${payload}`);
	expect(
		segs.every((s) => !s.link),
		'linkifier does not link an XSS-tail run'
	);
}

// ── 5. Render wiring: TermsText is the single render path, no {@html}, privacy attrs present ──
const termsText = readFileSync(join(WEB, 'src/lib/components/TermsText.svelte'), 'utf8');
expect(!/\{@html\s/.test(termsText), 'TermsText never uses the {@html} directive');
expect(
	termsText.includes('safeBlurtImageUrl(seg.value)'),
	'TermsText binds href via the safe builder'
);
expect(termsText.includes('target="_blank"'), 'TermsText opens links in a new tab');
expect(
	termsText.includes('rel="noopener noreferrer nofollow"'),
	'TermsText link carries noopener noreferrer nofollow'
);
expect(
	termsText.includes('referrerpolicy="no-referrer"'),
	'TermsText link sets referrerpolicy="no-referrer"'
);

// ── 6. All four terms-display views render through TermsText ──
const SITES = [
	'src/routes/[lang]/[x+40][account=account]/[permlink=permlink]/+page.svelte',
	'src/routes/[lang]/orderbook/+page.svelte',
	'src/routes/[lang]/my/orders/+page.svelte',
	'src/routes/[lang]/[x+40][account=account]/+page.svelte'
];
for (const rel of SITES) {
	const src = readFileSync(join(WEB, rel), 'utf8');
	const wired =
		src.includes("import TermsText from '$components/TermsText.svelte'") &&
		src.includes('<TermsText');
	expect(wired, `terms rendered via <TermsText> in ${rel.split('/').slice(-2).join('/')}`);
	// belt-and-suspenders: no raw {order.terms}/{o.terms} render left behind
	expect(
		!/[>\s]\{(?:order|o)\.terms\}/.test(src),
		`no raw terms interpolation left in ${rel.split('/').slice(-2).join('/')}`
	);
}

// ── 7. href-xss-smoke recognises safeBlurtImageUrl as a safe builder ──
const hrefXss = readFileSync(join(WEB, 'scripts/href-xss-smoke.ts'), 'utf8');
expect(
	/SAFE_BUILDER_NAMES[\s\S]*'safeBlurtImageUrl'/.test(hrefXss),
	'safeBlurtImageUrl is registered in href-xss SAFE_BUILDER_NAMES'
);

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`\u2713 all ${pass} blurt-image-link-safety scenarios passed`);
