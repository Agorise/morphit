/**
 * reviewCitation — the ONE definition of "this review cites a real, fee-paid
 * order of one of the two parties".
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

/**
 * True iff an order at `permlink`, owned by the review's subject or by the
 * reviewer, has a VERIFIED listing fee (every citation target costs
 * a real listing fee, which is what makes a fake review expensive).
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
 */
export async function reviewCitesFeePaidOrder(
	db: ChatGateDb,
	args: {
		permlink: string;
		subject: string;
		reviewer: string;
		/** Require that the pair traded on the cited order (see above). */
		pairBound: boolean;
		/** Chat at or before this instant counts. */
		asOf: Date;
	}
): Promise<boolean> {
	// `fee_method <> 'waived_first_buy'`: the free
	// first-buy waiver order is stored as fee_status='verified' at ZERO cost,
	// so it passed this check. A fresh sock (free relay signup) could cite its
	// own waiver order to 5★ a target, and a review citing the sock's waiver
	// order triggered the relay-paid welcome bonus (whose trigger requires an
	// accepted citation) from whichever instance the sock named in
	// operator_tag. A citation must carry a real paid listing fee.
	const r = await db.query(
		`SELECT 1 FROM orders o
		  WHERE o.account IN ($1, $3)
		    AND o.permlink = $2
		    AND o.fee_status = 'verified'
		    AND o.fee_method <> 'waived_first_buy'
		    AND (NOT $4::boolean
		         OR o.completed_counterparty = (CASE WHEN o.account = $1 THEN $3 ELSE $1 END)
		         OR EXISTS (
		              SELECT 1 FROM chat_messages m
		               WHERE m.order_permlink = $2
		                 AND m.created_at <= $5
		                 AND ((m.sender = $1 AND m.recipient = $3)
		                      OR (m.sender = $3 AND m.recipient = $1))))
		  LIMIT 1`,
		[args.subject, args.permlink, args.reviewer, args.pairBound, args.asOf]
	);
	return (r.rowCount ?? r.rows.length) > 0;
}
