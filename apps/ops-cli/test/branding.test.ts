/**
 * Per-instance branding (docs/BRANDING.md) — the build-time slot map
 * (scripts/build-brand-slots.mjs) and `morphit-ops branding apply | reset`
 * (src/lib/branding.ts), end to end on a small fixture build.
 *
 * The fixture pages carry the same U+2060 slot markers the real prerender emits,
 * and the REAL slot builder turns them into build/.brand-slots.json — so these
 * tests also pin the contract between the two halves (marker format, the
 * canonical <html> attributes, the protected SPA shell).
 *
 * The invariants that matter most:
 *   - the files the on-chain tamper check covers (index.html, service-worker,
 *     _app/…) are NEVER written;
 *   - only SITE-name slots change; software mentions ("Run a Morphit node") stay;
 *   - the brand is HTML-escaped in markup and verbatim inside JSON-LD;
 *   - the .gz/.br siblings match the branded page (no stale compressed copy);
 *   - verify.json is refreshed and discloses the override;
 *   - apply is idempotent, and reset restores every byte of the canonical build.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { applyBrandToString } from '../../../packages/operator-config/src/brand.ts';
import { createHash } from 'node:crypto';
import { gunzipSync, brotliDecompressSync, gzipSync } from 'node:zlib';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
	applyBranding,
	brandingPaths,
	isProtectedPath,
	normalizeSvg,
	pngSize,
	rasterizeSvg,
	brandPage,
	brandNameProblem,
	readBrandingSettings,
	CANONICAL_HTML_ATTRS,
	type BrandingSettings
} from '../src/lib/branding.ts';

const SLOT_BUILDER = join(
	import.meta.dirname,
	'..',
	'..',
	'..',
	'scripts',
	'build-brand-slots.mjs'
);
const M = '\u2060';
const slot = (form = 'Morphit'): string => `${M}${form}${M}`;

const LOGIN_PAGE =
	`<!doctype html><html lang="en"><head><title>Sign in to ${slot()}</title>` +
	`<meta property="og:site_name" content="${slot()}">` +
	`<script type="application/ld+json">{"@type":"WebSite","name":"${slot()}"}</script>` +
	`</head><body><h1>Sign in to ${slot()}</h1><p>Run a Morphit node.</p></body></html>`;
const PL_PAGE =
	`<!doctype html><html lang="pl"><head><title>${slot()}</title></head>` +
	`<body><p>Otwórz ${slot('Morphita')} na telefonie</p></body></html>`;
const SHELL = `<!doctype html><html lang="en"><head><title>${slot()}</title></head><body></body></html>`;
const LOGO_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="357" height="250"><rect width="357" height="250" fill="#0f0"/></svg>';

let root: string;
let buildDir: string;
let brandDir: string;

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else out.push(relative(buildDir, full).split(sep).join('/'));
	}
	return out;
}

function snapshot(): Map<string, string> {
	const m = new Map<string, string>();
	for (const rel of walk(buildDir).sort()) {
		m.set(
			rel,
			createHash('sha256')
				.update(readFileSync(join(buildDir, rel)))
				.digest('hex')
		);
	}
	return m;
}

function write(rel: string, body: string | Buffer, compress = false): void {
	const p = join(buildDir, rel);
	mkdirSync(join(p, '..'), { recursive: true });
	writeFileSync(p, body);
	if (compress) writeFileSync(`${p}.gz`, gzipSync(Buffer.from(body)));
}

function settings(over: Partial<BrandingSettings> = {}): BrandingSettings {
	return {
		brandName: null,
		invalidBrandName: null,
		shortName: null,
		betaBadge: null,
		dir: brandDir,
		...over
	};
}

/** verify.json like the real postbuild writes it (after the slot map). */
function writeVerifyJson(): void {
	const hm: Record<string, string> = {};
	for (const rel of walk(buildDir)) {
		if (rel === 'verify.json') continue;
		hm[rel] = createHash('sha256')
			.update(readFileSync(join(buildDir, rel)))
			.digest('hex');
	}
	write('verify.json', JSON.stringify({ hash_manifest: hm }, null, 2) + '\n');
}

