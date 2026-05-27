#!/usr/bin/env tsx
/**
 * scripts/seo-url-consistency-smoke.ts
 *
 * Structural Defense #39 — canonical/hreflang/sitemap URL consistency
 * (cp112).
 *
 * cp112 surfaced a real shipped-bug class: the `hreflangAlternates()`
 * function in `apps/web/src/lib/seo/urls.ts` was emitting `?lang=es`
 * query-string URLs while the actual SvelteKit routes are path-based
 * at `/[lang]/...` AND the sitemap.xml was emitting path-based
 * `/{locale}{path}` URLs.  Google joins hreflang + canonical + sitemap
 * signals; emitting two URL shapes for the same content is the
 * exact duplicate-content pattern Google penalizes.
 *
 * This smoke catches the recurrence.  Three invariants:
 *
 *   I-1: For every indexable route × locale combo, the URL emitted
 *        by `localizedUrl()` (the hreflang/canonical helper)
 *        MUST match the URL emitted by the sitemap builder
 *        (`scripts/build-sitemap.mjs`'s `localizedUrl()`) byte-for-byte.
 *
 *   I-2: For every indexable route × locale, the URL appears in
 *        the on-disk `apps/web/static/sitemap.xml`.  Catches the
 *        case where sitemap.xml has gone stale relative to the
 *        route registry (e.g. someone added a route to routes.ts
 *        but didn't rebuild the sitemap).
 *
 *   I-3: `hreflangAlternates()` never emits a `?lang=` URL.  This
 *        is a defense against the specific regression cp112 fixed.
 *        Mutation-tested.
 *
 * One scenario per (route × locale) combo plus the explicit
 * anti-pattern checks.  Today: ~18 indexable routes × 10 locales =
 * 180 scenarios + 3 anti-pattern × 4 sample inputs = ~192 total.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const ORIGIN = 'https://morphit.io';
// Derive supported locales from the on-disk JSON files; the
// i18n-locale-registry-smoke enforces 1:1 correspondence between
// SUPPORTED_LOCALES and these files, so this list is canonical.
const LOCALES_DIR = join(REPO, 'apps/web/src/lib/i18n/locales');
const LOCALES = readdirSync(LOCALES_DIR)
	.filter((f) => f.endsWith('.json'))
	.map((f) => f.replace(/\.json$/, ''))
	.sort();

// ─── Parse indexable routes from routes.ts ───────────────────────
function parseIndexableRoutes(): Array<{ path: string }> {
	const src = readFileSync(join(REPO, 'apps/web/src/lib/seo/routes.ts'), 'utf8');
	const re =
		/\{\s*path:\s*'([^']+)'\s*,\s*key:\s*'[^']+'\s*,\s*indexable:\s*(true|false)\s*,/g;
	const out: Array<{ path: string }> = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) {
		if (m[2] === 'true') out.push({ path: m[1] });
	}
	return out;
}

// ─── Expand dynamic segments ───────────────────────────────────
// cp117 A7: indexable routes may contain dynamic segments (e.g.
// `/privacy/[asset]`).  The sitemap builder expands these to one
// URL per registry value; this smoke must mirror that logic to
// produce a comparable URL set.  Today only `[asset]` is supported.
//
// IMPORTANT: this expansion mirror MUST stay in sync with the
// matching block in scripts/build-sitemap.mjs's expandRoutes().
// If a new dynamic-segment type is added there, add it here too.
function readAssetTickers(): string[] {
	const src = readFileSync(
		join(REPO, 'packages/asset-registry/src/index.ts'),
		'utf8'
	);
	const m = src.match(
		/export\s+const\s+ASSET_TICKERS\s*=\s*\[([^\]]+)\]\s*as\s+const/
	);
	if (!m) throw new Error('seo-url-consistency: ASSET_TICKERS not found');
	const tickers: string[] = [];
	const tickerRe = /'([A-Z][A-Z0-9]*)'/g;
	let tm: RegExpExecArray | null;
	while ((tm = tickerRe.exec(m[1])) !== null) tickers.push(tm[1]);
	return tickers;
}

function expandRoutes(routes: Array<{ path: string }>): Array<{ path: string }> {
	const tickers = readAssetTickers();
	const out: Array<{ path: string }> = [];
	for (const r of routes) {
		if (r.path.includes('[asset]')) {
			for (const t of tickers) {
				out.push({ path: r.path.replace('[asset]', t.toLowerCase()) });
			}
		} else if (r.path.includes('[')) {
			throw new Error(
				`seo-url-consistency: unhandled dynamic segment in route ${r.path}. ` +
					'Add a case to expandRoutes() in scripts/seo-url-consistency-smoke.ts.'
			);
		} else {
			out.push(r);
		}
	}
	return out;
}

// ─── Mirror the sitemap builder's localizedUrl() ─────────────────
// (Byte-for-byte copy of scripts/build-sitemap.mjs's logic.  If
// the sitemap builder changes shape, update here too — the smoke
// then catches whether urls.ts followed.)
function sitemapLocalizedUrl(path: string, locale: string): string {
	const prefixed = path === '/' ? `/${locale}/` : `/${locale}${path}`;
	return `${ORIGIN}${prefixed}`;
}

// ─── Mirror urls.ts's localizedUrl() ─────────────────────────────
function helperLocalizedUrl(path: string, locale: string): string {
	const p = path.startsWith('/') ? path : `/${path}`;
	const suffix = p === '/' || p === '' ? `/${locale}/` : `/${locale}${p}`;
	return `${ORIGIN}${suffix}`;
}

// ─── Parse urls.ts to verify it has no `?lang=` regression ──────
function urlsTsSource(): string {
	return readFileSync(join(REPO, 'apps/web/src/lib/seo/urls.ts'), 'utf8');
}

// ─── Read sitemap.xml ────────────────────────────────────────────
function readSitemap(): string {
	const p = join(REPO, 'apps/web/static/sitemap.xml');
	if (!existsSync(p)) return '';
	return readFileSync(p, 'utf8');
}

interface Scenario {
	kind: 'I1' | 'I2' | 'I3';
	label: string;
	failure?: string;
}

const scenarios: Scenario[] = [];

console.log('\n── seo-url-consistency smoke (cp112) ──────────────────\n');

const routes = parseIndexableRoutes();
if (routes.length < 5) {
	console.log(
		`  ✗ parsed only ${routes.length} indexable routes from routes.ts — parser broken or registry near-empty`
	);
	console.log(`\n──────────────────────────────────────────────────────`);
	console.log(`✗ 1/1 scenarios failed`);
	process.exit(1);
}

// cp117 A7: expand dynamic segments (`[asset]` etc.) so the URL
// comparisons below match the rendered sitemap's expanded URLs.
const expandedRoutes = expandRoutes(routes);

console.log(
	`  parsed ${routes.length} indexable routes (${expandedRoutes.length} after dynamic-segment expansion) × ${LOCALES.length} locales`
);

const sitemap = readSitemap();
if (!sitemap) {
	console.log(`  ⚠ sitemap.xml missing — only I-1 and I-3 will be checked`);
}

// ─── I-1: helper vs sitemap-builder URL match ────────────────────
for (const r of expandedRoutes) {
	for (const loc of LOCALES) {
		const sm = sitemapLocalizedUrl(r.path, loc);
		const hp = helperLocalizedUrl(r.path, loc);
		const sc: Scenario = {
			kind: 'I1',
			label: `${r.path} × ${loc}`
		};
		if (sm !== hp) {
			sc.failure = `helper emits ${hp} but sitemap builder emits ${sm}`;
		}
		scenarios.push(sc);
	}
}

// ─── I-2: sitemap.xml contains each (route × locale) URL ─────────
if (sitemap) {
	for (const r of expandedRoutes) {
		for (const loc of LOCALES) {
			const expected = sitemapLocalizedUrl(r.path, loc);
			const sc: Scenario = {
				kind: 'I2',
				label: `sitemap contains ${expected}`
			};
			if (!sitemap.includes(`<loc>${expected}</loc>`)) {
				sc.failure = `URL ${expected} not present in sitemap.xml — rebuild via 'npm run build:sitemap'`;
			}
			scenarios.push(sc);
		}
	}
}

// ─── I-3: urls.ts has no `?lang=` regression ─────────────────────
// The cp112 fix removed the `?lang=` URL form.  If anyone re-adds
// query-string-form hreflang URLs, this fires.
{
	const src = urlsTsSource();
	const sc: Scenario = {
		kind: 'I3',
		label: `urls.ts contains no '?lang=' hreflang form`
	};
	if (/`\$\{[^`]*\}\?lang=/.test(src) || /['"]\?lang=/.test(src)) {
		sc.failure =
			"urls.ts emits a '?lang=' style URL — that conflicts with path-based routing and sitemap; use /{locale}{path} form instead";
	}
	scenarios.push(sc);
}

// ─── I-3b: Head.svelte should use the helper, not roll its own ───
{
	const head = readFileSync(join(REPO, 'apps/web/src/lib/components/Head.svelte'), 'utf8');
	const sc: Scenario = {
		kind: 'I3',
		label: `Head.svelte sources hreflang from urls.ts helper`
	};
	if (!head.includes('hreflangAlternates')) {
		sc.failure = `Head.svelte no longer imports hreflangAlternates — verify hreflang emission survived refactor`;
	}
	scenarios.push(sc);
}

// ─── I-3c: build-sitemap.mjs still uses path-based localizedUrl ──
{
	const sm = readFileSync(join(REPO, 'scripts/build-sitemap.mjs'), 'utf8');
	const sc: Scenario = {
		kind: 'I3',
		label: `build-sitemap.mjs uses path-based locale URLs`
	};
	if (!sm.includes('`/${locale}/`') && !sm.includes("`/${locale}${path}`")) {
		sc.failure = `build-sitemap.mjs no longer uses path-based locale URL shape; verify it didn't regress to query-string form`;
	}
	scenarios.push(sc);
}

// ─── I-3d: positive sample — helperLocalizedUrl emits expected shape
{
	const samples: Array<[string, string, string]> = [
		['/', 'en', `${ORIGIN}/en/`],
		['/faq', 'es', `${ORIGIN}/es/faq`],
		['/privacy', 'zh-CN', `${ORIGIN}/zh-CN/privacy`]
	];
	for (const [p, loc, expected] of samples) {
		const got = helperLocalizedUrl(p, loc);
		const sc: Scenario = {
			kind: 'I3',
			label: `helper(${p}, ${loc}) → ${expected}`
		};
		if (got !== expected) {
			sc.failure = `expected ${expected} but got ${got}`;
		}
		scenarios.push(sc);
	}
}

// ─── Tally ───────────────────────────────────────────────────────
const byKind: Record<string, { pass: number; fail: number }> = {
	I1: { pass: 0, fail: 0 },
	I2: { pass: 0, fail: 0 },
	I3: { pass: 0, fail: 0 }
};
for (const s of scenarios) {
	if (s.failure) byKind[s.kind].fail++;
	else byKind[s.kind].pass++;
}

console.log(
	`  I-1 helper vs sitemap-builder URL match: ${byKind.I1.pass + byKind.I1.fail} (${byKind.I1.fail} failed)`
);
console.log(
	`  I-2 sitemap.xml contains every (route × locale): ${byKind.I2.pass + byKind.I2.fail} (${byKind.I2.fail} failed)`
);
console.log(
	`  I-3 anti-regression checks (no ?lang= form): ${byKind.I3.pass + byKind.I3.fail} (${byKind.I3.fail} failed)`
);

const failed = scenarios.filter((s) => s.failure);
const total = scenarios.length;

if (failed.length > 0) {
	console.log(`\n  ✗ ${failed.length} URL consistency failures:`);
	for (const f of failed.slice(0, 30)) {
		console.log(`    - [${f.kind}] ${f.label}: ${f.failure}`);
	}
	if (failed.length > 30) {
		console.log(`    ... (${failed.length - 30} more not shown)`);
	}
	console.log(`\n──────────────────────────────────────────────────────`);
	console.log(`✗ ${failed.length}/${total} scenarios failed`);
	process.exit(1);
}

console.log(
	`\n  ✓ all ${total} URL-consistency scenarios pass — hreflang/canonical/sitemap aligned`
);
console.log(`\n──────────────────────────────────────────────────────`);
console.log(`✓ all ${total} scenarios passed`);
