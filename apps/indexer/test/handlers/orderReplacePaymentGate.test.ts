/**
 * a replacement may not swap a live order's payment methods for
 * ones this instance has turned off. The order handler refuses an order whose
 * every method is disabled here; orderReplace skipped that gate (MK-12). From
 * CONSENSUS_V2_ACTIVATION_TIME it applies to replacements too.
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

async function verdict(methods: string[], blockTime: Date): Promise<string> {
	const r = await orderReplaceHandler(
		makeCtx({
			blockTime,
			payload: replacement(methods),
			config: fakeConfig({ disabledPaymentMethods: ['paypal', 'zelle'] })
		}),
		makeMockClient().client
	);
	return r.ok ? 'ok' : r.reason;
}

describe('orderReplace honours the disabled-payment-method gate', () => {
	it('from the activation time, a replacement offering only disabled methods is refused', async () => {
		expect(await verdict(['paypal', 'Zelle'], AFTER)).toBe('payment_methods_all_disabled');
	});
	it('a replacement keeping one enabled method passes the gate', async () => {
		expect(await verdict(['paypal', 'cash_in_person'], AFTER)).not.toBe(
			'payment_methods_all_disabled'
		);
	});
	it('before the activation time the old verdict stands', async () => {
		expect(await verdict(['paypal', 'zelle'], BEFORE)).not.toBe('payment_methods_all_disabled');
	});
});
