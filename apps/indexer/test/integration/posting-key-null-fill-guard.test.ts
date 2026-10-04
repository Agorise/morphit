/**
 * the boot NULL fill never refills a key the
 * owner disowned.
 *
 * The reconcile writes `posting_pubkey = NULL, posting_key_reconciled = TRUE`
 * when the chain names no single key for an account (the owner moved posting
 * authority away from a leaked key). The NULL fill selected every NULL row
 * regardless of the flag, and its UPDATE was guarded only on the key being
 * NULL — so on the next boot it wrote back whatever key two lagging nodes
 * still agreed on, confirmed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { backfillPostingKeys } from '../../src/indexer/postingKeyBackfill';

const STALE = 'BLT6stale0000000000000000000000000000000000000000000';

describe.skipIf(!INTEGRATION_ENABLED)(
	'posting-key NULL fill respects a confirmed NULL (rv2-11)',
	() => {
		let fx: IntegrationFixture;
		beforeAll(async () => {
			fx = await setupWithMigrations();
		});
		afterAll(async () => fx?.teardown());

		it('a disowned (NULL + confirmed) row stays NULL; an unconfirmed NULL row is filled', async () => {
			await fx.db.query(
				`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id, posting_pubkey, posting_key_reconciled)
			 VALUES ('disowned', 'x', 1, now(), 't1', NULL, TRUE),
			        ('neverseen', 'x', 2, now(), 't2', NULL, FALSE)`
			);
			// Every node still answers with the old key (lagging, or colluding).
			const auth = { weight_threshold: 1, account_auths: [], key_auths: [[STALE, 1]] };
			const answer = async (names: readonly string[]) =>
				new Map(names.map((n) => [n, { name: n, posting: auth }] as const));
			const source = { getAccounts: answer, getAccountsAgreed: answer };
			await backfillPostingKeys(fx.db, source as never);
			const rows = (
				await fx.db.query<{
					name: string;
					posting_pubkey: string | null;
					posting_key_reconciled: boolean;
				}>(`SELECT name, posting_pubkey, posting_key_reconciled FROM accounts ORDER BY name`)
			).rows;
			expect(rows).toEqual([
				{ name: 'disowned', posting_pubkey: null, posting_key_reconciled: true },
				{ name: 'neverseen', posting_pubkey: STALE, posting_key_reconciled: true }
			]);
		});
	}
);
