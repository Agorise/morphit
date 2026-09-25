/**
 * reviewCitation — the ONE definition of "this review cites a real, fee-paid
 * order of one of the two parties" (v1.18.0 deep-deep, rv6-L1).
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
 * reviewer, has a VERIFIED listing fee (Part 113: every citation target costs
 * a real listing fee, which is what makes a fake review expensive).
 */
export async function reviewCitesFeePaidOrder(
	db: ChatGateDb,
	args: { permlink: string; subject: string; reviewer: string }
): Promise<boolean> {
	// The durable handler's query, verbatim — it is the authority.
	//
	// (v1.18.0 deep-deep, rv6-M3) `fee_method <> 'waived_first_buy'`: the free
	// first-buy waiver order is stored as fee_status='verified' at ZERO cost,
	// so it passed this check. A fresh sock (free relay signup) could cite its
	// own waiver order to 5★ a target, and a review citing the sock's waiver
	// order triggered the relay-paid welcome bonus (whose trigger requires an
	// accepted citation) from whichever instance the sock named in
	// operator_tag. A citation must carry a real paid listing fee.
	const r = await db.query(
		`SELECT 1 FROM orders
		  WHERE account IN ($1, $3)
		    AND permlink = $2
		    AND fee_status = 'verified'
		    AND fee_method <> 'waived_first_buy'
		  LIMIT 1`,
		[args.subject, args.permlink, args.reviewer]
	);
	return (r.rowCount ?? r.rows.length) > 0;
}
