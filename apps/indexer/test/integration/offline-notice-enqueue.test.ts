/**
 * Settings → Offline Notifications, the indexer's half: what a chat message
 * puts in `offline_notify_pending` for the relay's notice worker.
 *
 *   - nothing unless the recipient has a CONFIRMED address on this instance
 *     (a code still waiting does not count);
 *   - one row per thread, due on a quarter hour 10–60 minutes after the
 *     message — a burst, or the fast and durable paths each enqueueing the
 *     same message, adds nothing;
 *   - never for her own message, never for a message older than thirty
 *     minutes (a node catching up after an outage must stay quiet);
 *   - and a failing enqueue inside the block transaction never takes the
 *     stored message with it (the durable handler's savepoint).
 *
 * Skips without TEST_DATABASE_URL, like every other integration suite here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import {
	enqueueOfflineNotice,
	OFFLINE_NOTICE_MAX_AGE_MS,
	OFFLINE_NOTICE_MAX_WAIT_MS,
	OFFLINE_NOTICE_MIN_WAIT_MS,
	OFFLINE_NOTICE_SLOT_MS
} from '../../src/indexer/offlineNoticeEnqueue';
import { enqueueChatPush } from '../../src/indexer/chatPushEnqueue';
import { inSavepoint } from '../../src/indexer/savepoint';
import chatHandler from '../../src/indexer/handlers/chat';
import { makeCtx } from '../testutils/context';

const NOW = new Date('2026-10-15T12:00:00Z');

describe.skipIf(!INTEGRATION_ENABLED)('offline notices: the queue the indexer fills', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await fx.db.query('DELETE FROM offline_notify_pending');
		await fx.db.query('DELETE FROM offline_notify_channels');
		await fx.db.query('DELETE FROM chat_messages');
		await fx.db.query('DELETE FROM push_pending');
		await fx.db.query('DELETE FROM push_subscriptions');
	});

	const rows = async (): Promise<
		Array<{ account: string; sender: string; order_permlink: string; due_at: Date }>
	> =>
		(
			await fx.db.query<{
				account: string;
				sender: string;
				order_permlink: string;
				due_at: Date;
			}>(
				`SELECT account, sender, order_permlink, due_at FROM offline_notify_pending
				  ORDER BY sender, order_permlink`
			)
		).rows;
	const channel = (account: string, verified: boolean): Promise<unknown> =>
		fx.db.query(
			`INSERT INTO offline_notify_channels (account, channel, address_sealed, verified_at)
			 VALUES ($1, 'email', '\\x00'::bytea, $2)`,
			[account, verified ? NOW : null]
		);
	const msg = (sender: string, order: string | null, at: Date = NOW): Promise<void> =>
		enqueueOfflineNotice(
			fx.db,
			{ recipient: 'grandma', sender, orderPermlink: order, eventAt: at },
			NOW
		);

	it('nothing for an account with no confirmed address', async () => {
		await msg('trader-joe', null);
		await channel('grandma', false); // a code is still waiting
		await msg('trader-joe', null);
		expect(await rows()).toEqual([]);
	});

	it('while she changes her address, the one she had still gets notes: messages are queued', async () => {
		await fx.db.query(
			`INSERT INTO offline_notify_channels (account, channel, address_sealed, verified_at, prev_address_sealed, prev_verified_at)
			 VALUES ('grandma', 'email', '\\x01'::bytea, NULL, '\\x00'::bytea, $1)`,
			[NOW]
		);
		await msg('trader-joe', null);
		expect((await rows()).map((r) => r.sender)).toEqual(['trader-joe']);
	});

	it('one row per thread, due on a quarter hour 10–60 minutes after the message', async () => {
		await channel('grandma', true);
		await msg('trader-joe', 'btc-for-mxn-42');
		await msg('trader-joe', 'btc-for-mxn-42', new Date(NOW.getTime() + 60_000));
		await msg('trader-joe', null);
		await msg('stranger-x', null);
		const r = await rows();
		expect(r.map((x) => [x.sender, x.order_permlink])).toEqual([
			['stranger-x', ''],
			['trader-joe', ''],
			['trader-joe', 'btc-for-mxn-42']
		]);
		for (const x of r) {
			const wait = x.due_at.getTime() - NOW.getTime();
			expect(x.due_at.getTime() % OFFLINE_NOTICE_SLOT_MS).toBe(0);
			expect(wait).toBeGreaterThan(OFFLINE_NOTICE_MIN_WAIT_MS);
			expect(wait).toBeLessThanOrEqual(OFFLINE_NOTICE_MAX_WAIT_MS);
		}
	});

	it('a later message in a waiting thread moves its message time, never its due time', async () => {
		await channel('grandma', true);
		await msg('trader-joe', 'btc-for-mxn-42');
		const [first] = await rows();
		const later = new Date(NOW.getTime() + 8 * 60_000);
		await enqueueOfflineNotice(
			fx.db,
			{
				recipient: 'grandma',
				sender: 'trader-joe',
				orderPermlink: 'btc-for-mxn-42',
				eventAt: later
			},
			later
		);
		// …and an earlier copy (the other path, arriving late) moves nothing back.
		await msg('trader-joe', 'btc-for-mxn-42');
		const r = await fx.db.query<{ event_at: Date; due_at: Date }>(
			`SELECT event_at, due_at FROM offline_notify_pending`
		);
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0]!.event_at.getTime()).toBe(later.getTime());
		expect(r.rows[0]!.due_at.getTime()).toBe(first!.due_at.getTime());
	});

	it('never for her own message, never for an old one', async () => {
		await channel('grandma', true);
		await enqueueOfflineNotice(
			fx.db,
			{ recipient: 'grandma', sender: 'grandma', orderPermlink: null, eventAt: NOW },
			NOW
		);
		await msg('trader-joe', null, new Date(NOW.getTime() - OFFLINE_NOTICE_MAX_AGE_MS - 1));
		expect(await rows()).toEqual([]);
		// just inside the window still counts
		await msg('trader-joe', null, new Date(NOW.getTime() - OFFLINE_NOTICE_MAX_AGE_MS + 1000));
		expect(await rows()).toHaveLength(1);
	});

	it('the chat push enqueue fills it whether or not she has a browser subscribed', async () => {
		await channel('grandma', true);
		await enqueueChatPush(fx.db, {
			recipient: 'grandma',
			sender: 'trader-joe',
			orderPermlink: null,
			sourceTrxId: 'trx-1',
			eventAt: new Date()
		});
		expect(await rows()).toHaveLength(1);
	});

	it('a failing enqueue inside the block transaction does not lose the stored message, nor the Web Push', async () => {
		await channel('grandma', true);
		// She has a browser subscribed and has written to trader-joe before, so
		// the message earns her a Web Push as well.
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode)
			 VALUES ('grandma', 'https://push.example/g', 'p', 'a', 'standard')`
		);
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
			 VALUES ('grandma', 'trader-joe', 'eA==', '{}'::jsonb, now() - interval '1 day', 'trx-0')`
		);
		await fx.db.withTx(async (c) => {
			await c.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
				 VALUES ('trader-joe', 'grandma', 'eA==', '{}'::jsonb, now(), 'trx-a')`
			);
			// Make the offline insert fail the way a broken table would.
			await c.query('ALTER TABLE offline_notify_pending RENAME TO offline_notify_pending_away');
			// Exactly what handlers/chat.ts does.
			await inSavepoint(c, 'chat_push_enqueue', () =>
				enqueueChatPush(c, {
					recipient: 'grandma',
					sender: 'trader-joe',
					orderPermlink: null,
					sourceTrxId: 'trx-a',
					eventAt: new Date(),
					inTransaction: true
				})
			).catch(() => undefined);
			// The block transaction carries on: the next statement must work.
			await c.query('ALTER TABLE offline_notify_pending_away RENAME TO offline_notify_pending');
			await c.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
				 VALUES ('trader-joe', 'grandma', 'eA==', '{}'::jsonb, now(), 'trx-b')`
			);
		});
		const stored = await fx.db.query<{ source_trx_id: string }>(
			`SELECT source_trx_id FROM chat_messages ORDER BY source_trx_id`
		);
		expect(stored.rows.map((r) => r.source_trx_id)).toEqual(['trx-0', 'trx-a', 'trx-b']);
		const push = await fx.db.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM push_pending WHERE account = 'grandma' AND source_trx_id = 'trx-a'`
		);
		expect(push.rows[0]?.n, 'the Web Push survived the failed offline insert').toBe('1');
	});

	it('the real chat handler: a failing offline insert keeps the message and the Web Push', async () => {
		await channel('grandma', true);
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode)
			 VALUES ('grandma', 'https://push.example/g', 'p', 'a', 'standard')`
		);
		// grandma wrote to trader-joe before: he is admitted, and she gets a push.
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
			 VALUES ('grandma', 'trader-joe', 'eA==', '{}'::jsonb, now() - interval '1 day', 'trx-0')`
		);
		const trxId = 'a'.repeat(40);
		const result = await fx.db.withTx(async (c) => {
			await c.query('ALTER TABLE offline_notify_pending RENAME TO offline_notify_pending_away');
			const r = await chatHandler(
				makeCtx({
					signer: 'trader-joe',
					trxId,
					blockTime: new Date(),
					payload: {
						recipient: 'grandma',
						ciphertext: 'aGVsbG8=',
						header: { n: 1, dh: 'a'.repeat(43) }
					}
				}),
				c
			);
			// The block transaction carries on.
			await c.query('ALTER TABLE offline_notify_pending_away RENAME TO offline_notify_pending');
			return r;
		});
		expect(result).toMatchObject({ ok: true });
		const stored = await fx.db.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM chat_messages WHERE source_trx_id = $1`,
			[trxId]
		);
		expect(stored.rows[0]?.n).toBe('1');
		const push = await fx.db.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM push_pending WHERE account = 'grandma' AND source_trx_id = $1`,
			[trxId]
		);
		expect(push.rows[0]?.n, 'the Web Push survived the failed offline insert').toBe('1');
		// And with the table there, the same handler queues the notice.
		const trx2 = 'b'.repeat(40);
		await fx.db.withTx((c) =>
			chatHandler(
				makeCtx({
					signer: 'trader-joe',
					trxId: trx2,
					blockTime: new Date(),
					payload: {
						recipient: 'grandma',
						ciphertext: 'aGVsbG8=',
						header: { n: 2, dh: 'b'.repeat(43) }
					}
				}),
				c
			)
		);
		expect((await rows()).map((r) => r.sender)).toEqual(['trader-joe']);
	});
});
