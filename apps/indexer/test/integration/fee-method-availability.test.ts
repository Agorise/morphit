/**
 * turning BTC/XMR fees off works, and never
 * stops indexing.
 *
 * Before:
 *   - an empty explorer list plus an address pinned on chain made the poller
 *     build a verifier with no explorers on every loop; the constructor threw
 *     before the loop reached the chain, so the node never indexed again;
 *   - an explicitly empty MORPHIT_INDEXER_{BTC,XMR}_FEE_ADDRESS was ignored as
 *     soon as a release pinned an address, so there was no way to turn a
 *     method off;
 *   - a hidden-only node (no clearnet RPC) built clearnet-explorer verifiers it
 *     can never reach and advertised BTC/XMR on /v1/instance.
 * (reversed b: a hidden-only node now verifies through the
 * default ONION explorers and advertises a method only while one of them
 * answers — test/integration/onion-fee-verification.test.ts. Here no onion
 * explorer has been probed, so it advertises neither.)
 *
 * The REAL Poller, one loop iteration at a time (treasury refresh, then tick),
 * over real Postgres with a release that pins both addresses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Poller } from '../../src/indexer/poller';
import { loadConfig } from '../../src/config/index';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { mockBlurt } from '../testutils/context';

const BTC = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const XMR =
	'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';

const emptyBlock = (n: number) => ({
	timestamp: new Date(Date.parse('2026-10-01T00:00:00Z') + n * 3000).toISOString().slice(0, 19),
	transaction_ids: [],
	transactions: []
});

async function runPoller(
	fx: IntegrationFixture,
	env: Record<string, string>
): Promise<{
	indexedBlock: number;
	treasury: { btc: string | null; xmr: string | null };
	verifiers: { btc: boolean; xmr: boolean };
}> {
	const chain = mockBlurt({
		reachableOperatorCount: () => 1,
		endpointCount: () => 1,
		healthyEndpointCount: () => 1,
		fastestLatencyMs: () => 1,
		getDynamicGlobalProperties: async () =>
			({ head_block_number: 102, last_irreversible_block_num: 102 }) as never,
		crossCheckChainConsistency: async () =>
			({ consistent: true, reason: 'ok', agreeing: 1, contacted: 1, required: 1 }) as never,
		getBlocks: (async (nums: readonly number[]) => nums.map(emptyBlock)) as never
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
		MORPHIT_INDEXER_BACKFILL_CONCURRENCY: '1',
		...env
	});
	const config = (() => {
		try {
			return loadConfig();
		} finally {
			process.env = saved;
		}
	})();
	await fx.db.query(
		`INSERT INTO indexer_state (id, last_applied_block, chain_id) VALUES (1, 100, $1)
		 ON CONFLICT (id) DO UPDATE SET last_applied_block = 100`,
		[config.chainId]
	);
	const poller = new Poller(config, fx.db, chain, null, null);
	const p = poller as unknown as {
		status: { indexedBlock: number };
		tick(): Promise<void>;
		refreshFeeVerifiersFromTreasury(): Promise<void>;
	};
	p.status = { ...p.status, indexedBlock: 100 };
	// What one iteration of the run loop does, three times; an iteration that
	// throws is what the loop logs as tick_failed before backing off.
	for (let i = 0; i < 3 && poller.getStatus().indexedBlock < 102; i++) {
		try {
			await p.refreshFeeVerifiersFromTreasury();
			await p.tick();
		} catch {
			/* the loop backs off and tries again */
		}
	}
	const v = poller.feeCheckCurrent().verifiers;
	return {
		indexedBlock: poller.getStatus().indexedBlock,
		treasury: poller.currentTreasuryAddresses(),
		verifiers: { btc: v.btc !== undefined, xmr: v.xmr !== undefined }
	};
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'BTC/XMR fees can be turned off without stopping indexing',
	() => {
		let fx: IntegrationFixture;
		beforeAll(async () => {
			fx = await setupWithMigrations();
		});
		afterAll(async () => {
			await fx?.teardown();
		});
		beforeEach(async () => {
			await truncateAll(fx);
			await fx.db.query(
				`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num,
			                       source_trx_id, signer, valid, created_at, treasury)
			 VALUES ('1.20.0', '{}'::jsonb, '{}'::jsonb, '', 50, 'rel-50', 'morphit', true, NOW(), $1::jsonb)`,
				[
					JSON.stringify({
						btc: { address: BTC, satoshis: 416 },
						xmr: { address: XMR, piconero: '781250000' }
					})
				]
			);
		});

		it('control: with explorers configured, the pinned addresses are taken and indexing goes on', async () => {
			expect(await runPoller(fx, {})).toMatchObject({
				indexedBlock: 102,
				treasury: { btc: BTC, xmr: XMR }
			});
		});

		it('an empty explorer list with a pinned address: the node indexes to head and advertises the method off', async () => {
			expect(
				await runPoller(fx, {
					MORPHIT_INDEXER_BTC_EXPLORER_URLS: '',
					MORPHIT_INDEXER_XMR_EXPLORER_URLS: ''
				})
			).toMatchObject({ indexedBlock: 102, treasury: { btc: null, xmr: null } });
		});

		it('an explicitly empty fee address turns the method off even though the chain pins one', async () => {
			expect(await runPoller(fx, { MORPHIT_INDEXER_BTC_FEE_ADDRESS: '' })).toMatchObject({
				indexedBlock: 102,
				treasury: { btc: null, xmr: XMR }
			});
			expect(await runPoller(fx, { MORPHIT_INDEXER_XMR_FEE_ADDRESS: '' })).toMatchObject({
				indexedBlock: 102,
				treasury: { btc: BTC, xmr: null }
			});
		});

		it('a hidden-only node builds onion verifiers but advertises neither method before an onion explorer has answered', async () => {
			expect(
				await runPoller(fx, {
					MORPHIT_INDEXER_RPC_ENDPOINTS: '',
					// Nothing listens on port 1: no onion explorer can answer.
					MORPHIT_INDEXER_TOR_SOCKS: '127.0.0.1:1'
				})
			).toEqual({
				indexedBlock: 102,
				treasury: { btc: null, xmr: null },
				verifiers: { btc: true, xmr: true }
			});
		});

		it('a hidden-only node whose lists hold no onion explorer takes neither method', async () => {
			expect(
				await runPoller(fx, {
					MORPHIT_INDEXER_RPC_ENDPOINTS: '',
					MORPHIT_INDEXER_BTC_EXPLORER_URLS: 'https://blockstream.info/api',
					MORPHIT_INDEXER_XMR_EXPLORER_URLS: 'https://xmrchain.net'
				})
			).toEqual({
				indexedBlock: 102,
				treasury: { btc: null, xmr: null },
				verifiers: { btc: false, xmr: false }
			});
		});
	}
);
