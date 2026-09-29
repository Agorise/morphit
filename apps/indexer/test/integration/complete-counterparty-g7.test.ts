/**
 * v1.20.0 fix wave, G7 — the buyer must not lose their trade credit because
 * the seller's client auto-completed the order first.
 *
 * /my/orders auto-completes a paid order with NO counterparty; the review form
 * then sends a second completion that names the (provable) counterparty. The
 * handler only updated `WHERE status = 'live'`, so the second op answered
 * `target_already_completed` and `completed_counterparty` stayed NULL forever.
 * Now a later completion by the OWNER may fill a still-NULL counterparty (same
 * provable-conversation bar; never overwrites one already recorded). Real
 * handlers + Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import orderHandler from '../../src/indexer/handlers/order';
import orderCompleteHandler from '../../src/indexer/handlers/orderComplete';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx } from '../testutils/context';

const T0 = new Date('2026-09-27T10:00:00Z');
const LATER = new Date('2026-09-27T12:00:00Z');

describe.skipIf(!INTEGRATION_ENABLED)('G7 — a later completion can name the counterparty', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		if (fx) await fx.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		await fx.db.withTx((c) =>
			orderHandler(
				makeCtx({
					signer: 'alice',
					blockTime: T0,
					payload: {
						permlink: 'sell-blurt-1',
						side: 'sell',
						asset: 'BLURT',
						fiat_currency: 'USD',
						amount_min: 10,
						amount_max: 20,
						price_model: { kind: 'spread', percent: 0 },
						payment_methods: ['cash']
					}
				}),
				c
			)
		);
	});

	async function chat(a: string, b: string) {
		const times = ['10:00', '10:10', '10:20', '10:30'];
		for (const [i, t] of times.entries()) {
			const [from, to] = i % 2 === 0 ? [a, b] : [b, a];
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
				 VALUES ($1, $2, 'eA==', '{}'::jsonb, $3, $4)`,
				[from, to, new Date(`2026-09-27T${t}:00Z`), `trx-${a}-${b}-${i}`]
			);
		}
	}
	const complete = (payload: Record<string, unknown>, signer = 'alice') =>
		fx.db.withTx((c) => orderCompleteHandler(makeCtx({ signer, blockTime: LATER, payload }), c));
	const cp = async () =>
		(
			await fx.db.query<{ completed_counterparty: string | null }>(
				`SELECT completed_counterparty FROM orders WHERE permlink = 'sell-blurt-1'`
			)
		).rows[0]?.completed_counterparty;

	it('auto-complete (no counterparty) then the review completion (proven bob) records bob', async () => {
		await chat('alice', 'bob');
		expect(await complete({ permlink: 'sell-blurt-1' })).toEqual({ ok: true });
		expect(await cp()).toBeNull();
		expect(await complete({ permlink: 'sell-blurt-1', counterparty: 'bob' })).toEqual({ ok: true });
		expect(await cp()).toBe('bob');
	});

	it('never overwrites a counterparty already recorded', async () => {
		await chat('alice', 'bob');
		await chat('alice', 'carol');
		await complete({ permlink: 'sell-blurt-1', counterparty: 'bob' });
		const r = await complete({ permlink: 'sell-blurt-1', counterparty: 'carol' });
		expect(r).toEqual({ ok: false, reason: 'target_already_completed' });
		expect(await cp()).toBe('bob');
	});

	it('an unproven name still cannot be attached later', async () => {
		await complete({ permlink: 'sell-blurt-1' });
		const r = await complete({ permlink: 'sell-blurt-1', counterparty: 'stranger' });
		expect(r).toEqual({ ok: false, reason: 'target_already_completed' });
		expect(await cp()).toBeNull();
	});

	it('a non-owner cannot attach a counterparty to someone else’s completed order', async () => {
		await chat('mallory', 'bob');
		await complete({ permlink: 'sell-blurt-1' });
		const r = await complete({ permlink: 'sell-blurt-1', counterparty: 'bob' }, 'mallory');
		expect(r).toEqual({ ok: false, reason: 'target_not_found' });
		expect(await cp()).toBeNull();
	});
});
