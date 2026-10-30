/**
 * /v1/instance: from the consensus activation time, an instance whose fees
 * account is verified unregistered advertises the canonical treasury as
 * `fee_recipient` (where its users' fees go). `morphit-ops status` must still
 * name the CONFIGURED account as the unregistered one, so a local caller also
 * gets `configured_fee_recipient`; a visitor does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { instanceRoute } from '$api/instance';
import { CONSENSUS_V2_ACTIVATION_TIME } from '$indexer/consensusActivation';
import { fakeConfig } from '../testutils/context';

const ACT = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
// No operator tag configured: verified unregistered without a DB row.
const db = { query: async () => ({ rows: [] }) } as never;
const cfg = fakeConfig({ feeRecipient: 'zed-fees', instanceOperatorTag: undefined });

async function read(local: boolean): Promise<Record<string, unknown>> {
	const res = await instanceRoute(cfg, undefined, db).request('/', {
		headers: local ? { 'x-morphit-local-health': '1' } : {}
	});
	return (await res.json()) as Record<string, unknown>;
}

afterEach(() => {
	vi.useRealTimers();
});

describe('/v1/instance: the configured fees account, for the operator', () => {
	it('after the activation time: fee_recipient is the treasury, configured_fee_recipient the unregistered account', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(ACT + 60_000);
		const local = await read(true);
		expect(local).toMatchObject({
			fee_recipient: 'morphit-fees',
			fee_recipient_registered: false,
			configured_fee_recipient: 'zed-fees'
		});
		const pub = await read(false);
		expect(pub.fee_recipient).toBe('morphit-fees');
		expect('configured_fee_recipient' in pub).toBe(false);
	});

	it('before the activation time: both name the configured account', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(ACT - 60_000);
		expect(await read(true)).toMatchObject({
			fee_recipient: 'zed-fees',
			fee_recipient_registered: false,
			configured_fee_recipient: 'zed-fees'
		});
	});
});
