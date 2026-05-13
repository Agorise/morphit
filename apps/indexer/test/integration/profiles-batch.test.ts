/**
 * Integration test — /v1/profiles batch endpoint SQL.
 *
 * Exercises the SELECT pattern the batch handler uses. Mirrors the
 * SQL in src/api/profiles.ts (batch branch); if that changes, this
 * test should change too.
 *
 * We test the SQL directly rather than spinning up the HTTP server
 * for the same reason orderbook-join.test.ts does: the meaningful
 * logic lives in the SQL, and the HTTP layer is a thin validator
 * that's simple enough to cover by human review. Integration here
 * catches the one thing unit tests can't: PG behavior on
 * `ANY($1::text[])` with various inputs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

/** Mirror of the SELECT in src/api/profiles.ts batch handler. */
const BATCH_SELECT = `
	SELECT account, display_name, json_metadata,
	       source_block_num::text, updated_at
	FROM profiles WHERE account = ANY($1::text[])
`;

/** Insert a profiles row. Values that aren't parameterized here
 *  (metadata, block_num) default to sensible empties. */
async function insertProfile(
	fx: IntegrationFixture,
	account: string,
	display_name: string
): Promise<void> {
	await fx.db.query(
		`INSERT INTO profiles (
			account, display_name, json_metadata,
			source_block_num, source_trx_id, updated_at
		) VALUES ($1, $2, $3, $4, $5, NOW())`,
		[account, display_name, {}, 1, `0000000000000000000000000000000000000000`]
	);
}

describe.skipIf(!INTEGRATION_ENABLED)('batch profiles endpoint — SQL integration', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});

	afterAll(async () => {
		if (fx) await fx.teardown();
	});

	beforeEach(async () => {
		await truncateAll(fx);
	});

	it('returns zero rows for empty table', async () => {
		const result = await fx.db.query(BATCH_SELECT, [['alice', 'bob']]);
		expect(result.rowCount).toBe(0);
	});

	it('returns a single profile when one account matches', async () => {
		await insertProfile(fx, 'alice', 'Alice');
		const result = await fx.db.query<{ account: string; display_name: string }>(BATCH_SELECT, [
			['alice']
		]);
		expect(result.rowCount).toBe(1);
		expect(result.rows[0]!.account).toBe('alice');
		expect(result.rows[0]!.display_name).toBe('Alice');
	});

	it('returns all matching profiles when many accounts match', async () => {
		await insertProfile(fx, 'alice', 'Alice');
		await insertProfile(fx, 'bob', 'Bob');
		await insertProfile(fx, 'carol', 'Carol');
		const result = await fx.db.query<{ account: string }>(BATCH_SELECT, [
			['alice', 'bob', 'carol']
		]);
		expect(result.rowCount).toBe(3);
		const accounts = result.rows.map((r) => r.account).sort();
		expect(accounts).toEqual(['alice', 'bob', 'carol']);
	});

	it('returns only the known accounts on a mixed batch', async () => {
		// The HTTP handler silently drops unknown accounts. Verified
		// at the SQL level: the WHERE clause simply yields no row
		// for an account that doesn't exist, so the result set
		// contains only the knowns.
		await insertProfile(fx, 'alice', 'Alice');
		await insertProfile(fx, 'bob', 'Bob');
		const result = await fx.db.query<{ account: string }>(BATCH_SELECT, [
			['alice', 'nonexistent', 'bob', 'another-missing']
		]);
		expect(result.rowCount).toBe(2);
		const accounts = result.rows.map((r) => r.account).sort();
		expect(accounts).toEqual(['alice', 'bob']);
	});

	it('deduplicates at the application layer — SQL handles duplicates fine too', async () => {
		// The HTTP handler dedupes before querying. But even if it
		// didn't, ANY($1) with a duplicated array returns one row
		// per matching account — the array deduplication is
		// semantically transparent to the query. This test locks
		// that behavior in.
		await insertProfile(fx, 'alice', 'Alice');
		const result = await fx.db.query<{ account: string }>(BATCH_SELECT, [
			['alice', 'alice', 'alice']
		]);
		expect(result.rowCount).toBe(1);
		expect(result.rows[0]!.account).toBe('alice');
	});

	it('returns the correct columns for serialization', async () => {
		// The handler does parseInt on source_block_num::text (to
		// dodge BIGINT becoming a string in pg's default serde),
		// and calls .toISOString() on updated_at. Verify both
		// column types as the query casts them.
		await insertProfile(fx, 'alice', 'Alice');
		const result = await fx.db.query<{
			account: string;
			display_name: string;
			json_metadata: unknown;
			source_block_num: string;
			updated_at: Date;
		}>(BATCH_SELECT, [['alice']]);
		const row = result.rows[0]!;
		expect(typeof row.source_block_num).toBe('string');
		expect(row.updated_at).toBeInstanceOf(Date);
		// json_metadata returns as a parsed object, not a string
		// (pg's default JSONB decoder).
		expect(typeof row.json_metadata).toBe('object');
	});

	it('handles a large batch at the max-size boundary (100)', async () => {
		// Insert 100 accounts — fewer than we'd want if we were
		// really testing load, but enough to prove the parameterized
		// array handles the cap without pathological planning.
		// Account names must pass the ACCOUNT_NAME_RE regex
		// (lowercase, 3..16 chars, letter-start). Use "user001" etc.
		const accounts: string[] = [];
		for (let i = 0; i < 100; i++) {
			const name = `user${String(i).padStart(3, '0')}`;
			accounts.push(name);
			await insertProfile(fx, name, `User ${i}`);
		}
		const result = await fx.db.query<{ account: string }>(BATCH_SELECT, [accounts]);
		expect(result.rowCount).toBe(100);
	});
});
