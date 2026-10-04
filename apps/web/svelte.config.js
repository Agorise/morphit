import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { processBuild } from '../../scripts/build-brand-slots.mjs';
import { externalizeInlineScripts } from './scripts/csp-externalize-scripts.mjs';

/**
 * adapter-static, then — in the same step, so EVERY `vite build` emits a clean
 * build — apps/web/scripts/csp-externalize-scripts.mjs (no inline script left:
 * see the Content-Security-Policy note in the config below) and, for
 * per-instance branding (docs/BRANDING.md), scripts/build-brand-slots.mjs:
 * record each prerendered site-name slot into build/.brand-slots.json, strip the
 * invisible slot markers, stamp the canonical <html data-brand-*> attributes and
 * re-compress the pages it changed. `morphit-ops branding apply` rewrites exactly
 * those slots on an operator's server, without rebuilding.
 * @param {import('@sveltejs/kit').Adapter} base
 * @param {string} pages
 * @returns {import('@sveltejs/kit').Adapter}
 */
function withBrandSlots(base, pages) {
	return {
		...base,
		async adapt(builder) {
			await base.adapt(builder);
			const dir = fileURLToPath(new URL(pages, import.meta.url));
			// First move every inline script into its own file (the strict
			// Content-Security-Policy below), THEN record the brand slots, whose
			// byte offsets must describe the final pages.
			externalizeInlineScripts(dir, (m) => builder.log.minor(m));
			processBuild(dir, (m) => builder.log.minor(m));
			// Last: record the site-origin slots (scripts/origin-slots.mjs) and
			// strip their markers, shifting the brand-slot offsets just written —
			// so a bare `vite build` emits clean pages too. Idempotent; the
			// `npm run build` guard's own run is then a no-op.
			// (Loaded by URL: origin-slots.mjs carries no type declarations.)
			const { recordOriginSlots } = await import(
				new URL('./scripts/origin-slots.mjs', import.meta.url).href
			);
			recordOriginSlots(
				dir,
				process.env.MORPHIT_SITE_ORIGIN || 'https://morphit.io',
				(/** @type {string} */ m) => builder.log.minor(m)
			);
		}
	};
}

