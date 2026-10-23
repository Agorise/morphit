/**
 * The second operator's copy of each chat block is asked for AHEAD of applying
 * it, several at a time (v1.21.14 review A, F2).
 *
 * Since v1.21.14 a block holding a chat or inbox op is applied only when two
 * RPC operators serve the same transaction at that position, and the poller
 * asked for that copy inside its apply loop, one block after another: a
 * window of chat blocks cost one quorum round trip each (about a second over
 * a hidden-service RPC), so catching up after downtime — or a junk chat op in
 * every block — slowed a Tor/I2P node to about one block per round trip.
 *
 * The real Poller over real Postgres; the chain answers every quorum read
 * after QUORUM_RTT_MS.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Poller } from '../../src/indexer/poller';
import { loadConfig } from '../../src/config/index';
import { positionsKey, _resetBlockConfirmForTest } from '../../src/indexer/fee/btcFeeBlockConfirm';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { mockBlurt } from '../testutils/context';

const FIRST = 101;
const COUNT = 30;
const QUORUM_RTT_MS = 100;

function chatBlock(n: number): unknown {
	return {
		timestamp: '2026-10-01T00:01:03',
		transaction_ids: [`c${n}`.padEnd(40, 'f')],
		transactions: [
			{
				operations: [
					[
						'custom_json',
						{
							required_auths: [],
							required_posting_auths: [`u${n}`],
							id: 'morphit_chat_v1',
							json: JSON.stringify({ recipient: 'bob', ciphertext: 'AAAA', header: {} })
						}
					]
				]
			}
		]
	};
}

describe.skipIf(!INTEGRATION_ENABLED)('quorum reads for chat blocks (review A, F2)', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => fx?.teardown());
	beforeEach(async () => {
		await truncateAll(fx);
		_resetBlockConfirmForTest();
	});

	it(`a window of ${COUNT} chat blocks is not ${COUNT} round trips one after another`, async () => {
		const blocks = new Map<number, unknown>();
		for (let n = FIRST; n < FIRST + COUNT; n++) blocks.set(n, chatBlock(n));
		const head = FIRST + COUNT - 1;
		let inFlight = 0;
		let most = 0;
		let asks = 0;
		const chain = mockBlurt({
			operatorCount: () => 3,
			reachableOperatorCount: () => 3,
			endpointCount: () => 3,
			healthyEndpointCount: () => 3,
			fastestLatencyMs: () => 1,
			getDynamicGlobalProperties: async () =>
				({ head_block_number: head, last_irreversible_block_num: head }) as never,
			crossCheckChainConsistency: async () =>
				({ consistent: true, reason: 'ok', agreeing: 3, contacted: 3, required: 2 }) as never,
			getBlocks: (async (nums: readonly number[]) =>
				nums.map((n) => blocks.get(n) ?? null)) as never,
			condenserAgreed: (async (
				_m: string,
				params: unknown[],
				keyOf: (b: unknown) => string | null
			) => {
				asks++;
				inFlight++;
				most = Math.max(most, inFlight);
				await new Promise((r) => setTimeout(r, QUORUM_RTT_MS));
				inFlight--;
				const b = blocks.get(Number(params[0]));
				const key = b === undefined ? null : keyOf(b);
				return key === null ? null : { value: b, key };
			}) as never
		});
		const saved = { ...process.env };
		Object.assign(process.env, {
			MORPHIT_INDEXER_DATABASE_URL: 'postgres://unused@localhost/unused',
			MORPHIT_INDEXER_RELAY_ACCOUNT: 'morphit-relay',
			MORPHIT_INDEXER_FEE_RECIPIENT: 'morphit-fees',
			MORPHIT_INDEXER_CHAIN_ID: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
			MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example.org',
			MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY:
				'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9',
			MORPHIT_INDEXER_BACKFILL_MODE: 'fifo',
			MORPHIT_INDEXER_BACKFILL_CONCURRENCY: '1'
		});
		const config = (() => {
			try {
				return loadConfig();
			} finally {
				process.env = saved;
			}
		})();
		await fx.db.query(
			`INSERT INTO indexer_state (id, last_applied_block, chain_id) VALUES (1, $1, $2)
			 ON CONFLICT (id) DO UPDATE SET last_applied_block = EXCLUDED.last_applied_block`,
			[FIRST - 1, config.chainId]
		);
		const poller = new Poller(config, fx.db, chain, null, null);
		const p = poller as unknown as { status: { indexedBlock: number }; tick(): Promise<void> };
		p.status = { ...p.status, indexedBlock: FIRST - 1 };
		const t0 = Date.now();
		for (let i = 0; i < 20 && poller.getStatus().indexedBlock < head; i++) {
			await p.tick().catch(() => undefined);
		}
		const took = Date.now() - t0;
		expect(poller.getStatus().indexedBlock).toBe(head);
		expect(most, 'quorum reads in flight at once').toBeGreaterThan(1);
		expect(took, 'ms to apply the window').toBeLessThan((COUNT * QUORUM_RTT_MS) / 2);
		// One read per block, not two: the apply used what was fetched ahead.
		expect(asks).toBeLessThanOrEqual(COUNT + 2);
		void positionsKey;
	}, 60_000);
});
