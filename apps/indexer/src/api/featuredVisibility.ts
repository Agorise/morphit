/**
 * Which featured-slot bids can hold a slot right now: the bid is active
 * (not cancelled, effective, not expired) AND its order is one /v1/orderbook
 * would show — live, not past its expires_at (NULL = no expiry), fee
 * established, and its owner not blocked on this instance.
 *
 * The featured strip (featuredOrderbook.ts) ranks these and takes the top
 * MAX_SLOTS; /featured/bids (featuredBids.ts) ranks the same set for
 * `is_visible`. Both used to rank every active bid and only then drop dead
 * orders, so a bid on a cancelled or expired order held a paid slot and
 * showed nothing in it, a live bid ranked below it was reported invisible,
 * and an order with no expiry was never featured.
 *
 * `opParam` is the placeholder bound to the operator account. Yields the
 * featured_slot_bids columns.
 */
export function eligibleFeaturedBidsSql(opParam: string): string {
	return `SELECT b.*
	  FROM featured_slot_bids b
	  JOIN orders o
	    ON o.account = b.bidder
	   AND o.permlink = b.order_permlink
	 WHERE b.cancelled = FALSE
	   AND b.effective_at <= NOW()
	   AND b.expires_at > NOW()
	   AND o.status = 'live'
	   AND (o.expires_at IS NULL OR o.expires_at > NOW())
	   AND o.fee_status IN ('verified', 'verified_by_attestation')
	   AND NOT EXISTS (SELECT 1 FROM operator_blocks ob WHERE ob.operator = ${opParam} AND ob.blocked = o.account AND ob.state = 'blocked')`;
}
