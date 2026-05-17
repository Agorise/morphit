#!/usr/bin/env node
/**
 * Morphit — sitemap builder.
 *
 * Writes apps/web/static/sitemap.xml with every indexable route × every
 * supported locale, using xhtml:link alternate hreflang tags per
 * https://developers.google.com/search/docs/specialty/international/localized-versions
 *
 * Called from `npm run build` via a prebuild step.
 *
 * This script is intentionally dependency-free (std Node only) so that
 * `npm install` failures on the CI runner don't block the sitemap.
 *
 * Route data is duplicated from `src/lib/seo/routes.ts` because Node
 * can't import `.ts` without a build step and adding one for this
 * single-file script is worse than the duplication. We close the
 * drift risk with a CONSISTENCY CHECK at the top of main() — the
 * script reads the .ts file as text, extracts the indexable routes,
 * and fails the build if they don't match the ROUTES array below.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATIC_DIR = resolve(__dirname, '../apps/web/static');
const OUT_PATH = resolve(STATIC_DIR, 'sitemap.xml');
const ROUTES_TS_PATH = resolve(__dirname, '../apps/web/src/lib/seo/routes.ts');

const ORIGIN = 'https://morphit.io';
const DEFAULT_LOCALE = 'en';

// Duplicated from src/lib/seo/routes.ts — see module doc-comment.
// Must stay in sync with the INDEXABLE_ROUTES subset of ROUTES in
// that file. assertRoutesInSync() below verifies at build time.
const LOCALES = ['en', 'es', 'de', 'pl', 'fr', 'it', 'ru', 'fa', 'zh-CN', 'zh-HK'];

const ROUTES = [
	{ path: '/', priority: 1.0, changefreq: 'weekly' },
	{ path: '/orderbook', priority: 0.9, changefreq: 'daily' },
	{ path: '/faq', priority: 0.9, changefreq: 'weekly' },
	{ path: '/onboarding', priority: 0.8, changefreq: 'monthly' },
	{ path: '/download', priority: 0.7, changefreq: 'weekly' },
	{ path: '/run-a-node', priority: 0.7, changefreq: 'monthly' },
	{ path: '/operators', priority: 0.6, changefreq: 'weekly' },
	{ path: '/security', priority: 0.6, changefreq: 'monthly' },
	{ path: '/support', priority: 0.5, changefreq: 'monthly' },
	{ path: '/about-this-instance', priority: 0.5, changefreq: 'weekly' },
	{ path: '/instances', priority: 0.5, changefreq: 'weekly' },
	{ path: '/compare', priority: 0.5, changefreq: 'weekly' },
	{ path: '/backup-keys', priority: 0.5, changefreq: 'monthly' },
	{ path: '/privacy-terms', priority: 0.4, changefreq: 'yearly' },
	{ path: '/plan', priority: 0.4, changefreq: 'monthly' },
	{ path: '/glossary', priority: 0.6, changefreq: 'monthly' },
	{ path: '/cheat-sheet', priority: 0.5, changefreq: 'monthly' },
	{ path: '/privacy', priority: 0.6, changefreq: 'monthly' }
];

/**
 * Parse routes.ts as text, extract the indexable route set, and
 * assert it matches the ROUTES array above. This is a guard against
 * silent drift — if someone adds a new indexable route to routes.ts
 * but forgets to update this script, the build fails with a clear
 * error rather than silently shipping a sitemap missing that route.
 *
 * The parser is deliberately dumb — a regex over the source text.
 * It doesn't need to handle arbitrary TypeScript; it just needs to
 * read the ROUTES array we wrote. If someone refactors routes.ts
 * heavily, this parser may need to be refactored too. That's fine
 * — the test harness forces the conversation.
 */
