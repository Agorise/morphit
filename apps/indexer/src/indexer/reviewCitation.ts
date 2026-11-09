/**
 * reviewCitation — the ONE definition of "this review cites a real order of one
 * of the two parties": a fee-paid one, or a first-buy waiver order whose trade
 * is proven on chain.
 *
 * WHAT WAS WRONG. The durable feedback handler admitted a citation only when
 * the order's `fee_status = 'verified'`, while the head tailer's fast review
 * notification carried its own copy of the query and accepted
 * `('verified', 'verified_by_attestation')`. The fast path is documented as a
 * strict SUBSET of durable admission, and here it was a superset: a review
 * citing an attested order notified its subject within seconds and then never
 * indexed — so the duplicate check never stopped a repeat, and anyone with a
 * verified conversation could send unlimited "X left you a 1★ review" pushes.
 *
 * Both paths now call this function, so they cannot disagree again.
 */

import type { ChatGateDb } from '$indexer/chatGates';
import { CONSENSUS_V2_ACTIVATION_TIME } from '$indexer/consensusActivation';
import { WAIVER_TRADE_MIN_TRANSFER_BLURT } from '$indexer/waiverTradeTransfers';

/** What a valid citation cites: a PAID order, or (from the consensus
 *  activation time) a first-buy WAIVER order whose trade is proven on chain.
 *  A waiver citation never triggers the welcome bonus (handlers/feedback.ts). */
export type ReviewCitation = 'paid' | 'waived';

/**
 * The citation an order at `permlink`, owned by the review's subject or by the
 * reviewer, gives a review; null when it gives none. When both parties own an
 * order under the permlink and both qualify, 'paid' wins, so a paid order
 * keeps every effect it had before.
 *
 * PAID: the listing fee is VERIFIED (every citation target costs a real
 * listing fee, which is what makes a fake review expensive).
 *
 * `pairBound` adds the rule that the order is one THIS PAIR traded on: the
 * two discussed it in chat (a message between them tagged with it, at or
 * before `asOf`), or it was completed naming the other party as its
 * counterparty. Without it any paid order of either party, of any age or
 * status, was a valid citation, so one counterparty with one conversation
 * could file a 1★ review per order the victim ever listed. It is a
 * stricter acceptance rule, so the durable handler applies it from the
 * consensus activation time; the fast notification path, a strict subset
 * of durable admission, applies it always.
 *
 * WAIVED: the owner's free first-buy order, cited when the trade is PROVEN —
 *   - the order is completed and its completed_counterparty is the OTHER
 *     party of this review (the owner named them; the order-complete handler
 *     accepts the name only with a verified conversation), and
 *   - that counterparty sent the owner at least WAIVER_TRADE_MIN_TRANSFER_BLURT
 *     in one BLURT transfer, in a block stamped at or after the activation
 *     time and no earlier than the one that posted the order (even earlier in
 *     that block), up to and including the review's block (even later in that
 *     block). A review in the very block that posted the order is refused:
 *     that block's transfers are recorded only after its ops. A transfer
 *     before the activation time never counts (an older trade counts once the
 *     partner sends at least the minimum again). (waiver_trade_transfers keeps,
 *     per owner and sender, the earliest such transfer, recorded from the
 *     chain: waiverTradeTransfers.ts. The activation, created_at and amount
 *     conditions below repeat what recording already ensures, so a row that
 *     did not come from it — a snapshot's — cannot admit a review either.)
 * A waiver order is the account's first order and always a BLURT buy, so that
 * transfer is the BLURT the newcomer bought. Without it, a waiver order costs
 * nothing, and any fresh sock could post one to review a target or be
 * reviewed. The transfer must be stamped at or after the activation time and
 * at or before the review (`asOf`, the review's block time), so a waiver
 * order can only ever be cited by a review stamped at or after the activation
 * time: before it a waiver order is never a citation, exactly as before, and
 * history keeps its verdicts. (That is the activation gate; a separate check
 * of `asOf` would add nothing.)
 */
