/**
 * Morphit — order broadcaster.
 *
 * Composes the full posting flow:
 *
 *   1. Generate a permlink (random within the user's namespace)
 *   2. Build the morphit_order_v1 payload
 *   3. Compute the Sybil fee + BLURT amount
 *   4. Broadcast the 2-op transaction (custom_json + transfer)
 *      via sign.ts's broadcastOrderWithFee primitive
 *
 * The caller is expected to have already:
 *   - validated the form input
 *   - fetched the user's current Sybil tier from the indexer
 *     (GET /v1/orders/:account, count orders matching the ADR-0009
 *     §4 definition, pass nth = count + 1)
 *   - fetched a fresh BLURT/USD price via $lib/prices
 *   - JIT-unlocked the active key via useActiveKey()
 *
 * Returns the result from the chain plus the permlink so the
 * UI can route to the new order's detail view.
 */

import { getUserBlurtAccount, BroadcastError } from '$blurt/ops/profile';
import { resolveBroadcastAccount } from '../accountBinding';
import { OP_IDS } from '$net/config';
import type { LiveIdentity } from '$crypto/keygen';
import type { Transaction, SignedTransaction } from '@beblurt/dblurt';

import { FEE_RECIPIENT, computeFee, feeMemoFor, feeTransfersFor, type FeeQuote } from '$lib/orders/fee';
import { buildOrderPayload, makeOrderPermlink, type OrderFormInput } from '$lib/orders/payload';

export interface BroadcastOrderResult {
	readonly block_num: number;
	readonly trx_id: string;
	readonly permlink: string;
	/** Present only when feeMethod='blurt' (fee was actually
	 *  paid). Waived and btc/xmr orders have no quote. */
	readonly feeQuote: FeeQuote | null;
	readonly feeMethod: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr';
}

/**
 * Broadcast a new order with atomic fee transfer.
 *
 * @param live            Session LiveIdentity (posting key lives here)
 * @param activePriv      Active-key raw scalar from useActiveKey(). Caller
 *                        passes the scalar returned inside the useActiveKey
 *                        callback; useActiveKey wipes it when the callback
 *                        resolves or throws. Pass null for waived orders.
 * @param input           Validated form input; input.feeMethod drives which
 *                        code path runs.
 * @param nth             Sybil tier (1-indexed) for fee computation
 *                        (BLURT path only — unused for waived).
 * @param baseBlurt       Operator's configured base fee per listing in BLURT,
 *                        as reported by /v1/listing-fee. The frontend reads
 *                        this from the indexer rather than bundling a
 *                        constant so a federation operator can tune their
 *                        fee without forking the frontend.
 */
/**
 * Broadcast a new order.  Posts the custom_json with the
 * morphit_order op id and (for BLURT fee path) a sibling
 * transfer op carrying the listing fee.
 *
 * Phase F.5 audit fix (F-18) — for the BLURT fee path the
 * caller passes a `signCallback` rather than the raw active-key
 * scalar.  The caller wraps `useActiveKey` around the
 * construction of the callback so the active key lives only for
 * the duration of the synchronous signing call.  Network
 * roundtrip happens AFTER the key is wiped.
 *
 * @param signCallback   For BLURT fee path: a function that
 *                       takes an unsigned Transaction and returns
 *                       a fully-signed SignedTransaction (with
 *                       both posting and active signatures).
 *                       Caller is responsible for invoking this
 *                       inside a useActiveKey closure.  Pass null
 *                       for waived/btc/xmr paths.
 */
