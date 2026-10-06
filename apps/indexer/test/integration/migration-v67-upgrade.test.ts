/**
 * Migration v67 on the UPGRADE path, through the real runMigrations: an indexer
 * database at v66 still describes orders.lang as "untagged orders are NEVER
 * hidden by the language filter" — since v1.21.1 the opposite of what the
 * orderbook does. v67 corrects the description (comment only), once, to the
 * same text a fresh install gets from schema.sql.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { runMigrations } from '../../src/db/migrations';

const OLD_V56_COMMENT =
	'Language the order text is written in (a SUPPORTED_LOCALES code: en/es/de/' +
	'pl/fr/it/ru/fa/zh-CN/zh-HK). NULL = untagged (created before the feature, ' +
	'or unspecified); untagged orders are NEVER hidden by the language filter.';

async function langComment(fx: IntegrationFixture): Promise<string | null> {
	const r = await fx.db.query<{ d: string | null }>(
		`SELECT col_description('orders'::regclass, a.attnum) AS d
		   FROM pg_attribute a WHERE a.attrelid = 'orders'::regclass AND a.attname = 'lang'`
	);
	return r.rows[0]?.d ?? null;
}

describe.skipIf(!INTEGRATION_ENABLED)('migration v67 — upgrade path', () => {
	let fresh: IntegrationFixture;
	let upgraded: IntegrationFixture;
	let firstRun: { applied: number[] };
	let secondRun: { applied: number[] };

	beforeAll(async () => {
		fresh = await setupWithMigrations();
		upgraded = await setupWithMigrations();
		await upgraded.db.query(
			`COMMENT ON COLUMN orders.lang IS '${OLD_V56_COMMENT.replace(/'/g, "''")}'`
		);
		await upgraded.db.query(`DELETE FROM schema_migrations WHERE version = 67`);
		expect(await langComment(upgraded)).toBe(OLD_V56_COMMENT);
		firstRun = await runMigrations(upgraded.db);
		secondRun = await runMigrations(upgraded.db);
	});
	afterAll(async () => {
		await fresh?.teardown();
		await upgraded?.teardown();
	});

	it('applies v67 once, and a second run applies nothing', () => {
		expect(firstRun.applied).toEqual([67]);
		expect(secondRun.applied).toEqual([]);
	});
	it('the upgraded description is the fresh install’s, and says what the filter does', async () => {
		const up = await langComment(upgraded);
		expect(up).toBe(await langComment(fresh));
		expect(up).toMatch(/lists only orders tagged with one of its languages/);
	});
});
