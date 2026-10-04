/**
 * Two migration runners at once both succeed and apply each version once,
 * on real Postgres with the real runMigrations.
 *
 * The runner had no lock: a boot racing `npm run migrate`, or two containers
 * starting together, ran schema.sql twice concurrently, and one of them died
 * on a duplicate catalog entry (or both raced the tracking-table insert).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setup, type IntegrationFixture } from './harness';
import { runMigrations } from '../../src/db/migrations';

describe.skipIf(!INTEGRATION_ENABLED)('concurrent migration runners', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setup();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it('both finish without error, and every version is applied exactly once', async () => {
		const results = await Promise.allSettled([
			runMigrations(fx.db),
			runMigrations(fx.db),
			runMigrations(fx.db)
		]);
		const failures = results
			.filter((r) => r.status === 'rejected')
			.map((r) => String((r as PromiseRejectedResult).reason));
		expect(failures).toEqual([]);
		const applied = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.applied : []));
		expect(new Set(applied).size, 'a version was applied twice').toBe(applied.length);
		const again = await runMigrations(fx.db);
		expect(again.applied).toEqual([]);
	}, 120_000);
});
