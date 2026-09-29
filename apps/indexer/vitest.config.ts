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
		// Same regex aliases as vitest.integration.config.ts (mirroring
		// tsconfig.json "paths", bare AND subpath forms): the object form
		// mapped `$config` to the config/index.ts FILE, so a unit test that
		// imported the config module failed on its own
		// `$config/canonicalTreasury` import. Exact `$config` before the prefix.
		alias: [
			{ find: /^\$config$/, replacement: src('config/index.ts') },
			{ find: /^\$config\/(.*)$/, replacement: `${src('config')}/$1` },
			{ find: /^\$db$/, replacement: src('db') },
			{ find: /^\$db\/(.*)$/, replacement: `${src('db')}/$1` },
			{ find: /^\$blurt$/, replacement: src('blurt') },
			{ find: /^\$blurt\/(.*)$/, replacement: `${src('blurt')}/$1` },
			{ find: /^\$indexer$/, replacement: src('indexer') },
			{ find: /^\$indexer\/(.*)$/, replacement: `${src('indexer')}/$1` },
			{ find: /^\$api$/, replacement: src('api') },
			{ find: /^\$api\/(.*)$/, replacement: `${src('api')}/$1` },
			{ find: /^\$log$/, replacement: src('log/index.ts') }
		]
	}
});