const read = (rel: string): string => readFileSync(join(buildDir, rel), 'utf8');

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-branding-'));
	buildDir = join(root, 'apps', 'web', 'build');
	brandDir = join(root, 'etc', 'branding');
	mkdirSync(buildDir, { recursive: true });
	mkdirSync(brandDir, { recursive: true });
	write('index.html', SHELL, true);
	write('en/login.html', LOGIN_PAGE, true);
	write('pl.html', PL_PAGE, true);
	write('service-worker.js', 'self.addEventListener("fetch",()=>{});', true);
	write('_app/immutable/entry/start.js', 'export{};');
	write('brand/site-logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>');
	write(
		'brand/site-logo-footer.svg',
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>'
	);
	write(
		'brand/brand.json',
		'{\n\t"schema": 1,\n\t"name": "Morphit",\n\t"beta_badge": true\n}\n',
		true
	);
	write(
		'manifest.webmanifest',
		JSON.stringify({ name: 'Morphit', short_name: 'Morphit', start_url: '/' }, null, '\t') + '\n'
	);
	const r = spawnSync(process.execPath, [SLOT_BUILDER, buildDir], { encoding: 'utf8' });
	expect(r.status, r.stderr).toBe(0);
	writeVerifyJson();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('build-brand-slots (prerender post-processing)', () => {
	it('strips every marker, stamps pages but never the SPA shell, and records each slot', () => {
		for (const rel of walk(buildDir)) {
			if (rel.endsWith('.gz') || rel.endsWith('.br')) continue;
			expect(read(rel).includes(M), rel).toBe(false);
		}
		expect(read('index.html')).not.toContain('data-brand-name');
		expect(read('en/login.html')).toContain(`<html lang="en" ${CANONICAL_HTML_ATTRS}>`);
		// The compressed sibling was regenerated from the cleaned page.
		expect(gunzipSync(readFileSync(join(buildDir, 'en/login.html.gz'))).toString()).toBe(
			read('en/login.html')
		);
		const map = JSON.parse(read('.brand-slots.json')) as {
			files: Record<string, Array<[number, number, string, string]>>;
		};
		expect(Object.keys(map.files).sort()).toEqual(['en/login.html', 'pl.html']);
		expect(map.files['en/login.html']!.map((s) => s[3])).toEqual(['html', 'html', 'raw', 'html']);
		expect(map.files['pl.html']!.map((s) => s[2])).toEqual(['Morphit', 'Morphita']);
		for (const [rel, slots] of Object.entries(map.files)) {
			const text = read(rel);
			for (const [off, len, form] of slots) expect(text.slice(off, off + len)).toBe(form);
		}
	});

	it('is idempotent on an already-processed build', () => {
		const before = snapshot();
		const r = spawnSync(process.execPath, [SLOT_BUILDER, buildDir], { encoding: 'utf8' });
		expect(r.status).toBe(0);
		const after = snapshot();
		after.delete('verify.json');
		before.delete('verify.json');
		expect(after).toEqual(before);
	});
});

