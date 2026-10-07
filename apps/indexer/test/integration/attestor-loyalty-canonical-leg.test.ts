/**
 * the attestor loyalty gate counts only BLURT that reached the
 * canonical treasury (ops in blocks from CONSENSUS_V2_ACTIVATION_TIME on).
 *
 * Before: account_loyalty summed every leg of a verified listing fee. Any
 * account can register an operator naming ITSELF as fee recipient, so a sock
 * posting through that tag paid 90 BLURT back to the grifter and 10 to the
 * treasury, reached the 100-BLURT gate for 10 BLURT, and two such socks
 * promoted an unpaid XMR order to `verified_by_attestation` (HO poc9).
 *
 * Real dispatcher, real handlers, real Postgres. The same chain is applied
 * before and after the activation time: history keeps its verdicts.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBlock } from '../../src/indexer/dispatcher';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';

const ACTIVATION = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
import type { FeeVerifier } from '../../src/indexer/fee/verifier';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

type Op = [string, unknown];
const cj = (signer: string, id: string, json: unknown, active = false): Op => [
	'custom_json',
	{
		required_auths: active ? [signer] : [],
		required_posting_auths: active ? [] : [signer],
		id,
		json: JSON.stringify(json)
	}
];
const xfer = (from: string, to: string, amount: string, memo: string): Op => [
	'transfer',
	{ from, to, amount, memo }
];
const acct = (name: string): Op => [
	'account_create',
	{
		creator: 'morphit-relay',
		new_account_name: name,
		posting: { weight_threshold: 1, key_auths: [['BLT5x', 1]] }
	}
];
const order = (p: string, extra: Record<string, unknown> = {}) => ({
	permlink: p,
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	amount_min: 1,
	amount_max: 2,
	price_model: { kind: 'spread', percent: 0 },
	payment_methods: ['cash_in_person'],
	...extra
});
const xmrDown: FeeVerifier = {
	name: 'xmr-down',
	verify: async () => ({ kind: 'pending_external', reason: 'explorers unreachable' })
};

/** HO poc9 plus an honest payer, at block numbers starting from `base`. */
function chain(base: number): [number, Op[][]][] {
	const sock = (s: string): Op[] => [
		xfer(s, 'grifter', '90.000 BLURT', `morphit-fee:${s}o`),
		xfer(s, 'morphit-fees', '10.000 BLURT', `morphit-fee:${s}o`),
		cj(s, 'morphit_order_v1', order(`${s}o`, { operator_tag: 'grift' }), true)
	];
	const honest = (p: string): Op[] => [
		xfer('hana', 'morphit-fees', '62.500 BLURT', `morphit-fee:${p}`),
		cj('hana', 'morphit_order_v1', order(p), true)
	];
	const attest = (who: string): Op[] => [
		cj(who, 'morphit_fee_attest_v1', { order_account: 'grifter', order_permlink: 'free' })
	];
	return [
		[base, [[acct('sock1'), acct('sock2'), acct('grifter'), acct('hana')]]],
		[
			base + 1,
			[
				[
					cj('grifter', 'morphit_operator_register_v1', {
						v: 1,
						tag: 'grift',
						display_name: 'Grift',
						fee_recipient: 'grifter'
					})
				]
			]
		],
		[base + 2, [sock('sock1'), sock('sock2'), honest('h1'), honest('h2')]],
		[
			base + 3,
			[
				[
					cj(
						'grifter',
						'morphit_order_v1',
						order('free', {
							fee_method: 'xmr',
							external_tx_id: 'a'.repeat(64),
							tx_key: 'b'.repeat(64)
						})
					)
				]
			]
		],
		[base + 4, [attest('sock1'), attest('sock2')]]
	];
}

