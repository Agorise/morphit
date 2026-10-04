/**
 * the doctor notices a missing posting-key trust
 * column.
 *
 * `accounts.posting_pubkey` and `accounts.posting_key_reconciled` are added to
 * schema.sql by top-level `ALTER TABLE … ADD COLUMN`, and the drift parser
 * skipped every column added that way. A database without
 * `posting_key_reconciled` while `schema_migrations` still recorded v61 was
 * reported healthy — and the dispatcher's UPDATE then failed on every
 * account_update block, stalling the poller.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { checkSchemaDrift } from '../../src/db/schemaDrift';

describe.skipIf(!INTEGRATION_ENABLED)('schema drift: ALTER-added trust columns (rv2-10)', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => fx?.teardown());

	it('a fully migrated database is still clean', async () => {
		const res = await checkSchemaDrift(fx.db);
		expect(res.diff.missingColumns).toEqual([]);
		expect(res.ok).toBe(true);
	});

	it('dropping accounts.posting_key_reconciled is reported', async () => {
		await fx.db.query('ALTER TABLE accounts DROP COLUMN posting_key_reconciled');
		const res = await checkSchemaDrift(fx.db);
		expect(res.ok).toBe(false);
		expect(res.diff.missingColumns).toContainEqual(
			expect.objectContaining({ table: 'accounts', column: 'posting_key_reconciled' })
		);
	});
});