describe('morphit-ops branding apply / reset', () => {
	it('an unconfigured instance changes nothing', () => {
		const before = snapshot();
		const r = applyBranding({ buildDir, settings: settings() });
		expect(r.unsupported).toBe(false);
		expect(r.touched).toEqual([]);
		expect(snapshot()).toEqual(before);
		expect(existsSync(brandingPaths(buildDir).pristineDir)).toBe(false);
	});

	it('brands the site-name slots only, escaped per context, and never the protected files', () => {
		writeFileSync(join(brandDir, 'logo.svg'), LOGO_SVG);
		const before = snapshot();
		const r = applyBranding({ buildDir, settings: settings({ brandName: 'A&B Trading' }) });
		expect(r.beta).toBe(false); // automatic: off once a custom logo exists

		const login = read('en/login.html');
		expect(login).toContain('<title>Sign in to A&amp;B Trading</title>');
		expect(login).toContain('<h1>Sign in to A&amp;B Trading</h1>');
		expect(login).toContain('content="A&amp;B Trading"');
		expect(login).toContain('"name":"A&B Trading"'); // JSON-LD: raw text, not entities
		expect(login).toContain('Run a Morphit node.'); // software mention untouched
		expect(login).toContain('data-brand-name="A&amp;B Trading" data-brand-beta="off"');
		expect(read('pl.html')).toContain('Otwórz A&amp;B Trading na telefonie');

		// Compressed copies follow the branded page.
		expect(gunzipSync(readFileSync(join(buildDir, 'en/login.html.gz'))).toString()).toBe(login);
		expect(brotliDecompressSync(readFileSync(join(buildDir, 'en/login.html.br'))).toString()).toBe(
			login
		);

		// Logo: normalized (viewBox added), drawing unchanged.
		const logo = read('brand/site-logo.svg');
		expect(logo).toContain('viewBox="0 0 357 250"');
		expect(logo).toContain('<rect width="357" height="250" fill="#0f0"/>');
		expect(read('brand/site-logo-footer.svg')).toBe(logo);

		expect(JSON.parse(read('brand/brand.json'))).toEqual({
			schema: 1,
			name: 'A&B Trading',
			beta_badge: false
		});
		const manifest = JSON.parse(read('manifest.webmanifest')) as Record<string, unknown>;
		expect(manifest.name).toBe('A&B Trading');
		expect(manifest.short_name).toBe('A&B Trading');
		expect(manifest.start_url).toBe('/');

		// The on-chain-covered files are byte-for-byte canonical.
		const after = snapshot();
		for (const rel of before.keys()) {
			if (isProtectedPath(rel) && rel !== 'verify.json' && rel !== '.brand-slots.json') {
				expect(after.get(rel), rel).toBe(before.get(rel));
			}
		}
		expect(after.get('.brand-slots.json')).toBe(before.get('.brand-slots.json'));
		for (const rel of r.touched) expect(isProtectedPath(rel), rel).toBe(false);

		// verify.json: every hash current, and the override disclosed.
		const v = JSON.parse(read('verify.json')) as {
			hash_manifest: Record<string, string>;
			operator_branding: { brand_name: string; files: string[] };
		};
		for (const [rel, sha] of Object.entries(v.hash_manifest)) expect(after.get(rel), rel).toBe(sha);
		expect(v.operator_branding.brand_name).toBe('A&B Trading');
		expect(v.operator_branding.files).toContain('en/login.html');
		expect(v.operator_branding.files).toContain('brand/site-logo.svg');
	});

	it('re-applying is a no-op, and reset restores the canonical build byte for byte', () => {
		writeFileSync(join(brandDir, 'logo.svg'), LOGO_SVG);
		const canonical = snapshot();
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		const branded = snapshot();
		const again = applyBranding({
			buildDir,
			settings: settings({ brandName: 'Vigilante Trading' })
		});
		expect(again.touched).toEqual([]);
		expect(snapshot()).toEqual(branded);

		// Changing the name re-brands from the canonical originals (not the branded text).
		applyBranding({ buildDir, settings: settings({ brandName: 'Other Market' }) });
		expect(read('en/login.html')).toContain('Sign in to Other Market');
		expect(read('en/login.html')).not.toContain('Vigilante');

		const reset = applyBranding({ buildDir, settings: settings(), reset: true });
		expect(reset.touched.length).toBeGreaterThan(0);
		expect(snapshot()).toEqual(canonical);
		expect(existsSync(brandingPaths(buildDir).pristineDir)).toBe(false);
	});

	it('dry-run plans without writing', () => {
		const before = snapshot();
		const r = applyBranding({
			buildDir,
			settings: settings({ brandName: 'Vigilante Trading' }),
			dryRun: true
		});
		expect(r.touched).toContain('en/login.html');
		expect(snapshot()).toEqual(before);
	});

	it('the static/ overlay replaces images only — never pages, code, fonts, canary or generated files', () => {
		const before = snapshot();
		mkdirSync(join(brandDir, 'static', 'splash'), { recursive: true });
		mkdirSync(join(brandDir, 'static', 'fonts'), { recursive: true });
		mkdirSync(join(brandDir, 'static', 'extra'), { recursive: true });
		writeFileSync(join(brandDir, 'static', 'splash', 'splash-a.png'), Buffer.from('png-bytes'));
		writeFileSync(join(brandDir, 'static', 'extra', 'new.svg'), LOGO_SVG);
		for (const bad of [
			'en.html',
			'x.htm',
			'x.xhtml',
			'x.xml',
			'service-worker.js',
			'canary.txt',
			'pgp_keys.asc',
			'robots.txt',
			'fonts/comfortaa.woff2',
			'brand/brand.json',
			'manifest.webmanifest'
		]) {
			mkdirSync(join(brandDir, 'static', bad, '..'), { recursive: true });
			writeFileSync(join(brandDir, 'static', bad), 'evil');
		}
		// A FIFO dressed as an image must neither hang root nor be published.
		expect(spawnSync('mkfifo', [join(brandDir, 'static', 'splash', 'pipe.png')]).status).toBe(0);
		const r = applyBranding({ buildDir, settings: settings() });
		expect(existsSync(join(buildDir, 'splash', 'pipe.png'))).toBe(false);
		expect(read('splash/splash-a.png')).toBe('png-bytes');
		expect(read('extra/new.svg')).toContain('<rect');
		expect(existsSync(join(buildDir, 'en.html'))).toBe(false);
		expect(existsSync(join(buildDir, 'canary.txt'))).toBe(false);
		expect(read('service-worker.js')).toBe('self.addEventListener("fetch",()=>{});');
		expect(read('brand/brand.json')).not.toContain('evil');
		expect(r.warnings.filter((w) => w.includes('only images'))).toHaveLength(11);
		// …and reset removes what the overlay added — siblings, verify.json
		// entries and the directory it created included.
		applyBranding({ buildDir, settings: settings(), reset: true });
		expect(snapshot()).toEqual(before);
		expect(existsSync(join(buildDir, 'extra'))).toBe(false);
	});

	it('a build without a slot map is reported as unsupported and left alone', () => {
		rmSync(join(buildDir, '.brand-slots.json'));
		const before = snapshot();
		const r = applyBranding({ buildDir, settings: settings({ brandName: 'X' }) });
		expect(r.unsupported).toBe(true);
		expect(snapshot()).toEqual(before);
	});
});

