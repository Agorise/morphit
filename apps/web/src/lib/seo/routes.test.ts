import { describe, it, expect } from 'vitest';
import { ROUTES, INDEXABLE_ROUTES, routeFor } from './routes';

// Import the canonical en.json at test time to verify every route
// has matching seo.<key>.* entries. Other locales are checked for
// parity separately by the i18n parity script; we don't duplicate
// that here.
import en from '../i18n/locales/en.json';

describe('seo/routes — registry integrity', () => {
	it('every route has a non-empty path and key', () => {
		for (const r of ROUTES) {
			expect(r.path.length).toBeGreaterThan(0);
			expect(r.key.length).toBeGreaterThan(0);
		}
	});

	it('keys are unique across all routes', () => {
		const keys = ROUTES.map((r) => r.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('paths are unique across all routes', () => {
		const paths = ROUTES.map((r) => r.path);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it('priorities are in [0.0, 1.0]', () => {
		for (const r of ROUTES) {
			expect(r.priority).toBeGreaterThanOrEqual(0);
			expect(r.priority).toBeLessThanOrEqual(1);
		}
	});

	it('changefreq is one of the documented values', () => {
		const allowed = new Set(['daily', 'weekly', 'monthly', 'yearly']);
		for (const r of ROUTES) {
			expect(allowed.has(r.changefreq)).toBe(true);
		}
	});
});

describe('seo/routes — i18n coverage', () => {
	it('every route key has seo.<key>.title in en.json', () => {
		const seo = (en as Record<string, unknown>).seo as Record<
			string,
			{ title: string; description: string } | undefined
		>;
		expect(seo).toBeDefined();
		for (const r of ROUTES) {
			const entry = seo[r.key];
			expect(entry, `missing seo.${r.key} for path ${r.path}`).toBeDefined();
			expect(entry!.title.length).toBeGreaterThan(0);
		}
	});

	it('every route key has seo.<key>.description in en.json', () => {
		const seo = (en as Record<string, unknown>).seo as Record<
			string,
			{ title: string; description: string } | undefined
		>;
		for (const r of ROUTES) {
			const entry = seo[r.key];
			expect(entry!.description.length).toBeGreaterThan(0);
		}
	});

	it('every seo.<key>.* entry in en.json has a matching ROUTES entry', () => {
		// Catches the reverse drift — if someone adds a seo key to
		// the i18n file but forgets to register the route.
		const seo = (en as Record<string, unknown>).seo as Record<string, unknown>;
		const routeKeys = new Set(ROUTES.map((r) => r.key));
		const metaKeys = new Set(['site_name', 'og_image_alt']);
		for (const k of Object.keys(seo)) {
			if (metaKeys.has(k)) continue;
			expect(routeKeys.has(k), `seo.${k} in en.json has no matching ROUTES entry`).toBe(true);
		}
	});
});

describe('seo/routes — indexability rules', () => {
	it('INDEXABLE_ROUTES is the filtered subset of ROUTES', () => {
		expect(INDEXABLE_ROUTES.length).toBeLessThanOrEqual(ROUTES.length);
		for (const r of INDEXABLE_ROUTES) {
			expect(r.indexable).toBe(true);
			expect(ROUTES.includes(r)).toBe(true);
		}
	});

	it('every indexable dynamic route is expandable by the sitemap builder', () => {
		// SvelteKit dynamic route patterns (path contains `[`) have
		// an unbounded URL space at SvelteKit level, but the sitemap
		// builder CAN expand specific segments to concrete values from
		// a registry.  Today only `[asset]` is supported (expands to
		// every tradable ticker from packages/asset-registry).
		//
		// This test enforces: if a dynamic route is marked indexable,
		// the sitemap builder MUST know how to expand its segment.
		// Adding a new dynamic-segment indexable route requires also
		// adding a case to expandRoutes() in scripts/build-sitemap.mjs
		// and updating this allowlist.  cp117 A7 added `[asset]`.
		const EXPANDABLE_SEGMENTS: readonly string[] = ['[asset]'];

		for (const r of ROUTES) {
			if (!r.path.includes('[')) continue;
			if (!r.indexable) continue;
			// Find which dynamic segments this route contains
			const segments = (r.path.match(/\[[^\]]+\]/g) ?? []);
			for (const seg of segments) {
				expect(
					EXPANDABLE_SEGMENTS.includes(seg),
					`indexable dynamic route ${r.path} contains segment ${seg} but the sitemap builder doesn't know how to expand it; either flip indexable to false or add an expansion case to scripts/build-sitemap.mjs and to EXPANDABLE_SEGMENTS above`
				).toBe(true);
			}
		}
	});

	it('has at least one indexable route (home)', () => {
		expect(INDEXABLE_ROUTES.length).toBeGreaterThan(0);
		const home = INDEXABLE_ROUTES.find((r) => r.path === '/');
		expect(home).toBeDefined();
		expect(home!.priority).toBe(1.0);
	});
});

describe('routeFor — path lookup', () => {
	it('finds an exact match', () => {
		expect(routeFor('/')?.key).toBe('home');
		expect(routeFor('/faq')?.key).toBe('faq');
	});

	it('normalizes a trailing slash', () => {
		expect(routeFor('/faq/')?.key).toBe('faq');
	});

	it('returns undefined for unknown paths', () => {
		expect(routeFor('/this-page-does-not-exist')).toBeUndefined();
		expect(routeFor('/faq/random-subpath')).toBeUndefined();
	});

	it('does not attempt dynamic parameter matching', () => {
		// /alice is a real dynamic route (profile) but routeFor
		// doesn't try to recognize it because the route pattern has
		// brackets. Callers that need dynamic matching should use
		// $page.route.id instead.
		expect(routeFor('/alice')).toBeUndefined();
	});
});
