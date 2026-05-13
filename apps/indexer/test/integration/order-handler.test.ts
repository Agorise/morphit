/**
 * Integration test — order handler fee verification against real
 * Postgres. Unit tests mocked the query; this test runs the
 * actual SQL and verifies the Sybil-count predicate behaves
 * correctly (24h cutoff, live OR recent).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import orderHandler from '../../src/indexer/handlers/order';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx } from '../testutils/context';
import type { ChainOperation } from '../../src/blurt/client';

/** Build a matching fee-transfer sibling op for the order. */
function feeTransferOp(
	sender: string,
	amountBlurt: number,
	permlink: string,
	recipient = 'morphit-fees'
): ChainOperation {
	return [
		'transfer',
		{
			from: sender,
			to: recipient,
			amount: `${amountBlurt.toFixed(3)} BLURT`,
			memo: `morphit-fee:${permlink}`
		}
	] as const;
}

function orderPayload(permlink: string) {
	return {
		permlink,
		side: 'sell',
		asset: 'BTC',
		fiat_currency: 'USD',
		amount_min: 100,
		amount_max: 1000,
		price_model: { kind: 'spread', percent: 0 },
		payment_methods: ['cash']
	};
}

async function insertLiveOrder(
	fx: IntegrationFixture,
	account: string,
	permlink: string,
	createdAt: Date
): Promise<void> {
	await fx.db.query(
		`INSERT INTO orders (
			account, permlink, side, asset, fiat_currency,
			price_model, payment_methods, status, fee_status,
			created_at, updated_at
		) VALUES ($1, $2, 'sell', 'BTC', 'USD',
		          '{}'::jsonb, ARRAY['cash'], 'live', 'verified',
		          $3, $3)`,
		[account, permlink, createdAt]
	);
}

describe.skipIf(!INTEGRATION_ENABLED)('order handler fee verification — integration', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});

	afterAll(async () => {
		if (fx) await fx.teardown();
	});

	beforeEach(async () => {
		await truncateAll(fx);
	});

	it('first order: nth=1, fee_status=verified at 62.500 BLURT', async () => {
		const blockTime = new Date('2026-04-19T12:00:00Z');
		const payload = orderPayload('sell-btc-usd-aaa');

		const result = await fx.db.withTx(async (client) => {
			return orderHandler(
				makeCtx({
					signer: 'alice',
					blockTime,
					payload,
					siblingOps: [feeTransferOp('alice', 62.5, payload.permlink)]
				}),
				client
			);
		});
		expect(result).toEqual({ ok: true });

		const row = await fx.db.query<{ fee_status: string }>(
			`SELECT fee_status FROM orders WHERE permlink = $1`,
			[payload.permlink]
		);
		expect(row.rows[0]!.fee_status).toBe('verified');
	});

	it("counts only the user's own orders toward Sybil tier", async () => {
		// Seed: alice has 3 existing live orders in the last hour,
		// bob has 10 live orders. Alice posts her 4th; she should
		// be at tier 4 (1.25×), not affected by bob's volume.
		const now = new Date('2026-04-19T12:00:00Z');
		for (let i = 0; i < 3; i++) {
			await insertLiveOrder(fx, 'alice', `alice-${i}`, new Date(now.getTime() - (i + 1) * 60_000));
		}
		for (let i = 0; i < 10; i++) {
			await insertLiveOrder(fx, 'bob', `bob-${i}`, new Date(now.getTime() - (i + 1) * 60_000));
		}

		const payload = orderPayload('alice-new');
		// Tier 4 fee: 62.5 × 1.25 = 78.125 BLURT.
		const result = await fx.db.withTx(async (client) => {
			return orderHandler(
				makeCtx({
					signer: 'alice',
					blockTime: now,
					payload,
					siblingOps: [feeTransferOp('alice', 78.125, payload.permlink)]
				}),
				client
			);
		});
		expect(result).toEqual({ ok: true });

		const row = await fx.db.query<{ fee_status: string }>(
			`SELECT fee_status FROM orders WHERE permlink = $1`,
			[payload.permlink]
		);
		expect(row.rows[0]!.fee_status).toBe('verified');
	});

	it('excludes orders older than 24h from Sybil count', async () => {
		// Seed: alice has 10 orders, all OLDER than 24h and
		// status='cancelled' (so they don't satisfy the 'live OR
		// recent' predicate). Alice posts a new one; she should
		// be at tier 1, paying 62.5 BLURT.
		const now = new Date('2026-04-19T12:00:00Z');
		const old = new Date(now.getTime() - 48 * 3600 * 1000);
		for (let i = 0; i < 10; i++) {
			await fx.db.query(
				`INSERT INTO orders (
						account, permlink, side, asset, fiat_currency,
						price_model, payment_methods, status, fee_status,
						created_at, updated_at
					) VALUES ($1, $2, 'sell', 'BTC', 'USD',
					          '{}'::jsonb, ARRAY['cash'], 'cancelled', 'verified',
					          $3, $3)`,
				['alice', `alice-old-${i}`, old]
			);
		}

		const payload = orderPayload('alice-new');
		const result = await fx.db.withTx(async (client) => {
			return orderHandler(
				makeCtx({
					signer: 'alice',
					blockTime: now,
					payload,
					siblingOps: [feeTransferOp('alice', 62.5, payload.permlink)]
				}),
				client
			);
		});
		expect(result).toEqual({ ok: true });

		const row = await fx.db.query<{ fee_status: string }>(
			`SELECT fee_status FROM orders WHERE permlink = $1`,
			[payload.permlink]
		);
		// 62.5 BLURT was the CORRECT tier-1 fee given the old
		// orders don't count. If the 24h cutoff predicate were
		// broken, Alice would be computed as tier 11 and this
		// would land as 'underpaid'.
		expect(row.rows[0]!.fee_status).toBe('verified');
	});

	it('missing fee transfer: fee_status=missing', async () => {
		const payload = orderPayload('sell-btc-usd-none');
		const result = await fx.db.withTx(async (client) => {
			return orderHandler(
				makeCtx({
					signer: 'alice',
					payload,
					siblingOps: [] // no transfer at all
				}),
				client
			);
		});
		expect(result).toEqual({ ok: true });

		const row = await fx.db.query<{ fee_status: string }>(
			`SELECT fee_status FROM orders WHERE permlink = $1`,
			[payload.permlink]
		);
		expect(row.rows[0]!.fee_status).toBe('missing');
	});
});
