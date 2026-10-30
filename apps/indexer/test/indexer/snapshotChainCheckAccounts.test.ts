/**
 * The Tier-2 snapshot check compares a sampled account's creator and creation
 * time with the chain, not only its name.
 *
 * From the consensus activation time the fee-attestation quorum decides Signal
 * A ("related to the poster") from accounts.creator and first activity
 * (signalVerdicts.relatedEverHeld), and attestor age from created_block_time.
 * A restored snapshot whose rows had a rewritten creator used to pass this
 * check (only the name and transaction were compared), and could then move
 * which attestations count on the restoring node.
 */
import { describe, expect, it } from 'vitest';

import { checkSnapshotAgainstChain } from '../../src/indexer/snapshotChainCheck';

const CREATED = '2026-09-01T10:00:00';
const chainBlock = {
	timestamp: CREATED,
	transactions: [
		{
			operations: [
				[
					'account_create',
					{ creator: 'cli-pipeline', new_account_name: 'sock1', fee: '10.000 BLURT' }
				]
			]
		}
	],
	transaction_ids: ['ab'.repeat(20)]
};

interface Row {
	name: string;
	created_block_num: string;
	created_trx_id: string;
	creator: string;
	created_block_time: Date;
}
const honest: Row = {
	name: 'sock1',
	created_block_num: '4000',
	created_trx_id: 'ab'.repeat(20),
	creator: 'cli-pipeline',
	created_block_time: new Date(`${CREATED}Z`)
};

/** A restored database holding one chain-created account and nothing else. */
const dbWith = (row: Row) => ({
	query: async (sql: string) => {
		if (/MIN\(block_num\)/.test(sql)) return { rows: [{ lo: null, hi: null }] };
		if (/COUNT\(\*\)::text AS n FROM accounts/.test(sql)) return { rows: [{ n: '1' }] };
		if (/FROM accounts/.test(sql)) return { rows: [row] };
		if (/COUNT\(\*\)::text AS n/.test(sql)) return { rows: [{ n: '0' }] };
		return { rows: [] };
	}
});

const run = (row: Row) =>
	checkSnapshotAgainstChain({
		db: dbWith(row) as never,
		chain: { getBlock: async (n: number) => (n === 4000 ? chainBlock : null) },
		startBlock: 1,
		samples: 4,
		randomInt: () => 0,
		say: () => {}
	});

describe('Tier-2 check: a sampled account is the chain’s, creator and time included', () => {
	it('an honest row passes', async () => {
		const r = await run(honest);
		expect(r.failures).toEqual([]);
		expect(r.verdict).toBe('verified');
	});

	it('a row with another creator is a mismatch (quarantine)', async () => {
		// Rewritten to a registered relay: Signal A would never relate sock1 to
		// its real sibling accounts, so its attestations would count.
		const r = await run({ ...honest, creator: 'relay-reg' });
		expect(r.verdict).toBe('quarantine');
		expect(r.failures.join('\n')).toContain('created by cli-pipeline, recorded relay-reg');
	});

	it('a row with another creation time is a mismatch (quarantine)', async () => {
		// Made older: the attestor age gate would pass a fresh sock.
		const r = await run({ ...honest, created_block_time: new Date('2026-01-01T00:00:00Z') });
		expect(r.verdict).toBe('quarantine');
		expect(r.failures.join('\n')).toContain('recorded 2026-01-01T00:00:00.000Z');
	});
});
