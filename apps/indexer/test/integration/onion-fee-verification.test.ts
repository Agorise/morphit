/**
 * a zero-clearnet node offers and verifies BTC and XMR fees
 * through ONION explorers, and never touches clearnet or DNS doing it.
 *
 * Before: a hidden-only node (no clearnet RPC) built no BTC/XMR verifier at
 * all and advertised both methods off: the only explorers it knew were
 * clearnet https services, and the config refused an `http://<onion>` explorer.
 *
 * Here: the REAL config loader with its DEFAULT explorer lists, the REAL Poller
 * (verifiers, advertising), the REAL order handler and re-check job, over real
 * Postgres. The only stand-ins are Tor's SOCKS port (test/testutils/fakeTor.ts)
 * and the explorers behind the onion names the maintainer tested live on
 * 2026-10-02. The process router is installed fail-closed, as main.ts does on a
 * hidden-only node, and every DNS question is trapped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as http from 'node:http';

import { Poller } from '../../src/indexer/poller';
import { loadConfig, type Config } from '../../src/config/index';
import orderHandler from '../../src/indexer/handlers/order';
import { recheckExternalFees } from '../../src/indexer/fee/externalFeeRecheck';
import {
	installHiddenServiceDispatcher,
	indexerRouterPolicy,
	type HiddenDispatcherHandle
} from '../../src/indexer/hiddenServiceDispatcher';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx, mockBlurt } from '../testutils/context';
import { startFakeTor, sendJson, trapDns, type FakeTor } from '../testutils/fakeTor';

const BTC = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const XMR =
	'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
const BTC_TXID = 'b'.repeat(64);
const XMR_TXID = 'd'.repeat(64);
const XMR_TXKEY = 'e5b4fe26ae0a3a2f7d2bbed8a0c2a1c6d66925ccdbcb6bcef67a0ad66a9b9807';
const NOW = new Date('2026-10-02T12:00:00Z');

/** The live onion explorers (maintainer's Tor check, 2026-10-02). */
const BTC_ONIONS = [
	'mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion',
	'mempool4t6mypeemozyterviq3i5de4kpoua65r3qkn5i3kknu5l2cad.onion',
	'runbtcx3wfygbq2wdde6qzjnpyrqn3gvbks7t5jdymmunxttdvvttpyd.onion',
	'explorerzydxu5ecjrkwceayqybizmpjjznk5izmitf2modhcusuqlid.onion'
];
const XMR_ONIONS = [
	'xmrexplrthytnunr4jasr3vnjc6jo5idsyxzv74a7ep7dy7lwcv2eoyd.onion',
	'nklwsomtuok6dhqqecp3a26xzgokfgmeuaplcdkaxehncg57yzarvbad.onion'
];

/** An Esplora instance (mempool / Blockstream) under /api. */
function esplora(req: http.IncomingMessage, res: http.ServerResponse): void {
	const path = (req.url ?? '').split('?')[0]!;
	if (path === '/api/blocks/tip/height') {
		res.writeHead(200, { 'content-type': 'text/plain' }).end('900100');
		return;
	}
	if (path === `/api/tx/${BTC_TXID}`) {
		sendJson(res, 200, {
			txid: BTC_TXID,
			vout: [{ value: 416, scriptpubkey_address: BTC }],
			status: { confirmed: true, block_height: 900000 }
		});
		return;
	}
	res.writeHead(404).end('Transaction not found');
}

/** onion-monero-blockchain-explorer's JSON API (src/page.h). */
function xmrblocks(req: http.IncomingMessage, res: http.ServerResponse): void {
	const u = new URL(req.url ?? '/', 'http://x');
	if (u.pathname === '/api/networkinfo') {
		sendJson(res, 200, {
			data: { height: 3_500_000, testnet: false, stagenet: false, status: 'OK' },
			status: 'success'
		});
		return;
	}
	if (
		u.pathname === '/api/outputs' &&
		u.searchParams.get('txhash') === XMR_TXID &&
		u.searchParams.get('viewkey') === XMR_TXKEY &&
		u.searchParams.get('txprove') === '1'
	) {
		sendJson(res, 200, {
			data: {
				address: u.searchParams.get('address'),
				outputs: [
					{ amount: 781250000, match: true, output_idx: 0, output_pubkey: 'aa'.repeat(32) }
				],
				tx_confirmations: 12,
				tx_hash: XMR_TXID,
				tx_prove: true
			},
			status: 'success'
		});
		return;
	}
	sendJson(res, 200, { data: { title: 'not found' }, status: 'fail' });
}

const emptyBlock = (n: number) => ({
	timestamp: new Date(Date.parse('2026-10-01T00:00:00Z') + n * 3000).toISOString().slice(0, 19),
	transaction_ids: [],
	transactions: []
});