export async function broadcastNewOrder(
	live: LiveIdentity,
	signCallback: ((tx: Transaction) => SignedTransaction | Promise<SignedTransaction>) | null,
	input: OrderFormInput,
	nth: number,
	baseBlurt: number,
	/** cp407 — the Blurt account this instance's operator collects BLURT fees
	 *  in (from `$instance.fee_recipient`). Defaults to the canonical treasury
	 *  so callers that don't pass it stay correct on the canonical deployment. */
	feeRecipient: string = FEE_RECIPIENT
): Promise<BroadcastOrderResult> {
	const hint = getUserBlurtAccount();
	if (!hint) {
		throw new BroadcastError('no_account', 'You need a Blurt account before posting an order.');
	}
	// cp445 — the BLURT-fee path builds its own 2-op transaction (custom_json with
	// `required_auths: [account]`, plus the fee transfers) and never passes through
	// broadcastCustomJson's binding. It moves MONEY, so it gets the same rule: the
	// account is resolved from the signing key, not from an origin-wide
	// localStorage value another tab can overwrite. See accountBinding.ts.
	const account = await resolveBroadcastAccount(live, hint);

	const feeMethod = input.feeMethod ?? 'blurt';
	const permlink = makeOrderPermlink(input.side, input.asset, input.fiatCurrency);
	const payload = buildOrderPayload(permlink, input);

	// ─── ADR-0011 waived-first-buy path ───────────────────────────
	// No sibling transfer op. Just the custom_json with
	// fee_method='waived_first_buy'. Active key not required since
	// we're only signing with posting authority.
	if (feeMethod === 'waived_first_buy') {
		const { broadcastCustomJson } = await import('$blurt/sign');
		const result = await broadcastCustomJson(live, OP_IDS.order, payload, account);
		return {
			block_num: result.block_num,
			trx_id: result.trx_id,
			permlink,
			feeQuote: null,
			feeMethod: 'waived_first_buy'
		};
	}

	// ─── ADR-0011 sub-phase 4b: BTC/XMR paths ─────────────────────
	// The fee payment happened off-chain (Bitcoin or Monero), so
	// there's no sibling transfer op on Blurt. Only the custom_json
	// with fee_method + external_tx_id is broadcast. Posting key
	// is sufficient; no active-key unlock needed.
	if (feeMethod === 'btc' || feeMethod === 'xmr') {
		if (!input.externalTxId || input.externalTxId.length === 0) {
			throw new BroadcastError(
				'missing_external_tx_id',
				'external transaction id required for btc/xmr orders'
			);
		}
		const { broadcastCustomJson } = await import('$blurt/sign');
		const result = await broadcastCustomJson(live, OP_IDS.order, payload, account);
		return {
			block_num: result.block_num,
			trx_id: result.trx_id,
			permlink,
			feeQuote: null,
			feeMethod
		};
	}

	// ─── BLURT fee path (Phase F.5 — split sign + broadcast) ──────
	if (signCallback === null) {
		throw new BroadcastError('locked', 'Unlock your active key to pay the listing fee.');
	}

	const feeQuote = computeFee(nth, baseBlurt);
	const memo = feeMemoFor(permlink);

	// cp408 — split the fee at payment time: 90% to the instance's fee
	// recipient + 10% to the canonical treasury (or a single 100% transfer when
	// the recipient IS canonical / fell back to it). `feeRecipient` is already
	// resolved by the caller from /v1/instance.
	const feeTransfers = feeTransfersFor(feeQuote.blurtAmount, feeRecipient, FEE_RECIPIENT, account);

	const { prepareUnsignedOrderWithFee, broadcastSignedTransaction } = await import('$blurt/sign');

	// 1. Prepare unsigned tx (network call, no key in scope).
	const unsigned = await prepareUnsignedOrderWithFee(
		OP_IDS.order,
		payload,
		account,
		feeTransfers,
		memo
	);

	// 2. Sign via callback.  Caller's useActiveKey wraps this;
	//    the active key is wiped immediately after.
	const signed = await signCallback(unsigned);

	// 3. Broadcast — no keys in scope.
	const result = await broadcastSignedTransaction(signed);

	return {
		block_num: result.block_num,
		trx_id: result.trx_id,
		permlink,
		feeQuote,
		feeMethod: 'blurt'
	};
}

/**
 * Broadcast a REPLACEMENT for an existing order. The payload is
 * identical in shape to the create op, but the permlink must
 * match the original (that's how the indexer knows which order
 * to update).
 *
 * Replace is free — no fee is charged, since the user already
 * paid for the original listing. The indexer rejects
 * replacements older than 15 minutes from the original's block
 * time (ADR-0001 + ADR-0009; window extended from 3 to 15
 * minutes 2026-05-07 per ADR-0001 Amendment).
 */
export async function broadcastOrderReplace(
	live: LiveIdentity,
	permlink: string,
	input: OrderFormInput
): Promise<{ block_num: number; trx_id: string; permlink: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered.');
	}
	// Replace uses the posting key only — no fee transfer, so no
	// active key needed. Use the single-op primitive.
	const { broadcastCustomJson } = await import('$blurt/sign');
	const payload = buildOrderPayload(permlink, input);
	const result = await broadcastCustomJson(live, OP_IDS.orderReplace, payload, account);
	return { ...result, permlink };
}

/**
 * Broadcast a CANCEL for an existing order. Payload is just the
 * permlink; the indexer's handler marks the matching row as
 * `status='cancelled'`. Posting-key only — no fee, no active-key
 * unlock.
 *
 * Cancellation is irreversible but not lossy: the listing fee
 * was already paid and isn't refundable. A cancelled order
 * disappears from the public orderbook; the owner still sees it
 * in /v1/orders/:account.
 */
export async function broadcastOrderCancel(
	live: LiveIdentity,
	permlink: string
): Promise<{ block_num: number; trx_id: string; permlink: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered.');
	}
	const { broadcastCustomJson } = await import('$blurt/sign');
	const result = await broadcastCustomJson(live, OP_IDS.orderCancel, { permlink }, account);
	return { ...result, permlink };
}

export { BroadcastError };
