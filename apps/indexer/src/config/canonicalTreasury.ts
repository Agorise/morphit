/**
 * Canonical Morphit treasury — single source of truth for the
 * official morphit.io fee-collection accounts.
 *
 * WHAT THIS IS
 * ------------
 * Every Morphit instance — canonical and community alike — routes
 * listing fees to the SAME canonical treasury:
 *   • BLURT listing fees → split at payment time by the payer: 90%
 *     to the fee account of the instance the order was posted
 *     through, 10% to @morphit-fees (one 100% transfer when that
 *     instance's fee account IS @morphit-fees). Nothing is paid back
 *     afterwards: operatorEarnings.ts only records the attribution.
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
 * (109 privacy invariant).
 */
export const CANONICAL_TREASURY = {
	/** BLURT account that collects listing fees.  Mirrors the
	 *  frontend `FEE_RECIPIENT` (apps/web/src/lib/orders/fee.ts) and
	 *  the indexer `MORPHIT_INDEXER_FEE_RECIPIENT` default.
	 *  the 90/10 owner/treasury split is applied AT PAYMENT TIME (the
	 *  fee tx carries a 90% leg to the instance's recipient + a 10%
	 *  leg to this account); on the canonical instance both legs land
	 *  here, so it collects 100%. */
	blurt: 'morphit-fees',
	/** Mainnet BTC P2WPKH (bech32, `bc1q…`) fee address. 100% to
	 *  treasury.  Passes @morphit/release-schema validateTreasury
	 *  (shape and checksum). */
	btc: 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk',
	/** Mainnet XMR subaddress (`8…`, exactly 95 chars) fee address.
	 *  100% to treasury.  Passes @morphit/release-schema
	 *  validateTreasury (shape and checksum).  No indexer holds a
	 *  view key: payments are checked with the payer's tx key. */
	xmr: '84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe',
	/** v1.20.0 (MK-H2) — the treasury BTC wallet's ACCOUNT extended PUBLIC
	 *  key (native segwit, m/84'/0'/0'), canonical `xpub…` spelling. When
	 *  set, the release-op builder pins it (treasury.btc.xpub) and every
	 *  BTC-fee order posted after that release gets its OWN fee address
	 *  (receive address n of this key) instead of paying `btc` above.
	 *  Empty = not pinned (BTC fees keep the shared-address txid path).
	 *  Set it ONLY with `node_modules/.bin/tsx apps/indexer/scripts/set-treasury-btc-xpub.ts
	 *  <xpub-or-zpub>` on the laptop: it refuses private/testnet/wrong-type
	 *  keys and prints the first receive addresses to compare with the
	 *  wallet. Public information (every indexer must derive the
	 *  addresses); never a private key. Chain-pin ONLY: no indexer env
	 *  var reads it, because every indexer must number addresses from the
	 *  same on-chain value. Kept on ONE line (prettier-ignore below):
	 *  set-treasury-btc-xpub.ts finds and rewrites `btcXpub: '…'` as a line. */
	// prettier-ignore
	btcXpub: 'xpub6CcLNrHQNdy8UFduUNpM1bMCa8DUZdRKnApqBg3papGqdawVGKPu77ry8Q1FpjjevQ6nCVpSyuqC43DY7sK2vXsSz7fq5T5tjW6js61FBVp',
	/** v1.20.0 (MK-H2) — the treasury Monero wallet's PRIMARY (main) address,
	 *  `4…`, 95 chars — the same wallet as `xmr` above. When set, the
	 *  release-op builder pins it (treasury.xmr.primary_address) and every
	 *  XMR-fee order posted after that release must pay the INTEGRATED
	 *  address of this address carrying the order's own payment ID, so a
	 *  copied txid + tx key cannot pay for anyone else's order. Empty = not
	 *  pinned (XMR fees stay unbound payments to `xmr`). Set it ONLY with
	 *  `node_modules/.bin/tsx apps/indexer/scripts/set-treasury-xmr-primary.ts <address>`
	 *  on the laptop, and only after the pre-pin checklist in
	 *  docs/OPERATIONS.md §40.13 passes. Public; chain-pin ONLY. Kept on ONE
	 *  line (prettier-ignore below): set-treasury-xmr-primary.ts finds and
	 *  rewrites `xmrPrimary: '…'` as a line. */
	// prettier-ignore
	xmrPrimary: ''
} as const;
