import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// No test may reach the internet (test/setup/noInternet.ts).
		setupFiles: ['./test/setup/noInternet.ts'],
		// These tests run the real commands with fake docker/curl/systemctl
		// programs (each a child process), several heals per test. A CI runner
		// running them next to the other workspaces' suites is several times
		// slower than a laptop: a test that takes 1.5 s here took 6.8 s there and
		// hit vitest's 5 s default. A timed-out test is not stopped — it kept
		// running its heals and, sharing stdout and PATH with the next test, made
		// that one fail too. So each test gets a minute; one that sets its own
		// limit keeps it.
		testTimeout: 60_000
	}
});
