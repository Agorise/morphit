/**
 * Every prerendered page's og:url, og:image and twitter:image come from
 * Head.svelte, built for the build origin and marked so that morphit-ops can
 * point them at the instance's own origin: render Head on the server as
 * prerender does, run the page through the build's origin recording and an
 * instance's apply step, and read the tags back.
 *
 * HEAD_COMPONENT (env) renders another copy of Head.svelte — used by
 * apps/web/scripts/og-fallback-meta-smoke.ts to prove this fails when Head
 * stops emitting a tag.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readable } from 'svelte/store';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false, dev: false, building: true, version: 't' }));
vi.mock('$app/stores', () => ({
	// What prerender passes: SvelteKit's placeholder origin, never the site's.
	page: readable({
		url: new URL('http://sveltekit-prerender/en/faq'),
		params: { lang: 'en' },
		data: { lang: 'en' }
	})
}));
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string) => k),
	locale: readable('en')
}));
vi.mock('$stores/instance', () => ({
	instance: readable({ name: '', seo: null, alt_networks: {} })
}));
vi.mock('$lib/notifications/ambient', () => ({ setBaseTitle: () => {} }));

interface OriginSlots {
	recordOriginSlots: (dir: string, origin: string, log?: (s: string) => void) => unknown;
	applyInstanceOrigin: (dir: string, origin: string | null) => { changed: boolean };
}

const MARK = String.fromCharCode(0x2063);
const BUILD_ORIGIN = __MORPHIT_SITE_ORIGIN__;
const ONION = 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion';

let head = '';
let slots: OriginSlots;
const dirs: string[] = [];

beforeAll(async () => {
	const { render } = await import('svelte/server');
	const path = process.env.HEAD_COMPONENT ?? './Head.svelte';
	const { default: Head } = (await import(/* @vite-ignore */ path)) as {
		default: Parameters<typeof render>[0];
	};
	head = render(Head, { props: { routeKey: 'faq' } as never }).head;
	slots = (await import(
		/* @vite-ignore */ '../../../scripts/origin-slots.mjs' as string
	)) as OriginSlots;
});
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tag = (html: string, attr: 'property' | 'name', key: string): string | null => {
	const m = new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html);
	return m ? m[1]! : null;
};

/** The page as an instance serves it: recorded at build, applied at install. */
function servedAs(origin: string | null): string {
	const root = mkdtempSync(join(tmpdir(), 'head-ssr-'));
	dirs.push(root);
	const build = join(root, 'build');
	mkdirSync(join(build, 'en'), { recursive: true });
	writeFileSync(join(build, 'index.html'), '<!doctype html><html><head></head></html>');
	writeFileSync(join(build, 'en/faq.html'), `<!doctype html><html><head>${head}</head></html>`);
	slots.recordOriginSlots(build, BUILD_ORIGIN, () => {});
	slots.applyInstanceOrigin(build, origin);
	return readFileSync(join(build, 'en/faq.html'), 'utf8');
}

describe('Head.svelte on a prerendered page', () => {
	it('emits og:url, og:image and twitter:image on the (marked) build origin', () => {
		expect(tag(head, 'property', 'og:url')).toBe(`${MARK}${BUILD_ORIGIN}${MARK}/en/faq`);
		expect(tag(head, 'property', 'og:image')).toBe(`${MARK}${BUILD_ORIGIN}${MARK}/og-image.png`);
		expect(tag(head, 'name', 'twitter:image')).toBe(`${MARK}${BUILD_ORIGIN}${MARK}/og-image.png`);
		expect(head).not.toContain('sveltekit-prerender');
	});

	it('an instance serves them on its own origin, and a hidden-only one names no clearnet site', () => {
		const page = servedAs(ONION);
		expect(tag(page, 'property', 'og:url')).toBe(`${ONION}/en/faq`);
		expect(tag(page, 'property', 'og:image')).toBe(`${ONION}/og-image.png`);
		expect(tag(page, 'name', 'twitter:image')).toBe(`${ONION}/og-image.png`);
		expect(page).not.toContain(BUILD_ORIGIN);
		expect(page).not.toMatch(/https:\/\//);
		expect(page).not.toContain(MARK);
	});

	it('the release build itself serves them on the build origin', () => {
		const page = servedAs(BUILD_ORIGIN);
		expect(tag(page, 'property', 'og:url')).toBe(`${BUILD_ORIGIN}/en/faq`);
		expect(tag(page, 'name', 'twitter:image')).toBe(`${BUILD_ORIGIN}/og-image.png`);
	});
});
