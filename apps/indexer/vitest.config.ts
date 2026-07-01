import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const src = (p: string) => resolve(fileURLToPath(new URL('./src', import.meta.url)), p);

export default defineConfig({
	test: {
		// Unit tests only. Integration tests live under test/integration/
		// and are exercised via `npm run test:integration`.
		include: ['test/**/*.test.ts'],
		exclude: ['test/integration/**', 'node_modules/**'],
		environment: 'node',
		globals: false,
		// Tests touch no external services; each runs in isolation.
		isolate: true,
		// cp79-D21: uniform 30s per-test timeout across all
		// workspaces (relay applied at cp78-D19 after a confirmed
		// flake on scrypt-heavy tests).  Indexer's tests are fast
		// today (total 615ms for 481 tests = ~1.3ms avg), but
		// preemptively defending against the same dynamic-class
		// timing-under-contention bug class is essentially free.
		// Real hangs still fail fast within wall-clock budget.
		testTimeout: 30_000
	},
	resolve: {
		alias: {
			$config: src('config/index.ts'),
			$db: src('db'),
			$blurt: src('blurt'),
			$indexer: src('indexer'),
			$api: src('api'),
			$log: src('log/index.ts')
		}
	}
});
