/**
 * Integration tests — self-trade signal detectors against real
 * Postgres. These tests exercise the CTE SQL that unit tests
 * can't meaningfully cover.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	detectRelatedAccountsInTx,
	detectSuspiciousReciprocityInTx
} from '../../src/indexer/signals';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

async function insertAccount(
	fx: IntegrationFixture,
	name: string,
	creator: string,
	createdBlockTime: Date,
	firstActivityAt: Date | null
): Promise<void> {
	await fx.db.query(
		`INSERT INTO accounts (
			name, creator, created_block_num, created_block_time,
			created_trx_id, first_activity_at
		) VALUES ($1, $2, 1, $3, 'trx', $4)`,
		[name, creator, createdBlockTime, firstActivityAt]
	);
}

async function insertFeedback(
	fx: IntegrationFixture,
	reviewer: string,
	subject: string,
	rating: number,
	createdAt: Date,
	trxId: string,
	orderPermlink: string
): Promise<void> {
	await fx.db.query(
		`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		[reviewer, subject, rating, orderPermlink, createdAt, trxId]
	);
}

describe.skipIf(!INTEGRATION_ENABLED)('Signal A — related accounts — integration', () => {
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

	it('flags two accounts with same creator + close first activity', async () => {
		// Shared creator 'carol'. Alice and bob both first active
		// within 3 minutes of each other → within the 5-min window.
		const created = new Date('2026-04-19T09:00:00Z');
		const firstA = new Date('2026-04-19T12:00:00Z');
		const firstB = new Date('2026-04-19T12:03:00Z');
		await insertAccount(fx, 'alice', 'carol', created, firstA);
		await insertAccount(fx, 'bob', 'carol', created, firstB);

		const flagged = await fx.db.withTx((client) => detectRelatedAccountsInTx(client));
		expect(flagged).toBe(1);

		const row = await fx.db.query<{
			account_a: string;
			account_b: string;
			reason: string;
		}>(`SELECT account_a, account_b, reason FROM related_accounts`);
		expect(row.rowCount).toBe(1);
		expect(row.rows[0]!.account_a).toBe('alice'); // canonical a < b
		expect(row.rows[0]!.account_b).toBe('bob');
		expect(row.rows[0]!.reason).toBe('same_creator_close_timing');
	});

	it('does NOT flag accounts with the same creator but far-apart activity', async () => {
		// Same creator but activities 10 minutes apart — beyond the
		// 5-minute window.
		const created = new Date('2026-04-19T09:00:00Z');
		await insertAccount(fx, 'alice', 'carol', created, new Date('2026-04-19T12:00:00Z'));
		await insertAccount(fx, 'bob', 'carol', created, new Date('2026-04-19T12:10:00Z'));

		const flagged = await fx.db.withTx((client) => detectRelatedAccountsInTx(client));
		expect(flagged).toBe(0);
	});

	it('does NOT flag accounts with different creators', async () => {
		const created = new Date('2026-04-19T09:00:00Z');
		const same = new Date('2026-04-19T12:00:00Z');
		await insertAccount(fx, 'alice', 'carol', created, same);
		await insertAccount(fx, 'bob', 'dave', created, same);

		const flagged = await fx.db.withTx((client) => detectRelatedAccountsInTx(client));
		expect(flagged).toBe(0);
	});

	it('does NOT flag accounts where one has null first_activity_at', async () => {
		// Alice has never produced a morphit op. Can't be a Signal A
		// candidate until she acts.
		const created = new Date('2026-04-19T09:00:00Z');
		await insertAccount(fx, 'alice', 'carol', created, null);
		await insertAccount(fx, 'bob', 'carol', created, new Date('2026-04-19T12:00:00Z'));

		const flagged = await fx.db.withTx((client) => detectRelatedAccountsInTx(client));
		expect(flagged).toBe(0);
	});

	it('is idempotent — re-running does not re-insert', async () => {
		const created = new Date('2026-04-19T09:00:00Z');
		const close = new Date('2026-04-19T12:00:00Z');
		await insertAccount(fx, 'alice', 'carol', created, close);
		await insertAccount(fx, 'bob', 'carol', created, close);

		const first = await fx.db.withTx((client) => detectRelatedAccountsInTx(client));
		const second = await fx.db.withTx((client) => detectRelatedAccountsInTx(client));
		expect(first).toBe(1);
		expect(second).toBe(0);
		// Only one row in related_accounts.
		const count = await fx.db.query<{ n: string }>(
			`SELECT COUNT(*)::text AS n FROM related_accounts`
		);
		expect(count.rows[0]!.n).toBe('1');
	});

	it('writes evidence JSONB with creator + gap_seconds', async () => {
		const created = new Date('2026-04-19T09:00:00Z');
		const firstA = new Date('2026-04-19T12:00:00Z');
		const firstB = new Date('2026-04-19T12:02:00Z'); // 120s gap
		await insertAccount(fx, 'alice', 'carol', created, firstA);
		await insertAccount(fx, 'bob', 'carol', created, firstB);

		await fx.db.withTx((client) => detectRelatedAccountsInTx(client));

		const row = await fx.db.query<{ evidence: unknown }>(`SELECT evidence FROM related_accounts`);
		const ev = row.rows[0]!.evidence as {
			creator: string;
			first_activity_gap_seconds: number;
		};
		expect(ev.creator).toBe('carol');
		expect(ev.first_activity_gap_seconds).toBeCloseTo(120, 0);
	});
});

describe.skipIf(!INTEGRATION_ENABLED)('Signal B — suspicious reciprocity — integration', () => {
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

	it('flags mutual high-star reviewers with no third-party feedback', async () => {
		// Alice ↔ Bob: 3 mutual 5-star reviews each way, with
		// distinct order_permlinks so the partial unique index on
		// (reviewer, subject, order_permlink) doesn't fire.
		const now = new Date();
		for (let i = 0; i < 3; i++) {
			await insertFeedback(fx, 'alice', 'bob', 5, now, `t-a-${i}`, `ord-a-${i}`);
			await insertFeedback(fx, 'bob', 'alice', 5, now, `t-b-${i}`, `ord-b-${i}`);
		}

		const flagged = await fx.db.withTx((client) => detectSuspiciousReciprocityInTx(client));
		expect(flagged).toBe(1);

		const row = await fx.db.query<{
			account_a: string;
			account_b: string;
			mutual_review_count: number;
		}>(`SELECT account_a, account_b, mutual_review_count FROM suspicious_reciprocity`);
		expect(row.rows[0]!.account_a).toBe('alice');
		expect(row.rows[0]!.account_b).toBe('bob');
		expect(row.rows[0]!.mutual_review_count).toBe(6); // 3 each way
	});

	it('does NOT flag reviewers who also reviewed third parties', async () => {
		// Alice and Bob mutually 5-star. Alice also reviews Carol.
		// Alice's distinct_subjects = 2 → filtered out.
		const now = new Date();
		for (let i = 0; i < 3; i++) {
			await insertFeedback(fx, 'alice', 'bob', 5, now, `t-a-${i}`, `ord-a-${i}`);
			await insertFeedback(fx, 'bob', 'alice', 5, now, `t-b-${i}`, `ord-b-${i}`);
		}
		await insertFeedback(fx, 'alice', 'carol', 5, now, 't-c', 'ord-c');

		const flagged = await fx.db.withTx((client) => detectSuspiciousReciprocityInTx(client));
		expect(flagged).toBe(0);
	});

	it('does NOT flag pairs with fewer than 3 mutual reviews', async () => {
		const now = new Date();
		for (let i = 0; i < 2; i++) {
			await insertFeedback(fx, 'alice', 'bob', 5, now, `t-a-${i}`, `ord-a-${i}`);
			await insertFeedback(fx, 'bob', 'alice', 5, now, `t-b-${i}`, `ord-b-${i}`);
		}
		const flagged = await fx.db.withTx((client) => detectSuspiciousReciprocityInTx(client));
		expect(flagged).toBe(0);
	});

	it('does NOT flag pairs whose avg rating is below the threshold', async () => {
		// 3 mutual reviews each way, but ratings are 4.0 — below
		// the 4.8 threshold.
		const now = new Date();
		for (let i = 0; i < 3; i++) {
			await insertFeedback(fx, 'alice', 'bob', 4, now, `t-a-${i}`, `ord-a-${i}`);
			await insertFeedback(fx, 'bob', 'alice', 4, now, `t-b-${i}`, `ord-b-${i}`);
		}
		const flagged = await fx.db.withTx((client) => detectSuspiciousReciprocityInTx(client));
		expect(flagged).toBe(0);
	});

	it('honors the 7-day window — old feedback does not count', async () => {
		const old = new Date(Date.now() - 10 * 86_400_000); // 10 days ago
		for (let i = 0; i < 3; i++) {
			await insertFeedback(fx, 'alice', 'bob', 5, old, `t-a-${i}`, `ord-a-${i}`);
			await insertFeedback(fx, 'bob', 'alice', 5, old, `t-b-${i}`, `ord-b-${i}`);
		}
		const flagged = await fx.db.withTx((client) => detectSuspiciousReciprocityInTx(client));
		expect(flagged).toBe(0);
	});
});
