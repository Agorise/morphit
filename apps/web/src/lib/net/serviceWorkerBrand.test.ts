/**
 * The service worker's answer to a brand-file request (answerBrandRequest, the
 * whole of what src/service-worker.ts does for one), driven with real Request
 * objects, a cache and a network. A branded site
 * must never show Morphit's look (v1.21.8): a brand file stored before the
 * site was branded is never handed out while the server answers.
 *
 * (The pure helpers are covered in brandResponse.test.ts; this proves the
 * request path is wired to them the right way round.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SITE_LOGO_SRC, SITE_LOGO_FOOTER_SRC } from '$lib/brand/brandAssets';
import { answerBrandRequest, isBrandOverridablePath } from './dynamicPaths';

const ORIGIN = 'https://site.example';
/** A Cache like the browser's: entries keyed by full URL, put() replaces
 *  only the same URL, match() with ignoreSearch returns the FIRST entry whose
 *  path matches. */
const stored = new Map<string, Response>();
let network: (req: Request, init?: RequestInit) => Promise<Response>;
const pathOf = (u: string): string => {
	const x = new URL(u);
	return x.origin + x.pathname;
};
const cache = {
	match: async (r: Request, o?: CacheQueryOptions) => {
		for (const [k, v] of stored)
			if (o?.ignoreSearch ? pathOf(k) === pathOf(r.url) : k === r.url) return v.clone();
		return undefined;
	},
	put: async (r: Request, res: Response) => {
		stored.set(r.url, res);
	}
};

beforeEach(() => stored.clear());
afterEach(() => vi.useRealTimers());

/** A request as the page makes it: `destination` '' is a fetch() call. */
async function get(path: string, destination: string): Promise<Response> {
	const req = new Request(ORIGIN + path);
	Object.defineProperty(req, 'destination', { value: destination });
	expect(isBrandOverridablePath(new URL(req.url).pathname)).toBe(true);
	return answerBrandRequest(req, {
		cache,
		fetch: (r, init) => network(r, init),
		timeoutMs: 60_000
	});
}
const body = (r: Response) => r.text();
const morphitLogo = () => new Response('MORPHIT-LOGO', { status: 200 });
const brandedLogo = () => new Response('BRANDED-LOGO', { status: 200 });

describe('the service worker and brand files', () => {
	it('a logo stored before the site was branded is not shown while the server answers', async () => {
		stored.set(ORIGIN + '/brand/site-logo.svg', morphitLogo());
		network = async () => brandedLogo();
		expect(await body(await get(SITE_LOGO_SRC, 'image'))).toBe('BRANDED-LOGO');
		// …and the server's copy is what is stored now.
		expect(
			await stored
				.get(ORIGIN + '/brand/site-logo.svg')!
				.clone()
				.text()
		).toBe('BRANDED-LOGO');
	});

	it('the theme stylesheet too', async () => {
		stored.set(ORIGIN + '/brand/theme.css', new Response('/* empty */'));
		network = async () => new Response('html:root{--brand-name-hex:h41}');
		expect(await body(await get('/brand/theme.css', 'style'))).toContain('--brand-name-hex');
	});

	it('offline, the page gets the stored logo (also for the logo URL the page uses)', async () => {
		stored.set(ORIGIN + '/brand/site-logo.svg', brandedLogo());
		network = async () => {
			throw new TypeError('Failed to fetch');
		};
		expect(await body(await get(SITE_LOGO_SRC, 'image'))).toBe('BRANDED-LOGO');
		expect(await body(await get(SITE_LOGO_FOOTER_SRC.replace('-footer', ''), 'image'))).toBe(
			'BRANDED-LOGO'
		);
	});

	it("the app's own brand.json read (no ?fresh=1, whatever its cache mode) gets the stored copy offline", async () => {
		stored.set(ORIGIN + '/brand/brand.json', new Response('{"name":"Vigilante"}'));
		network = async () => {
			throw new TypeError('Failed to fetch');
		};
		const req = new Request(ORIGIN + '/brand/brand.json', { cache: 'no-cache' });
		Object.defineProperty(req, 'destination', { value: '' });
		const r = await answerBrandRequest(req, { cache, fetch: (x) => network(x), timeoutMs: 60_000 });
		expect(await r.text()).toContain('Vigilante');
	});

	it('a ?fresh=1 read by the app (the Blurt post) never gets the stored copy', async () => {
		stored.set(ORIGIN + '/brand/brand.json', new Response('{"name":"Morphit"}'));
		network = async () => {
			throw new TypeError('Failed to fetch');
		};
		const r = await get('/brand/brand.json?fresh=1', '');
		expect(r.status).toBe(503);
	});

	it('a server that answers with an error does not bring back a stored logo', async () => {
		for (const status of [404, 429, 503]) {
			stored.set(ORIGIN + '/brand/site-logo.svg', morphitLogo());
			network = async () => new Response('nope', { status });
			const r = await get(SITE_LOGO_SRC, 'image');
			expect(await body(r)).not.toBe('MORPHIT-LOGO');
			expect(r.status).toBe(status);
		}
	});

	it('…but a stored stylesheet is kept over an error (without it the page shows the default look)', async () => {
		stored.set(ORIGIN + '/brand/theme.css', new Response('html:root{--brand-name-hex:h41}'));
		network = async () => new Response('busy', { status: 503 });
		expect(await body(await get('/brand/theme.css', 'style'))).toContain('--brand-name-hex');
	});

	it('a stored brand.json is not handed out over an error (it may carry the colours of an older branding)', async () => {
		stored.set(
			ORIGIN + '/brand/brand.json',
			new Response('{"theme":{"tokens":{"brand-2":"#d6b26a"}}}')
		);
		for (const status of [429, 503]) {
			network = async () => new Response('busy', { status });
			const r = await get('/brand/brand.json', '');
			expect(r.status).toBe(status);
			expect(await body(r)).not.toContain('d6b26a');
		}
	});

	/** A server that takes the request and never answers (until aborted). */
	const hangs = (_r: Request, init?: RequestInit) =>
		new Promise<Response>((_, reject) =>
			init?.signal?.addEventListener('abort', () =>
				reject(new DOMException('The operation was aborted.', 'AbortError'))
			)
		);

	it("a server that never answers gets the worker's own 504 for a logo, not the stored copy", async () => {
		vi.useFakeTimers();
		stored.set(ORIGIN + '/brand/site-logo.svg', morphitLogo());
		network = hangs;
		const p = get(SITE_LOGO_SRC, 'image');
		await vi.advanceTimersByTimeAsync(60_000);
		const r = await p;
		expect(r.status).toBe(504);
		expect(await body(r)).not.toBe('MORPHIT-LOGO');
	});

	it('…while the stylesheet keeps its stored copy then', async () => {
		vi.useFakeTimers();
		stored.set(ORIGIN + '/brand/theme.css', new Response('html:root{--brand-name-hex:h41}'));
		network = hangs;
		const p = get('/brand/theme.css', 'style');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await body(await p)).toContain('--brand-name-hex');
	});

	it('the logo URLs the pages use make a v1.21.7 service worker ask the network', () => {
		// A visitor whose browser still runs v1.21.7's worker on the first page
		// after the upgrade: that worker served brand files from its stored copy
		// (stale-while-revalidate) EXCEPT a read carrying ?fresh=1, which it
		// fetched from the network. So the page's logo URLs carry it.
		for (const src of [SITE_LOGO_SRC, SITE_LOGO_FOOTER_SRC])
			expect(new URL(src, ORIGIN).searchParams.has('fresh')).toBe(true);
	});
});
