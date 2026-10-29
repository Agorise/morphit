/**
 * Morphit — can this account pay for it? (v1.21.17)
 *
 * The Feature form asked for the password first and only then found out, from
 * the chain, that the account did not hold enough BLURT ("Broadcast rejected
 * due to insufficient funds"). Now the form shows the live balance next to the
 * cost and does not ask for anything until the balance covers it.
 *
 * "Covers it" includes the network fee every Blurt transaction pays from
 * liquid BLURT: a flat fee per operation plus a fee per kB of the signed
 * transaction (chain properties `operation_flat_fee`, `bandwidth_kbytes_fee`,
 * served by /v1/chain-fee). The estimate here is an UPPER bound — whole kB,
 * and the size taken from the operations' JSON, which is longer than their
 * binary form — so "enough" never turns out to be a few thousandths short.
 */

import { OP_IDS } from '$net/config';
import { feeTransfersFor, FEE_RECIPIENT } from '$lib/orders/fee';
import { featureBidMemoFor } from '$blurt/ops/featureBid';

/** The chain's values when /v1/chain-fee had none to give (read from
 *  condenser_api.get_chain_properties on 2026-10-28). */
export const DEFAULT_OPERATION_FLAT_FEE_BLURT = 0.05;
export const DEFAULT_BANDWIDTH_KBYTES_FEE_BLURT = 0.2;
/** Transaction header (reference block, expiration, counts, extensions) and
 *  one signature, over-counted. */
export const TX_OVERHEAD_BYTES = 128;
/** The least the chain charges for each of the two parts. */
export const MIN_FEE_PART_BLURT = 0.001;

export interface NetworkFees {
	readonly operationFlatFeeBlurt: number | null;
	readonly bandwidthKbytesFeeBlurt: number | null;
}

const up3 = (n: number): number => Math.ceil(n * 1000 - 1e-9) / 1000;

/** Upper bound of the network fee for these operations, in BLURT. */
export function networkFeeUpperBound(operations: readonly unknown[], fees: NetworkFees): number {
	const flat = fees.operationFlatFeeBlurt ?? DEFAULT_OPERATION_FLAT_FEE_BLURT;
	const perKb = fees.bandwidthKbytesFeeBlurt ?? DEFAULT_BANDWIDTH_KBYTES_FEE_BLURT;
	const bytes = new TextEncoder().encode(JSON.stringify(operations)).length + TX_OVERHEAD_BYTES;
	// The chain charges each part at least 0.001 BLURT, even when witnesses set
	// its rate to 0 (Blurt database::process_tx_fee, std::max(…, 1)).
	return up3(
		Math.max(MIN_FEE_PART_BLURT, operations.length * flat) +
			Math.max(MIN_FEE_PART_BLURT, Math.ceil(bytes / 1024) * perKb)
	);
}

export interface FeatureBidCost {
	/** What the bid pays (the transfers). */
	readonly bidBlurt: number;
	/** Upper bound of the network fee for the bid's transaction. */
	readonly networkFeeBlurt: number;
	/** Both: what the liquid balance must hold. */
	readonly needBlurt: number;
}

/** The feature bid's transaction as broadcastFeatureBid builds it: the
 *  custom_json and its one or two fee transfers. */
export function featureBidCost(input: {
	readonly account: string;
	readonly orderPermlink: string;
	readonly hours: number;
	readonly feeBlurtPerHour: number;
	readonly feeRecipient: string;
	readonly fees: NetworkFees;
}): FeatureBidCost {
	const bid = input.feeBlurtPerHour * input.hours;
	const transfers = feeTransfersFor(bid, input.feeRecipient, FEE_RECIPIENT, input.account);
	const memo = featureBidMemoFor(input.orderPermlink);
	const ops: unknown[] = [
		[
			'custom_json',
			{
				required_auths: [input.account],
				required_posting_auths: [],
				id: OP_IDS.featureBid,
				json: JSON.stringify({ order_permlink: input.orderPermlink, hours_requested: input.hours })
			}
		],
		...transfers.map((t) => ['transfer', { from: input.account, to: t.to, amount: t.amount, memo }])
	];
	const bidBlurt = up3(bid);
	const networkFeeBlurt = networkFeeUpperBound(ops, input.fees);
	return { bidBlurt, networkFeeBlurt, needBlurt: up3(bidBlurt + networkFeeBlurt) };
}

/** What the form does with the balance it has. */
export type Payable =
	| { readonly kind: 'checking' }
	/** The balance could not be read: the form does not block on it (the
	 *  chain still refuses a payment the account cannot make). */
	| { readonly kind: 'unknown' }
	| { readonly kind: 'enough' }
	| { readonly kind: 'short'; readonly missingBlurt: number };

export function payableWith(
	balance:
		| { readonly kind: 'loading' }
		| { readonly kind: 'error' }
		| { readonly kind: 'ok'; readonly liquidBlurt: number },
	needBlurt: number
): Payable {
	if (balance.kind === 'loading') return { kind: 'checking' };
	if (balance.kind === 'error') return { kind: 'unknown' };
	if (balance.liquidBlurt + 1e-9 >= needBlurt) return { kind: 'enough' };
	return { kind: 'short', missingBlurt: up3(needBlurt - balance.liquidBlurt) };
}