/** Apply the chain from block `base`, the first block stamped `t0`. */
async function run(fx: IntegrationFixture, base: number, t0: number) {
	for (const [n, trxs] of chain(base)) {
		const c: pg.PoolClient = await fx.pool.connect();
		try {
			await c.query(`SET search_path TO "${fx.schema}"`);
			await c.query('BEGIN');
			await applyBlock(
				c,
				n,
				{
					timestamp: new Date(t0 + (n - base) * 3000).toISOString().slice(0, 19),
					transaction_ids: trxs.map((_, i) => `${n}-${i}`.padEnd(40, 'f')),
					transactions: trxs.map((operations) => ({ operations }))
				} as never,
				mockBlurt({ reachableOperatorCount: () => 1 }),
				fakeConfig({ feeBaseBlurt: 62.5, attestationPhase: 'launch' }),
				{ xmr: xmrDown },
				{ xmrPiconero: 781_250_000n },
				((a: number) => a) as never
			);
			await c.query('COMMIT');
		} catch (e) {
			await c.query('ROLLBACK').catch(() => undefined);
			throw e;
		} finally {
			c.release();
		}
	}
	const socks = await fx.db.query<{ account: string; fee_status: string }>(
		`SELECT account, fee_status FROM orders WHERE account IN ('sock1', 'sock2', 'hana') ORDER BY 1, permlink`
	);
	const attests = await fx.db.query<{ s: string }>(
		`SELECT status || ':' || COALESCE(reject_reason, '') AS s FROM ops
		  WHERE op_id = 'morphit_fee_attest_v1' ORDER BY trx_in_block`
	);
	const free = await fx.db.query<{ fee_status: string }>(
		`SELECT fee_status FROM orders WHERE permlink = 'free'`
	);
	return {
		feesVerified: socks.rows.every((r) => r.fee_status === 'verified') && socks.rows.length === 4,
		attests: attests.rows.map((r) => r.s),
		free: free.rows[0]?.fee_status
	};
}

describe.skipIf(!INTEGRATION_ENABLED)('attestor loyalty counts the canonical leg only', () => {
	let before: IntegrationFixture;
	let after: IntegrationFixture;
	beforeAll(async () => {
		before = await setupWithMigrations();
		after = await setupWithMigrations();
	});
	afterAll(async () => {
		await before?.teardown();
		await after?.teardown();
	});

	it('10 BLURT to the treasury no longer buys a sock the 100-BLURT gate; an unpaid XMR order stays pending', async () => {
		const r = await run(after, 10, ACTIVATION);
		expect(
			r.feesVerified,
			'the sock and honest fees must verify for the scenario to mean anything'
		).toBe(true);
		expect(r.attests.map((s) => s.split(':')[0])).toEqual(['rejected', 'rejected']);
		expect(r.attests.every((s) => s.startsWith('rejected:attestor_'))).toBe(true);
		expect(r.free).toBe('pending_external');
		const loyalty = await after.db.query<{ account: string; c: string }>(
			`SELECT account, canonical_blurt_paid::text AS c FROM account_loyalty ORDER BY 1`
		);
		expect(loyalty.rows.map((r) => [r.account, Number(r.c)])).toEqual([
			['hana', 125],
			['sock1', 10],
			['sock2', 10]
		]);
		// An honest payer who sent 125 BLURT to the treasury clears the gate.
		const { checkAttestorEligibility } = await import('../../src/indexer/attestorEligibility');
		const hana = await checkAttestorEligibility(
			'hana',
			'launch',
			after.db,
			new Date(ACTIVATION + 60_000),
			new Date(ACTIVATION + 60_000)
		);
		expect(hana.eligible).toBe(true);
	});

	it('before the activation time the old measure still decides, so history keeps its verdicts', async () => {
		const r = await run(before, 90, ACTIVATION - 30 * 86_400_000);
		expect(r.feesVerified).toBe(true);
		expect(r.attests).toEqual(['applied:', 'applied:']);
		expect(r.free).toBe('verified_by_attestation');
		// The new measure starts at the activation time: fees paid before it are
		// not counted (else a node that replayed history would hold a different
		// counter than one that applied the same blocks live under the old code).
		const loyalty = await before.db.query<{ c: string }>(
			`SELECT COALESCE(SUM(canonical_blurt_paid), 0)::text AS c FROM account_loyalty`
		);
		expect(Number(loyalty.rows[0]!.c)).toBe(0);
	});
});
