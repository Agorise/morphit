/**
 * The register op's display-name check switches to the strict (skeleton)
 * rule at the consensus activation time — by the op's BLOCK time. Before it,
 * a name the old rule let through stays accepted (history keeps its verdicts);
 * from it, a look-alike of a reserved name is refused.
 *
 * Driven through the real handler. The name check runs before the handler's
 * first query, so a client that throws on query marks "got past the check".
 */
import { describe, expect, it } from 'vitest';
import handle from '$indexer/handlers/operatorRegister';
import { CONSENSUS_V2_ACTIVATION_TIME } from '$indexer/consensusActivation';
import { makeCtx } from '../testutils/context';

const PAST_THE_CHECK = 'past the name check';
const client = {
	query: async () => {
		throw new Error(PAST_THE_CHECK);
	}
} as never;

const AT = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
// Only the strict rule catches these (a math letter; a soft hyphen).
const LOOKALIKES = ['\u{1D426}orphit-fees', 'morph­it-fees'];

async function verdict(name: string, blockTime: number): Promise<string> {
	try {
		const r = await handle(
			makeCtx({
				signer: 'mallory',
				blockTime: new Date(blockTime),
				payload: { tag: 'mallory', display_name: name, origin: 'https://mallory.example' }
			}),
			client
		);
		return r.ok ? 'applied' : r.reason;
	} catch (e) {
		if (e instanceof Error && e.message === PAST_THE_CHECK) return 'passed';
		throw e;
	}
}

describe('operator register: strict name rule by block time', () => {
	it.each(LOOKALIKES)('%s: refused from the activation instant', async (name) => {
		expect(await verdict(name, AT)).toBe('display_name_impersonates_reserved');
	});
	it.each(LOOKALIKES)(
		'%s: one second earlier, the old verdict (passes the name check)',
		async (name) => {
			expect(await verdict(name, AT - 1000)).toBe('passed');
		}
	);
	it('a plain name passes on both sides', async () => {
		expect(await verdict('Mallory Market', AT)).toBe('passed');
		expect(await verdict('Mallory Market', AT - 1000)).toBe('passed');
	});
});
