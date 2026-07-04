/**
 * Handler: morphit_stranger_fee_v1
 *
 * Payload shape:
 *   {
 *     v: 1,
 *     recipient: string (blurt account name),
 *     amount_blurt: number  // BLURT amount the client is paying
 *   }
 *
 * Accompanying op (in the same Blurt transaction):
 *   transfer { from=signer, to=@morphit-fees,
 *              amount="N BLURT",
 *              memo="morphit-stranger:<recipient>" }
 *
 * Effect: record that `signer` has paid the first-contact fee
 * to message `recipient`. Inserts a row in `stranger_fees`
 * keyed on (sender, recipient). Once recorded, the chat
 * handler's layer-2 gate allows messages from this sender to
 * this recipient without requiring further payment — forever.
 *
 * Fee amount: 5 BLURT base, escalating 2× per prior fee in the
 * last 5 minutes, capped at 640 BLURT (128×).  Intentionally
 * small enough that a real user with genuine intent will pay
 * without thinking, large enough that 1000 sybil first-contacts
 * cost meaningfully more than running a single account.
 *
 * Memo binding: the transfer's memo MUST be
 * `morphit-stranger:<recipient>`, so a paid fee for one
 * recipient can't be replayed to pay for messaging another.
 *
 * Block-list interaction: this handler does NOT re-check the
 * blocks table. A blocked sender's stranger-fee is accepted
 * here (bookkeeping), but their chat messages still reject at
 * the chat handler's layer-1 gate. Separation of concerns —
 * the fee is pair-level accounting, not admission.
 *
 * Idempotency: composite PK collision on (sender, recipient)
 * on INSERT is translated to ok:true. The user's first paid
 * fee already earns the admission; a re-submission is a
 * no-op from the handler's perspective (though it does cost
 * the user another transfer — a UI concern, not an indexer
 * concern).
 *
 * Anti-spam layer 2 of 3.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { getStrangerFeeQuote } from '$indexer/strangerFeePricing';
import { canonicalShareOk, sumFeeTransfers } from '$indexer/fee';
import { CANONICAL_TREASURY } from '../../config/canonicalTreasury';

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code: unknown }).code === '23505'
	);
}

/** cp408 — the stranger-fee sibling transfer(s) are located + summed by the
 *  shared `sumFeeTransfers` in `$indexer/fee`, which honors the payment-time
 *  federation split (90% owner / 10% canonical, memo
 *  `morphit-stranger:<recipient>`). */

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) {
		return { ok: false, reason: 'payload_not_object' };
	}

	// ─── Payload validation ─────────────────────────────────────

	const recipient = ctx.payload.recipient;
	if (typeof recipient !== 'string' || !ACCOUNT_NAME_RE.test(recipient)) {
		return { ok: false, reason: 'recipient_invalid' };
	}
	if (recipient === ctx.signer) {
		return { ok: false, reason: 'self_fee' };
	}

	const quotedBlurt = ctx.payload.amount_blurt;
	if (typeof quotedBlurt !== 'number' || !Number.isFinite(quotedBlurt) || quotedBlurt <= 0) {
		return { ok: false, reason: 'amount_blurt_invalid' };
	}

	// ─── Idempotency check ──────────────────────────────────────
	// If we already have a row for this pair, accept silently.
	// This handles (a) legitimate client retry after a network
	// hiccup, (b) double-broadcast due to UI bug, (c) chain
	// re-replay during indexer recovery. In all cases the
	// user's original admission stands.
	const existing = await client.query<{ exists: boolean }>(
		`SELECT EXISTS (
		   SELECT 1 FROM stranger_fees
		    WHERE sender = $1 AND recipient = $2
		 ) AS exists`,
		[ctx.signer, recipient]
	);
	if (existing.rows[0]?.exists) {
		return { ok: true };
	}

	// ─── Dynamic pricing — escalation ───────────────────────────
	// Count this sender's stranger-fee payments in the last 5
	// minutes. The next fee doubles for each prior, capped at
	// 128× base (= 640 BLURT). See strangerFeePricing.ts for the
	// rationale.
	//
	// Pass ctx.blockTime so replay (e.g. indexer bootstrapping a
	// fresh DB from chain history) produces the same quote that
	// the original real-time pass would have computed.  Without
	// this, NOW() at replay time makes historical fees fall
	// outside the window — same op gets a different verdict.
	const quote = await getStrangerFeeQuote(client, ctx.signer, ctx.blockTime);

	// Sanity window on the user's quote. Accept if it's at
	// least the current price (modulo client rounding) and not
	// wildly above. The 1.5× upper bound absorbs the case where
	// the user computed their quote a few seconds before another
	// of their fees landed and bumped the multiplier — they
	// might have committed to the older quote, which we accept
	// as long as it isn't UNDER the new quote (we don't let
	// people pay less than the current rate).
	if (quotedBlurt > quote.priceBlurt * 1.5) {
		return { ok: false, reason: 'amount_blurt_out_of_range' };
	}
	if (quotedBlurt < quote.priceBlurt * (1 - ctx.config.feeTolerance)) {
		// User quoted (and paid) less than the current escalating
		// price. They need to re-quote. The frontend will refresh
		// the modal showing the new price.
		return { ok: false, reason: 'amount_blurt_below_current_quote' };
	}

	// ─── Fee transfer verification ──────────────────────────────
	// cp408 — the stranger fee is paid as a payment-time split (90% to this
	// instance's recipient + 10% to the canonical treasury, or a single 100%
	// transfer when the recipient is canonical). Sum both legs, then confirm
	// the canonical treasury received its cut.

	const fee = sumFeeTransfers(
		ctx.siblingOps,
		ctx.signer,
		ctx.config.feeRecipient,
		CANONICAL_TREASURY.blurt,
		`morphit-stranger:${recipient}`
	);
	if (fee === null) {
		return { ok: false, reason: 'fee_missing' };
	}

	// BLURT-native: the user paid `quote.priceBlurt` directly,
	// no USD conversion needed.  Tolerance band absorbs floating-
	// point rounding in the client's BLURT amount formatting.
	const minAcceptable = quote.priceBlurt * (1 - ctx.config.feeTolerance);
	if (fee.totalBlurt < minAcceptable) {
		return { ok: false, reason: 'fee_underpaid' };
	}
	if (!canonicalShareOk(fee.totalBlurt, fee.toCanonicalBlurt)) {
		// Total paid, but the canonical treasury's 10% leg was missing/short.
		return { ok: false, reason: 'fee_underpaid' };
	}

	// ─── Record payment ─────────────────────────────────────────

	try {
		await client.query(
			`INSERT INTO stranger_fees
			   (sender, recipient, paid_block_num, paid_trx_id,
			    paid_at, amount_blurt)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[ctx.signer, recipient, ctx.blockNum, ctx.trxId, ctx.blockTime, fee.totalBlurt]
		);
	} catch (err) {
		// Race: another op in the same block paid for the same
		// pair (unlikely with cooperative clients, but possible
		// with sibling-op builders on the same account). PK
		// collision translates to idempotent success — the
		// earlier op already admitted the sender, so this one
		// is a no-op.
		if (isUniqueViolation(err)) {
			return { ok: true };
		}
		throw err;
	}

	return { ok: true };
};

export default handle;
