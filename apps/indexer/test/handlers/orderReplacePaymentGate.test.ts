/**
 * A replacement is never refused for the payment methods THIS instance has
 * switched off. MK-12 had added the order handler's "every method disabled
 * here" refusal to replacements from CONSENSUS_V2_ACTIVATION_TIME; that made
 * the stored order depend on each node's MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS.
 * From the activation time the order handler applies such orders too, and
 * each instance hides them on its own read side (api/localHiding.ts), so a
 * replacement is judged by chain data alone, before and after that time.
 */
import { describe, expect, it } from 'vitest';
import orderReplaceHandler from '$indexer/handlers/orderReplace';
import { CONSENSUS_V2_ACTIVATION_TIME } from '$indexer/consensusActivation';
import { fakeConfig, makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

const replacement = (payment_methods: string[]) => ({
	permlink: 'r1',
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	amount_min: 10,
	amount_max: 100,
	price_model: { kind: 'spread', percent: 1 },
	payment_methods
});

const ACTIVATION = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
const AFTER = new Date(ACTIVATION + 1000);
const BEFORE = new Date(ACTIVATION - 1000);

async function verdictWith(
	disabledPaymentMethods: string[],
	methods: string[],
	blockTime: Date
): Promise<string> {
	const r = await orderReplaceHandler(
		makeCtx({
			blockTime,
			payload: replacement(methods),
			config: fakeConfig({ disabledPaymentMethods })
		}),
		makeMockClient().client
	);
	return r.ok ? 'ok' : r.reason;
}

const verdict = (methods: string[], blockTime: Date) =>
	verdictWith(['paypal', 'zelle'], methods, blockTime);

describe('orderReplace does not read this instance’s disabled payment methods', () => {
	it('from the activation time, a replacement offering only disabled methods is judged like any other', async () => {
		const plain = await verdictWith([], ['paypal', 'Zelle'], AFTER);
		expect(plain).not.toBe('payment_methods_all_disabled');
		expect(await verdict(['paypal', 'Zelle'], AFTER)).toBe(plain);
	});
	it('before the activation time it never had the gate', async () => {
		const plain = await verdictWith([], ['paypal', 'zelle'], BEFORE);
		expect(await verdict(['paypal', 'zelle'], BEFORE)).toBe(plain);
	});
});