describe('normalizeSvg', () => {
	it('adds a viewBox from pixel width/height and keeps the drawing', () => {
		const n = normalizeSvg(LOGO_SVG, 'logo.svg');
		expect(n.viewBox).toBe('0 0 357 250');
		expect(n.width).toBe(357);
		expect(n.height).toBe(250);
		expect(n.svg).toContain('<rect width="357" height="250" fill="#0f0"/>');
	});

	it('takes width/height from the viewBox when missing', () => {
		const n = normalizeSvg(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1228.436 263.25"><path d="M0 0"/></svg>',
			'logo.svg'
		);
		expect(n.width).toBeCloseTo(1228.436);
		expect(n.svg).toMatch(/width="1228.436"/);
	});

	it.each([
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>',
			'script'
		],
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="x()"></svg>',
			'event-handler'
		],
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="https://e.x/a.png"/></svg>',
			'another file or site'
		],
		['<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'viewBox'],
		['<html></html>', 'html'],
		// The deep-deep red team's bypasses of the old regex check:
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" xmlns:h="http://www.w3.org/1999/xhtml"><h:script>alert(1)</h:script></svg>',
			'script'
		],
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>',
			'script'
		],
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" xmlns:h="http://www.w3.org/1999/xhtml"><h:iframe src="//e.x"/></svg>',
			'iframe'
		],
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect style="fill:url(//e.x/a)"/></svg>',
			'url'
		],
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect style="fill:url(\\68ttps://e.x)"/></svg>',
			'escape'
		],
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect><set attributeName="x" to="1"/></rect></svg>',
			'set'
		],
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><use href="&#106;avascript:alert(1)"/></svg>',
			'another file or site'
		],
		[
			'<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
			'DOCTYPE'
		],
		[
			'<?xml-stylesheet href="//e.x/a.css"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
			'processing instruction'
		],
		[Buffer.from([0xff, 0xfe, 0x3c, 0x00]), 'UTF-8'],
		// Second red team: characters XML forbids would make browsers reject
		// the served file (the logo silently vanishes)…
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text>a\u0000b</text></svg>',
			'control character'
		],
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text>a&#1;b</text></svg>',
			'invalid character reference'
		],
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="a&#xFFFE;"/></svg>',
			'invalid character reference'
		],
		// …and a comment must not split url( to slip an outside reference past.
		[
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><style>a{fill:url/**/(//e.x/x)}</style></svg>',
			'url'
		]
	])('refuses unsafe or unscalable input (%#)', (svg, why) => {
		expect(() => normalizeSvg(svg, 'logo.svg')).toThrow(new RegExp(why));
	});

	it('drops editor metadata but keeps the drawing (Inkscape export)', () => {
		const n = normalizeSvg(
			'<?xml version="1.0"?><!-- Inkscape --><svg width="10" height="10" viewBox="0 0 10 10" ' +
				'xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ' +
				'xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd">' +
				'<sodipodi:namedview id="n" inkscape:zoom="1"/><metadata><title>x</title></metadata>' +
				'<g inkscape:label="Layer"><path d="M0 0H5V5Z" fill="#0f0" inkscape:connector-curvature="0"/></g></svg>',
			'logo.svg'
		);
		expect(n.svg).toContain('<path d="M0 0H5V5Z" fill="#0f0"/>');
		expect(n.svg).not.toMatch(/inkscape|sodipodi|metadata|<!--/);
	});
});

