/**
 * a push tombstone outlives the push max age.
 *
 * The tombstone retention was a fixed hour while MORPHIT_RELAY_PUSH_MAX_AGE_SECONDS
 * could be raised without limit. With a two-hour max age, a tombstone pruned
 * after one hour let a late durable enqueue of the same (still "fresh enough")
 * notification in again — pushed twice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { enqueueChatPush } from '../../src/indexer/chatPushEnqueue';
import {
	PushQueueJanitor,
	PUSH_TOMBSTONE_RETENTION_SECONDS
} from '../../../relay/src/policy/pushQueueJanitor.ts';

const MAX_AGE = 2 * 3600;

describe.skipIf(!INTEGRATION_ENABLED)('push tombstones vs a raised max age (rv2-11)', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => fx?.teardown());
	beforeEach(async () => {
		await fx.db.query('DELETE FROM push_pending');
		await fx.db.query('DELETE FROM push_subscriptions');
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode, locale)
			   VALUES ('bob', 'https://example.invalid/ep', 'p', 'a', 'standard', 'en')`
		);
	});
	const queue = (trx: string, ageSec: number) =>
		enqueueChatPush(fx.db, {
			recipient: 'bob',
			sender: 'alice',
			orderPermlink: null,
			sourceTrxId: trx,
			eventAt: new Date(Date.now() - ageSec * 1000)
		});
	const rows = async () =>
		(
			await fx.db.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM push_pending WHERE source_trx_id = 'dup'`
			)
		).rows[0]!.n;

	it('a tombstone older than an hour but younger than the max age still blocks the duplicate', async () => {
		// Delivered 90 minutes ago, for an event 100 minutes old: inside a 2 h max age.
		await queue('dup', 100 * 60);
		await fx.db.query(
			`UPDATE push_pending SET sent_at = NOW() - INTERVAL '90 minutes' WHERE source_trx_id = 'dup'`
		);
		expect(90 * 60).toBeGreaterThan(PUSH_TOMBSTONE_RETENTION_SECONDS);
		await new PushQueueJanitor(fx.db, MAX_AGE).runOnce();
		// The durable enqueue arrives late.
		await queue('dup', 100 * 60);
		const sent = await fx.db.query<{ unsent: number }>(
			`SELECT count(*)::int AS unsent FROM push_pending WHERE source_trx_id = 'dup' AND sent_at IS NULL`
		);
		expect(await rows()).toBe(1);
		expect(sent.rows[0]!.unsent).toBe(0);
	});
});
