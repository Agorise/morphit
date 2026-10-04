/**
 * The relay's push-queue janitor, against a real Postgres.
 *
 * v1.18.0. A relay with push OFF — every hidden-only relay, and so every
 * existing tor-only node after upgrading — runs no sender, and the sender was
 * the only thing that retired or pruned `push_pending`. Users who subscribed
 * while push worked keep the indexer queueing for them, so the table grew for
 * as long as the node ran. The janitor applies the sender's own rules instead.
 *
 * A fake database would prove the janitor SENDS its SQL; only a real one proves
 * the SQL does what it says — the interval arithmetic, the NULL handling, and
 * that a retired row still blocks a late duplicate the way the sender's
 * tombstones do.
 *
 * The janitor lives in the relay; it is imported by path, and takes the
 * narrowest query shape precisely so it can be run here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { enqueueChatPush } from '../../src/indexer/chatPushEnqueue';
import {
	PushQueueJanitor,
	PUSH_TOMBSTONE_RETENTION_SECONDS
} from '../../../relay/src/policy/pushQueueJanitor.ts';

const MAX_AGE = 3600;
const RECIPIENT = 'bob';

describe.skipIf(!INTEGRATION_ENABLED)('push_pending stays bounded with push off', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await fx.db.query('DELETE FROM push_pending');
		await fx.db.query('DELETE FROM push_subscriptions');
		// A subscription taken while push worked — the state every existing
		// tor-only node upgrades into. Without it the indexer queues nothing.
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode, locale)
			   VALUES ($1, 'https://example.invalid/ep', 'p', 'a', 'standard', 'en')`,
			[RECIPIENT]
		);
		// The recipient has written back to the sender, so every message
		// notifies (the one-push-per-day cap for unanswered senders, is
		// not what this suite is about).
		await fx.db.query('DELETE FROM chat_messages');
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
			   VALUES ($1, 'alice', 'AAAA', '{}'::jsonb, NOW() - INTERVAL '30 days', 'reply-0')`,
			[RECIPIENT]
		);
	});

	/** Queue a notification the way the indexer does, for an event `ageSec` old. */
	const queue = async (trx: string, ageSec: number): Promise<void> => {
		await enqueueChatPush(fx.db, {
			recipient: RECIPIENT,
			sender: 'alice',
			orderPermlink: null,
			sourceTrxId: trx,
			eventAt: new Date(Date.now() - ageSec * 1000)
		});
	};
	const state = async () => {
		const r = await fx.db.query<{ source_trx_id: string; sent: boolean }>(
			`SELECT source_trx_id, sent_at IS NOT NULL AS sent FROM push_pending ORDER BY source_trx_id`
		);
		return Object.fromEntries(r.rows.map((x) => [x.source_trx_id, x.sent ? 'retired' : 'queued']));
	};
	const janitor = () => new PushQueueJanitor(fx.db, MAX_AGE);

	it('control: with nothing sending, the queue only grows', async () => {
		for (let i = 0; i < 5; i++) await queue(`old${i}`, MAX_AGE * 3);
		expect(Object.keys(await state())).toHaveLength(5);
	});

	it('an event too old to push is retired; a fresh one is left for a sender that may return', async () => {
		await queue('fresh', 60);
		await queue('stale', MAX_AGE + 600);
		const r = await janitor().runOnce();
		expect(r.retired).toBe(1);
		expect(await state()).toEqual({ fresh: 'queued', stale: 'retired' });
	});

	it('a retired row is pruned once it is older than the tombstone retention — and not before', async () => {
		await queue('young-tomb', MAX_AGE * 2);
		await queue('old-tomb', MAX_AGE * 2);
		await janitor().runOnce(); // retires both, stamping sent_at = now
		// Age one tombstone past the retention, as the passage of time would.
		await fx.db.query(
			`UPDATE push_pending SET sent_at = NOW() - ($1::int * INTERVAL '1 second')
			  WHERE source_trx_id = 'old-tomb'`,
			[PUSH_TOMBSTONE_RETENTION_SECONDS + 60]
		);
		const r = await janitor().runOnce();
		expect(r.pruned).toBe(1);
		expect(await state()).toEqual({ 'young-tomb': 'retired' });
	});

	/** THE DEDUP. The sender retires rather than deletes so a durable enqueue
	 *  arriving late lands on a conflict; the janitor must keep that promise, or
	 *  a node whose push later comes back re-notifies. */
	it('a retired row still blocks a late duplicate of the same message', async () => {
		await queue('same-trx', MAX_AGE + 600);
		await janitor().runOnce();
		await queue('same-trx', 10); // the durable path, late
		expect(await state()).toEqual({ 'same-trx': 'retired' });
	});

	it('bounded: a backlog of stale notifications is gone after retire + retention', async () => {
		for (let i = 0; i < 20; i++) await queue(`b${String(i).padStart(2, '0')}`, MAX_AGE * 5);
		await janitor().runOnce();
		await fx.db.query(`UPDATE push_pending SET sent_at = NOW() - ($1::int * INTERVAL '1 second')`, [
			PUSH_TOMBSTONE_RETENTION_SECONDS + 60
		]);
		await janitor().runOnce();
		expect(await state()).toEqual({});
	});
});
