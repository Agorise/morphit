/**
 * an instance's prebuilt pages, sitemap and robots.txt name THAT
 * instance's origin once morphit-ops applies it — a hidden-only instance
 * serves no https://morphit.io — while the files on the on-chain integrity
 * manifest stay byte-identical, the brand slots keep working, and the served
 * verify.json still describes every file.
 */
import { createHash } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/** The build script under test (plain .mjs, loaded at run time). */
interface OriginSlots {
	recordOriginSlots: (dir: string, origin: string, log?: (s: string) => void) => unknown;
	applyInstanceOrigin: (
		dir: string,
		origin: string | null
	) => { changed: boolean; touched: string[] };
	stripMarkedOrigins: (s: string) => { text: string };
}
let recordOriginSlots: OriginSlots['recordOriginSlots'];
let applyInstanceOrigin: OriginSlots['applyInstanceOrigin'];
let stripMarkedOrigins: OriginSlots['stripMarkedOrigins'];
beforeAll(async () => {
	const mod = (await import(
		/* @vite-ignore */ '../../../scripts/origin-slots.mjs' as string
	)) as OriginSlots;
	({ recordOriginSlots, applyInstanceOrigin, stripMarkedOrigins } = mod);
});

const M = String.fromCharCode(0x2063);
const BUILD = 'https://morphit.io';
const ONION = 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion';
const marked = (path: string) => `${M}${BUILD}${M}${path}`;

const PAGE = [
	'<!doctype html><html lang="en" data-brand-name="Morphit" data-brand-beta="on"><head>',
	`<link rel="canonical" href="${marked('/en/faq')}" />`,
	'<title>FAQ — Morphit</title>',
	`<meta property="og:image" content="${marked('/og-image.png')}" />`,
	`<script type="application/ld+json">{"@id":"${marked('/#organization')}","name":"Morphit"}</script>`,
	'</head><body><h1>Welcome to Morphit</h1></body></html>'
].join('');
const SHELL = '<!doctype html><html><head><title>x</title></head><body></body></html>';
const ROBOTS = `User-agent: *\nAllow: /\nSitemap: ${BUILD}/sitemap.xml\n`;
const SITEMAP = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<urlset',
	'\txmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
	'\txmlns:xhtml="http://www.w3.org/1999/xhtml">',
	'\t<url>',
	`\t\t<loc>${BUILD}/en/</loc>`,
	`\t\t<xhtml:link rel="alternate" hreflang="x-default" href="${BUILD}/"/>`,
	'\t</url>',
	'\t<url>',
	`\t\t<loc>${BUILD}/en/faq</loc>`,
	`\t\t<xhtml:link rel="alternate" hreflang="x-default" href="${BUILD}/faq"/>`,
	'\t</url>',
	'</urlset>',
	''
].join('\n');
const ENTRY_JS = 'console.log("entry")';

type Slot = [number, number, string, string];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Brand slots of the marked page, as the brand-slot recorder writes them:
 *  offsets into the text it saw (markers still in). */
function brandSlotsOf(text: string): Slot[] {
	const out: Slot[] = [];
	for (const needle of ['FAQ — Morphit', '"name":"Morphit"', 'Welcome to Morphit']) {
		const at = text.indexOf(needle) + needle.indexOf('Morphit');
		out.push([at, 7, 'Morphit', needle.startsWith('"') ? 'raw' : 'html']);
	}
	const head = text.indexOf('</head>');
	return [...out.sort((a, b) => a[0] - b[0]), [head, 0, '', 'theme-style']];
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(root: string, rel: string, data: string | Buffer) {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), data);
}

function verifyJsonOf(build: string): Record<string, string> {
	const hm: Record<string, string> = {};
	for (const rel of [
		'en/faq.html',
		'robots.txt',
		'sitemap.xml',
		'index.html',
		'_app/immutable/entry/start.js'
	]) {
		hm[rel] = sha(readFileSync(join(build, rel)));
	}
	return hm;
}

