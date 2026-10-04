/**
 * the order-contact bypass can no longer turn 20 sock accounts into
 * 1,000 fee-free notifications a day: until the recipient has written to a
 * sender, that sender's messages earn one push per 24 h. The messages
 * themselves are still delivered.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueChatPush } from '../../src/indexer/chatPushEnqueue';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

const T0 = Date.parse('2026-10-01T12:00:00Z');

describe.skipIf(!INTEGRATION_ENABLED)('pushes for unanswered senders', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		await fx.db.query('TRUNCATE push_pending, push_subscriptions CASCADE');
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode, locale)
			 VALUES ('seller', 'https://example.invalid/ep', 'p', 'a', 'standard', 'en')`
		);
	});

	/** A message as the durable handler stores it, then its push. */
	async function message(from: string, to: string, i: number, atMs: number): Promise<void> {
		const trx = `${from}-${i}-`.padEnd(40, '0');
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
			 VALUES ($1, $2, 'AAAA', '{}'::jsonb, $3, $4, 'listing')`,
			[from, to, new Date(atMs), trx]
		);
		await enqueueChatPush(fx.db, {
			recipient: to,
			sender: from,
			orderPermlink: 'listing',
			sourceTrxId: trx,
			eventAt: new Date(atMs)
		});
	}
	const pushes = async () =>
		(
			await fx.db.query<{ n: number }>(
				`SELECT COUNT(*)::int AS n FROM push_pending WHERE account = 'seller'`
			)
		).rows[0]!.n;

	it('20 unanswered senders × 50 messages make 20 notifications, not 1,000', async () => {
		for (let s = 0; s < 20; s++) {
			for (let m = 0; m < 50; m++) await message(`sock${s}`, 'seller', m, T0 + s * 1000 + m * 10);
		}
		expect(await pushes()).toBe(20);
	});

	it('once the recipient replies, every message notifies again; and a new day earns a new push', async () => {
		await message('buyer', 'seller', 1, T0);
		await message('buyer', 'seller', 2, T0 + 60_000);
		expect(await pushes()).toBe(1);
		await message('buyer', 'seller', 3, T0 + 25 * 3_600_000);
		expect(await pushes()).toBe(2);
		await message('seller', 'buyer', 1, T0 + 25 * 3_600_000 + 1000);
		await message('buyer', 'seller', 4, T0 + 25 * 3_600_000 + 2000);
		await message('buyer', 'seller', 5, T0 + 25 * 3_600_000 + 3000);
		expect(await pushes()).toBe(4);
	});
});
