/**
 * /v1/instance tells the frontend which account to pay the 90 % owner leg to.
 * From the consensus activation time only an account registered on chain is
 * accepted by any indexer (feeRecipients.ownerRecipientsAt), so an instance
 * whose account is verified unregistered sends its users' fees whole to the
 * canonical treasury instead of into an `underpaid` order.
 */
import { describe, expect, it } from 'vitest';

import { advertisedFeeRecipient } from '$api/instance';
import { CONSENSUS_V2_ACTIVATION_TIME } from '$indexer/consensusActivation';

const ACT = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
const before = new Date(ACT - 60_000);
const after = new Date(ACT + 60_000);

describe('the fees account /v1/instance advertises', () => {
	it('from the activation time: the canonical treasury when this account is verified unregistered', () => {
		expect(advertisedFeeRecipient('zed-fees', false, after, 'morphit-fees')).toBe('morphit-fees');
	});
	it('a registered account, or one that could not be checked, stays as configured', () => {
		expect(advertisedFeeRecipient('zed-fees', true, after, 'morphit-fees')).toBe('zed-fees');
		expect(advertisedFeeRecipient('zed-fees', null, after, 'morphit-fees')).toBe('zed-fees');
	});
	it('before the activation time: as configured, registered or not', () => {
		expect(advertisedFeeRecipient('zed-fees', false, before, 'morphit-fees')).toBe('zed-fees');
	});
});
