/**
 * GET /v1/attestor-eligibility answers for the phase the NEXT attestation will
 * be judged by.
 *
 * From the consensus activation time every node judges attestations by the
 * federation-wide phase (attestorEligibility.FEDERATION_ATTESTATION_PHASE), not
 * its own MORPHIT_INDEXER_ATTESTATION_PHASE: a recorded attestation moves an
 * order's fee_status, which every node must agree on. The endpoint the web
 * app asks before showing the attest button must say the same, or a node set
 * to 'steady' would hide the button from accounts every node now admits.
 */
import { describe, expect, it } from 'vitest';

import { attestorEligibilityRoute } from '$api/attestorEligibility';
import { CONSENSUS_V2_ACTIVATION_TIME } from '$indexer/consensusActivation';

const ACTIVATION = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);

/** carol: 60 days old, never paid a fee — eligible in 'launch' only. */
const dbAt = (latestBlockTime: Date) => ({
	query: async (sql: string) => {
		if (/FROM ops ORDER BY block_num DESC/.test(sql) && !/FROM accounts/.test(sql)) {
			return { rows: [{ block_time: latestBlockTime }], rowCount: 1 };
		}
		if (/FROM accounts/.test(sql)) {
			return {
				rows: [
					{
						created_block_time: new Date(latestBlockTime.getTime() - 60 * 86_400_000),
						cumulative_blurt_paid: null,
						canonical_blurt_paid: null,
						latest_block_time: latestBlockTime
					}
				],
				rowCount: 1
			};
		}
		return { rows: [], rowCount: 0 };
	}
});

async function ask(latest: Date, configured: 'launch' | 'steady') {
	const app = attestorEligibilityRoute(
		dbAt(latest) as never,
		{
			attestationPhase: configured
		} as never
	);
	const res = await app.request('/carol');
	return (await res.json()) as { phase: string; eligible: boolean };
}

describe('attestor eligibility: the default phase follows the chain', () => {
	it('before the activation time: this node’s configured phase', async () => {
		const r = await ask(new Date(ACTIVATION - 86_400_000), 'steady');
		expect(r).toMatchObject({ phase: 'steady', eligible: false });
	});

	it('from the activation time: the federation phase, whatever this node is set to', async () => {
		const r = await ask(new Date(ACTIVATION + 86_400_000), 'steady');
		expect(r).toMatchObject({ phase: 'launch', eligible: true });
	});
});
