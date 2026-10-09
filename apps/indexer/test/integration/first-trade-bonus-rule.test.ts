/**
 * The first-trade welcome bonus (10 BLURT + 10 BLURT Power, paid by the relay
 * of the instance the order was posted through) and what uses it up.
 *
 * WHAT WAS WRONG. The one-time "first trade complete" flag was set by the
 * subject's first reviewed trade of ANY kind, while the bonus is paid only for
 * a review citing the subject's OWN paid order. So a new user whose first trade
 * was a reply to someone else's listing used the flag up and was never paid,
 * however many listings of their own they traded later.
 *
 * NOW (blocks from the consensus activation time, so history keeps the
 * verdicts every node already recorded): only a review citing the subject's own
 * paid order uses the flag up.
 *
 * Runs the real feedback handler against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import feedbackHandler from '../../src/indexer/handlers/feedback';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx } from '../testutils/context';

const AFTER = new Date(Date.parse(CONSENSUS_V2_ACTIVATION_TIME) + 86_400_000);
const BEFORE = new Date(Date.parse(CONSENSUS_V2_ACTIVATION_TIME) - 30 * 86_400_000);

describe.skipIf(!INTEGRATION_ENABLED)('the first-trade welcome bonus', () => {
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

	/** A substantiated conversation between two accounts, before `at`. */
	async function chat(a: string, b: string, at: Date): Promise<void> {
		const t0 = new Date(at.getTime() - 3600_000);
		const rows: Array<[string, string, number]> = [
			[a, b, 0],
			[b, a, 5],
			[a, b, 10],
			[b, a, 20]
		];
		for (const [s, r, min] of rows) {
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
				 VALUES ($1, $2, 'x', '{}'::jsonb, $3, $4)`,
				[s, r, new Date(t0.getTime() + min * 60_000), `${s}-${r}-${min}-${at.getTime()}`]
			);
		}
	}
	/** A paid, completed listing of `owner`, traded with `counterparty`. */
	async function paidOrder(owner: string, permlink: string, counterparty: string, at: Date) {
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model,
			                     payment_methods, status, created_at, updated_at,
			                     fee_status, fee_method, operator_tag, completed_counterparty)
			 VALUES ($1, $2, 'sell', 'BLURT', 'USD', '{}'::jsonb, ARRAY['cash'],
			         'completed', $3, $3, 'verified', 'blurt', 'morphit', $4)`,
			[owner, permlink, at, counterparty]
		);
	}
	let n = 0;
	async function review(signer: string, subject: string, permlink: string, at: Date) {
		n++;
		return fx.db.withTx((c) =>
			feedbackHandler(
				makeCtx({
					signer,
					blockTime: at,
					trxId: String(n).padEnd(40, '0'),
					payload: { subject, rating: 5, order_permlink: permlink }
				}),
				c
			)
		);
	}
	async function bonusRows(): Promise<string[]> {
		const q = await fx.db.query<{ recipient: string; reason: string }>(
			`SELECT recipient, reason FROM relay_pending_transfers ORDER BY reason`
		);
		return q.rows.map((r) => `${r.recipient}:${r.reason}`);
	}

	it("replying to someone else's listing first no longer uses the bonus up", async () => {
		await chat('alice', 'bob', AFTER);
		await chat('carol', 'bob', AFTER);
		// bob's first trade: he answered alice's listing; alice reviews him.
		await paidOrder('alice', 'sell-alice', 'bob', AFTER);
		expect(await review('alice', 'bob', 'sell-alice', AFTER)).toEqual({ ok: true });
		expect(await bonusRows(), 'nothing is owed for a trade on her listing').toEqual([]);
		// Later, a trade on bob's OWN paid listing.
		await paidOrder('bob', 'sell-bob', 'carol', AFTER);
		expect(await review('carol', 'bob', 'sell-bob', AFTER)).toEqual({ ok: true });
		expect(await bonusRows()).toEqual(['bob:welcome_bonus_liquid', 'bob:welcome_bonus_vesting']);
	});

	it('the bonus is still paid once only', async () => {
		await chat('alice', 'bob', AFTER);
		await chat('carol', 'bob', AFTER);
		await paidOrder('bob', 'sell-bob-1', 'alice', AFTER);
		await paidOrder('bob', 'sell-bob-2', 'carol', AFTER);
		expect(await review('alice', 'bob', 'sell-bob-1', AFTER)).toEqual({ ok: true });
		expect(await review('carol', 'bob', 'sell-bob-2', AFTER)).toEqual({ ok: true });
		expect(await bonusRows()).toEqual(['bob:welcome_bonus_liquid', 'bob:welcome_bonus_vesting']);
	});

	it('blocks before the activation time keep the rule every node already applied', async () => {
		await chat('alice', 'bob', BEFORE);
		await chat('carol', 'bob', BEFORE);
		await paidOrder('alice', 'sell-alice', 'bob', BEFORE);
		expect(await review('alice', 'bob', 'sell-alice', BEFORE)).toEqual({ ok: true });
		await paidOrder('bob', 'sell-bob', 'carol', BEFORE);
		expect(await review('carol', 'bob', 'sell-bob', BEFORE)).toEqual({ ok: true });
		expect(await bonusRows(), 'history replays to the same payouts').toEqual([]);
	});
});
