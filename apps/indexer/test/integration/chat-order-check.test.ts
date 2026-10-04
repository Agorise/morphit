/**
 * checkChatOrder is deterministic when sender and recipient both hold
 * an order under the same permlink: the recipient's order decides.
 *
 * Before: `LIMIT 1` without ORDER BY returned whichever row the scan met
 * first, so the stranger-fee bypass verdict depended on physical row order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkChatOrder } from '../../src/indexer/chatGates';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';

describe.skipIf(!INTEGRATION_ENABLED)('checkChatOrder with a shared permlink', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it("the recipient's order decides, whatever order the rows were written in", async () => {
		const insert = (account: string, status: string) =>
			fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method)
				 VALUES ($1, 'shared', 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'], $2, NOW(), NOW(), 'verified', 'blurt')`,
				[account, status]
			);
		// The sender's (cancelled) order is written first, so a plain scan meets it first.
		await insert('sender', 'cancelled');
		await insert('recipient', 'live');
		const r = await checkChatOrder(fx.db as never, {
			permlink: 'shared',
			recipient: 'recipient',
			signer: 'sender',
			blockTime: new Date()
		});
		expect(r).toEqual({ found: true, live: true, ownedByRecipient: true });
	});
});
