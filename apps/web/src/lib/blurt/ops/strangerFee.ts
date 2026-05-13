/**
 * Morphit — stranger-fee op broadcaster.
 *
 * Builds a `morphit_stranger_fee_v1` custom_json bundled with
 * a BLURT transfer to the fee-collection account in one
 * transaction. The indexer's layer-2 gate verifies the transfer
 * by matching the signer, recipient account, memo binding
 * (`morphit-stranger:<recipient>`), and BLURT amount against
 * the current escalating BLURT price.
 *
 * Why bundle the two ops: the indexer's handler reads
 * `ctx.siblingOps` to find the transfer. If the transfer
 * landed in a separate transaction, the handler wouldn't see
 * it and would reject `fee_missing`. Same architecture as
 * listing fees and feature bids.
 *
 * Active-key requirement: the sibling transfer needs active
 * auth. The caller is responsible for JIT-unlocking via
 * `useActiveKey()` and passing the raw scalar here. We never
 * carry the active key on LiveIdentity — tier policy.
 *
 * Pricing flow:
 *   1. Caller fetches the quote from /v1/stranger-fee-quote/:sender.
 *      The indexer returns the current escalating BLURT price
 *      based on the sender's recent first-contact payments.
 *   2. Caller passes that price_blurt into the broadcast
 *      directly — no client-side conversion, no price-feed
 *      dependency.  The amount the user sees is the amount
 *      that gets transferred.
 */

import { prepareUnsignedOrderWithFee, broadcastSignedTransaction } from '$blurt/sign';
import type { Transaction, SignedTransaction } from '@beblurt/dblurt';
import { getUserBlurtAccount, BroadcastError } from '$blurt/ops/profile';
import { OP_IDS } from '$net/config';
import { FEE_RECIPIENT, formatBlurtAmount } from '$lib/orders/fee';
import type { LiveIdentity } from '$crypto/keygen';

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;

export interface StrangerFeePayload {
	readonly v: 1;
	readonly recipient: string;
	readonly amount_blurt: number;
}

/**
 * Broadcast a stranger-fee. Pairs a custom_json carrying the
 * payload with a sibling transfer to the fee-collection
 * account. Both ops are signed in one transaction; either both
 * land or neither does.
 *
 * @param live         Unlocked identity with posting key.
 * @param activePriv   Raw 32-byte active-key scalar (from useActiveKey).
 * @param recipient    Account the sender wants to message.
 * @param amountBlurt  BLURT amount the indexer's quote endpoint
 *                     reported.  Pass exactly what the user saw
 *                     and confirmed in the modal so the paid
 *                     amount matches the displayed amount.
 *
 * @throws BroadcastError('no_account') if the user has no Blurt
 *         account on file.
 * @throws Error on structural violations (invalid recipient,
 *         self-fee) — these shouldn't happen via real UI flows.
 */
/**
 * Broadcast a stranger-fee payment.
 *
 * Phase F.5 audit fix (F-18) — for the same reasons as
 * broadcastNewOrder, this takes a `signCallback` rather than the
 * raw active-key scalar.  The caller wraps useActiveKey around
 * the construction of the callback so the active key only lives
 * during the synchronous signing call.
 */
export async function broadcastStrangerFee(
	_live: LiveIdentity,
	signCallback: (tx: Transaction) => SignedTransaction | Promise<SignedTransaction>,
	recipient: string,
	amountBlurt: number
): Promise<{ block_num: number; trx_id: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered yet.');
	}
	if (!ACCOUNT_NAME_RE.test(recipient)) {
		throw new Error(`broadcastStrangerFee: invalid recipient: ${recipient}`);
	}
	if (recipient === account) {
		throw new Error('broadcastStrangerFee: cannot pay stranger-fee to self');
	}
	if (!(amountBlurt > 0) || !Number.isFinite(amountBlurt)) {
		throw new Error('broadcastStrangerFee: invalid amountBlurt');
	}

	const payload: StrangerFeePayload = {
		v: 1,
		recipient,
		amount_blurt: amountBlurt
	};

	// Phase F.5 audit fix (F-18) — three-phase split:
	const unsigned = await prepareUnsignedOrderWithFee(
		OP_IDS.strangerFee,
		payload,
		account,
		FEE_RECIPIENT,
		formatBlurtAmount(amountBlurt),
		`morphit-stranger:${recipient}`
	);
	const signed = await signCallback(unsigned);
	return broadcastSignedTransaction(signed);
}
