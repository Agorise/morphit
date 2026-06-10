import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

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
		// Content-Security-Policy` (see docs/RUN-A-MORPHIT-NODE.md §11 and
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
			// Auto-register the SW bundle. We still control the messaging
			// surface (CHECK_UPDATE / APPLY_UPDATE) from hooks.client.ts so
			// that version upgrades require user consent.
			register: true
		}
	}
};

export default config;
