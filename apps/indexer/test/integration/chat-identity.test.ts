/**
 * Integration test — chat_identities table + /v1/chat-identity endpoint SQL.
 *
 * Exercises the SQL the handler (src/indexer/handlers/chatIdentity.ts)
 * and endpoint (src/api/chatIdentity.ts) use.
 *
 * Tested directly at the SQL level, same rationale as
 * profiles-batch.test.ts: the meaningful logic is in the SQL;
 * the handler and endpoint are thin wrappers whose validation
 * is covered by unit tests and code review.
 *
 * What integration catches that unit tests can't:
 *   - Postgres BYTEA round-tripping via node-pg's Buffer adapter
 *   - The octet_length(chat_pub) = 32 CHECK constraint
 *   - ON CONFLICT DO UPDATE semantics on the account PK
 *   - bigint → text cast for JS precision-safe serialization
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

/** Mirror of the SELECT in src/api/chatIdentity.ts. */
const ENDPOINT_SELECT = `
	SELECT account, chat_pub, source_block_num::text, updated_at
	FROM chat_identities
	WHERE account = $1
`;

/** Mirror of the INSERT+ON CONFLICT in src/indexer/handlers/chatIdentity.ts. */
const UPSERT_SQL = `
	INSERT INTO chat_identities (
		account, chat_pub, source_block_num, source_trx_id, updated_at
	) VALUES ($1, $2, $3, $4, $5)
	ON CONFLICT (account) DO UPDATE SET
		chat_pub = EXCLUDED.chat_pub,
		source_block_num = EXCLUDED.source_block_num,
		source_trx_id = EXCLUDED.source_trx_id,
		updated_at = EXCLUDED.updated_at
`;

/** Build a 32-byte buffer with a recognizable filler byte. The
 *  tests only care that inserts + reads preserve the bytes
 *  exactly; we don't validate the bytes cryptographically. */
function fakePub(fill: number): Buffer {
	return Buffer.alloc(32, fill);
}

describe.skipIf(!INTEGRATION_ENABLED)('chat_identities — SQL integration', () => {
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
		const result = await fx.db.query(ENDPOINT_SELECT, ['alice']);
		expect(result.rowCount).toBe(0);
	});

	it('insert + select round-trips the pubkey bytes exactly', async () => {
		const pub = fakePub(0x2a);
		await fx.db.query(UPSERT_SQL, ['alice', pub, 42, 'trxA', new Date('2026-04-23T12:00:00Z')]);

		const result = await fx.db.query<{
			account: string;
			chat_pub: Buffer;
			source_block_num: string;
			updated_at: Date;
		}>(ENDPOINT_SELECT, ['alice']);

		expect(result.rowCount).toBe(1);
		const row = result.rows[0]!;
		expect(row.account).toBe('alice');
		// Exact byte match — no encoding damage in BYTEA round-trip.
		expect(Buffer.compare(row.chat_pub, pub)).toBe(0);
		expect(row.chat_pub.length).toBe(32);
		// bigint comes back as text (from the ::text cast) so JS
		// doesn't silently lose precision on large block numbers.
		expect(row.source_block_num).toBe('42');
		expect(row.updated_at).toBeInstanceOf(Date);
	});

	it('re-publishing overwrites via ON CONFLICT DO UPDATE', async () => {
		const pub1 = fakePub(0x11);
		const pub2 = fakePub(0x22);
		await fx.db.query(UPSERT_SQL, ['alice', pub1, 1, 'trxA', new Date('2026-04-20T00:00:00Z')]);
		await fx.db.query(UPSERT_SQL, ['alice', pub2, 99, 'trxB', new Date('2026-04-23T00:00:00Z')]);

		const result = await fx.db.query<{
			chat_pub: Buffer;
			source_block_num: string;
		}>(ENDPOINT_SELECT, ['alice']);
		expect(result.rowCount).toBe(1);
		expect(Buffer.compare(result.rows[0]!.chat_pub, pub2)).toBe(0);
		expect(result.rows[0]!.source_block_num).toBe('99');

		// Verify the FIRST insert's row really was replaced, not
		// duplicated. Count of distinct accounts must be 1.
		const countResult = await fx.db.query<{ c: string }>(
			'SELECT COUNT(*)::text AS c FROM chat_identities'
		);
		expect(countResult.rows[0]!.c).toBe('1');
	});

	it('rejects wrong-length pubkey via octet_length CHECK constraint', async () => {
		// 31 bytes — one short. The CHECK on the column should
		// reject this at the database level, independent of the
		// handler's own validation.
		const shortPub = Buffer.alloc(31, 0x33);
		await expect(
			fx.db.query(UPSERT_SQL, ['alice', shortPub, 1, 'trxA', new Date()])
		).rejects.toThrow(/check|octet_length/i);
	});

	it('rejects too-long pubkey via octet_length CHECK constraint', async () => {
		// 64 bytes — too many. Same mechanism.
		const longPub = Buffer.alloc(64, 0x44);
		await expect(
			fx.db.query(UPSERT_SQL, ['alice', longPub, 1, 'trxA', new Date()])
		).rejects.toThrow(/check|octet_length/i);
	});

	it('different accounts get separate rows', async () => {
		await fx.db.query(UPSERT_SQL, ['alice', fakePub(0x01), 1, 'trxA', new Date()]);
		await fx.db.query(UPSERT_SQL, ['bob', fakePub(0x02), 2, 'trxB', new Date()]);

		const aliceResult = await fx.db.query<{ chat_pub: Buffer }>(ENDPOINT_SELECT, ['alice']);
		const bobResult = await fx.db.query<{ chat_pub: Buffer }>(ENDPOINT_SELECT, ['bob']);
		expect(aliceResult.rowCount).toBe(1);
		expect(bobResult.rowCount).toBe(1);
		expect(aliceResult.rows[0]!.chat_pub[0]).toBe(0x01);
		expect(bobResult.rows[0]!.chat_pub[0]).toBe(0x02);
	});

	it('lookup by an unknown account returns zero rows (not-found case)', async () => {
		await fx.db.query(UPSERT_SQL, ['alice', fakePub(0x99), 1, 'trxA', new Date()]);
		const result = await fx.db.query(ENDPOINT_SELECT, ['nonexistent']);
		expect(result.rowCount).toBe(0);
	});
});
