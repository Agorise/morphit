/**
 * The relay's "is there a stored message to tell her about?" check, against a
 * real Postgres (v1.21.14 full chat audit, S-L8, and the independent review of
 * the audit fixes, finding 6; the worker's use of it is in
 * apps/relay/test/offlineNotifyNotOnChain.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { OfflineNotifyStore } from '../../../relay/src/notify/store.ts';

describe.skipIf(!INTEGRATION_ENABLED)('offline notices: stored message check', () => {
	let fx: IntegrationFixture;
	let store: OfflineNotifyStore;
	const message = (
		sender: string,
		recipient: string,
		at: string,
		id: string,
		thread: string | null = null
	) =>
		fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
			 VALUES ($1, $2, 'x', '{}'::jsonb, $3, $4, $5)`,
			[sender, recipient, at, id, thread]
		);
	const read = (reader: string, peer: string, thread: string, at: string) =>
		fx.db.query(
			`INSERT INTO chat_read_state (reader_account, peer_account, order_permlink, last_read_at,
			                              source_block_num, source_trx_id, updated_at)
			 VALUES ($1, $2, $3, $4, 1, 'x', NOW())`,
			[reader, peer, thread, at]
		);
	beforeAll(async () => {
		fx = await setupWithMigrations();
		store = new OfflineNotifyStore(fx.db as never, {} as never);
	});
	afterAll(async () => fx?.teardown());
	beforeEach(async () => {
		await fx.db.query('DELETE FROM chat_messages');
		await fx.db.query('DELETE FROM chat_read_state');
		await message('friend', 'grandma', '2026-10-15T12:00:03Z', 'm1');
	});

	it('finds an unread stored message from the peer', async () => {
		expect(await store.unreadStoredFrom('grandma', 'friend', '')).toBe(true);
	});
	it('not one in the other direction', async () => {
		expect(await store.unreadStoredFrom('friend', 'grandma', '')).toBe(false);
	});
	it('not one she has read (this thread, or everything from the peer)', async () => {
		await read('grandma', 'friend', '', '2026-10-15T12:01:00Z');
		expect(await store.unreadStoredFrom('grandma', 'friend', '')).toBe(false);
		await fx.db.query('DELETE FROM chat_read_state');
		await read('grandma', 'friend', '*', '2026-10-15T12:01:00Z');
		expect(await store.unreadStoredFrom('grandma', 'friend', '')).toBe(false);
	});
	it('not one she has answered since', async () => {
		await message('grandma', 'friend', '2026-10-15T12:02:00Z', 'r1');
		expect(await store.unreadStoredFrom('grandma', 'friend', '')).toBe(false);
	});
	it('not one in another thread', async () => {
		expect(await store.unreadStoredFrom('grandma', 'friend', 'some-order')).toBe(false);
		await message('friend', 'grandma', '2026-10-15T12:00:09Z', 'o1', 'some-order');
		expect(await store.unreadStoredFrom('grandma', 'friend', 'some-order')).toBe(true);
	});
	it('a real unread message keeps its notice when a LATER one never reached the chain (finding 6)', async () => {
		// The queued notice's time is the later, never-stored message's; the
		// earlier one is stored and unread.
		expect(await store.unreadStoredFrom('grandma', 'friend', '')).toBe(true);
	});
});
