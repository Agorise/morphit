/**
 * Morphit indexer — the BLURT that paid each Morphit fee op (v1.21.8).
 *
 * WHY. The Operators page says what each operator has earned. The only
 * per-operator figure before this came from operatorEarnings.ts, which counts
 * only orders paid through THIS instance (it is gated on this instance's own
 * tag), only listing fees, and only from the version that added it — so every
 * other operator showed nothing, everywhere.
 *
 * WHAT IS RECORDED. For every op of the three fee-bearing ids, whatever its
 * verdict (the BLURT moved either way): one `fee_payments` row, and one
 * `fee_payment_legs` row per transfer in the same transaction that comes from
 * the op's signer and carries the op's memo:
 *   morphit_order_v1        listing   memo morphit-fee:<permlink>
 *   morphit_stranger_fee_v1 stranger  memo morphit-stranger:<recipient>
 *   morphit_feature_bid_v1  feature   memo morphit-feature:<order_permlink>
 * At most MAX_LEGS_PER_FEE_OP legs per op. Only facts from the transaction are
 * stored. WHO a leg credits is decided
 * when the figures are computed (indexer/operatorStats.ts), from the on-chain fees-account history,
 * so an operator that registers its fees account later is credited for its
 * older payments on every node alike.
 *
 * WHEN. Live, by the dispatcher, for every fee op it logs (applied or
 * rejected, at any step). For ops indexed before this version, by the
 * back-fill (feeLegsBackfill.ts), which fetches the original transaction
 * again and proves it by its id. The `fee_payments` row is the marker that an
 * op has been recorded, so the back-fill picks exactly the ops without one.
 */
import type { ChainOperation } from '$blurt/client';
import { parseBlurtMilli } from '$indexer/fee';
import { operatorTagOf, type Queryable } from '$indexer/feeRecipients';

export type FeePaymentKind = 'listing' | 'stranger' | 'feature';

/** The fee-bearing op ids, the kind each records, and the payload field its
 *  memo names. */
export const FEE_PAYMENT_OPS: Readonly<
	Record<string, { readonly kind: FeePaymentKind; readonly field: string; readonly prefix: string }>
> = {
	morphit_order_v1: { kind: 'listing', field: 'permlink', prefix: 'morphit-fee:' },
	morphit_stranger_fee_v1: { kind: 'stranger', field: 'recipient', prefix: 'morphit-stranger:' },
	morphit_feature_bid_v1: { kind: 'feature', field: 'order_permlink', prefix: 'morphit-feature:' }
};

/** Transfers kept per fee op. A real fee is one or two transfers (the owner's
 *  90 % and the treasury's 10 %); without a bound one transaction stuffed with
 *  memo-matching dust would add thousands of rows to store, carry in every
 *  snapshot and scan for the Operators page. The first ones, in transaction
 *  order, are kept — the same on every node. */
export const MAX_LEGS_PER_FEE_OP = 16;

export interface FeeLeg {
	/** The transfer's position in the transaction. */
	readonly legOpInTrx: number;
	readonly recipient: string;
	readonly amountMilli: number;
}

export interface FeePayment {
	readonly kind: FeePaymentKind;
	readonly operatorTag: string | null;
	readonly ref: string | null;
	readonly legs: readonly FeeLeg[];
}

/**
 * What a fee op paid, from its transaction's operations; null when `opId` is
 * not a fee-bearing op. A payload that names no memo target (malformed, or the
 * raw text of a rejected op) gives a payment with no legs, so the op is still
 * marked recorded.
 */
export function feePaymentOf(
	opId: string,
	signer: string,
	payload: unknown,
	siblingOps: readonly ChainOperation[]
): FeePayment | null {
	const spec = FEE_PAYMENT_OPS[opId];
	if (spec === undefined) return null;
	const obj =
		typeof payload === 'object' && payload !== null && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: null;
	const raw = obj?.[spec.field];
	const ref = typeof raw === 'string' && raw.length > 0 ? raw : null;
	const legs: FeeLeg[] = [];
	if (ref !== null && signer !== '') {
		const memo = spec.prefix + ref;
		siblingOps.forEach((op, i) => {
			if (legs.length >= MAX_LEGS_PER_FEE_OP) return;
			if (!op || op[0] !== 'transfer') return;
			const b = op[1] as { from?: unknown; to?: unknown; amount?: unknown; memo?: unknown };
			if (b.from !== signer || b.memo !== memo) return;
			if (typeof b.to !== 'string' || b.to === '' || typeof b.amount !== 'string') return;
			const milli = parseBlurtMilli(b.amount);
			if (milli === null || milli <= 0) return;
			legs.push({ legOpInTrx: i, recipient: b.to, amountMilli: milli });
		});
	}
	// A featured-slot bid names no operator (its handler reads no tag); the
	// Operators page takes the featured order's tag from its order op.
	return {
		kind: spec.kind,
		operatorTag: spec.kind === 'feature' ? null : operatorTagOf(obj),
		ref,
		legs
	};
}

export interface FeeOpPosition {
	readonly blockNum: number | string;
	readonly trxInBlock: number;
	readonly opInTrx: number;
	readonly trxId: string;
	readonly blockTime: Date;
	readonly signer: string;
	readonly opId: string;
	readonly payload: unknown;
}

/** Record what the fee op at `pos` paid. No-op for any other op id. Idempotent
 *  (a block applied twice, or the back-fill racing the live path). */
export async function recordFeePayment(
	client: Queryable,
	pos: FeeOpPosition,
	siblingOps: readonly ChainOperation[]
): Promise<void> {
	const p = feePaymentOf(pos.opId, pos.signer, pos.payload, siblingOps);
	if (p === null) return;
	const ins = await client.query(
		`INSERT INTO fee_payments
		   (block_num, trx_in_block, op_in_trx, kind, payer, operator_tag, ref, trx_id, block_time)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 ON CONFLICT (block_num, trx_in_block, op_in_trx) DO NOTHING`,
		[
			String(pos.blockNum),
			pos.trxInBlock,
			pos.opInTrx,
			p.kind,
			pos.signer,
			p.operatorTag,
			p.ref,
			pos.trxId,
			pos.blockTime
		]
	);
	if ((ins.rowCount ?? 0) === 0) return;
	for (const leg of p.legs) {
		await client.query(
			`INSERT INTO fee_payment_legs
			   (block_num, trx_in_block, leg_op_in_trx, op_in_trx, recipient, amount_milli)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (block_num, trx_in_block, leg_op_in_trx) DO NOTHING`,
			[
				String(pos.blockNum),
				pos.trxInBlock,
				leg.legOpInTrx,
				pos.opInTrx,
				leg.recipient,
				leg.amountMilli
			]
		);
	}
}
