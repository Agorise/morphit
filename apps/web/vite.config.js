import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8'));

export default defineConfig({
	plugins: [sveltekit()],

	define: {
		// Batch J: bake the package.json version into the bundle so
		// the release-trust-anchor module can compare running vs
		// announced version.  Available throughout the app as
		// `__MORPHIT_VERSION__`.
		__MORPHIT_VERSION__: JSON.stringify(pkg.version)
	},

	build: {
		target: 'es2022',
		minify: 'esbuild',
		cssMinify: 'lightningcss',
		sourcemap: false,
		reportCompressedSize: true,
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
		// Part 70 closure of REVISIT-LIST G1.E: 97 web unit tests
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
		// cp79-D21: uniform 30s per-test timeout across all
		// workspaces.  apps/web's `src/lib/crypto/crypto.test.ts`
		// runs 52 tests in 5270ms total (~100ms avg), but
		// libsodium-wrappers-sumo + scrypt-style operations have
		// long-tail durations that can spike under battery CPU
		// contention.  Same dynamic-class defense as cp78-D19
		// applied to relay; preemptively closes the gap before
		// the next flake surfaces.
		testTimeout: 30_000
	}
});
