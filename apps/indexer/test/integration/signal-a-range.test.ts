/**
 * Signal A (same creator, first activity within 5 minutes) is a range
 * join, time-capped, and ignores every registered operator's relay.
 *
 * Before: it self-joined every same-creator pair (O(k²) — 5,000 accounts from
 * one creator is 12.5 M comparisons) inside the poll loop with no time limit,
 * and excluded only this instance's relay, so other instances' users were
 * flagged as related to each other.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { detectRelatedAccounts } from '../../src/indexer/signals';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

const T0 = '2026-10-01T00:00:00Z';

describe.skipIf(!INTEGRATION_ENABLED)('Signal A', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		await fx.db.query('TRUNCATE operators CASCADE');
	});

	const seed = (creator: string, n: number, stepSeconds: number, prefix: string) =>
		fx.db.query(
			`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id, first_activity_at)
			 SELECT $3 || g, $1, g, $4::timestamptz, 't' || g,
			        $4::timestamptz + make_interval(secs => g * $2)
			   FROM generate_series(1, $5) g`,
			[creator, stepSeconds, prefix, T0, n]
		);

	it('5,000 accounts from one creator are judged within a second, and only close pairs are flagged', async () => {
		// One account every 2 minutes: each has two neighbours within 5 minutes.
		await seed('factory', 5000, 120, 'f');
		const t = Date.now();
		const flagged = await detectRelatedAccounts(fx.db, { excludeCreators: ['morphit-relay'] });
		const ms = Date.now() - t;
		expect(flagged).toBe(5000 - 1 + 5000 - 2);
		expect(ms, `Signal A took ${ms} ms`).toBeLessThan(1000);
	});

	it("another registered instance's relay is not a suspicious creator", async () => {
		await fx.db.query(
			`INSERT INTO operators (account, tag, display_name, registered_in_block) VALUES ('other-relay', 'other', 'Other', 1)`
		);
		await seed('other-relay', 3, 10, 'o');
		await seed('custom-cli', 3, 10, 'c');
		await detectRelatedAccounts(fx.db, { excludeCreators: ['morphit-relay'] });
		const rows = await fx.db.query<{ a: string }>(
			`SELECT DISTINCT left(account_a, 1) AS a FROM related_accounts ORDER BY 1`
		);
		expect(rows.rows.map((r) => r.a)).toEqual(['c']);
	});
});
