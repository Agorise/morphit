/**
 * Peer price federation end to end: the real receipt route, served
 * from real orders in Postgres, read by the real peer-price consumer.
 *
 * The producer sent `price`; the consumer read `derived_price`, which nothing
 * ever sent. Every peer receipt parsed to null, `price_peer_observations`
 * never got a row, a hidden-only node's federated price never had a sample,
 * and the clearnet gate still reported its price leg as federated. The BLURT
 * plausibility envelope (0.0001–0.1 USD) was also applied to BTC and XMR, so
 * their receipts carried no price at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig } from '../testutils/context';
import { priceReceiptRoute } from '../../src/api/priceReceipt';
import {
	fetchPeerReceipt,
	runPeerPriceSampleCycle,
	_resetPeerPriceMonitorState
} from '../../src/indexer/price/peerPriceMonitor';
import {
	createFederatedFetcher,
	federatedPriceIsLive,
	_resetFederatedRuns
} from '../../src/indexer/price/federatedPriceFetcher';
import { clearnetLegsFromConfig } from '../../src/indexer/clearnetGate';

const ONION = (c: string): string => `${c.repeat(56)}.onion`;

describe.skipIf(!INTEGRATION_ENABLED)('peer price federation, producer to consumer', () => {
	let fx: IntegrationFixture;
	let app: Hono;
	/** A peer transport that answers from the real route. */
	const viaRoute = async <T>(url: string): Promise<T> => {
		const res = await app.request(url);
		return (await res.json()) as T;
	};

	beforeAll(async () => {
		fx = await setupWithMigrations();
		const ins = (acct: string, p: string, price: number, ageMin: number, asset: string) =>
			fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status)
				 VALUES ($1, $2, 'sell', $5, 'USD', $3::jsonb, ARRAY['bank_transfer'], 'live',
				         NOW() - ($4 || ' minutes')::interval, NOW(), 'verified')`,
				[acct, p, JSON.stringify({ kind: 'fixed', price }), ageMin, asset]
			);
		for (const [a, blurt, btc, xmr] of [
			['ann', 0.0021, 61000, 300],
			['ben', 0.0022, 61500, 310],
			['cat', 0.0023, 62000, 320]
		] as const) {
			// Each trader needs an earlier verified order (the Sybil cold-start floor).
			for (const [asset, price] of [
				['BLURT', blurt],
				['BTC', btc],
				['XMR', xmr]
			] as const) {
				await ins(a, `${a}-${asset.toLowerCase()}-old`, price, 300, asset);
				await ins(a, `${a}-${asset.toLowerCase()}-new`, price, 60, asset);
			}
		}
		app = new Hono();
		app.route('/v1/price', priceReceiptRoute(fx.db, fakeConfig()));
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	beforeEach(() => {
		_resetPeerPriceMonitorState();
		_resetFederatedRuns();
	});

	it('the consumer reads a number from the producer, for BLURT and for BTC/XMR', async () => {
		const blurt = await fetchPeerReceipt('http://peer.test', 'BLURT', 'USD', 5000, viaRoute);
		expect(blurt).toEqual({
			asset: 'BLURT',
			denominationFiat: 'USD',
			price: 0.0022,
			sourceNative: 'morphit_native'
		});
		const btc = await fetchPeerReceipt('http://peer.test', 'BTC', 'USD', 5000, viaRoute);
		expect(btc?.price).toBe(61500);
		const xmr = await fetchPeerReceipt('http://peer.test', 'XMR', 'USD', 5000, viaRoute);
		expect(xmr?.price).toBe(310);
	});

	it('a receipt in another denomination is refused', async () => {
		// The peer answers in USD whatever it was asked; a EUR consumer must not use it.
		const usdOnly = <T>(u: string): Promise<T> => viaRoute<T>(u.replace('EUR', 'USD'));
		expect(await fetchPeerReceipt('http://peer.test', 'BLURT', 'EUR', 5000, usdOnly)).toBeNull();
	});

	it('the ETag does not change between two calls with the same content', async () => {
		const a = await app.request('http://peer.test/v1/price/morphit-native/receipt?asset=BLURT');
		await new Promise((r) => setTimeout(r, 5));
		const b = await app.request('http://peer.test/v1/price/morphit-native/receipt?asset=BLURT');
		expect(a.headers.get('etag')).toBeTruthy();
		expect(b.headers.get('etag')).toBe(a.headers.get('etag'));
		const c = await app.request('http://peer.test/v1/price/morphit-native/receipt?asset=BLURT', {
			headers: { 'if-none-match': a.headers.get('etag')! }
		});
		expect(c.status).toBe(304);
	});

	it('a hidden-only node samples three peers, prices from the federation, and only then claims it', async () => {
		await fx.db.query(`TRUNCATE known_instances, price_peer_observations CASCADE`);
		for (const [i, c] of ['d', 'e', 'f'].entries()) {
			await fx.db.query(
				`INSERT INTO operators (account, tag, display_name, registered_in_block, reg_alt_networks)
				 VALUES ($1, $1, $1, 1, $2::jsonb) ON CONFLICT DO NOTHING`,
				[`op${i}`, JSON.stringify({ tor: ONION(c) })]
			);
			await fx.db.query(
				`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time, last_probe_status)
				 VALUES ($1, $2, 1, NOW(), 'good')`,
				[`https://peer${i}.example`, `op${i}`]
			);
		}
		const hiddenCfg = {
			blurtRpcEndpoints: [],
			hiddenRpcEndpoints: [`http://${'a'.repeat(56)}.onion:8091`],
			instanceTorAddress: ONION('b'),
			instanceI2pB32Address: `${'c'.repeat(52)}.b32.i2p`,
			instanceMatrixHomeserver: null
		};
		// Before any federated price: the leg is not claimed.
		expect(clearnetLegsFromConfig(hiddenCfg, true).priceFederated).toBe(false);

		const cycle = await runPeerPriceSampleCycle({
			db: fx.db,
			priceSource: { currentDetailed: () => ({ price: 0.0022, stale: false }) } as never,
			asset: 'BLURT',
			denominationFiat: 'USD',
			hiddenOnly: true,
			hiddenFetch: viaRoute
		});
		expect(cycle.observationsRecorded).toBe(3);
		const rows = await fx.db.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM price_peer_observations WHERE source_native = 'morphit_native'`
		);
		expect(rows.rows[0]!.n).toBe('3');

		const federated = createFederatedFetcher({
			db: fx.db as never,
			asset: 'BLURT',
			denominationFiat: 'USD',
			ownNative: null,
			freshnessMinutes: 240,
			minObservations: 3
		});
		expect(await federated()).toBe(0.0022);
		expect(federatedPriceIsLive('BLURT')).toBe(true);
		expect(clearnetLegsFromConfig(hiddenCfg, true).priceFederated).toBe(true);
	});
});