describe('crash safety and link safety (run as root)', () => {
	it('an apply interrupted half-way is completed by apply and fully undone by reset', () => {
		writeFileSync(join(brandDir, 'logo.svg'), LOGO_SVG);
		const canonical = snapshot();
		// Simulate: originals saved and state.json written (phase 1), then only
		// ONE page rewritten before the process died.
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		const branded = snapshot();
		const loginBranded = readFileSync(join(buildDir, 'en/login.html'));
		// Put every build file back EXCEPT en/login.html, keeping the saved state.
		for (const [rel] of canonical) {
			if (rel === 'en/login.html' || rel === 'en/login.html.gz' || rel === 'en/login.html.br')
				continue;
			const p = join(root, 'apps', 'web', '.brand-pristine', 'files', rel);
			if (existsSync(p)) writeFileSync(join(buildDir, rel), readFileSync(p));
		}
		writeFileSync(join(buildDir, 'en/login.html'), loginBranded);
		// A second apply completes it …
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		const again = snapshot();
		again.delete('verify.json');
		branded.delete('verify.json');
		expect(again).toEqual(branded);
		// … and reset restores every byte.
		applyBranding({ buildDir, settings: settings(), reset: true });
		expect(snapshot()).toEqual(canonical);
	});

	it('recovers when it died before state.json was written (only originals saved)', () => {
		const canonical = snapshot();
		applyBranding({ buildDir, settings: settings({ brandName: 'X Market' }) });
		rmSync(join(root, 'apps', 'web', '.brand-pristine', 'state.json'));
		applyBranding({ buildDir, settings: settings(), reset: true });
		expect(snapshot()).toEqual(canonical);
	});

	it('a dry run never deletes saved originals', () => {
		applyBranding({ buildDir, settings: settings({ brandName: 'X Market' }) });
		const pristine = join(root, 'apps', 'web', '.brand-pristine');
		const st = JSON.parse(readFileSync(join(pristine, 'state.json'), 'utf8')) as {
			build_id: string;
		};
		st.build_id = 'something-else';
		writeFileSync(join(pristine, 'state.json'), JSON.stringify(st));
		applyBranding({ buildDir, settings: settings(), dryRun: true });
		expect(existsSync(join(pristine, 'state.json'))).toBe(true);
	});

	it('refuses to follow a symbolic link planted in the build or the branding dir', () => {
		const outside = join(root, 'outside');
		mkdirSync(outside);
		writeFileSync(join(outside, 'victim'), 'untouched');
		// A link where branding would write the logo.
		rmSync(join(buildDir, 'brand', 'site-logo.svg'));
		symlinkSync(join(outside, 'victim'), join(buildDir, 'brand', 'site-logo.svg'));
		writeFileSync(join(brandDir, 'logo.svg'), LOGO_SVG);
		expect(() => applyBranding({ buildDir, settings: settings() })).toThrow(/symbolic link/);
		expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('untouched');
		// A linked input file is not read.
		rmSync(join(buildDir, 'brand', 'site-logo.svg'));
		writeFileSync(
			join(buildDir, 'brand', 'site-logo.svg'),
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>'
		);
		rmSync(join(brandDir, 'logo.svg'));
		symlinkSync(join(outside, 'victim'), join(brandDir, 'logo.svg'));
		const r = applyBranding({ buildDir, settings: settings() });
		expect(r.notes.some((n) => n.startsWith('logo:'))).toBe(false);
	});

	it('only one run at a time', () => {
		writeFileSync(join(root, 'apps', 'web', '.branding.lock'), String(process.ppid));
		expect(() => applyBranding({ buildDir, settings: settings({ brandName: 'X' }) })).toThrow(
			/in progress/
		);
		// A lock left by a dead process is taken over.
		writeFileSync(join(root, 'apps', 'web', '.branding.lock'), '999999999');
		expect(() => applyBranding({ buildDir, settings: settings({ brandName: 'X' }) })).not.toThrow();
	});
});