function loadHiddenOnlyConfig(tor: FakeTor): Config {
	const saved = { ...process.env };
	Object.assign(process.env, {
		MORPHIT_INDEXER_DATABASE_URL: 'postgres://unused@localhost/unused',
		MORPHIT_INDEXER_RELAY_ACCOUNT: 'morphit-relay',
		MORPHIT_INDEXER_FEE_RECIPIENT: 'morphit-fees',
		MORPHIT_INDEXER_CHAIN_ID: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
		MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example.org',
		MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY:
			'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9',
		// Zero-clearnet: no clearnet RPC (the installer's tor-only template).
		MORPHIT_INDEXER_RPC_ENDPOINTS: '',
		MORPHIT_INDEXER_TOR_SOCKS: tor.socks,
		MORPHIT_INDEXER_I2P_HTTP_PROXY: ''
	});
	// The explorer lists are NOT set: the shipped defaults are what is tested.
	delete process.env.MORPHIT_INDEXER_BTC_EXPLORER_URLS;
	delete process.env.MORPHIT_INDEXER_XMR_EXPLORER_URLS;
	try {
		return loadConfig();
	} finally {
		process.env = saved;
	}
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'a zero-clearnet node verifies BTC/XMR fees over onion explorers',
	() => {
		let fx: IntegrationFixture;
		let tor: FakeTor;
		let dns: Awaited<ReturnType<typeof trapDns>>;
		let router: HiddenDispatcherHandle | null = null;
		let poller: Poller;

		beforeAll(async () => {
			fx = await setupWithMigrations();
			await truncateAll(fx);
			tor = await startFakeTor(
				Object.fromEntries([
					...BTC_ONIONS.map((h) => [h, esplora] as const),
					...XMR_ONIONS.map((h) => [h, xmrblocks] as const)
				])
			);
			const config = loadHiddenOnlyConfig(tor);
			dns = await trapDns();
			router = installHiddenServiceDispatcher(
				{ torSocks: tor.socks, i2pHttpProxy: '', lokinet: false },
				indexerRouterPolicy(config)
			);
			await fx.db.query(
				`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num,
				                       source_trx_id, signer, valid, created_at, treasury)
				 VALUES ('1.20.0', '{}'::jsonb, '{}'::jsonb, '', 50, 'rel-50', 'morphit', true, $2, $1::jsonb)`,
				[
					JSON.stringify({
						btc: { address: BTC, satoshis: 416 },
						xmr: { address: XMR, piconero: '781250000' }
					}),
					new Date(NOW.getTime() - 86_400_000)
				]
			);
			for (const n of ['alice', 'bob']) {
				await fx.db.query(
					`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id)
					 VALUES ($1, 'relay', 1, $2, 'x') ON CONFLICT DO NOTHING`,
					[n, new Date(NOW.getTime() - 40 * 86_400_000)]
				);
			}
			const chain = mockBlurt({
				getDynamicGlobalProperties: async () =>
					({ head_block_number: 102, last_irreversible_block_num: 102 }) as never,
				getBlocks: (async (nums: readonly number[]) => nums.map(emptyBlock)) as never
			});
			poller = new Poller(config, fx.db, chain, null, null);
			await (
				poller as unknown as { refreshFeeVerifiersFromTreasury(): Promise<void> }
			).refreshFeeVerifiersFromTreasury();
			// The background source-health probe, run once in the foreground.
			await (
				poller as unknown as { feeSourceHealth?: { probeOnce(): Promise<void> } }
			).feeSourceHealth?.probeOnce();
		}, 60_000);

		afterAll(async () => {
			dns?.restore();
			await router?.uninstall();
			await tor?.close();
			await fx?.teardown();
		});

		it('advertises BTC and XMR (the pinned treasury) once an onion source has answered', () => {
			expect(poller.currentTreasuryAddresses()).toEqual({ btc: BTC, xmr: XMR });
		});

		async function postAndRecheck(payload: Record<string, unknown>, permlink: string) {
			const { verifiers, amounts } = poller.feeCheckCurrent();
			const r = await fx.db.withTx((c) =>
				orderHandler(
					makeCtx({
						signer: 'alice',
						blockNum: 101,
						blockTime: NOW,
						trxId: permlink.padEnd(40, '0').slice(0, 40),
						payload: {
							permlink,
							side: 'sell',
							fiat_currency: 'USD',
							amount_min: 100,
							amount_max: 1000,
							price_model: { kind: 'spread', percent: 0 },
							payment_methods: ['cash'],
							...payload
						},
						feeVerifiers: verifiers,
						feeAmounts: amounts
					}),
					c
				)
			);
			await recheckExternalFees({ db: fx.db, verifiers, amounts, now: NOW });
			const row = await fx.db.query<{ fee_status: string }>(
				`SELECT fee_status FROM orders WHERE account = 'alice' AND permlink = $1`,
				[permlink]
			);
			return { handler: r, status: row.rows[0]?.fee_status ?? null };
		}

		it('a BTC fee is verified through the onion Esplora explorers', async () => {
			const r = await postAndRecheck(
				{ asset: 'BTC', fee_method: 'btc', external_tx_id: BTC_TXID },
				'order-onionbtc1'
			);
			expect(r).toEqual({ handler: { ok: true }, status: 'verified' });
		});

		it('an XMR fee is proven (txprove) through the onion xmrblocks explorers', async () => {
			const r = await postAndRecheck(
				{ asset: 'XMR', fee_method: 'xmr', external_tx_id: XMR_TXID, tx_key: XMR_TXKEY },
				'order-onionxmr1'
			);
			expect(r).toEqual({ handler: { ok: true }, status: 'verified' });
		});

		it('nothing went to clearnet or DNS; every onion request had its own Tor circuit', () => {
			expect(dns.names, 'a DNS question names a host to the resolver: a leak').toEqual([]);
			const asked = tor.streams.map((s) => s.host);
			expect(asked.length).toBeGreaterThan(0);
			expect(asked.filter((h) => !h.endsWith('.onion'))).toEqual([]);
			// Isolation: every stream carried SOCKS credentials, never the same twice.
			const users = tor.streams.map((s) => s.user);
			expect(users.every((u) => typeof u === 'string' && u.length > 0)).toBe(true);
			expect(new Set(users).size).toBe(users.length);
		});
	}
);
