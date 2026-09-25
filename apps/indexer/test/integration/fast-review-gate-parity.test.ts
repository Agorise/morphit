/**
 * The head tailer's fast REVIEW notification must admit a subset of what the
 * durable feedback handler admits (v1.18.0 deep-deep, rv6-L1).
 *
 * It did not. The durable handler accepted a cited order only when its
 * `fee_status = 'verified'`; the tailer's own copy of the query also accepted
 * `'verified_by_attestation'`. So a review citing an attested order notified
 * its subject within seconds and then never indexed — and, never indexed, it
 * could be re-sent with no duplicate check ever stopping it: unlimited
 * "X left you a 1★ review" pushes from anyone with a verified conversation.
 *
 * Both paths now call one predicate. This drives BOTH, against the same real
 * database rows, and asserts they agree — the property, not the SQL.
 *
 * Skips without TEST_DATABASE_URL, like every other integration suite here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import feedbackHandler from '../../src/indexer/handlers/feedback';
import { HeadTailer } from '../../src/indexer/headTailer';
import { makeCtx } from '../testutils/context';

const REVIEWER = 'alice';
const SUBJECT = 'bob';
const BLOCK_TIME = new Date('2026-04-19T12:00:00Z');

interface FastFeedbackGate {
	fastFeedbackAllowed(
		fb: { reviewer: string; subject: string; rating: number; orderPermlink: string },
		createdAt: Date
	): Promise<boolean>;
}

describe.skipIf(!INTEGRATION_ENABLED)('fast review notification ⊆ durable review admission', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		const order = (permlink: string, feeStatus: string, feeMethod: string): Promise<unknown> =>
			fx.db.query(
				`INSERT INTO orders (
				   account, permlink, side, asset, fiat_currency,
				   price_model, payment_methods, status, fee_status, fee_method,
				   created_at, updated_at, expires_at
				 ) VALUES ($1, $2, 'sell', 'BTC', 'USD',
				           '{}'::jsonb, ARRAY['cash'], 'live', $3, $4,
				           $5, $5, NULL)`,
				[SUBJECT, permlink, feeStatus, feeMethod, new Date('2026-04-18T00:00:00Z')]
			);
		await order('attested-order', 'verified_by_attestation', 'btc');
		await order('paid-order', 'verified', 'blurt');
		// A substantiated conversation (≥2 each way over ≥15 min), so the
		// provable-counterparty bar passes and the CITATION is the only
		// difference between the cases.
		const times = ['10:00', '10:10', '10:20', '10:30'];
		for (const [i, t] of times.entries()) {
			const [from, to] = i % 2 === 0 ? [REVIEWER, SUBJECT] : [SUBJECT, REVIEWER];
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
				 VALUES ($1, $2, 'eA==', '{}'::jsonb, $3, $4)`,
				[from, to, new Date(`2026-04-19T${t}:00Z`), `trx-chat-${i}`]
			);
		}
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	/** The durable verdict, inside a transaction that is rolled back. */
	const durable = async (permlink: string): Promise<{ ok: boolean; reason?: string }> => {
		const client = await fx.pool.connect();
		try {
			await client.query('BEGIN');
			const r = await feedbackHandler(
				makeCtx({
					signer: REVIEWER,
					blockTime: BLOCK_TIME,
					trxId: `trx-review-${permlink}`,
					payload: { subject: SUBJECT, rating: 1, order_permlink: permlink }
				}),
				client
			);
			return r as { ok: boolean; reason?: string };
		} finally {
			await client.query('ROLLBACK');
			client.release();
		}
	};

	const fast = (permlink: string): Promise<boolean> => {
		const tailer = new HeadTailer({} as never, fx.db, {} as never);
		return (tailer as unknown as FastFeedbackGate).fastFeedbackAllowed(
			{ reviewer: REVIEWER, subject: SUBJECT, rating: 1, orderPermlink: permlink },
			BLOCK_TIME
		);
	};

	it('a review citing an ATTESTED order: the durable handler rejects it, and the fast path does not notify', async () => {
		const d = await durable('attested-order');
		expect(d.ok, 'the durable handler must reject this citation').toBe(false);
		expect(d.reason).toBe('order_permlink_not_found_or_unverified');
		expect(
			await fast('attested-order'),
			'the fast path notified for a review the durable path rejects — a push for a review that never exists'
		).toBe(false);
	});

	it('a review citing a PAID order: both admit it (the fast path is not simply switched off)', async () => {
		expect(await fast('paid-order')).toBe(true);
		const d = await durable('paid-order');
		expect(d.reason).not.toBe('order_permlink_not_found_or_unverified');
	});
});
