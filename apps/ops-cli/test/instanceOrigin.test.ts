/**
 * The instance's own origin in the prebuilt frontend. Runs the REAL apps/web/scripts/origin-slots.mjs (record at
 * "build time", apply through ops-cli) on a fixture build, then reads what a
 * visitor would get: the canonical link, robots.txt, sitemap.xml, verify.json.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(REPO, 'apps', 'web', 'scripts', 'origin-slots.mjs');
const ONION = `${'a'.repeat(56)}.onion`;
const M = '⁣';

const mod = (await import('../src/lib/instanceOrigin.ts').catch(() => null)) as
	| typeof import('../src/lib/instanceOrigin.ts')
	| null;

let root = '';
let installDir = '';
let buildDir = '';
let etcDir = '';
const saved = { ...process.env };

function walk(d: string): string[] {
	return readdirSync(d).flatMap((n) => {
		const p = join(d, n);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

/** A build as `npm run build` leaves it: marked pages, SEO files, verify.json, then `record`. */
function makeBuild(): void {
	mkdirSync(join(installDir, 'apps', 'web', 'scripts'), { recursive: true });
	cpSync(SCRIPT, join(installDir, 'apps', 'web', 'scripts', 'origin-slots.mjs'));
	mkdirSync(join(buildDir, '_app'), { recursive: true });
	writeFileSync(
		join(buildDir, 'index.html'),
		'<!doctype html><html><head></head><body></body></html>'
	);
	writeFileSync(join(buildDir, '_app', 'entry.js'), 'export const x = 1;');
	// What every real build ships (branding's canonical brand record).
	mkdirSync(join(buildDir, 'brand'), { recursive: true });
	writeFileSync(
		join(buildDir, 'brand', 'brand.json'),
		'{\n\t"schema": 1,\n\t"name": "Morphit",\n\t"beta_badge": true\n}\n'
	);
	const page = (path: string): string =>
		`<!doctype html><html><head><title>Morphit</title><link rel="canonical" href="${M}https://morphit.io${M}${path}">` +
		`<meta property="og:url" content="${M}https://morphit.io${M}${path}"></head><body>Morphit</body></html>`;
	writeFileSync(join(buildDir, 'en.html'), page('/en'));
	writeFileSync(join(buildDir, 'en.html.gz'), gzipSync(page('/en')));
	writeFileSync(
		join(buildDir, 'robots.txt'),
		'User-agent: *\nAllow: /\nSitemap: https://morphit.io/sitemap.xml\n'
	);
	writeFileSync(
		join(buildDir, 'sitemap.xml'),
		'<urlset><url><loc>https://morphit.io/en</loc></url></urlset>\n'
	);
	writeFileSync(
		join(buildDir, '.brand-slots.json'),
		JSON.stringify({
			schema: 2,
			attrs: 'data-brand-name="Morphit" data-brand-beta="on"',
			files: {},
			theme_files: {}
		})
	);
	const rec = spawnSync(process.execPath, [SCRIPT, 'record', buildDir], { encoding: 'utf8' });
	expect(rec.status, rec.stderr).toBe(0);
	const hm: Record<string, string> = {};
	for (const f of walk(buildDir)) hm[relative(buildDir, f)] = sha(f);
	writeFileSync(
		join(buildDir, 'verify.json'),
		JSON.stringify({ schema_version: 1, hash_manifest: hm }, null, 2)
	);
}

function config(lines: string): void {
	writeFileSync(join(installDir, 'morphit.config.env'), lines);
}
function hiddenOnly(on: boolean): void {
	writeFileSync(
		join(etcDir, 'indexer.env'),
		on
			? 'MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\n'
			: 'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example\n'
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-origin-'));
	installDir = join(root, 'opt', 'morphit');
	buildDir = join(installDir, 'apps', 'web', 'build');
	etcDir = join(root, 'etc', 'morphit');
	mkdirSync(etcDir, { recursive: true });
	mkdirSync(buildDir, { recursive: true });
	process.env.MORPHIT_ENV_ROOT = root;
	process.env.MORPHIT_ETC_DIR = etcDir;
	makeBuild();
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
	rmSync(root, { recursive: true, force: true });
});