describe('site-name rules', () => {
	it('a compound word gets the name hyphenated, exactly as the browser writes it', () => {
		const html =
			'<html data-brand-name="Morphit" data-brand-beta="on"><p>Dein Morphit-Passwort</p></html>';
		const page = brandPage(
			html,
			[[html.indexOf('Morphit-'), 7, 'Morphit', 'html']],
			'Vigilante Trading',
			true
		);
		expect(page).toContain('Dein Vigilante-Trading-Passwort');
		expect(applyBrandToString('Dein {brand}-Passwort', () => 'Vigilante Trading')).toBe(
			'Dein Vigilante-Trading-Passwort'
		);
	});

	it('names that imitate the project are refused; plain "Morphit" means unbranded', () => {
		expect(brandNameProblem('Vigilante Trading')).toBeNull();
		expect(brandNameProblem('Morphit Iran')).toBeNull();
		expect(brandNameProblem('\u041corphit')).toMatch(/imitates/); // Cyrillic М
		expect(brandNameProblem('morphit-fees')).toMatch(/imitates/);
		expect(brandNameProblem('[Support](https://x)')).not.toBeNull();
		expect(brandNameProblem('\u202eX')).not.toBeNull();
		// Invisible direction marks reorder the text around the name.
		for (const mark of ['\u200e', '\u200f', '\u061c'])
			expect(brandNameProblem(`Vigilante${mark}Trading`)).not.toBeNull();
		// …but the joiners Persian needs stay allowed.
		expect(brandNameProblem('بازار\u200cآزاد')).toBeNull();
		writeFileSync(join(root, 'morphit.config.env'), 'MORPHIT_INSTANCE_BRAND_NAME=Morphit\n');
		expect(readBrandingSettings(root, { MORPHIT_ETC_DIR: join(root, 'etc') }).brandName).toBeNull();
	});

	it('reads the config files the services source, bash-style', () => {
		mkdirSync(join(root, 'etc'), { recursive: true });
		writeFileSync(
			join(root, 'morphit.config.env'),
			"export MORPHIT_INSTANCE_BRAND_NAME='Vigilante Trading'\nMORPHIT_INSTANCE_BRAND_SHORT_NAME=Vigilante # short\n"
		);
		const s1 = readBrandingSettings(root, { MORPHIT_ETC_DIR: join(root, 'etc') });
		expect(s1.brandName).toBe('Vigilante Trading');
		expect(s1.shortName).toBe('Vigilante');
		// /etc/morphit/indexer.env is sourced last by the services — it wins.
		writeFileSync(join(root, 'etc', 'indexer.env'), 'MORPHIT_INSTANCE_BRAND_NAME="Other"\n');
		expect(readBrandingSettings(root, { MORPHIT_ETC_DIR: join(root, 'etc') }).brandName).toBe(
			'Other'
		);
	});

	it('the short name alone still sets the home-screen label', () => {
		applyBranding({ buildDir, settings: settings({ shortName: 'Vigi' }) });
		const m = JSON.parse(read('manifest.webmanifest')) as Record<string, unknown>;
		expect(m.short_name).toBe('Vigi');
		expect(m.name).toBe('Morphit');
	});
});

describe('isProtectedPath', () => {
	it.each([
		['index.html', true],
		['index.html.gz', true],
		['service-worker.js', true],
		['_app/immutable/entry/start.js', true],
		['verify.json', true],
		['.brand-slots.json', true],
		['canary.txt', true],
		['pgp_keys.asc', true],
		['fonts/comfortaa.woff2', true],
		['brand/../index.html', true],
		['en/login.html', false],
		['brand/site-logo.svg', false],
		['favicon.svg', false]
	])('%s → %s', (rel, want) => {
		expect(isProtectedPath(rel)).toBe(want);
	});
});

/** A PNG header (signature + IHDR) of the given size — enough for pngSize(). */
function pngHeader(w: number, h: number): Buffer {
	const b = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
	b.writeUInt32BE(13, 8);
	b.write('IHDR', 12, 'latin1');
	b.writeUInt32BE(w, 16);
	b.writeUInt32BE(h, 20);
	return b;
}
const CAN_RASTERIZE = rasterizeSvg(LOGO_SVG, 8) !== null;

