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
