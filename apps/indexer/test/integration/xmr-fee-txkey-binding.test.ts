/**
 * v1.20.0 — XMR listing fees that can actually verify (M-X1) and that are
 * bound to their order (MK-H2).
 *
 * M-X1: the verifier used to send the payer's OutProof string as the upstream
 * explorer's `viewkey`, which that API parses as a 64-hex tx private key only
 * (onion-monero-blockchain-explorer page.h json_outputs → parse_str_secret_key
 * → parse_hash256) — so every XMR order ended `missing`. Orders now carry the
 * tx key; OutProof-only orders are stored `proof_unsupported`, deterministically,
 * and never re-checked.
 *
 * MK-H2: once a release pins treasury.xmr.primary_address, the payment must go
 * to the integrated address carrying the order's payment ID, so a txid + key
 * copied from someone else's order op pays for nothing — and cannot take the
 * victim's order down as `reused` either.
 *
 * Real Postgres, the real dispatcher + order handler + re-check SQL + attest
 * handler; the explorer is a stub that behaves like the real one (a payment ID
 * only decrypts for the order it was made for).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { applyBlock } from '../../src/indexer/dispatcher';
import feeAttestHandler from '../../src/indexer/handlers/feeAttest';
import { recheckExternalFees } from '../../src/indexer/fee/externalFeeRecheck';
import type { FeeClaim, FeeVerifier } from '../../src/indexer/fee/verifier';
import { runMigrations } from '../../src/db/migrations';
import { xmrFeePaymentId } from '@morphit/release-schema';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, makeCtx, unusedBlurt } from '../testutils/context';

const PRIMARY =
	'447UAtPLv7u8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49CyFBGy';
const SUBADDRESS =
	'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
const TXKEY = 'e5b4fe26ae0a3a2f7d2bbed8a0c2a1c6d66925ccdbcb6bcef67a0ad66a9b9807';
const TXID = 'd'.repeat(64);
const OUTPROOF = 'OutProofV2' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'.repeat(3);
const T0 = Date.parse('2026-09-28T12:00:00Z');
const OLD = new Date(T0 - 400 * 86_400_000);

function xmrOp(
	signer: string,
	permlink: string,
	extra: Record<string, unknown>
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
				fee_method: 'xmr',
				external_tx_id: TXID,
				...extra
			})
		}
	];
}

/** Stands in for the explorers. Like the real ones it can only prove the
 *  amount with the right tx key, and (bound) its payment ID decrypts only to
 *  the order the payer made the payment for: `paidFor`. */
function explorer(paidFor: { account: string; permlink: string } | 'down') {
	const claims: FeeClaim[] = [];
	const v: FeeVerifier = {
		name: 'xmr-stub',
		verify: async (c) => {
			claims.push(c);
			if (paidFor === 'down') return { kind: 'pending_external', reason: 'down' };
			if (c.txKey !== TXKEY) return { kind: 'rejected', reason: 'tx_key_did_not_prove_any_match' };
			if (c.xmrBinding) {
				if (c.xmrBinding.primaryAddress !== PRIMARY)
					return { kind: 'rejected', reason: 'tx_key_did_not_prove_any_match' };
				if (c.xmrBinding.paymentId !== xmrFeePaymentId(paidFor.account, paidFor.permlink)) {
					return { kind: 'rejected', reason: 'payment_id_mismatch' };
				}
			}
			return { kind: 'verified', observedAmount: 781_250_000n };
		}
	};
	return { v, claims };
}

