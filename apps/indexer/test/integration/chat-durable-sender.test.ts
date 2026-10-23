/**
 * A durably stored chat message's event names its sender (v1.21.14 full chat
 * audit, S-L5), so the activity stream's durable ping can say which way the
 * message went (it always said "not inbound"). Real Postgres, the real
 * dispatcher and chat handler.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyBlock } from '../../src/indexer/dispatcher';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

describe.skipIf(!INTEGRATION_ENABLED)('durable chat events carry the sender', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
		// An established conversation: alice wrote to bob first.
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
			 VALUES ('alice','bob','x','{}'::jsonb, NOW() - INTERVAL '1 day','t0')`
		);
	});
	afterAll(async () => fx?.teardown());

	it("bob's reply to alice is reported as sent by bob", async () => {
		const c: pg.PoolClient = await fx.pool.connect();
		try {
			await c.query(`SET search_path TO "${fx.schema}"`);
			await c.query('BEGIN');
			const result = await applyBlock(
				c,
				1000,
				{
					timestamp: new Date().toISOString().slice(0, 19),
					transaction_ids: ['c'.repeat(40)],
					transactions: [
						{
							ref_block_num: 1,
							ref_block_prefix: 2,
							expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
							signatures: [],
							extensions: [],
							operations: [
								[
									'custom_json',
									{
										required_auths: [],
										required_posting_auths: ['bob'],
										id: 'morphit_chat_v1',
										json: JSON.stringify({
											recipient: 'alice',
											ciphertext: Buffer.from('hi').toString('base64'),
											header: { client_tag: 'd1', ephemeral_pub: 'AAAA', nonce: 'AAAA' }
										})
									}
								]
							]
						}
					]
				} as never,
				mockBlurt({ reachableOperatorCount: () => 1 }),
				fakeConfig({ feeBaseBlurt: 62.5 }),
				{},
				{},
				((a: number) => a) as never
			);
			await c.query('COMMIT');
			expect(result.chatChanges.map((e) => [e.lo, e.hi, e.sender])).toEqual([
				['alice', 'bob', 'bob']
			]);
		} finally {
			c.release();
		}
	});
});
