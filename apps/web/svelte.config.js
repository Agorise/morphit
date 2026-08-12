import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// v1.11.1 — quiet ONE benign SvelteKit adapter-static warning during the
// `morphit-ops upgrade` frontend build. adapter-static prerenders the root `/`
// (the detection-redirect shell, ADR-0024) AND writes the SPA fallback to that
// same `index.html`, so SvelteKit core prints (via console.log):
//   "Overwriting …/build/index.html with fallback page. Consider using a
//    different name for the fallback."
// The overwrite is INTENTIONAL here — the fallback shell is exactly what every
// unmatched route (including `/`) should boot — so the line is noise an
// operator can't act on and, mid-upgrade, reads like something went wrong. Same
// gate + rationale as the chunk-size (cp687) and npm-deprecation (cp686)
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
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html',
			precompress: true, // emit .gz and .br alongside every asset
			strict: true
		}),

		// Every Morphit instance is served from its DOMAIN ROOT (nginx web
		// root = the build dir), never a sub-path.  SvelteKit's default
		// `paths.relative: true` rewrites root-absolute links (e.g. the
		// footer's `/canary.txt` / `/pgp_keys.asc`) into paths relative to
		// the current prerendered page — so from `/en/` they resolved to
		// `/en/canary.txt` and 404'd.  `relative: false` keeps them absolute
		// (`/canary.txt`) on every locale page, which is what a root-hosted
		// static site wants.  (cp431 — footer canary link 404.)
		paths: { relative: false },

		// Content Security Policy is NOT emitted here.
		//
		// This is a fully static (adapter-static) build served by nginx, so
		// there is no SvelteKit runtime to set a response header — a
		// SvelteKit-managed CSP can only be injected as a <meta http-equiv>
		// tag, and that is strictly worse here:
		//   1. `frame-ancestors` (our clickjacking defense) is IGNORED by
		//      browsers when delivered via <meta>; it only works as a
		//      header.  X-Frame-Options + a header CSP cover it instead.
		//   2. The app runs WebAssembly in the browser (argon2 KDF for the
		//      keystore, signing) which needs `wasm-unsafe-eval`, and ships
		//      inline bootstrap scripts which need `'unsafe-inline'` once
		//      per-page hashes aren't being computed — a hash-mode meta tag
		//      fought both and silently broke crypto + hydration.
		//   3. A meta CSP and the nginx header CSP are INTERSECTED by the
		//      browser, so the stricter meta clobbered the working header,
		//      and operators had to `sed` the meta out of the build by hand.
		//
		// The canonical CSP is therefore a single nginx `add_header
		// Content-Security-Policy` (see docs/RUN-A-MORPHIT-NODE.md §10 and
		// docs/OPERATIONS.md §15).  One source of truth, no meta tag, no
		// manual stripping.  If you change the client's Blurt RPC list
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
		// out per Part 121 cp7's restructure attempt.  Static
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
