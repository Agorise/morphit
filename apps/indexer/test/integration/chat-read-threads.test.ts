/**
 * morphit_chat_read_v1 no longer stores a free row for any
 * string: from CONSENSUS_V2_ACTIVATION_TIME the order_permlink must have a
 * permlink's shape, and one reader keeps at most MAX_THREADS_PER_PEER thread
 * rows per peer (HO-10: one row per distinct value, unbounded).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import chatReadHandler, { MAX_THREADS_PER_PEER } from '../../src/indexer/handlers/chatRead';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';

const ACTIVATION = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
const at = (secondsAfter: number): Date => new Date(ACTIVATION + secondsAfter * 1000);
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { makeCtx } from '../testutils/context';

describe.skipIf(!INTEGRATION_ENABLED)('chat read acks per thread', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	const ack = (blockTime: Date, order_permlink: string) =>
		fx.db.withTx((c) =>
			chatReadHandler(
				makeCtx({
					signer: 'reader',
					blockNum: 900,
					blockTime,
					payload: { peer: 'peer', last_read_at: '2026-10-01T11:59:00Z', order_permlink }
				}),
				c
			)
		);

	it('from the activation time: a malformed permlink is refused and the per-peer thread rows are capped', async () => {
		expect(await ack(at(0), 'Not A Permlink!')).toEqual({
			ok: false,
			reason: 'order_permlink_invalid'
		});
		await fx.db.query(
			`INSERT INTO chat_read_state (reader_account, peer_account, order_permlink, last_read_at,
			                              source_block_num, source_trx_id, updated_at)
			 SELECT 'reader', 'peer', 'thread-' || g, '2026-10-01T00:00:00Z', 1, 'x', NOW()
			   FROM generate_series(1, $1) g`,
			[MAX_THREADS_PER_PEER]
		);
		expect(await ack(at(1), 'one-more-thread')).toEqual({
			ok: false,
			reason: 'chat_read_threads_limit'
		});
		// an existing thread still advances
		expect(await ack(at(2), 'thread-7')).toEqual({ ok: true });
	});

	it('before the activation time the old verdict stands', async () => {
		expect(await ack(at(-1), 'Not A Permlink!')).toEqual({ ok: true });
	});
});
