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
