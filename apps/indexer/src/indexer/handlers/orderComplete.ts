/**
 * Handler: morphit_order_complete_v1
 *
 * Payload shape:
 *   {
 *     "permlink": string,
 *     "counterparty"?: string   // v1.5.5, OPTIONAL
 *   }
 *
 * Effect: flip the order's status from 'live' to 'completed', bump
 * updated_at. Row is preserved (no DELETE) so the audit trail and
 * any feedback linked to the order both keep working.
 *
 * Posted by the SELLER (order owner) once a trade's payment is
 * confirmed — automatically the moment their client verifies the
 * payment on-chain, or via the manual "Mark as complete" action for
 * off-chain settlements (BTC/XMR/cash). A completed order leaves the
 * public orderbook (the orderbook query filters status='live').
 *
 * This is the second removal path parallel to morphit_order_cancel_v1.
 * The `account = signer` guard means ONLY the owner can complete their
 * own listing, so a buyer faking payment cannot grief an order off the
 * book. v1.5.0.
 *
 * v1.5.5 — OPTIONAL `counterparty`: who the owner traded WITH. Without it only
 * the OWNER can ever be credited a completed trade, because the counterparty
 * owns no order of their own and would read "0 trades" forever however many
 * trades they completed.
 *
 * The owner ASSERTS this; the chain cannot prove it (the payment proof lives in
 * E2EE chat the indexer can't read, and the BLURT transfer memo is a random
 * opaque token by design so nothing on-chain links a payment to an order).
 * That asymmetry is deliberate and bounded:
 *   - it is the owner's OWN order, and completing it REMOVES their listing from
 *     the book — a cost, not a gain, so there is no incentive to farm it;
 *   - it credits a TRADE COUNT only. It cannot forge a rating: those still come
 *     from morphit_feedback_v1, which is separately gated (fee-verified order,
 *     one review per reviewer/subject/order) and filtered by the sock-puppet
 *     signals. Reputation-by-collusion therefore still costs a real listing fee
 *     per fake trade and still trips the reciprocity/related-account signals.
 * Naming yourself is rejected (self-trade); an unparseable name is rejected
 * outright rather than silently dropped, so a client bug can't quietly cost
 * someone their trade credit.
 *
 * cp472 TIGHTENING (Ken) — the named counterparty must clear the PROVABLE-
 * COUNTERPARTY bar: the same substantiated two-way conversation the
 * has_verified_chat badge and every REVIEW already require (≥2 messages each
 * way, ≥15-min span, pair not flagged for reciprocity). Shared impl in
 * $indexer/chatGates, so the two can never drift.
 *
 * Without it an owner could name ANYONE. That is not just cheap trade credit
 * for a confederate (a listing fee each) — it publishes an unconsented claim
 * that some stranger traded with them, which the stranger cannot refuse. With
 * it, the named party must provably have held a real conversation with the
 * owner first, so a fake trade now costs a listing fee AND a fabricated
 * sustained conversation AND not tripping the sockpuppet signals: the same bar
 * as a fake review.
 *
 * Failing the bar does NOT reject the op — the completion is the owner's own
 * call about their own listing. The counterparty is simply dropped to NULL:
 * the order still completes and the owner still gets their credit; only the
 * unproven third party goes uncredited.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { validateOrderPermlink } from '$indexer/permlink';
import { hasVerifiedChat } from '$indexer/chatGates';

/** Blurt account names: 3-16 chars, lowercase, dot-separated segments. Same
 *  shape the other handlers accept. */
/** Canonical Blurt account name. MUST stay byte-identical to the regex in
 *  `$api/shared` and every other handler — `blurt-account-regex-parity-smoke`
 *  enforces that, and for good reason: the last drift here (a no-dot variant
 *  in chat.ts vs a dot-allowing one elsewhere) broke chat outright for every
 *  user with a dotted account name. A bespoke variant in THIS handler would
 *  have silently refused to credit a trade to any counterparty whose name has
 *  a dot — they'd read "0 trades" forever with no error anywhere. */
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) return { ok: false, reason: 'payload_not_object' };

	const permlinkFail = validateOrderPermlink(ctx.payload.permlink);
	if (permlinkFail) return { ok: false, reason: permlinkFail };
	const permlink = ctx.payload.permlink as string;

	// v1.5.5 — optional counterparty. Absent (older clients) → NULL, and the
	// owner still gets their credit; only the other side goes uncredited.
	const rawCp = ctx.payload.counterparty;
	let counterparty: string | null = null;
	if (rawCp !== undefined && rawCp !== null) {
		if (typeof rawCp !== 'string' || !ACCOUNT_NAME_RE.test(rawCp)) {
			return { ok: false, reason: 'counterparty_invalid' };
		}
		if (rawCp === ctx.signer) return { ok: false, reason: 'counterparty_is_self' };
		// cp472 — accept the name ONLY with provable conversation evidence.
		// Bounded to this op's block time so a replay can't see its own future.
		const proven = await hasVerifiedChat(client, {
			a: ctx.signer,
			b: rawCp,
			asOf: ctx.blockTime
		});
		counterparty = proven ? rawCp : null;
	}

	const res = await client.query(
		`UPDATE orders SET status = 'completed', updated_at = $3,
		        completed_counterparty = $4
		 WHERE account = $1 AND permlink = $2 AND status = 'live'`,
		[ctx.signer, permlink, ctx.blockTime, counterparty]
	);

	if (res.rowCount === 0) {
		const probe = await client.query<{ status: string }>(
			`SELECT status FROM orders WHERE account = $1 AND permlink = $2`,
			[ctx.signer, permlink]
		);
		if (probe.rowCount === 0) return { ok: false, reason: 'target_not_found' };
		return { ok: false, reason: 'target_already_' + (probe.rows[0]?.status ?? 'unknown') };
	}

	ctx.recordOrderbookChange(`${ctx.signer}/${permlink}`);
	return { ok: true };
};

export default handle;