function assertRoutesInSync() {
	const src = readFileSync(ROUTES_TS_PATH, 'utf8');
	// Match each object literal inside ROUTES = [ ... ]. Each entry
	// is one line of `{ path: '...', key: '...', indexable: true/false, priority: N, changefreq: '...' },`
	const re =
		/\{\s*path:\s*'([^']+)'\s*,\s*key:\s*'[^']+'\s*,\s*indexable:\s*(true|false)\s*,\s*priority:\s*([\d.]+)\s*,\s*changefreq:\s*'([^']+)'\s*\}/g;
	const parsed = [];
	let m;
	while ((m = re.exec(src)) !== null) {
		const [, path, indexable, priority, changefreq] = m;
		if (indexable === 'true') {
			parsed.push({
				path,
				priority: parseFloat(priority),
				changefreq
			});
		}
	}
	if (parsed.length === 0) {
		throw new Error(
			'build-sitemap: parsed zero indexable routes from routes.ts. '
				+ 'The parser may be out of date with the file shape.'
		);
	}
	// Compare: same paths, in the same order, with same priority+changefreq.
	if (parsed.length !== ROUTES.length) {
		throw new Error(
			`build-sitemap: drift — routes.ts has ${parsed.length} indexable `
				+ `routes but this script has ${ROUTES.length}. Synchronize the `
				+ `ROUTES array in scripts/build-sitemap.mjs with INDEXABLE_ROUTES `
				+ `in apps/web/src/lib/seo/routes.ts.`
		);
	}
	for (let i = 0; i < parsed.length; i++) {
		const a = parsed[i];
		const b = ROUTES[i];
		if (a.path !== b.path || a.priority !== b.priority || a.changefreq !== b.changefreq) {
			throw new Error(
				`build-sitemap: drift at index ${i} — routes.ts has `
					+ `${JSON.stringify(a)} but this script has ${JSON.stringify(b)}. `
					+ `Synchronize the two.`
			);
		}
	}
}

function localizedUrl(path, locale) {
	// Per-locale URL prefix structure (post per-locale prerendering):
	//   '/'          → bare path; ships a detection-redirect shell
	//   '/en/'       → English prerendered
	//   '/es/...'    → Spanish prerendered
	//   '/zh-CN/...' → Simplified Chinese prerendered
	// Every locale including the default ('en') gets a prefix so the
	// URL structure is symmetric. The bare path is reserved for the
	// client-side redirect shell.
	const prefixed = path === '/' ? `/${locale}/` : `/${locale}${path}`;
	return `${ORIGIN}${prefixed}`;
}

function xmlEscape(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function buildSitemap() {
	const today = new Date().toISOString().slice(0, 10);
	const lines = [];
	lines.push('<?xml version="1.0" encoding="UTF-8"?>');
	lines.push('<urlset');
	lines.push('\txmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
	lines.push('\txmlns:xhtml="http://www.w3.org/1999/xhtml">');

	for (const route of ROUTES) {
		// Emit one <url> per locale × route. Each <url> carries the full
		// set of alternates (xhtml:link) pointing at every other locale
		// of the same route, plus x-default pointing at the canonical
		// English URL.
		for (const locale of LOCALES) {
			const loc = localizedUrl(route.path, locale);
			lines.push('\t<url>');
			lines.push(`\t\t<loc>${xmlEscape(loc)}</loc>`);
			lines.push(`\t\t<lastmod>${today}</lastmod>`);
			lines.push(`\t\t<changefreq>${route.changefreq}</changefreq>`);
			lines.push(`\t\t<priority>${route.priority.toFixed(1)}</priority>`);
			for (const other of LOCALES) {
				const otherUrl = localizedUrl(route.path, other);
				lines.push(
					`\t\t<xhtml:link rel="alternate" hreflang="${other}" href="${xmlEscape(otherUrl)}"/>`
				);
			}
			lines.push(
				`\t\t<xhtml:link rel="alternate" hreflang="x-default" href="${xmlEscape(
					`${ORIGIN}${route.path}`
				)}"/>`
			);
			lines.push('\t</url>');
		}
	}

	lines.push('</urlset>');
	return lines.join('\n') + '\n';
}

function main() {
	assertRoutesInSync();
	mkdirSync(STATIC_DIR, { recursive: true });
	const xml = buildSitemap();
	writeFileSync(OUT_PATH, xml, 'utf-8');
	const urlCount = (xml.match(/<url>/g) || []).length;
	console.log(`sitemap: ${urlCount} URLs written to ${OUT_PATH}`);
}

main();
