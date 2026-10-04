import { sveltekit } from '@sveltejs/kit/vite';
import { i18nSections } from './scripts/vite-i18n-sections.ts';
import { licensesTxt } from './scripts/vite-licenses.ts';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8'));

export default defineConfig({
	// i18nSections (v1.20.2): locale files served in parts, so a page downloads
	// only the messages it shows (src/lib/i18n/lazySections.ts).
	// licensesTxt: build/licenses.txt, the licences of every third-party
	// package in the client bundle (linked from the footer).
	plugins: [i18nSections(resolve(HERE, 'src/lib/i18n/locales')), licensesTxt(), sveltekit()],

	define: {
		// Bake the package.json version into the bundle so the release check
		// can compare running vs announced version (`__MORPHIT_VERSION__`).
		__MORPHIT_VERSION__: JSON.stringify(pkg.version),
		// The origin the PRERENDERED pages are built for: used only
		// by server-side code (src/lib/seo/urls.ts siteOrigin), marked in the
		// output, recorded by scripts/origin-slots.mjs and rewritten to each
		// instance's own origin by morphit-ops. MORPHIT_SITE_ORIGIN overrides it
		// (a test build); the release is built for the canonical instance.
		__MORPHIT_SITE_ORIGIN__: JSON.stringify(
			process.env.MORPHIT_SITE_ORIGIN || 'https://morphit.io'
		)
	},

	build: {
		target: 'es2022',
		minify: 'esbuild',
		cssMinify: 'lightningcss',
		sourcemap: false,
		reportCompressedSize: true,
		// the chunk-size hint is a useful footprint signal in dev + CI, but
		// mid-upgrade it's noise an operator can't act on and reads like a problem.
		// morphit-ops sets MORPHIT_QUIET_BUILD=1 for the upgrade's frontend build to
		// raise the limit out of the way; a normal `npm run build` keeps the 500 kB
		// warning so we still watch chunk growth.
		chunkSizeWarningLimit: process.env.MORPHIT_QUIET_BUILD === '1' ? 100000 : 500,
		rollupOptions: {
			output: {
				// Stable chunk names for SRI hash generation
				entryFileNames: 'assets/[name]-[hash].js',
				chunkFileNames: 'assets/[name]-[hash].js',
				assetFileNames: 'assets/[name]-[hash][extname]'
			}
		}
	},

	server: {
		port: 5173,
		strictPort: true,
		host: '127.0.0.1'
	},

	// No telemetry to Vite / SvelteKit during dev
	clearScreen: false,

	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
		// of backlog G1.E: 97 web unit tests
		// were failing under jsdom because libsodium-wrappers-sumo
		// (and other crypto / Buffer code paths) hits "TypeError:
		// unsupported input type for message" when its global
		// detection picks up jsdom's partial Web Crypto / Buffer
		// shim instead of Node's real one.  Most tests are pure
		// data / crypto / utility — they never touch the DOM.
		// Default to 'node' so those work.  The 8 files that DO
		// need DOM are tagged with `// @vitest-environment jsdom`
		// at the top, per Vitest's per-file override convention.
		environment: 'node',
		// uniform 30s per-test timeout across all
		// workspaces.  apps/web's `src/lib/crypto/crypto.test.ts`
		// runs 52 tests in 5270ms total (~100ms avg), but
		// libsodium-wrappers-sumo + scrypt-style operations have
		// long-tail durations that can spike under battery CPU
		// contention.  Same dynamic-class defense as an earlier fix
		// applied to relay; preemptively closes the gap before
		// the next flake surfaces.
		testTimeout: 30_000
	}
});