/** The cited order `o` is the owner's first-buy WAIVER order, completed
 *  naming the OTHER party of the review. One text, used by the citation and by
 *  waiverTradeOfThePair, so the two cannot drift. `subject` and `reviewer` are
 *  SQL expressions. */
function waiverTradeOfThePairSql(subject: string, reviewer: string): string {
	return `o.fee_method = 'waived_first_buy'
		          AND o.status = 'completed'
		          AND o.completed_counterparty = (CASE WHEN o.account = ${subject} THEN ${reviewer} ELSE ${subject} END)`;
}

/**
 * v1.23.5: SQL — the order `o` may be the one a review is recorded against
 * (`order_account`, what proves a repeat trade), because its fee verdict is
 * the same on every node from the block that posted it:
 *   - a first-buy waiver order (stored verified at intake), or
 *   - a BLURT-fee order posted from the consensus v2 activation time on: its
 *     fee transfer is in the order's own transaction and judged by the
 *     federation's rules as of that block, at intake and on any re-check
 *     alike (blurtFeeReverify.ts).
 * Not a BTC or XMR fee (each node verifies it against outside explorers when
 * it gets to it), and not a BLURT order posted before that time (the re-check
 * may still raise it from underpaid on its legacy grace, whenever it runs).
 */
export function pinnableOrderSql(o: string): string {
	return `(${o}.fee_method = 'waived_first_buy'
	        OR (${o}.fee_method = 'blurt' AND ${o}.created_at >= '${CONSENSUS_V2_ACTIVATION_TIME}'::timestamptz))`;
}

/**
 * The citation rule as SQL (v1.23.5: one text for the handler and for the
 * start-up back-fill of `feedback.order_account`, healOrderAccounts): every
 * order that admits the review, best first, as rows (kind, owner,
 * in_block_fee). The arguments are SQL expressions — placeholders for the
 * handler, the review row's own columns for the back-fill — for the review's
 * subject, cited permlink and reviewer, whether the pair rule applies, and its
 * block time. The order completed naming the other is preferred only if it
 * was named by the review's time (live that is every such order the database
 * holds; at start-up it keeps a later completion from changing the choice).
 * `pinOnly`: only the orders that may be recorded against (pinnableOrderSql).
 */
export function citationCandidatesSql(e: {
	subject: string;
	permlink: string;
	reviewer: string;
	pairBound: string;
	asOf: string;
	pinOnly?: boolean;
}): string {
	const { subject, permlink, reviewer, pairBound, asOf } = e;
	const pin = e.pinOnly === true ? `\n\t    AND ${pinnableOrderSql('o')}` : '';
	return `SELECT CASE WHEN o.fee_method = 'waived_first_buy' THEN 'waived' ELSE 'paid' END AS kind,
	        o.account AS owner,
	        ${pinnableOrderSql('o')} AS in_block_fee
	   FROM orders o
	  WHERE o.account IN (${subject}, ${reviewer})${pin}
	    AND o.permlink = ${permlink}
	    AND o.fee_status = 'verified'
	    AND ((o.fee_method <> 'waived_first_buy'
	          AND (NOT ${pairBound}
	               OR o.completed_counterparty = (CASE WHEN o.account = ${subject} THEN ${reviewer} ELSE ${subject} END)
	               OR EXISTS (
	                    SELECT 1 FROM chat_messages m
	                     WHERE m.order_permlink = ${permlink}
	                       AND m.created_at <= ${asOf}
	                       AND ((m.sender = ${subject} AND m.recipient = ${reviewer})
	                            OR (m.sender = ${reviewer} AND m.recipient = ${subject})))))
	      OR (${waiverTradeOfThePairSql(subject, reviewer)}
	          AND EXISTS (
	               SELECT 1 FROM waiver_trade_transfers t
	                WHERE t.recipient = o.account
	                  AND t.sender = o.completed_counterparty
	                  AND t.block_time >= o.created_at
	                  AND t.block_time >= '${CONSENSUS_V2_ACTIVATION_TIME}'::timestamptz
	                  AND t.block_time <= ${asOf}
	                  AND t.amount_blurt >= ${WAIVER_TRADE_MIN_TRANSFER_BLURT.toFixed(3)}::numeric)))
	  ORDER BY (o.fee_method = 'waived_first_buy'),
	           COALESCE(o.status = 'completed'
	                    AND o.completed_counterparty = (CASE WHEN o.account = ${subject} THEN ${reviewer} ELSE ${subject} END)
	                    AND COALESCE(o.counterparty_named_at, o.completed_at) <= ${asOf},
	                    FALSE) DESC,
	           (o.account = ${subject}) DESC`;
}

