import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const src = (p: string) => resolve(fileURLToPath(new URL('./src', import.meta.url)), p);

export default defineConfig({
	test: {
		// Integration tests only.
		include: ['test/integration/**/*.test.ts'],
		environment: 'node',
		globals: false,
		// Real-Postgres operations are slower than unit tests.
		testTimeout: 15_000,
		hookTimeout: 15_000,
		// Serialize suites — each suite creates its own schema but a
		// shared Postgres instance with a small connection limit
		// shouldn't be flooded by parallel suite setups.
		fileParallelism: false,
		isolate: true
	},
	resolve: {
		// Mirror apps/indexer/tsconfig.json "paths" EXACTLY, including the
		// subpath (`/*`) forms.  The object-shorthand alias mapped bare
		// `$config` to the config/index.ts FILE, so a subpath import like
		// `$config/canonicalTreasury` (which src/config/index.ts itself
		// uses) resolved to `config/index.ts/canonicalTreasury` and the
		// whole integration suite failed to load.  Regex aliases resolve
		// both the bare and subpath forms.  Order matters: exact `$config`
		// before the `$config/` prefix.
		alias: [
			{ find: /^\$config$/, replacement: src('config/index.ts') },
			{ find: /^\$config\/(.*)$/, replacement: `${src('config')}/$1` },
			{ find: /^\$db\/(.*)$/, replacement: `${src('db')}/$1` },
			{ find: /^\$blurt\/(.*)$/, replacement: `${src('blurt')}/$1` },
			{ find: /^\$indexer\/(.*)$/, replacement: `${src('indexer')}/$1` },
			{ find: /^\$api\/(.*)$/, replacement: `${src('api')}/$1` },
			{ find: /^\$log$/, replacement: src('log/index.ts') }
		]
	}
});