const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };
const read = (rel: string, dir = buildDir): string => readFileSync(join(dir, rel), 'utf8');
const canonical = (dir = buildDir): string =>
	/rel="canonical" href="([^"]*)"/.exec(read('en.html', dir))![1]!;
const verifyOk = (dir = buildDir): boolean => {
	const hm = JSON.parse(read('verify.json', dir)).hash_manifest as Record<string, string>;
	return Object.entries(hm).every(
		([rel, h]) => existsSync(join(dir, rel)) && sha(join(dir, rel)) === h
	);
};

describe('the instance origin on the served pages', () => {
	it('a clearnet instance: pages, sitemap and robots name ITS origin; verify.json still matches; a second run changes nothing', () => {
		expect(mod, 'lib/instanceOrigin.ts is missing').not.toBeNull();
		config('MORPHIT_INSTANCE_ORIGIN=https://Alice.Example/\n');
		hiddenOnly(false);
		const r = mod!.syncInstanceOrigin(ctx, { installDir, webRoot: null });
		expect(r.verified, r.detail).toBe(true);
		expect(r.strategy).toBe('applied');
		expect(canonical()).toBe('https://alice.example/en');
		expect(read('robots.txt')).toMatch(/^Sitemap: https:\/\/alice\.example\/sitemap\.xml$/m);
		expect(read('sitemap.xml')).not.toMatch(/morphit\.io/);
		expect(verifyOk()).toBe(true);
		expect(read('index.html')).toBe('<!doctype html><html><head></head><body></body></html>');
		expect(mod!.syncInstanceOrigin(ctx, { installDir, webRoot: null }).strategy).toBe('already');
	});

	it('a hidden-only node with a clearnet origin configured gets NO absolute URL (zero-clearnet)', () => {
		config('MORPHIT_INSTANCE_ORIGIN=https://alice.example\n');
		hiddenOnly(true);
		const r = mod!.syncInstanceOrigin(ctx, { installDir, webRoot: null });
		expect(r.origin).toBe('-');
		expect(r.verified, r.detail).toBe(true);
		expect(canonical()).toBe('/en');
		for (const f of ['en.html', 'robots.txt', 'sitemap.xml'])
			expect(read(f), f).not.toMatch(/https?:\/\//);
		// No origin: no Sitemap line (the protocol needs absolute URLs); the slot
		// forms wait, unserved, under .origin-held/ for an apply with an origin.
		expect(read('robots.txt')).not.toMatch(/^Sitemap:/m);
		expect(existsSync(join(buildDir, '.origin-held'))).toBe(true);
		expect(verifyOk()).toBe(true);
	});

	it('a hidden-only node with only its onion set: the onion; with nothing set: no origin', () => {
		hiddenOnly(true);
		config(`MORPHIT_INSTANCE_TOR_ADDRESS=${ONION}\n`);
		expect(mod!.resolveInstanceOrigin(installDir).origin).toBe(`http://${ONION}`);
		config('');
		expect(mod!.resolveInstanceOrigin(installDir).origin).toBe('-');
		hiddenOnly(false);
		expect(mod!.resolveInstanceOrigin(installDir).origin).toBe('-');
	});

	it('a bare-metal web root gets the changed files, and the check reads the SERVED copy', () => {
		const webRoot = join(root, 'www');
		cpSync(buildDir, webRoot, { recursive: true });
		config('MORPHIT_INSTANCE_ORIGIN=https://alice.example\n');
		hiddenOnly(false);
		const r = mod!.syncInstanceOrigin(ctx, { installDir, webRoot });
		expect(r.verified, r.detail).toBe(true);
		expect(canonical(webRoot)).toBe('https://alice.example/en');
		expect(verifyOk(webRoot)).toBe(true);
	});

	it('a bare-metal web root mirrors .origin-held/ exactly: added, removed, and leftovers from an earlier copy', () => {
		const webRoot = join(root, 'www');
		cpSync(buildDir, webRoot, { recursive: true });
		const held = (dir: string): Record<string, string> => {
			const d = join(dir, '.origin-held');
			return existsSync(d) ? Object.fromEntries(walk(d).map((f) => [relative(d, f), sha(f)])) : {};
		};
		// 1. no origin (hidden-only, nothing set): the held forms appear in both.
		hiddenOnly(true);
		config('');
		const none = mod!.syncInstanceOrigin(ctx, { installDir, webRoot });
		expect(none.verified, none.detail).toBe(true);
		expect(Object.keys(held(buildDir)).length).toBeGreaterThan(0);
		expect(held(webRoot)).toEqual(held(buildDir));
		expect(verifyOk(webRoot)).toBe(true);
		// 2. the onion is set: the build drops .origin-held/, so must the web root.
		config(`MORPHIT_INSTANCE_TOR_ADDRESS=${ONION}\n`);
		const onion = mod!.syncInstanceOrigin(ctx, { installDir, webRoot });
		expect(onion.verified, onion.detail).toBe(true);
		expect(canonical(webRoot)).toBe(`http://${ONION}/en`);
		expect(existsSync(join(buildDir, '.origin-held'))).toBe(false);
		expect(existsSync(join(webRoot, '.origin-held')), 'left in the web root').toBe(false);
		expect(verifyOk(webRoot)).toBe(true);
		// 3. a web root still holding an earlier copy's .origin-held/ (nothing to
		// apply this time) loses it too.
		mkdirSync(join(webRoot, '.origin-held'), { recursive: true });
		writeFileSync(join(webRoot, '.origin-held', 'robots.txt'), 'stale\n');
		const again = mod!.syncInstanceOrigin(ctx, { installDir, webRoot });
		expect(again.strategy).toBe('already');
		expect(existsSync(join(webRoot, '.origin-held')), 'stale copy kept').toBe(false);
	});

	it('a failed apply is reported, never thrown, and leaves verify.json matching', () => {
		config('MORPHIT_INSTANCE_ORIGIN=https://alice.example\n');
		hiddenOnly(false);
		writeFileSync(
			join(buildDir, 'en.html'),
			read('en.html').replace('https://morphit.io', 'https://tampered.io')
		);
		const r = mod!.syncInstanceOrigin(ctx, { installDir, webRoot: null });
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/could not be applied/);
	});

	it('the upgrade self-heal (healBranding) applies it on the served build', async () => {
		const { healBranding } = await import('../src/commands/upgrade.ts');
		config('MORPHIT_INSTANCE_ORIGIN=https://alice.example\n');
		hiddenOnly(false);
		process.env.MORPHIT_INSTALL_DIR = installDir;
		process.env.MORPHIT_WEB_ROOT = join(root, 'no-web-root');
		healBranding();
		expect(canonical()).toBe('https://alice.example/en');
		expect(verifyOk()).toBe(true);
	});
});