export async function reviewCitesFeePaidOrder(
	db: ChatGateDb,
	args: {
		permlink: string;
		subject: string;
		reviewer: string;
		pairBound: boolean;
		asOf: Date;
	}
): Promise<ReviewCitation | null> {
	return (await reviewCitationOf(db, args))?.kind ?? null;
}

/**
 * reviewCitesFeePaidOrder, with the OWNER of the order that admits the review
 * (v1.23.5): recorded on the review (feedback.order_account), so the two
 * reviews of one trade and its completion are pinned to the same order even
 * when both parties own an order under that permlink. Among the orders that
 * qualify: a paid one before a waiver order (the kind decides the welcome
 * bonus, as before), then the one completed naming the other party (the order
 * they traded on), then the subject's — and only one whose fee is judged in
 * its block (pinnableOrderSql): none, and the owner is null.
 */
export async function reviewCitationOf(
	db: ChatGateDb,
	args: {
		permlink: string;
		subject: string;
		reviewer: string;
		/** Require that the pair traded on the cited order (see above). */
		pairBound: boolean;
		/** The review's block time: chat and transfers at or before it count. */
		asOf: Date;
	}
): Promise<{ kind: ReviewCitation; owner: string | null } | null> {
	// The paid branch keeps `fee_method <> 'waived_first_buy'`: the free
	// first-buy waiver order is stored as fee_status='verified' at ZERO cost,
	// so it passed this check. A fresh sock (free relay signup) could cite its
	// own waiver order to 5★ a target, and a review citing the sock's waiver
	// order triggered the relay-paid welcome bonus (whose trigger requires an
	// accepted citation) from whichever instance the sock named in
	// operator_tag. A paid citation must carry a real paid listing fee; a
	// waiver citation must carry the proof of a real trade instead.
	// Every admitting order, best first (one or two: an order of each party):
	// the first decides the kind, as before; the first whose fee is judged in
	// its block is the one the review is recorded against (null if none).
	const r = await db.query<{ kind: ReviewCitation; owner: string; in_block_fee: boolean }>(
		citationCandidatesSql({
			subject: '$1',
			permlink: '$2',
			reviewer: '$3',
			pairBound: '$4::boolean',
			asOf: '$5'
		}),
		[args.subject, args.permlink, args.reviewer, args.pairBound, args.asOf]
	);
	const first = r.rows[0];
	if (first === undefined) return null;
	return { kind: first.kind, owner: r.rows.find((x) => x.in_block_fee)?.owner ?? null };
}

/**
 * The first-buy waiver trade a review of this pair cites — everything the
 * WAIVED citation asks for but the transfer: the order at `permlink`, owned by
 * one of the two, is a waiver order (fee verified, as every waiver order is),
 * completed naming the other. Returns its owner and that partner, or null.
 * GET /v1/feedback/status uses it to tell a reviewer the review is waiting for
 * the partner's transfer. Read-only; not a consensus input.
 */
export async function waiverTradeOfThePair(
	db: ChatGateDb,
	args: { permlink: string; subject: string; reviewer: string }
): Promise<{ owner: string; partner: string } | null> {
	const r = await db.query<{ owner: string; partner: string }>(
		`SELECT o.account AS owner, o.completed_counterparty AS partner
		   FROM orders o
		  WHERE o.account IN ($1, $3)
		    AND o.permlink = $2
		    AND o.fee_status = 'verified'
		    AND ${waiverTradeOfThePairSql('$1', '$3')}
		  ORDER BY o.account
		  LIMIT 1`,
		[args.subject, args.permlink, args.reviewer]
	);
	return r.rows[0] ?? null;
}
