/**
 * Morphit — the featured-slot cap, client side.
 *
 * The indexer is authoritative: `MAX_SLOTS = 3` in
 * `apps/indexer/src/api/featuredOrderbook.ts` (and the matching constant in
 * featuredBids.ts / clearingPriceHistory.ts). Runtime surfaces that already
 * fetch the API should prefer the `max_slots` field it returns.
 *
 * This constant exists for the places that only need to *say* the number —
 * chiefly the "Feature this order!" explainer, which for a while claimed "Max
 * 5 concurrent slots" while the FAQ and the indexer both said 3. Copy that
 * hardcodes a number drifts silently; a constant that a smoke pins against the
 * indexer's value cannot.
 *
 * If you change this, change `MAX_SLOTS` in the indexer and re-run
 * `featured-slot-count-parity` inside the featured-order-copy smoke.
 */
export const MAX_FEATURED_SLOTS = 3;
