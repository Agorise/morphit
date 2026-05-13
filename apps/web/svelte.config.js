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

		// Content Security Policy — enforced by SvelteKit at build time AND by
		// nginx at serve time. Both must agree; if you change one, change
		// docs/OPERATIONS.md §15 and docs/RUN-A-MORPHIT-NODE.md §11 to match.
		//
		// Audit 2026-05 finding 6-5: tightened connect-src from `'self'
		// https:` to an explicit allowlist (the four default Blurt RPCs +
		// CoinGecko price API). Tradeoff: users who add custom RPC
		// endpoints in Settings will see CSP violations until the operator
		// extends the allowlist. Operators serving community pools that
		// can't be enumerated at build time should fork this list and
		// add the relevant hosts (or revert to `'self', 'https:'` for
		// maximum compatibility at the cost of weaker CSP).
		csp: {
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self'],
				'img-src': ['self', 'data:'],
				'font-src': ['self'],
				'connect-src': [
					'self',
					'https://rpc.blurt.blog',
					'https://blurt-rpc.saboin.com',
					'https://rpc.beblurt.com',
					'https://rpc.blurt.one',
					'https://api.coingecko.com'
				],
				'frame-ancestors': ['none'],
				'form-action': ['self'],
				'base-uri': ['self'],
				'object-src': ['none']
			}
		},

		// No server-side state; prerender everything possible.
		prerender: {
			handleHttpError: 'warn',
			handleMissingId: 'warn'
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