describe('iOS launch screens', () => {
	beforeEach(() => {
		write('splash/splash-a.png', pngHeader(75, 133));
		write('splash/splash-b.png', pngHeader(81, 108));
		writeVerifyJson(); // like the real build: verify.json covers every file
	});

	it('are generated from logo.svg at each canonical image size, and reset restores them', () => {
		writeFileSync(join(brandDir, 'logo.svg'), LOGO_SVG);
		const before = snapshot();
		const r = applyBranding({ buildDir, settings: settings() });
		if (CAN_RASTERIZE) {
			for (const [rel, w, h] of [
				['splash/splash-a.png', 75, 133],
				['splash/splash-b.png', 81, 108]
			] as const) {
				const buf = readFileSync(join(buildDir, rel));
				expect(pngSize(buf), rel).toEqual({ width: w, height: h });
				expect(buf.length, rel).toBeGreaterThan(33); // a real image, not the header
			}
			expect(r.notes.some((n) => n.includes('2 iPhone/iPad images'))).toBe(true);
		} else {
			expect(r.warnings.some((w) => w.includes('launch screens'))).toBe(true);
		}
		applyBranding({ buildDir, settings: settings(), reset: true });
		expect(snapshot()).toEqual(before);
	});

	it("the operator's own static/splash image wins over the generated one", () => {
		writeFileSync(join(brandDir, 'logo.svg'), LOGO_SVG);
		mkdirSync(join(brandDir, 'static', 'splash'), { recursive: true });
		writeFileSync(join(brandDir, 'static', 'splash', 'splash-a.png'), 'mine');
		applyBranding({ buildDir, settings: settings() });
		expect(read('splash/splash-a.png')).toBe('mine');
	});

	it('are left alone without a custom logo', () => {
		const before = snapshot();
		applyBranding({ buildDir, settings: settings({ brandName: 'X' }) });
		const after = snapshot();
		expect(after.get('splash/splash-a.png')).toBe(before.get('splash/splash-a.png'));
	});
});

describe('morphit-ops branding apply --logo/--icon/--name (one-command setup)', () => {
	const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
	const TSX = join(import.meta.dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');
	let etc: string;
	let files: string;

	function cli(...args: string[]): { status: number | null; out: string } {
		const r = spawnSync(TSX, [MAIN, 'branding', ...args], {
			cwd: root,
			encoding: 'utf8',
			timeout: 120_000,
			env: {
				...process.env,
				MORPHIT_ETC_DIR: etc,
				MORPHIT_BRANDING_DIR: '',
				MORPHIT_INSTANCE_BRAND_NAME: '',
				MORPHIT_WEB_ROOT: join(root, 'no-web-root'),
				NO_COLOR: '1'
			}
		});
		return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
	}

	beforeEach(() => {
		etc = join(root, 'etc');
		files = join(root, 'incoming');
		mkdirSync(files, { recursive: true });
		// A fake install: the monorepo marker + a config file.
		writeFileSync(join(root, 'package.json'), '{"name":"x","workspaces":[]}\n');
		writeFileSync(join(root, 'morphit.config.env'), '# config\nMORPHIT_INSTANCE_NAME=Test\n');
		writeFileSync(join(files, 'combined.svg'), LOGO_SVG);
		writeFileSync(join(files, 'wordmark.svg'), LOGO_SVG.replace('#0f0', '#00f'));
		writeFileSync(join(files, 'symbol.svg'), LOGO_SVG.replace('#0f0', '#f00'));
		writeFileSync(join(files, 'evil.svg'), LOGO_SVG.replace('<rect', '<script>x</script><rect'));
	});

	it('installs the files and the name, then applies them', () => {
		const r = cli(
			'apply',
			'--logo',
			join(files, 'combined.svg'),
			'--logo-footer',
			join(files, 'wordmark.svg'),
			'--icon',
			join(files, 'symbol.svg'),
			'--name',
			'Vigilante Trading'
		);
		expect(r.status, r.out).toBe(0);
		const dir = join(etc, 'branding');
		expect(readFileSync(join(dir, 'logo.svg'), 'utf8')).toBe(LOGO_SVG); // original bytes kept
		expect(readFileSync(join(dir, 'logo-footer.svg'), 'utf8')).toContain('#00f');
		expect(readFileSync(join(dir, 'icon.svg'), 'utf8')).toContain('#f00');
		expect(readFileSync(join(root, 'morphit.config.env'), 'utf8')).toMatch(
			/^MORPHIT_INSTANCE_BRAND_NAME=.*Vigilante Trading/m
		);
		expect(readFileSync(join(root, 'morphit.config.env'), 'utf8')).toContain(
			'MORPHIT_INSTANCE_NAME=Test'
		);
		expect(read('en/login.html')).toContain('<title>Sign in to Vigilante Trading</title>');
		expect(read('brand/site-logo.svg')).toContain('viewBox="0 0 357 250"');
		expect(read('favicon.svg')).toContain('#f00');

		// --name= removes it again; the files stay.
		const r2 = cli('apply', '--name=');
		expect(r2.status, r2.out).toBe(0);
		expect(readFileSync(join(root, 'morphit.config.env'), 'utf8')).not.toMatch(
			/^MORPHIT_INSTANCE_BRAND_NAME=/m
		);
		expect(read('en/login.html')).toContain('<title>Sign in to Morphit</title>');
		expect(read('brand/site-logo.svg')).toContain('viewBox="0 0 357 250"');
	});

	it('refuses an unsafe file or an unusable name and changes nothing', () => {
		const before = snapshot();
		const r = cli(
			'apply',
			'--logo',
			join(files, 'combined.svg'),
			'--icon',
			join(files, 'evil.svg')
		);
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/script/);
		expect(existsSync(join(etc, 'branding', 'logo.svg'))).toBe(false);

		const r2 = cli('apply', '--name', 'Bad {name}');
		expect(r2.status).toBe(1);
		expect(readFileSync(join(root, 'morphit.config.env'), 'utf8')).not.toContain('BRAND_NAME');

		const r3 = cli('apply', '--logo', join(files, 'missing.svg'));
		expect(r3.status).toBe(1);
		expect(r3.out).toMatch(/no such file/);

		// The guided form needs a terminal; piped, it says how to do it instead.
		const r5 = cli('setup');
		expect(r5.status).toBe(2);
		expect(r5.out).toMatch(/branding apply --logo/);

		const r4 = cli('status', '--name', 'X');
		expect(r4.status).toBe(2);
		expect(snapshot()).toEqual(before);
	});
});

