/**
 * What the indexer says when it stops on a gap in the first-trade evidence
 * (waiverEvidenceGuard.ts) must be true.
 *
 * Review, 2026-10-29: it said to run fast-sync because "it restores a snapshot
 * made by v1.21.17 or later". fast-sync restores the NEWEST anchored snapshot,
 * whichever version made it, so on a node where that snapshot is older the
 * advice led straight back to the same stop. It now names both ways on, and
 * when the first one helps.
 */
import { describe, expect, it } from 'vitest';

import { checkWaiverEvidence } from '../../src/indexer/waiverEvidenceGuard';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';

/** indexer_state with blocks up to 5,000 applied and evidence recorded through 4,000. */
const db = {
	query: async (sql: string) =>
		/SELECT/.test(sql) ? { rows: [{ last: '5000', through: '4000' }] } : { rows: [] }
};
const afterActivation = async (): Promise<Date> =>
	new Date(Date.parse(CONSENSUS_V2_ACTIVATION_TIME) + 60_000);

describe('the evidence-gap stop', () => {
	it('says both ways on, and when fast-sync helps — never that it restores a v1.21.17 snapshot', async () => {
		const err = await checkWaiverEvidence(db, afterActivation).then(
			() => null,
			(e: Error) => e
		);
		expect(err).not.toBeNull();
		const msg = err!.message;
		expect(msg).toContain('blocks 4001 to 5000');
		expect(msg).toContain('sudo morphit-ops fast-sync');
		expect(msg).toMatch(
			/helps only if the newest snapshot was made by Morphit v1\.21\.17 or later/
		);
		expect(msg).toMatch(/fast-sync shows which version made it/);
		expect(msg).toMatch(/Rebuild the indexer's database from the chain \(OPERATIONS\.md §46/);
		expect(msg).not.toMatch(/it restores a snapshot made by/);
	});
});