/** A synthetic prerendered build, as vite + the brand-slot recorder leave it. */
function makeBuild(page = PAGE): { root: string; build: string } {
	const root = mkdtempSync(join(tmpdir(), 'origin-slots-'));
	dirs.push(root);
	const build = join(root, 'build');
	write(build, 'en/faq.html', page);
	write(build, 'en/faq.html.gz', 'stale');
	write(build, 'index.html', SHELL);
	write(build, 'robots.txt', ROBOTS);
	write(build, 'sitemap.xml', SITEMAP);
	write(build, '_app/immutable/entry/start.js', ENTRY_JS);
	write(
		build,
		'.brand-slots.json',
		JSON.stringify({
			schema: 2,
			files: { 'en/faq.html': brandSlotsOf(page).slice(0, 3) },
			theme_files: { 'en/faq.html': brandSlotsOf(page).slice(3) }
		})
	);
	return { root, build };
}

function finishBuild(build: string) {
	recordOriginSlots(build, BUILD, () => {});
	write(build, 'verify.json', JSON.stringify({ hash_manifest: verifyJsonOf(build) }));
}

function read(build: string, rel: string) {
	return readFileSync(join(build, rel), 'utf8');
}

/** Every brand slot still names the brand at its recorded offset. */
function expectBrandSlotsValid(build: string) {
	const map = JSON.parse(read(build, '.brand-slots.json')) as {
		files: Record<string, Slot[]>;
		theme_files: Record<string, Slot[]>;
	};
	const text = read(build, 'en/faq.html');
	for (const [off, len, form] of map.files['en/faq.html']!) {
		expect(text.slice(off, off + len)).toBe(form);
	}
	const [[head]] = map.theme_files['en/faq.html']! as [Slot];
	expect(text.slice(head, head + 7)).toBe('</head>');
}

describe('build: record the origin slots', () => {
	it('strips the markers, keeps the build origin and the brand slots valid', () => {
		const { build } = makeBuild();
		finishBuild(build);
		const page = read(build, 'en/faq.html');
		expect(page).not.toContain(M);
		expect(page).toContain(`href="${BUILD}/en/faq"`);
		expect(page).toBe(PAGE.split(M).join(''));
		expect(gunzipSync(readFileSync(join(build, 'en/faq.html.gz'))).toString()).toBe(page);
		expectBrandSlotsValid(build);
	});

	it('fails when a marked origin reaches a protected file', () => {
		const { build } = makeBuild();
		write(build, 'index.html', `<link href="${marked('/')}">`);
		expect(() => recordOriginSlots(build, BUILD, () => {})).toThrow(/index\.html/);
		const other = makeBuild();
		write(other.build, '_app/immutable/chunks/a.js', `const o="${marked('')}"`);
		expect(() => recordOriginSlots(other.build, BUILD, () => {})).toThrow(/_app/);
	});

	it('fails on an unpaired marker', () => {
		expect(() => stripMarkedOrigins(`<a href="${M}${BUILD}/x">`)).toThrow(/unpaired/);
	});
});

