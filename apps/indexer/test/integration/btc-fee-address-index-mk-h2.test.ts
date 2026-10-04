/**
 * v1.20.0 (MK-H2) — per-order BTC fee addresses, numbered from chain replay.
 *
 * Before: a BTC fee was a payment to ONE treasury address, claimed by pasting
 * its txid into the order op, so a bot watching the address could claim a
 * victim's payment for its own order first. Now, once a release pins the
 * treasury's BIP84 account xpub, each BTC-fee order op gets receive address n
 * of that xpub, n counting the earlier such ops in chain order — and the
 * numbering must come out the same on every indexer.
 *
 * Real Postgres, the REAL dispatcher (applyBlock: savepoints, event log) and
 * the real order handler. Addresses are checked against the BIP84 test vectors
 * (bip-0084.mediawiki, "abandon … about", account 0): receive #0 =
 * bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu, #1 =
 * bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { applyBlock } from '../../src/indexer/dispatcher';
import { deriveBtcFeeAddress } from '@morphit/release-schema';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, unusedBlurt } from '../testutils/context';
import type { Config } from '../../src/config';
import type { BlurtClient } from '../../src/blurt/client';
import type { AddressPaymentResult, FeeVerifier } from '../../src/indexer/fee/verifier';
import { recheckExternalFees } from '../../src/indexer/fee/externalFeeRecheck';
import { ordersByAccountRoute } from '../../src/api/orders';
import { loadBtcTreasuryReports } from '../../../ops-cli/src/commands/treasury';

// BIP84 test-vector account 0, canonical xpub spelling (zpub6rFR7y4Q2Aij… re-prefixed).
const XPUB_A =
	'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
// An independent account (bip_utils cross-check vector 0).
const XPUB_B =
	'xpub6DAQJuk3fp8AHZTEz7mx9KazuHD2LPT9GGmPLLbM2gv2sHmbnxPB615DomoH5wsFwXgNjREEh5XGDWssDJU68Pmy1kWDjDMx3YJmk7tfRk9';
const SHARED_ADDR = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const T0 = Date.parse('2026-09-27T12:00:00Z');
const HOUR = 3_600_000;

function orderOp(
	signer: string,
	permlink: string,
	extra: Record<string, unknown> = {}
): [string, unknown] {
	return [
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: [signer],
			id: 'morphit_order_v1',
			json: JSON.stringify({
				permlink,
				side: 'sell',
				asset: 'BTC',
				fiat_currency: 'USD',
				amount_min: 100,
				amount_max: 1000,
				price_model: { kind: 'spread', percent: 0 },
				payment_methods: ['cash'],
				fee_method: 'btc',
				...extra
			})
		}
	];
}

const pendingVerifier: FeeVerifier = {
	name: 'stub',
	verify: async () => ({ kind: 'pending_external', reason: 'explorers down' })
};

describe.skipIf(!INTEGRATION_ENABLED)('MK-H2 — BTC fee address numbering', () => {
	let fx: IntegrationFixture;
	let fx2: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
		fx2 = await setupWithMigrations();
	});
	afterAll(async () => {
		if (fx) await fx.teardown();
		if (fx2) await fx2.teardown();
	});
	beforeEach(async () => {
		for (const f of [fx, fx2]) {
			await f.db.query(`TRUNCATE orders, ops, releases, btc_fee_address_log CASCADE`);
		}
	});

	async function pin(
		f: IntegrationFixture,
		block: number,
		btc: Record<string, unknown> | null
	): Promise<void> {
		await f.db.query(
			`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num,
			                       source_trx_id, signer, valid, created_at, treasury)
			 VALUES ('1.20.0', '{}'::jsonb, '{}'::jsonb, '', $1, $2, 'morphit', true, $3, $4::jsonb)`,
			[block, `rel-${block}-${Math.random()}`, new Date(T0), JSON.stringify({ btc, xmr: null })]
		);
	}

	/** One block through the REAL dispatcher. */
	async function apply(
		f: IntegrationFixture,
		blockNum: number,
		ops: [string, unknown][],
		opts: { hoursAfterT0?: number; config?: Partial<Config>; blurt?: BlurtClient } = {}
	): Promise<void> {
		const client: pg.PoolClient = await f.pool.connect();
		try {
			await client.query(`SET search_path TO "${f.schema}"`);
			await client.query('BEGIN');
			await applyBlock(
				client,
				blockNum,
				{
					timestamp: new Date(T0 + (opts.hoursAfterT0 ?? 0) * HOUR).toISOString().slice(0, 19),
					transaction_ids: ops.map((_, i) => `trx-${blockNum}-${i}`),
					transactions: ops.map((op) => ({ operations: [op] }))
				} as unknown as Parameters<typeof applyBlock>[2],
				opts.blurt ?? unusedBlurt(),
				fakeConfig(opts.config ?? {}),
				{ btc: pendingVerifier },
				{ btcSatoshis: 1000 },
				((a: number) => a) as Parameters<typeof applyBlock>[7]
			);
			await client.query('COMMIT');
		} catch (e) {
			await client.query('ROLLBACK');
			throw e;
		} finally {
			client.release();
		}
	}

	async function row(f: IntegrationFixture, account: string, permlink: string) {
		const r = await f.db.query<{
			fee_status: string;
			external_tx_id: string | null;
			btc_fee_index: number | null;
			btc_fee_address: string | null;
			btc_fee_sats: string | null;
			btc_fee_xpub: string | null;
		}>(
			`SELECT fee_status, external_tx_id, btc_fee_index, btc_fee_address, btc_fee_sats::text, btc_fee_xpub
			   FROM orders WHERE account = $1 AND permlink = $2`,
			[account, permlink]
		);
		return r.rows[0] ?? null;
	}

	async function rejectReason(f: IntegrationFixture, account: string, permlink: string) {
		const r = await f.db.query<{ status: string; reject_reason: string | null }>(
			`SELECT status, reject_reason FROM ops WHERE signer = $1 AND payload->>'permlink' = $2
			  ORDER BY block_num DESC, trx_in_block DESC LIMIT 1`,
			[account, permlink]
		);
		return r.rows[0] ?? null;
	}

	it('gives each BTC-fee order after the pin the next address of the pinned xpub', async () => {
		await pin(fx, 100, { address: SHARED_ADDR, satoshis: 1000, xpub: XPUB_A });
		await apply(fx, 101, [orderOp('alice', 'a1'), orderOp('bob', 'b1')]);
		await apply(fx, 102, [orderOp('carol', 'c1')]);

		const a = await row(fx, 'alice', 'a1');
		const b = await row(fx, 'bob', 'b1');
		const c = await row(fx, 'carol', 'c1');
		expect(a).toMatchObject({
			fee_status: 'awaiting_payment',
			external_tx_id: null,
			btc_fee_index: 0,
			btc_fee_address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
			btc_fee_sats: '1000',
			btc_fee_xpub: XPUB_A
		});
		expect(b).toMatchObject({
			btc_fee_index: 1,
			btc_fee_address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'
		});
		expect(c).toMatchObject({ btc_fee_index: 2, btc_fee_address: deriveBtcFeeAddress(XPUB_A, 2) });
	});

	it('refuses a txid claim once the xpub is pinned; the old txid path works before it', async () => {
		await pin(fx, 100, { address: SHARED_ADDR, satoshis: 1000, xpub: XPUB_A });
		// Same block as the release: the pin is not yet in force.
		await apply(fx, 100, [
			orderOp('alice', 'old', { external_tx_id: 'ab'.repeat(32) }),
			orderOp('bob', 'old-no-txid')
		]);
		expect(await row(fx, 'alice', 'old')).toMatchObject({
			fee_status: 'pending_external',
			external_tx_id: 'ab'.repeat(32),
			btc_fee_index: null
		});
		expect(await rejectReason(fx, 'bob', 'old-no-txid')).toEqual({
			status: 'rejected',
			reject_reason: 'external_tx_id_required_for_btc_xmr'
		});
		// After the pin: a pasted txid is refused (the claim race is gone)…
		await apply(fx, 101, [orderOp('mallory', 'steal', { external_tx_id: 'cd'.repeat(32) })]);
		expect(await row(fx, 'mallory', 'steal')).toBeNull();
		expect(await rejectReason(fx, 'mallory', 'steal')).toEqual({
			status: 'rejected',
			reject_reason: 'btc_fee_txid_after_xpub_pin'
		});
		// …and the txid op took no index: the first address order gets #0.
		await apply(fx, 102, [orderOp('carol', 'c1')]);
		expect(await row(fx, 'carol', 'c1')).toMatchObject({ btc_fee_index: 0 });
	});

	it('numbers identically on two indexers with different local settings', async () => {
		for (const f of [fx, fx2])
			await pin(f, 100, { address: SHARED_ADDR, satoshis: 1000, xpub: XPUB_A });
		const blocks: [number, [string, unknown][]][] = [
			[101, [orderOp('alice', 'a1', { payment_methods: ['sepa'] })]],
			// invalid order (bad fiat) — rejected by the validator on BOTH, still numbered
			[102, [orderOp('bob', 'bad', { fiat_currency: 'usd' })]],
			[103, [orderOp('carol', 'c1')]]
		];
		for (const [n, ops] of blocks) {
			// fx2's operator disabled SEPA: alice's order is refused THERE only.
			await apply(fx, n, ops);
			await apply(fx2, n, ops, { config: { disabledPaymentMethods: ['sepa'] } });
		}
		expect(await row(fx2, 'alice', 'a1')).toBeNull();
		expect(await row(fx, 'alice', 'a1')).toMatchObject({ btc_fee_index: 0 });
		const c1 = await row(fx, 'carol', 'c1');
		const c2 = await row(fx2, 'carol', 'c1');
		expect(c1).toMatchObject({ btc_fee_index: 2 });
		expect(c2).toMatchObject({ btc_fee_index: 2, btc_fee_address: c1!.btc_fee_address });
	});

	it('counts ops an older indexer rejected, and rebuilds the same numbering from the event log', async () => {
		await pin(fx, 100, { address: SHARED_ADDR, satoshis: 1000, xpub: XPUB_A });
		// An indexer still on v1.19.x logged this op as rejected (no txid) and
		// wrote nothing else — exactly what the event log holds after an upgrade.
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id,
			                  payload, status, reject_reason)
			 VALUES (101, 0, 0, $1, 'old-trx', 'alice', 'morphit_order_v1', $2::jsonb, 'rejected',
			         'external_tx_id_required_for_btc_xmr')`,
			[new Date(T0), JSON.stringify({ permlink: 'a1', fee_method: 'btc', asset: 'BTC' })]
		);
		await apply(fx, 102, [orderOp('bob', 'b1')]);
		expect(await row(fx, 'bob', 'b1')).toMatchObject({ btc_fee_index: 1 });

		// The log is only a cache: drop it and the next order still gets #2.
		await fx.db.query(`TRUNCATE btc_fee_address_log`);
		await apply(fx, 103, [orderOp('carol', 'c1')]);
		expect(await row(fx, 'carol', 'c1')).toMatchObject({ btc_fee_index: 2 });
		const log = await fx.db.query<{ account: string; idx: number }>(
			`SELECT account, idx FROM btc_fee_address_log ORDER BY block_num`
		);
		expect(log.rows).toEqual([
			{ account: 'alice', idx: 0 },
			{ account: 'bob', idx: 1 },
			{ account: 'carol', idx: 2 }
		]);
	});

	it('caps addresses per account per day and refuses a reused permlink, without burning indices', async () => {
		await pin(fx, 100, { address: SHARED_ADDR, satoshis: 1000, xpub: XPUB_A });
		await apply(fx, 101, [orderOp('alice', 'a1'), orderOp('alice', 'a1')]);
		expect(await rejectReason(fx, 'alice', 'a1')).toEqual({
			status: 'rejected',
			reject_reason: 'btc_fee_permlink_reused'
		});
		await apply(fx, 102, [orderOp('alice', 'a2'), orderOp('alice', 'a3')], { hoursAfterT0: 1 });
		// 3 attempts (a1, a1-again, a2) are in the last 24 h → a3 is refused.
		expect(await rejectReason(fx, 'alice', 'a3')).toEqual({
			status: 'rejected',
			reject_reason: 'btc_fee_daily_limit'
		});
		await apply(fx, 103, [orderOp('bob', 'b1')], { hoursAfterT0: 2 });
		// Only a1 and a2 took indices.
		expect(await row(fx, 'alice', 'a2')).toMatchObject({ btc_fee_index: 1 });
		expect(await row(fx, 'bob', 'b1')).toMatchObject({ btc_fee_index: 2 });
		// A day later alice may post again.
		await apply(fx, 104, [orderOp('alice', 'a4')], { hoursAfterT0: 26 });
		expect(await row(fx, 'alice', 'a4')).toMatchObject({ btc_fee_index: 3 });
	});

	it('V3-6: a block with an injected (never-on-chain) BTC order op is not applied, so numbering does not shift', async () => {
		for (const f of [fx, fx2])
			await pin(f, 100, { address: SHARED_ADDR, satoshis: 1000, xpub: XPUB_A });
		const blockOf = (ops: [string, unknown][], n: number) => ({
			timestamp: new Date(T0).toISOString().slice(0, 19),
			transaction_ids: ops.map((_, i) => `trx-${n}-${i}`),
			transactions: ops.map((op) => ({ operations: [op] }))
		});
		// Two other RPC operators serve the REAL block 101 (no order op in it).
		const honest101 = blockOf([], 101);
		const chain = {
			operatorCount: () => 3,
			reachableOperatorCount: () => 3,
			condenserAgreed: async (_m: string, _p: unknown[], keyOf: (b: unknown) => string | null) => {
				const key = keyOf(honest101);
				return key === null ? null : { value: honest101, key };
			}
		} as unknown as BlurtClient;
		// Node fx is handed a forged block 101 carrying an unsigned order op.
		await expect(apply(fx, 101, [orderOp('ghost', 'g1')], { blurt: chain })).rejects.toThrow(
			/not confirmed/
		);
		// The poller retries the block and gets the real one.
		await apply(fx, 101, [], { blurt: chain });
		await apply(fx2, 101, []);
		for (const f of [fx, fx2]) await apply(f, 102, [orderOp('alice', 'a1'), orderOp('bob', 'b1')]);
		expect((await row(fx, 'alice', 'a1'))?.btc_fee_address).toBe(
			(await row(fx2, 'alice', 'a1'))?.btc_fee_address
		);
		expect((await row(fx, 'alice', 'a1'))?.btc_fee_index).toBe(0);
	});

	it('starts a fresh sequence when the treasury pins a different xpub', async () => {
		await pin(fx, 100, { address: SHARED_ADDR, satoshis: 1000, xpub: XPUB_A });
		await apply(fx, 101, [orderOp('alice', 'a1')]);
		await pin(fx, 110, { address: SHARED_ADDR, satoshis: 1500, xpub: XPUB_B });
		await apply(fx, 111, [orderOp('bob', 'b1')]);
		expect(await row(fx, 'bob', 'b1')).toMatchObject({
			btc_fee_index: 0,
			btc_fee_xpub: XPUB_B,
			btc_fee_address: deriveBtcFeeAddress(XPUB_B, 0),
			btc_fee_sats: '1500'
		});
		// A later re-release with the SAME xpub continues its sequence (the
		// treasury is re-pinned on every release).
		await pin(fx, 120, { address: SHARED_ADDR, satoshis: 1500, xpub: XPUB_B });
		await apply(fx, 121, [orderOp('carol', 'c1')]);
		expect(await row(fx, 'carol', 'c1')).toMatchObject({ btc_fee_index: 1, btc_fee_xpub: XPUB_B });
	});
});

// ─── The re-check loop watches per-order addresses ───────────────────────

describe.skipIf(!INTEGRATION_ENABLED)('MK-H2 — re-check of per-order BTC fee addresses', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		if (fx) await fx.teardown();
	});
	beforeEach(async () => {
		await fx.db.query(`TRUNCATE orders, ops, releases, btc_fee_address_log CASCADE`);
		await fx.db.query(
			`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num,
			                       source_trx_id, signer, valid, created_at, treasury)
			 VALUES ('1.20.0', '{}'::jsonb, '{}'::jsonb, '', 100, 'rel', 'morphit', true, $1, $2::jsonb)`,
			[
				new Date(T0),
				JSON.stringify({ btc: { address: SHARED_ADDR, satoshis: 1000, xpub: XPUB_A }, xmr: null })
			]
		);
		const client: pg.PoolClient = await fx.pool.connect();
		try {
			await client.query(`SET search_path TO "${fx.schema}"`);
			await client.query('BEGIN');
			await applyBlock(
				client,
				101,
				{
					timestamp: new Date(T0).toISOString().slice(0, 19),
					transaction_ids: ['t0', 't1'],
					transactions: [
						{ operations: [orderOp('alice', 'a1')] },
						{ operations: [orderOp('bob', 'b1')] }
					]
				} as unknown as Parameters<typeof applyBlock>[2],
				unusedBlurt(),
				fakeConfig(),
				{},
				{},
				((a: number) => a) as Parameters<typeof applyBlock>[7]
			);
			await client.query('COMMIT');
		} finally {
			client.release();
		}
	});

	function watcher(answer: (address: string, expected: number) => AddressPaymentResult) {
		const asked: { address: string; expected: number }[] = [];
		let txidCalls = 0;
		const v: FeeVerifier = {
			name: 'watch',
			verify: async () => {
				txidCalls++;
				return { kind: 'pending_external', reason: 'n/a' };
			},
			checkAddressPayment: async (address, expected) => {
				asked.push({ address, expected });
				return answer(address, expected);
			}
		};
		return { v, asked, txidCalls: () => txidCalls };
	}

	const state = async (permlink: string) =>
		(
			await fx.db.query<{
				fee_status: string;
				btc_fee_received_sats: string | null;
				btc_fee_unconfirmed_sats: string | null;
			}>(
				`SELECT fee_status, btc_fee_received_sats::text, btc_fee_unconfirmed_sats::text
				   FROM orders WHERE permlink = $1`,
				[permlink]
			)
		).rows[0];

	it('verifies the order whose own address was paid, and only that one', async () => {
		const addr0 = deriveBtcFeeAddress(XPUB_A, 0); // alice
		const w = watcher((address) =>
			address === addr0
				? { kind: 'paid', confirmedSats: 1000, unconfirmedSats: 0 }
				: { kind: 'not_yet', confirmedSats: 0, unconfirmedSats: 500 }
		);
		const changed: string[] = [];
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: w.v },
			amounts: { btcSatoshis: 1000 },
			now: new Date(T0 + HOUR),
			onChange: (id) => changed.push(id)
		});
		expect(w.asked.map((a) => a.address).sort()).toEqual(
			[addr0, deriveBtcFeeAddress(XPUB_A, 1)].sort()
		);
		expect(w.txidCalls()).toBe(0);
		expect(await state('a1')).toEqual({
			fee_status: 'verified',
			btc_fee_received_sats: '1000',
			btc_fee_unconfirmed_sats: '0'
		});
		expect(await state('b1')).toEqual({
			fee_status: 'awaiting_payment',
			btc_fee_received_sats: '0',
			btc_fee_unconfirmed_sats: '500'
		});
		expect(changed).toEqual(['alice/a1']);
	});

	it("asks for the lower of the posted amount and today's pin", async () => {
		const w = watcher(() => ({ kind: 'not_yet', confirmedSats: 0, unconfirmedSats: 0 }));
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: w.v },
			amounts: { btcSatoshis: 800 },
			now: new Date(T0 + HOUR)
		});
		expect(w.asked.map((a) => a.expected)).toEqual([800, 800]);
		const w2 = watcher(() => ({ kind: 'not_yet', confirmedSats: 0, unconfirmedSats: 0 }));
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: w2.v },
			amounts: { btcSatoshis: 1200 },
			now: new Date(T0 + 2 * HOUR)
		});
		expect(w2.asked.map((a) => a.expected)).toEqual([1000, 1000]);
		// No pin known locally at all: the posted amount still stands.
		const w3 = watcher(() => ({ kind: 'not_yet', confirmedSats: 0, unconfirmedSats: 0 }));
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: w3.v },
			amounts: {},
			now: new Date(T0 + 3 * HOUR)
		});
		expect(w3.asked.map((a) => a.expected)).toEqual([1000, 1000]);
	});

	it('keeps an unanswered order waiting, then checks late orders once a day, and stops after 90 days', async () => {
		const none = () => watcher(() => ({ kind: 'no_answer', reason: 'down' }));
		const w = none();
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: w.v },
			amounts: {},
			now: new Date(T0 + HOUR)
		});
		expect(w.asked).toHaveLength(2);
		expect((await state('a1'))!.fee_status).toBe('awaiting_payment');
		// Day 10: an hour after the last check → not yet due (daily after day 7).
		await fx.db.query(`UPDATE orders SET fee_rechecked_at = $1`, [
			new Date(T0 + 240 * HOUR - HOUR)
		]);
		const w10 = none();
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: w10.v },
			amounts: {},
			now: new Date(T0 + 240 * HOUR)
		});
		expect(w10.asked).toHaveLength(0);
		// A day after that check → due again.
		const w11 = none();
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: w11.v },
			amounts: {},
			now: new Date(T0 + 264 * HOUR)
		});
		expect(w11.asked).toHaveLength(2);
		// Day 91 → no longer watched.
		await fx.db.query(`UPDATE orders SET fee_rechecked_at = NULL`);
		const w91 = none();
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: w91.v },
			amounts: {},
			now: new Date(T0 + 91 * 24 * HOUR)
		});
		expect(w91.asked).toHaveLength(0);
	});
});

describe.skipIf(!INTEGRATION_ENABLED)(
	"MK-H2 — the owner's order API carries the fee address",
	() => {
		let fx: IntegrationFixture;
		beforeAll(async () => {
			fx = await setupWithMigrations();
		});
		afterAll(async () => {
			if (fx) await fx.teardown();
		});

		it('returns index, address and amounts for an awaiting order, and nothing for other orders', async () => {
			await fx.db.query(
				`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num,
			                       source_trx_id, signer, valid, created_at, treasury)
			 VALUES ('1.20.0', '{}'::jsonb, '{}'::jsonb, '', 100, 'rel', 'morphit', true, $1, $2::jsonb)`,
				[
					new Date(T0),
					JSON.stringify({ btc: { address: SHARED_ADDR, satoshis: 1000, xpub: XPUB_A }, xmr: null })
				]
			);
			const client: pg.PoolClient = await fx.pool.connect();
			try {
				await client.query(`SET search_path TO "${fx.schema}"`);
				await client.query('BEGIN');
				await applyBlock(
					client,
					101,
					{
						timestamp: new Date(T0).toISOString().slice(0, 19),
						transaction_ids: ['t0', 't1'],
						transactions: [
							{ operations: [orderOp('alice', 'a1')] },
							{ operations: [orderOp('alice', 'a2', { fee_method: 'blurt' })] }
						]
					} as unknown as Parameters<typeof applyBlock>[2],
					unusedBlurt(),
					fakeConfig(),
					{},
					{},
					((a: number) => a) as Parameters<typeof applyBlock>[7]
				);
				await client.query('COMMIT');
			} finally {
				client.release();
			}
			await fx.db.query(
				`UPDATE orders SET btc_fee_unconfirmed_sats = 1000, btc_fee_received_sats = 0 WHERE permlink = 'a1'`
			);
			const res = await ordersByAccountRoute(fx.db, 'morphit').request('/alice');
			const body = (await res.json()) as { items: Record<string, unknown>[] };
			const a1 = body.items.find((o) => o.permlink === 'a1')!;
			const a2 = body.items.find((o) => o.permlink === 'a2')!;
			expect(a1.fee_status).toBe('awaiting_payment');
			expect(a1.btc_fee).toEqual({
				index: 0,
				address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
				sats: 1000,
				received_sats: 0,
				unconfirmed_sats: 1000,
				// (V3-10) the key it was numbered under, so a browser can still
				// derive it after the treasury key is rotated
				xpub: XPUB_A
			});
			expect('btc_fee' in a2).toBe(false);
		});
	}
);

describe.skipIf(!INTEGRATION_ENABLED)(
	'MK-H2 — `morphit-ops treasury btc` reads the real schema',
	() => {
		let fx: IntegrationFixture;
		beforeAll(async () => {
			fx = await setupWithMigrations();
		});
		afterAll(async () => {
			if (fx) await fx.teardown();
		});

		it('reports handed-out indices, payments seen, refusals and a safe gap limit', async () => {
			await fx.db.query(
				`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num,
			                       source_trx_id, signer, valid, created_at, treasury)
			 VALUES ('1.20.0', '{}'::jsonb, '{}'::jsonb, '', 100, 'rel', 'morphit', true, $1, $2::jsonb)`,
				[
					new Date(T0),
					JSON.stringify({ btc: { address: SHARED_ADDR, satoshis: 1000, xpub: XPUB_A }, xmr: null })
				]
			);
			const client: pg.PoolClient = await fx.pool.connect();
			try {
				await client.query(`SET search_path TO "${fx.schema}"`);
				await client.query('BEGIN');
				await applyBlock(
					client,
					101,
					{
						timestamp: new Date(T0).toISOString().slice(0, 19),
						transaction_ids: ['t0', 't1', 't2', 't3'],
						transactions: [
							{ operations: [orderOp('alice', 'a1')] },
							{ operations: [orderOp('bob', 'b1')] },
							{ operations: [orderOp('bob', 'b1')] }, // reused permlink → refused
							{ operations: [orderOp('carol', 'c1')] }
						]
					} as unknown as Parameters<typeof applyBlock>[2],
					unusedBlurt(),
					fakeConfig(),
					{},
					{},
					((a: number) => a) as Parameters<typeof applyBlock>[7]
				);
				await client.query('COMMIT');
			} finally {
				client.release();
			}
			// carol (#2) paid; alice (#0) and bob (#1) not.
			await fx.db.query(
				`UPDATE orders SET fee_status = 'verified', btc_fee_received_sats = 1000 WHERE permlink = 'c1'`
			);
			const reports = await loadBtcTreasuryReports({
				db: fx.db as never,
				config: {} as never,
				flags: {},
				positional: ['btc']
			});
			expect(reports).toHaveLength(1);
			expect(reports[0]).toMatchObject({
				xpub: XPUB_A,
				keyId: 'fd13aac9',
				pinnedInBlock: 100,
				handedOut: 3,
				highestIndex: 2,
				paid: 1,
				awaiting: 2,
				refused: 1,
				longestUnusedRun: 2,
				unusedAboveLastPaid: 0,
				recommendedGapLimit: 20
			});
			expect(reports[0]!.allocations.map((a) => a.address)).toEqual([
				'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
				'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
				deriveBtcFeeAddress(XPUB_A, 2)
			]);
		});
	}
);
