/**
 * BlurtClient.delegationRules: the chain's minimum delegation and minimum
 * change, and what is delegated now, in Blurt Power (Blurt's
 * delegate_vesting_shares evaluator: new ≥ fee / 3, change ≥ fee / 30).
 * Figures from morphit.io's chain reads on 2026-10-08.
 */
import { describe, expect, it, vi } from 'vitest';
import { BlurtClient } from '../src/blurt/client.ts';

function client(delegations: unknown[]): BlurtClient {
	const c = new BlurtClient(['https://rpc.example.invalid'], 100);
	vi.spyOn(c, 'getChainProperties').mockResolvedValue({
		account_creation_fee: '100.000 BLURT',
		maximum_block_size: 65536
	});
	vi.spyOn(c, 'getVestingInfo').mockResolvedValue({
		total_vesting_fund_blurt: '393735174.767 BLURT',
		total_vesting_shares: '342803631.095390 VESTS'
	});
	(c as unknown as { callWithRotation: () => Promise<unknown> }).callWithRotation = async () =>
		delegations;
	return c;
}

describe('delegationRules', () => {
	it('no delegation yet: a new one must be at least a third of the account fee', async () => {
		const r = await client([]).delegationRules('morphit-relay', 'khrom');
		expect(r.minNewBp).toBeCloseTo(33.333, 3);
		expect(r.minChangeBp).toBeCloseTo(3.333, 3);
		expect(r.currentBp).toBe(0);
	});

	it('an existing delegation is read back in Blurt Power', async () => {
		const r = await client([
			{ delegator: 'morphit-relay', delegatee: 'alice', vesting_shares: '228.062220 VESTS' }
		]).delegationRules('morphit-relay', 'alice');
		expect(r.currentBp).toBeCloseTo(261.95, 1);
	});

	it("another account's delegation (the list starts at the name asked) is not this one", async () => {
		const r = await client([
			{
				delegator: 'morphit-relay',
				delegatee: 'mallory',
				vesting_shares: '53.288127 VESTS'
			}
		]).delegationRules('morphit-relay', 'khrom');
		expect(r.currentBp).toBe(0);
	});
});