describe('install / upgrade: apply the instance origin', () => {
	it('a hidden-only instance serves no clearnet origin; protected files are untouched', () => {
		const { build } = makeBuild();
		finishBuild(build);
		const shell = readFileSync(join(build, 'index.html'));
		const entry = readFileSync(join(build, '_app/immutable/entry/start.js'));
		const r = applyInstanceOrigin(build, ONION);
		expect(r.changed).toBe(true);
		for (const rel of ['en/faq.html', 'robots.txt', 'sitemap.xml']) {
			expect(read(build, rel)).not.toContain('https://');
			expect(read(build, rel)).toContain(ONION);
		}
		expect(read(build, 'robots.txt')).toContain(`Sitemap: ${ONION}/sitemap.xml`);
		expect(read(build, 'en/faq.html')).toContain(`"@id":"${ONION}/#organization"`);
		expect(gunzipSync(readFileSync(join(build, 'en/faq.html.gz'))).toString()).toBe(
			read(build, 'en/faq.html')
		);
		expect(readFileSync(join(build, 'index.html')).equals(shell)).toBe(true);
		expect(readFileSync(join(build, '_app/immutable/entry/start.js')).equals(entry)).toBe(true);
		expect(r.touched.some((t) => t.startsWith('index.html') || t.startsWith('_app'))).toBe(false);
		expectBrandSlotsValid(build);
		// The served manifest describes what is served.
		const doc = JSON.parse(read(build, 'verify.json')) as {
			hash_manifest: Record<string, string>;
			instance_origin?: { origin: string };
		};
		for (const rel of [
			'en/faq.html',
			'en/faq.html.gz',
			'robots.txt',
			'sitemap.xml',
			'index.html',
			'.brand-slots.json',
			'.origin-slots.json'
		]) {
			expect(doc.hash_manifest[rel], rel).toBe(sha(readFileSync(join(build, rel))));
		}
		expect(doc.instance_origin?.origin).toBe(ONION);
	});

	it('is idempotent, reversible, and can drop the origin altogether', () => {
		const { build } = makeBuild();
		finishBuild(build);
		const canonical = read(build, 'en/faq.html');
		const canonicalBrand = read(build, '.brand-slots.json');
		applyInstanceOrigin(build, 'https://Alice.example/');
		expect(read(build, 'en/faq.html')).toContain('href="https://alice.example/en/faq"');
		expect(applyInstanceOrigin(build, 'https://alice.example').changed).toBe(false);
		applyInstanceOrigin(build, null);
		expect(read(build, 'en/faq.html')).toContain('href="/en/faq"');
		expectBrandSlotsValid(build);
		applyInstanceOrigin(build, BUILD);
		expect(read(build, 'en/faq.html')).toBe(canonical);
		expect(read(build, '.brand-slots.json')).toBe(canonicalBrand);
		expect(JSON.parse(read(build, 'verify.json')).instance_origin).toBeUndefined();
	});

	it('no known origin: no Sitemap line and no relative sitemap URLs; an onion origin later restores them (VT3-9)', () => {
		const { build } = makeBuild();
		write(build, 'sitemap.xml.gz', 'stale');
		finishBuild(build);
		const canonicalRobots = read(build, 'robots.txt');
		const canonicalSitemap = read(build, 'sitemap.xml');
		applyInstanceOrigin(build, null);
		// robots.txt: the rest stays, the Sitemap directive goes (it must be absolute).
		expect(read(build, 'robots.txt')).toContain('User-agent: *');
		expect(read(build, 'robots.txt')).not.toMatch(/^\s*Sitemap:/im);
		// sitemap.xml: still a sitemap document, but with no (relative) URL entries.
		const sm = read(build, 'sitemap.xml');
		expect(sm).toContain('<urlset');
		expect(sm).not.toContain('<url>');
		expect(sm).not.toContain('<loc>');
		expect(gunzipSync(readFileSync(join(build, 'sitemap.xml.gz'))).toString()).toBe(sm);
		// The served manifest still describes every served file.
		const doc = JSON.parse(read(build, 'verify.json')) as { hash_manifest: Record<string, string> };
		for (const [rel, hash] of Object.entries(doc.hash_manifest)) {
			expect(existsSync(join(build, rel)), rel).toBe(true);
			expect(sha(readFileSync(join(build, rel))), rel).toBe(hash);
		}
		for (const rel of ['robots.txt', 'sitemap.xml', 'sitemap.xml.gz', 'en/faq.html']) {
			expect(doc.hash_manifest[rel], rel).toBe(sha(readFileSync(join(build, rel))));
		}
		// A known onion origin: absolute onion URLs come back.
		applyInstanceOrigin(build, ONION);
		expect(read(build, 'robots.txt')).toContain(`Sitemap: ${ONION}/sitemap.xml`);
		expect(read(build, 'sitemap.xml')).toContain(`<loc>${ONION}/en/faq</loc>`);
		// And the build origin restores the canonical files byte for byte.
		applyInstanceOrigin(build, null);
		applyInstanceOrigin(build, BUILD);
		expect(read(build, 'robots.txt')).toBe(canonicalRobots);
		expect(read(build, 'sitemap.xml')).toBe(canonicalSitemap);
		const after = JSON.parse(read(build, 'verify.json')) as {
			hash_manifest: Record<string, string>;
		};
		for (const [rel, hash] of Object.entries(after.hash_manifest)) {
			expect(existsSync(join(build, rel)), rel).toBe(true);
			expect(sha(readFileSync(join(build, rel))), rel).toBe(hash);
		}
	});

	it('finishes an interrupted no-origin apply (held copy written, served file not yet)', () => {
		const a = makeBuild();
		finishBuild(a.build);
		const b = join(a.root, 'copy');
		cpSync(a.build, b, { recursive: true });
		const before = JSON.parse(read(b, '.origin-slots.json'));
		applyInstanceOrigin(a.build, null);
		write(
			b,
			'.origin-slots.pending.json',
			JSON.stringify({
				from: before,
				to: JSON.parse(read(a.build, '.origin-slots.json')),
				brand: JSON.parse(read(a.build, '.brand-slots.json'))
			})
		);
		write(b, '.origin-held/robots.txt', read(a.build, '.origin-held/robots.txt'));
		applyInstanceOrigin(b, null);
		for (const rel of [
			'robots.txt',
			'sitemap.xml',
			'.origin-held/robots.txt',
			'.origin-held/sitemap.xml',
			'verify.json'
		]) {
			expect(read(b, rel), rel).toBe(read(a.build, rel));
		}
	});

	it('refuses an origin that is not one', () => {
		const { build } = makeBuild();
		finishBuild(build);
		expect(() => applyInstanceOrigin(build, 'https://alice.example/path')).toThrow();
		expect(() => applyInstanceOrigin(build, 'javascript:alert(1)')).toThrow();
		expect(() => applyInstanceOrigin(build, 'https://a.example"><script>')).toThrow();
	});

	it('refuses a branded build (brand offsets would go stale)', () => {
		const { root, build } = makeBuild();
		finishBuild(build);
		const id = createHash('sha256')
			.update(readFileSync(join(build, '.brand-slots.json')))
			.update(readFileSync(join(build, 'index.html')))
			.digest('hex');
		write(
			root,
			'.brand-pristine/state.json',
			JSON.stringify({ schema: 1, build_id: id, modified: ['en/faq.html'], added: [] })
		);
		expect(() => applyInstanceOrigin(build, ONION)).toThrow(/branded/);
		expect(read(build, 'en/faq.html')).toContain(BUILD);
	});

	it('finishes an apply that was interrupted after some files changed', () => {
		const a = makeBuild();
		finishBuild(a.build);
		const b = join(a.root, 'copy');
		cpSync(a.build, b, { recursive: true });
		const before = JSON.parse(read(b, '.origin-slots.json'));
		applyInstanceOrigin(a.build, ONION);
		// The crashed state: pending written, only the page rewritten.
		write(
			b,
			'.origin-slots.pending.json',
			JSON.stringify({
				from: before,
				to: JSON.parse(read(a.build, '.origin-slots.json')),
				brand: JSON.parse(read(a.build, '.brand-slots.json'))
			})
		);
		write(b, 'en/faq.html', read(a.build, 'en/faq.html'));
		applyInstanceOrigin(b, ONION);
		for (const rel of [
			'en/faq.html',
			'robots.txt',
			'sitemap.xml',
			'.brand-slots.json',
			'.origin-slots.json',
			'verify.json'
		]) {
			expect(read(b, rel), rel).toBe(read(a.build, rel));
		}
		expect(existsSync(join(b, '.origin-slots.pending.json'))).toBe(false);
	});
});