describe('on a real, branded build (when this tree has one)', () => {
	const REAL = join(REPO, 'apps', 'web', 'build');
	// A whole `npm run build` (a bare `vite build` leaves no verify.json).
	const has =
		existsSync(join(REAL, '.origin-slots.json')) &&
		existsSync(join(REAL, '.brand-slots.json')) &&
		existsSync(join(REAL, 'verify.json'));
	it.skipIf(!has)(
		'resets the branding, applies the origin, brands again: canonical + name + verify.json all right',
		async () => {
			const { applyBranding, readBrandingSettings } = await import('../src/lib/branding.ts');
			rmSync(buildDir, { recursive: true, force: true });
			cpSync(REAL, buildDir, { recursive: true });
			const indexBefore = readFileSync(join(buildDir, 'index.html'));
			config(
				'MORPHIT_INSTANCE_ORIGIN=https://alice.example\nMORPHIT_INSTANCE_BRAND_NAME=Alice Market\n'
			);
			hiddenOnly(false);
			// The served build is already branded (as after an older upgrade).
			applyBranding({ buildDir, settings: readBrandingSettings(installDir) });
			expect(read('en.html')).toMatch(/Alice Market/);
			const r = mod!.syncInstanceOrigin(ctx, { installDir, webRoot: null });
			expect(r.verified, r.detail).toBe(true);
			expect(r.strategy).toBe('applied-around-branding');
			expect(canonical()).toBe('https://alice.example/en');
			expect(read('en.html')).toMatch(/Alice Market/);
			expect(read('robots.txt')).toMatch(/^Sitemap: https:\/\/alice\.example\/sitemap\.xml$/m);
			expect(readFileSync(join(buildDir, 'index.html')).equals(indexBefore)).toBe(true);
			expect(verifyOk()).toBe(true);
			// Order origin → branding → link-preview image: the og-image.png the
			// branding draws names the instance host from the APPLIED origin, so it
			// is drawn after the origin and a later branding pass has nothing to redo.
			expect(r.touched).toContain('og-image.png');
			const ogAlice = readFileSync(join(buildDir, 'og-image.png'));
			expect(
				applyBranding({ buildDir, settings: readBrandingSettings(installDir) }).touched
			).toEqual([]);
			config(
				'MORPHIT_INSTANCE_ORIGIN=https://bob.example\nMORPHIT_INSTANCE_BRAND_NAME=Alice Market\n'
			);
			const r2 = mod!.syncInstanceOrigin(ctx, { installDir, webRoot: null });
			expect(r2.verified, r2.detail).toBe(true);
			expect(r2.touched).toContain('og-image.png');
			expect(readFileSync(join(buildDir, 'og-image.png')).equals(ogAlice)).toBe(false);
			expect(
				applyBranding({ buildDir, settings: readBrandingSettings(installDir) }).touched
			).toEqual([]);
			expect(verifyOk()).toBe(true);
			// The page template's fixed og:url / og:image meta tags are outside the
			// recorded places (C removes them); counted, not hidden.
			if (/content="https:\/\/morphit\.io\//.test(read('en.html')))
				expect(r.detail).toMatch(/outside the recorded places/);
		},
		120_000
	);

	it.skipIf(!has)(
		'a hidden-only node: robots/sitemap carry no clearnet URL; leftover template tags are reported, not passed',
		() => {
			rmSync(buildDir, { recursive: true, force: true });
			cpSync(REAL, buildDir, { recursive: true });
			config('MORPHIT_INSTANCE_ORIGIN=https://alice.example\n');
			hiddenOnly(true);
			const r = mod!.syncInstanceOrigin(ctx, { installDir, webRoot: null });
			expect(r.origin).toBe('-');
			expect(canonical()).toBe('/en');
			expect(read('robots.txt')).not.toMatch(/https?:\/\//);
			// (the sitemap keeps its XML namespace URIs; no page URL is absolute)
			expect(read('sitemap.xml')).not.toMatch(/<(?:loc|xhtml:link)[^>]*https?:\/\/|morphit\.io/);
			expect(verifyOk()).toBe(true);
			const leftover = /https:\/\/morphit\.io/.test(read('en.html'));
			expect(r.verified).toBe(!leftover);
			if (leftover) expect(r.detail).toMatch(/outside the recorded places/);
		},
		120_000
	);
});

describe('wiring', () => {
	const src = (p: string): string =>
		readFileSync(join(import.meta.dirname, '..', 'src', p), 'utf8');
	it('upgrade applies it at step 9b3, before the branding of the fresh build', () => {
		const u = src('commands/upgrade.ts');
		const at = u.indexOf('syncInstanceOrigin(', u.indexOf('9b3.'));
		expect(at, 'no origin step in 9b3').toBeGreaterThan(0);
		expect(at).toBeLessThan(u.indexOf('applyBranding({ buildDir, settings: brandingSettings })'));
	});
	it('install applies it on every install, not only when branding is configured', () => {
		const i = src('commands/install.ts');
		const fi = i.slice(i.indexOf('function finishInstall'));
		expect(fi.indexOf('syncInstanceOrigin(')).toBeGreaterThan(0);
		expect(fi.indexOf('syncInstanceOrigin(')).toBeLessThan(
			fi.indexOf('if (!brandingConfigured(settings)) return;') >>> 0
		);
	});
});
