/**
 * BTC/XMR fee explorers are never asked while a block transaction is
 * open.
 *
 * Before: the order handler ran the fee verifier inside applyBlock, so a block
 * of junk XMR fee orders (posting-signed, no fee paid) held the block open for
 * every explorer round trip — 25 orders, ~10 s, 50 outbound requests — and
 * every indexer fired the same burst (HO poc7). The stored verdict also
 * depended on what each node's explorers said at that moment.
 *
 * Real dispatcher, real order handler, real MoneroProofFeeVerifier and
 * BitcoinExplorerFeeVerifier, real re-check job, real Postgres; only the
 * explorers' HTTP answers are simulated.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBlock } from '../../src/indexer/dispatcher';
import {
	ExternalFeeRechecker,
	FRESH_CHECKS_PER_PASS,
	FRESH_CHECK_INTERVAL_MS
} from '../../src/indexer/fee/externalFeeRecheck';
import { MoneroProofFeeVerifier } from '../../src/indexer/fee/moneroProofVerifier';
import { BitcoinExplorerFeeVerifier } from '../../src/indexer/fee/bitcoinExplorerVerifier';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

const XMR_ADDR =
	'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
const BTC_ADDR = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const SATS = 416;
const PICO = 781_250_000n;
const BLOCK_TIME = '2026-10-01T12:00:00';
const T0 = Date.parse(`${BLOCK_TIME}Z`) + 5_000;
const PAID_TXID = 'b1'.repeat(32);

/** Every explorer request, and whether a block transaction was open then. */
const calls: { txOpen: boolean }[] = [];
let txOpen = false;
const explorer = (async (url: string | URL) => {
	calls.push({ txOpen });
	// Answer asynchronously, as a real round trip would (the flag above is
	// read when the request is made, so the answer's timing cannot change it).
	await new Promise((r) => setImmediate(r));
	if (String(url).endsWith(`/tx/${PAID_TXID}`)) {
		return new Response(
			JSON.stringify({
				txid: PAID_TXID,
				vout: [{ value: SATS, scriptpubkey_address: BTC_ADDR }],
				status: { confirmed: true, block_height: 900_000 }
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	}
	return new Response('not found', { status: 404 });
}) as typeof fetch;

const verifiers = {
	xmr: new MoneroProofFeeVerifier(
		{
			feeAddress: XMR_ADDR,
			explorerUrls: ['https://xmr-a.example', 'https://xmr-b.example'],
			minConfirmations: 1,
			requestTimeoutMs: 5_000,
			minSuccessfulResponses: 1
		},
		explorer
	),
	btc: new BitcoinExplorerFeeVerifier(
		{
			feeAddress: BTC_ADDR,
			explorerUrls: ['https://btc-a.example/api'],
			minConfirmations: 1,
			requestTimeoutMs: 5_000,
			minSuccessfulResponses: 1
		},
		explorer
	)
};
const amounts = { btcSatoshis: SATS, xmrPiconero: PICO };

const hex = () => randomBytes(32).toString('hex');
const order = (permlink: string, fee: Record<string, unknown>) => ({
	permlink,
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	amount_min: 1,
	amount_max: 2,
	price_model: { kind: 'spread', percent: 0 },
	payment_methods: ['cash_in_person'],
	...fee
});
const op = (signer: string, payload: unknown) => [
	'custom_json',
	{
		required_auths: [],
		required_posting_auths: [signer],
		id: 'morphit_order_v1',
		json: JSON.stringify(payload)
	}
];

async function applyOne(fx: IntegrationFixture, n: number, ops: unknown[]): Promise<void> {
	const c: pg.PoolClient = await fx.pool.connect();
	try {
		await c.query(`SET search_path TO "${fx.schema}"`);
		await c.query('BEGIN');
		txOpen = true;
		await applyBlock(
			c,
			n,
			{
				timestamp: BLOCK_TIME,
				transaction_ids: [`t${n}`.padEnd(40, '0')],
				transactions: [{ operations: ops }]
			} as never,
			mockBlurt({}),
			fakeConfig({}),
			verifiers,
			amounts,
			((a: number) => a) as never
		);
		await c.query('COMMIT');
	} catch (e) {
		await c.query('ROLLBACK').catch(() => undefined);
		throw e;
	} finally {
		txOpen = false;
		c.release();
	}
}

const statuses = async (fx: IntegrationFixture) =>
	(
		await fx.db.query<{ fee_status: string; n: number }>(
			`SELECT fee_status, COUNT(*)::int AS n FROM orders GROUP BY 1 ORDER BY 1`
		)
	).rows;

describe.skipIf(!INTEGRATION_ENABLED)(
	'BTC/XMR fees are verified outside the block transaction',
	() => {
		let fx: IntegrationFixture;
		beforeAll(async () => {
			fx = await setupWithMigrations();
		});
		afterAll(async () => {
			await fx?.teardown();
		});

		it('a block of junk XMR fee orders makes no explorer request; the re-check settles them, rate-limited', async () => {
			const junk = Array.from({ length: 25 }, (_, i) =>
				op(
					`sock${i % 5}`,
					order(`junk${i}`, { fee_method: 'xmr', external_tx_id: hex(), tx_key: hex() })
				)
			);
			await applyOne(fx, 70, junk);
			expect(
				calls.filter((c) => c.txOpen).length,
				'explorer requests while the block tx was open'
			).toBe(0);
			expect(calls.length).toBe(0);
			expect(await statuses(fx)).toEqual([{ fee_status: 'pending_external', n: 25 }]);

			// A paid BTC order in a later block.
			await applyOne(fx, 71, [
				op('alice', order('paid', { fee_method: 'btc', external_tx_id: PAID_TXID }))
			]);
			expect(calls.length).toBe(0);

			// The job asks the explorers outside any block transaction.
			let now = T0;
			const changed: string[] = [];
			const job = new ExternalFeeRechecker(
				fx.db,
				() => ({ verifiers, amounts }),
				(id) => changed.push(id),
				() => now
			);
			// maybeRun only starts the pass (it runs in the background); wait for it.
			await job.maybeRun();
			await job.whenIdle();
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.filter((c) => c.txOpen).length).toBe(0);

			// New rows are settled within a fresh-row interval or two, never more
			// than FRESH_CHECKS_PER_PASS lookups a pass after the first full pass.
			for (let i = 0; i < 6; i++) {
				now += FRESH_CHECK_INTERVAL_MS;
				const before = await fx.db.query<{ n: number }>(
					'SELECT COUNT(*)::int AS n FROM orders WHERE fee_rechecked_at IS NOT NULL'
				);
				await job.maybeRun();
				await job.whenIdle();
				const after = await fx.db.query<{ n: number }>(
					'SELECT COUNT(*)::int AS n FROM orders WHERE fee_rechecked_at IS NOT NULL'
				);
				expect(after.rows[0]!.n - before.rows[0]!.n).toBeLessThanOrEqual(FRESH_CHECKS_PER_PASS);
			}
			const paid = await fx.db.query<{ fee_status: string }>(
				`SELECT fee_status FROM orders WHERE permlink = 'paid'`
			);
			expect(paid.rows[0]!.fee_status).toBe('verified');
			expect(changed).toContain('alice/paid');
			expect(await statuses(fx)).toEqual([
				{ fee_status: 'missing', n: 25 },
				{ fee_status: 'verified', n: 1 }
			]);
		});
	}
);