describe.skipIf(!INTEGRATION_ENABLED)('XMR fees: tx key (M-X1) and order binding (MK-H2)', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		if (fx) await fx.teardown();
	});
	beforeEach(async () => {
		await fx.db.query(`TRUNCATE orders, ops, releases, fee_attestations, accounts CASCADE`);
	});

	async function pinXmr(block: number, primary: string | null) {
		await fx.db.query(
			`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num,
			                       source_trx_id, signer, valid, created_at, treasury)
			 VALUES ('1.20.0', '{}'::jsonb, '{}'::jsonb, '', $1, $2, 'morphit', true, $3, $4::jsonb)`,
			[
				block,
				`rel-${block}`,
				new Date(T0),
				JSON.stringify({
					btc: null,
					xmr: {
						address: SUBADDRESS,
						piconero: '781250000',
						...(primary ? { primary_address: primary } : {})
					}
				})
			]
		);
	}

	async function apply(blockNum: number, ops: [string, unknown][], v: FeeVerifier) {
		const client: pg.PoolClient = await fx.pool.connect();
		try {
			await client.query(`SET search_path TO "${fx.schema}"`);
			await client.query('BEGIN');
			await applyBlock(
				client,
				blockNum,
				{
					timestamp: new Date(T0).toISOString().slice(0, 19),
					transaction_ids: ops.map((_, i) => `trx-${blockNum}-${i}`),
					transactions: ops.map((op) => ({ operations: [op] }))
				} as unknown as Parameters<typeof applyBlock>[2],
				unusedBlurt(),
				fakeConfig(),
				{ xmr: v },
				{ xmrPiconero: 781_250_000n },
				((a: number) => a) as Parameters<typeof applyBlock>[7]
			);
			await client.query('COMMIT');
		} catch (e) {
			await client.query('ROLLBACK');
			throw e;
		} finally {
			client.release();
		}
		// The fee is stored pending_external; its first explorer check is the
		// re-check job's, outside the block.
		await recheckExternalFees({
			db: fx.db,
			verifiers: { xmr: v },
			amounts: { xmrPiconero: 781_250_000n },
			now: new Date(T0)
		});
	}

	const row = async (account: string, permlink: string) =>
		(
			await fx.db.query<{
				fee_status: string;
				xmr_tx_key: string | null;
				xmr_payment_id: string | null;
			}>(
				`SELECT fee_status, xmr_tx_key, xmr_payment_id FROM orders WHERE account = $1 AND permlink = $2`,
				[account, permlink]
			)
		).rows[0] ?? null;
	const reason = async (account: string, permlink: string) =>
		(
			await fx.db.query<{ reject_reason: string | null }>(
				`SELECT reject_reason FROM ops WHERE signer = $1 AND payload->>'permlink' = $2`,
				[account, permlink]
			)
		).rows[0]?.reject_reason ?? null;

	it("verifies an unbound XMR fee with the payer's tx key (before any primary pin)", async () => {
		const e = explorer({ account: 'alice', permlink: 'a1' });
		await apply(101, [xmrOp('alice', 'a1', { tx_key: TXKEY.toUpperCase() })], e.v);
		expect(await row('alice', 'a1')).toEqual({
			fee_status: 'verified',
			xmr_tx_key: TXKEY,
			xmr_payment_id: null
		});
		expect(e.claims[0]).toMatchObject({ txKey: TXKEY, xmrBinding: null });
	});

	it('stores an OutProof-only order as proof_unsupported without asking anyone, and refuses one with neither', async () => {
		const e = explorer({ account: 'alice', permlink: 'p1' });
		await apply(101, [xmrOp('alice', 'p1', { tx_proof: OUTPROOF }), xmrOp('bob', 'n1', {})], e.v);
		expect(await row('alice', 'p1')).toMatchObject({ fee_status: 'proof_unsupported' });
		expect(e.claims).toHaveLength(0);
		expect(await row('bob', 'n1')).toBeNull();
		expect(await reason('bob', 'n1')).toBe('tx_key_required_for_xmr');
	});

	it('after the primary pin, binds the fee to the order: a front-running copy gets nothing and cannot knock the payer out', async () => {
		await pinXmr(100, PRIMARY);
		const e = explorer({ account: 'alice', permlink: 'a1' });
		// mallory copies alice's txid + tx key from her op and gets in FIRST
		await apply(
			101,
			[xmrOp('mallory', 'steal', { tx_key: TXKEY }), xmrOp('alice', 'a1', { tx_key: TXKEY })],
			e.v
		);
		expect(await row('mallory', 'steal')).toMatchObject({ fee_status: 'missing' });
		expect(await row('alice', 'a1')).toEqual({
			fee_status: 'verified',
			xmr_tx_key: TXKEY,
			xmr_payment_id: xmrFeePaymentId('alice', 'a1')
		});
		expect(e.claims.map((c) => c.xmrBinding?.paymentId).sort()).toEqual(
			[xmrFeePaymentId('mallory', 'steal'), xmrFeePaymentId('alice', 'a1')].sort()
		);
		expect(e.claims.every((c) => c.xmrBinding?.primaryAddress === PRIMARY)).toBe(true);
	});

	it('re-checks bound rows with their key and binding, never promotes them by attestation, and skips proof_unsupported rows', async () => {
		await pinXmr(100, PRIMARY);
		await apply(
			101,
			[xmrOp('alice', 'a1', { tx_key: TXKEY }), xmrOp('bob', 'p1', { tx_proof: OUTPROOF })],
			explorer('down').v
		);
		expect(await row('alice', 'a1')).toMatchObject({ fee_status: 'pending_external' });
		for (const n of ['sock1', 'sock2']) {
			await fx.db.query(
				`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id)
				 VALUES ($1, 'relay', 1, $2, 'x') ON CONFLICT DO NOTHING`,
				[n, OLD]
			);
			await fx.db.withTx((c) =>
				feeAttestHandler(
					makeCtx({
						signer: n,
						blockTime: new Date(T0),
						trxId: `${n}`.padEnd(40, '0'),
						payload: { order_account: 'alice', order_permlink: 'a1' },
						config: { ...makeCtx().config, attestationPhase: 'launch' }
					}),
					c
				)
			);
		}
		expect(await row('alice', 'a1')).toMatchObject({ fee_status: 'pending_external' });
		// explorers still down: the re-check's attestation fallback must not promote it either
		await recheckExternalFees({
			db: fx.db,
			verifiers: { xmr: explorer('down').v },
			amounts: { xmrPiconero: 781_250_000n },
			now: new Date(T0 + 3_600_000)
		});
		expect(await row('alice', 'a1')).toMatchObject({ fee_status: 'pending_external' });
		const e = explorer({ account: 'alice', permlink: 'a1' });
		await recheckExternalFees({
			db: fx.db,
			verifiers: { xmr: e.v },
			amounts: { xmrPiconero: 781_250_000n },
			now: new Date(T0 + 7_200_000)
		});
		expect(e.claims).toHaveLength(1);
		expect(e.claims[0]).toMatchObject({
			txKey: TXKEY,
			xmrBinding: { primaryAddress: PRIMARY, paymentId: xmrFeePaymentId('alice', 'a1') },
			// (v1.20.2) how long the order has waited — the lone-answer rule's clock
			waitedMs: 7_200_000
		});
		expect(await row('alice', 'a1')).toMatchObject({ fee_status: 'verified' });
		expect(await row('bob', 'p1')).toMatchObject({ fee_status: 'proof_unsupported' });
	});

	it('the v65 upgrade marks stored OutProof orders proof_unsupported and leaves everything else alone', async () => {
		const base = `INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
		                                  status, created_at, updated_at, fee_status, fee_method, external_tx_id, tx_proof)
		              VALUES ($1, $2, 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'], 'live', NOW(), NOW(), $3, $4, $5, $6)`;
		await fx.db.query(base, ['u', 'x-missing', 'missing', 'xmr', 'e1'.repeat(32), OUTPROOF]);
		await fx.db.query(base, [
			'u',
			'x-pending',
			'pending_external',
			'xmr',
			'e2'.repeat(32),
			OUTPROOF
		]);
		await fx.db.query(base, [
			'u',
			'x-attested',
			'verified_by_attestation',
			'xmr',
			'e3'.repeat(32),
			OUTPROOF
		]);
		await fx.db.query(base, ['u', 'x-reused', 'reused', 'xmr', null, OUTPROOF]);
		await fx.db.query(base, ['u', 'b-pending', 'pending_external', 'btc', 'e4'.repeat(32), null]);
		await fx.db.query(`DELETE FROM schema_migrations WHERE version = 65`);
		await runMigrations(fx.db);
		const got = await fx.db.query<{ permlink: string; fee_status: string; txid: string | null }>(
			`SELECT permlink, fee_status, external_tx_id AS txid FROM orders WHERE account = 'u' ORDER BY permlink`
		);
		// Same row shape as intake stores for such an op (txid released), so
		// an upgraded node and a node replaying from scratch agree — and the
		// payer can re-post the same payment with its tx key.
		expect(got.rows).toEqual([
			{ permlink: 'b-pending', fee_status: 'pending_external', txid: 'e4'.repeat(32) },
			{ permlink: 'x-attested', fee_status: 'proof_unsupported', txid: null },
			{ permlink: 'x-missing', fee_status: 'proof_unsupported', txid: null },
			{ permlink: 'x-pending', fee_status: 'proof_unsupported', txid: null },
			{ permlink: 'x-reused', fee_status: 'reused', txid: null }
		]);
	});

	it('a payer whose OutProof order could not verify re-posts the same payment with its tx key and it verifies', async () => {
		const e = explorer({ account: 'alice', permlink: 'again' });
		await apply(101, [xmrOp('alice', 'old', { tx_proof: OUTPROOF })], e.v);
		await apply(102, [xmrOp('alice', 'again', { tx_key: TXKEY })], e.v);
		expect(await row('alice', 'old')).toMatchObject({ fee_status: 'proof_unsupported' });
		expect(await row('alice', 'again')).toMatchObject({ fee_status: 'verified' });
	});

	it('V3: two orders whose payment IDs collide (a 2^32 birthday search) cannot both be paid by one payment', async () => {
		await pinXmr(100, PRIMARY);
		// bob found two permlinks with the same 8-byte payment ID; the first
		// (stored as bob/p1) already claimed the payment.
		const pid = xmrFeePaymentId('bob', 'p2');
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                     status, created_at, updated_at, fee_status, fee_method, external_tx_id,
			                     xmr_tx_key, xmr_payment_id)
			 VALUES ('bob', 'p1', 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'], 'live', NOW(), NOW(),
			         'verified', 'xmr', $1, $2, $3)`,
			[TXID, TXKEY, pid]
		);
		const e = explorer({ account: 'bob', permlink: 'p2' });
		await apply(101, [xmrOp('bob', 'p2', { tx_key: TXKEY })], e.v);
		expect(await row('bob', 'p2')).toMatchObject({ fee_status: 'reused' });
		expect(e.claims).toHaveLength(0);
		// a copier with a DIFFERENT payment ID is still not "reused" (it just fails)
		await apply(102, [xmrOp('mallory', 'm1', { tx_key: TXKEY })], e.v);
		expect(await row('mallory', 'm1')).toMatchObject({ fee_status: 'missing' });
	});
});
