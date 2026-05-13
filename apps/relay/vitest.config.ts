import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const src = (p: string) => resolve(fileURLToPath(new URL('./src', import.meta.url)), p);

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		exclude: ['test/integration/**', 'node_modules/**'],
		environment: 'node',
		globals: false,
		isolate: true
	},
	resolve: {
		alias: {
			$config: src('config'),
			$api: src('api'),
			$blurt: src('blurt'),
			$crypto: src('crypto'),
			$db: src('db'),
			$queue: src('queue'),
			$policy: src('policy'),
			$middleware: src('middleware'),
			$log: src('log/index.ts')
		}
	}
});
