import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// No test may reach the internet (test/setup/noInternet.ts).
		setupFiles: ['./test/setup/noInternet.ts']
	}
});