// v1.11.1 — quiet ONE benign SvelteKit adapter-static warning during the
// `morphit-ops upgrade` frontend build. adapter-static prerenders the root `/`
// (the detection-redirect shell, ADR-0024) AND writes the SPA fallback to that
// same `index.html`, so SvelteKit core prints (via console.log):
//   "Overwriting …/build/index.html with fallback page. Consider using a
//    different name for the fallback."
// The overwrite is INTENTIONAL here — the fallback shell is exactly what every
// unmatched route (including `/`) should boot — so the line is noise an
// operator can't act on and, mid-upgrade, reads like something went wrong. Same
// gate + rationale as the chunk-size and npm-deprecation
// quieting: suppressed ONLY when morphit-ops sets MORPHIT_QUIET_BUILD=1. A
// developer's or CI build (no MORPHIT_QUIET_BUILD) still sees it in full.
if (process.env.MORPHIT_QUIET_BUILD === '1') {
	const FALLBACK_WARNING = 'Consider using a different name for the fallback';
	const origLog = console.log.bind(console);
	console.log = (...args) => {
		if (args.some((a) => typeof a === 'string' && a.includes(FALLBACK_WARNING))) return;
		origLog(...args);
	};
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		// Fully static output — deployable anywhere, no runtime server required.
		adapter: withBrandSlots(
			adapter({
				pages: 'build',
				assets: 'build',
				fallback: 'index.html',
				precompress: true, // emit .gz and .br alongside every asset
				strict: true
			}),
			'./build/'
		),

		// Every Morphit instance is served from its DOMAIN ROOT (nginx web
		// root = the build dir), never a sub-path.  SvelteKit's default
		// `paths.relative: true` rewrites root-absolute links (e.g. the
		// footer's `/canary.txt` / `/pgp_keys.asc`) into paths relative to
		// the current prerendered page — so from `/en/` they resolved to
		// `/en/canary.txt` and 404'd.  `relative: false` keeps them absolute
		// (`/canary.txt`) on every locale page, which is what a root-hosted
		// static site wants.  (footer canary link 404.)
		paths: { relative: false },

		// Content Security Policy: one HEADER, sent by nginx / BunkerWeb for
		// every page — `script-src 'self' 'wasm-unsafe-eval'`, with no
		// 'unsafe-inline' and no 'unsafe-eval' (ops/bunkerweb/frontend/nginx.conf,
		// ops/nginx/web.conf, the BunkerWeb env's CONTENT_SECURITY_POLICY;
		// scripts/csp-header-consistency-smoke.ts keeps them in step).
		//
		// No `kit.csp` here, on purpose: in a static build SvelteKit can only
		// add per-page hashes as a <meta> tag, and a header sent unchanged for
		// every page would still have to allow inline script for those pages to
		// run (the browser enforces both policies). Instead the build leaves no
		// inline script at all: the ?lang= hint is static/lang-hint.js, and
		// SvelteKit's per-page bootstrap is moved into content-addressed files
		// by csp-externalize-scripts.mjs (wrapped around the adapter above),
		// which FAILS the build if anything inline is left. 'wasm-unsafe-eval'
		// stays: libsodium (keystore KDF, chat crypto) runs as WebAssembly.
		// `frame-ancestors` only works as a header, which is another reason the
		// policy lives there. If you change the client's Blurt RPC lists
		// (src/lib/net/config.ts) update that header's connect-src to match.

		// No server-side state; prerender everything possible.
		//
		// `handleUnseenRoutes: 'ignore'` — dynamic-param routes
		// (/<lang>/chat/[peer=account], /<lang>/explorer/tx/[id=trxid],
		// /<lang>/[x+40][account=account]/[permlink=permlink], etc.)
		// have no enumeration source at build time — we can't list
		// every possible peer account or txid in advance.  These
		// routes are served at runtime via the SPA fallback
		// (`fallback: 'index.html'` above), which SvelteKit's
		// client router then resolves to the correct dynamic page.
		// Without `handleUnseenRoutes: 'ignore'` the build errors
		// out the restructure attempt.  Static
		// indexable routes (17 routes × 10 locales = 170 HTMLs)
		// prerender as expected.
		prerender: {
			handleHttpError: 'warn',
			handleMissingId: 'warn',
			handleUnseenRoutes: 'ignore'
		},

		alias: {
			$lib: 'src/lib',
			$components: 'src/lib/components',
			$crypto: 'src/lib/crypto',
			$i18n: 'src/lib/i18n',
			$stores: 'src/lib/stores',
			$utils: 'src/lib/utils',
			$net: 'src/lib/net',
			$blurt: 'src/lib/blurt',
			$indexer: 'src/lib/indexer',
			$seo: 'src/lib/seo',
			$prices: 'src/lib/prices'
		},

		// Tighten default security headers
		serviceWorker: {
			// Auto-register the SW bundle. Update-consent (the "Load it now"
			// snackbar) is driven by UpdateBanner.svelte off the waiting
			// worker; the SW's APPLY_UPDATE message is the only path that
			// calls skipWaiting(), so a new version never takes over silently.
			register: true,
			// updateViaCache:'none' — the browser must re-fetch
			// /service-worker.js from the NETWORK (never its HTTP cache) on
			// every update check, so a freshly-deployed worker is detected
			// promptly and the snackbar can surface. Without this, a cached
			// SW script can hide a deploy until the browser's own ~24h cycle.
			// (Pair with a server-side `Cache-Control: no-cache` on
			// /service-worker.js so an upstream proxy can't serve it stale.)
			options: { updateViaCache: 'none' }
		}
	}
};

export default config;
