/**
 * Canonical Morphit treasury — single source of truth for the
 * official morphit.io fee-collection accounts (cp315).
 *
 * WHAT THIS IS
 * ------------
 * Every Morphit instance — canonical and community alike — routes
 * listing fees to the SAME canonical treasury:
 *   • BLURT listing fees → @morphit-fees.  The treasury receives
 *     100% and immediately pays the attributed operator their 90%
 *     back (apps/indexer/src/indexer/operatorEarnings.ts); the
 *     treasury nets 10%.  On the canonical (unattributed) instance
 *     there is no operator to pay, so the treasury keeps 100%.
 *   • BTC / XMR listing fees → the canonical addresses below, 100%
 *     to treasury.  They never enter the operator-split path
 *     (attributeBlurtFeeToOperator is only called on the BLURT-fee
 *     branch of the order handler).
 *
 * These three values are the economic spine of the project: if
 * they drift per-operator the treasury stops being paid and the
 * federation's shared-fee model collapses.  They are therefore:
 *   1. baked in here as the software default — not hand-entered
 *      per deployment;
 *   2. the seed the on-chain release-op builder
 *      (apps/indexer/scripts/release-build-payload.ts) pre-fills,
 *      so the signed `morphit_release_v1` treasury block carries
 *      these exact addresses with no typo risk at launch;
 *   3. NOT surfaced in the morphit-ops menu — operators must not
 *      edit them.  A forked operator who changes a local value
 *      still cannot divert fees: the frontend only ever displays
 *      the CHAIN-PINNED address (apps/web/src/lib/stores/release.ts)
 *      and every indexer verifies payments against the chain-pin
 *      (apps/indexer/src/indexer/treasurySource.ts), so a tampered
 *      local value just gets that instance's orders marked
 *      underpaid / unfederated.
 *
 * RESOLUTION ORDER (treasurySource.ts):
 *     chain-pinned release op  >  operator env var  >  THIS default
 * The chain-pin is authoritative once a release op is broadcast.
 * These defaults are the verification fallback + the builder seed.
 * An operator who genuinely wants BTC or XMR fee acceptance
 * DISABLED on their instance sets the corresponding
 * MORPHIT_INDEXER_{BTC,XMR}_FEE_ADDRESS env var to an explicit
 * empty string (an absent var now resolves to the canonical
 * default rather than "disabled").
 *
 * EDITING / ROTATION: change the value here AND broadcast a fresh
 * release op so the chain-pin matches; otherwise instances already
 * on the old chain-pin keep the old address until they see the new
 * op.  These are PUBLIC receiving addresses — safe to commit.  The
 * Monero PRIVATE view key is NEVER stored here or chain-pinned
 * (Part 107 / 109 privacy invariant).
 */
export const CANONICAL_TREASURY = {
	/** BLURT account that collects listing fees.  Mirrors the
	 *  frontend `FEE_RECIPIENT` (apps/web/src/lib/orders/fee.ts) and
	 *  the indexer `MORPHIT_INDEXER_FEE_RECIPIENT` default.  cp408 —
	 *  the 90/10 owner/treasury split is applied AT PAYMENT TIME (the
	 *  fee tx carries a 90% leg to the instance's recipient + a 10%
	 *  leg to this account); on the canonical instance both legs land
	 *  here, so it collects 100%. */
	blurt: 'morphit-fees',
	/** Mainnet BTC P2WPKH (bech32, `bc1q…`) fee address. 100% to
	 *  treasury.  Passes @morphit/release-schema validateTreasury
	 *  (BTC_MAINNET_ADDRESS_RE). */
	btc: 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk',
	/** Mainnet XMR subaddress (`8…`, exactly 95 chars) fee address.
	 *  100% to treasury.  Passes @morphit/release-schema
	 *  validateTreasury (XMR_MAINNET_ADDRESS_RE).  View key is
	 *  env-only and never published. */
	xmr: '84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe'
} as const;