describe('resolveCallerPath — a relative --logo resolves where the operator typed it', () => {
	// Imported lazily so the fixture tests above don't pay for the command module.
	const load = async () => (await import('../src/commands/branding.ts')).resolveCallerPath;
	const install = '/opt/morphit';
	const cliDir = '/opt/morphit/apps/ops-cli';

	it('uses the directory the launcher passed (MORPHIT_OPS_CALLER_CWD)', async () => {
		const r = await load();
		expect(r('logo.svg', install, { MORPHIT_OPS_CALLER_CWD: '/home/tester' }, cliDir)).toBe(
			'/home/tester/logo.svg'
		);
		expect(r('./art/logo.svg', install, { MORPHIT_OPS_CALLER_CWD: '/home/tester' }, cliDir)).toBe(
			'/home/tester/art/logo.svg'
		);
	});

	it('falls back to OLDPWD under an older launcher (npm exec from the install)', async () => {
		const r = await load();
		const env = { INIT_CWD: install, OLDPWD: '/root/art' };
		expect(r('logo.svg', install, env, cliDir)).toBe('/root/art/logo.svg');
		// …but not when the CLI was started somewhere else (npx from a folder).
		expect(r('logo.svg', install, { INIT_CWD: '/srv', OLDPWD: '/root/art' }, '/srv')).toBe(
			'/srv/logo.svg'
		);
	});

	it('keeps absolute paths, expands ~ and strips stray quotes', async () => {
		const r = await load();
		expect(r('/etc/x.svg', install, { MORPHIT_OPS_CALLER_CWD: '/home/tester' }, cliDir)).toBe(
			'/etc/x.svg'
		);
		expect(r('~/logo.svg', install, { HOME: '/home/tester' }, cliDir)).toBe('/home/tester/logo.svg');
		expect(r("'/tmp/a b.svg'", install, {}, cliDir)).toBe('/tmp/a b.svg');
	});
});

describe('upgrade rollback re-attaches a container frontend', () => {
	it('every rollback after the frontend container is recreated passes the container', () => {
		const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'upgrade.ts'), 'utf8');
		const recreated = src.indexOf('restartFrontendContainer(plan.restartContainer, installDir);');
		expect(recreated).toBeGreaterThan(0);
		const fn = src.indexOf('export function rollback(');
		const later = src.slice(recreated, fn);
		const calls = later.match(/return rollback\([\s\S]*?\);/g) ?? [];
		expect(calls.length).toBeGreaterThan(0);
		for (const c of calls) expect(c).toMatch(/container: plan\.restartContainer/);
		// …and rollback() actually uses it.
		expect(src.slice(fn)).toMatch(/restartFrontendContainer\(web\.container, installDir\)/);
	});
});
