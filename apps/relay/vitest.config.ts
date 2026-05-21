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
		isolate: true,
		// cp78-D19: bump per-test timeout from vitest's 5s default to
		// 30s.  The scrypt-heavy tests in `test/unlock.test.ts` (931–
		// 1834ms solo) and `test/keyEnvelope.test.ts` (464–1422ms
		// solo) can exceed 5s under battery CPU contention when 100+
		// other tsx processes are warming up in parallel runners.
		// 30s = ~16× headroom over the slowest observed solo duration
		// (1834ms in `unlockActiveKey > 3 wrong passphrases`).  Real
		// hangs would still fail fast within a wall-clock budget.
		testTimeout: 30_000
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
