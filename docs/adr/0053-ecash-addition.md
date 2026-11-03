# ADR-0053: eCash (ECX) Addition — Trade-Only Bitcoin Fork with Bitcoin-Identical Addresses and Opt-In Replay Protection

**Status:** Accepted

**Context:**

eCash (ECX) is a hard fork of Bitcoin, associated with Paul Sztorc and LayerTwo Labs (ecash.com's FAQ), that activated at block 973,728, stamped 29 October 2026 18:59:55 UTC. It keeps Bitcoin's history up to that block, its rules, its transaction format and its address formats, and adds drivechains (BIP300/301): optional side chains whose withdrawals miners approve. Project site: ecash.com; integration notes: github.com/ecash-com/fast-facts; node: github.com/ecash-com/bitcoin.

Facts below were checked in the node's code at tag `ecash-v1.2.0-core32.1` (commit c8474e0b), not only in the integration notes, which still describe the pre-launch plan in places:

- **Fork height** 973,728 (`consensus.EcashHeight`, src/kernel/chainparams.cpp). Difficulty at the fork is set to 2.6e9 (`EcashForkBits`), and retargeting happens every 288 blocks after it.
- **Units:** `COIN = 100'000'000`, 8 decimals, as Bitcoin.
- **Addresses:** base58 prefixes 0 (P2PKH) and 5 (P2SH), WIF 128, Bitcoin's xpub/xprv versions, bech32 HRP `bc`. **Every eCash address is a Bitcoin address and the reverse.** No SLIP-44 coin type of its own (wallets use 0').
- **Replay protection:** opt-in. `IsFinalTx` treats `nLockTime == LOCKTIME_THRESHOLD - 2` (**499,999,998**) as final on eCash; Bitcoin reads it as a block height far in the future, so the transaction cannot be mined there as long as one of its inputs has an nSequence below 0xffffffff (with every input final, both chains ignore nLockTime) (src/consensus/tx_verify.cpp; CLTV in src/script/interpreter.cpp). The integration notes say 499,999,999 (`LOCKTIME_THRESHOLD - 1`), which is NOT the marker in the launch code. The node's own wallet does not set the marker by default (src/wallet/spend.cpp sets the locktime to the block height or 0, as Bitcoin Core does). Besides this marker and the difficulty rules, the node carries the drivechain opcode (`OP_DRIVECHAIN`, src/script/script.h) and leaves the BIP300/301 rules to a companion process (`bip300301_enforcer`, src/rpc/mining.cpp: block templates must come from it); none of these makes a Bitcoin transaction invalid on eCash, so a Bitcoin payment from pre-fork coins is protected only by splitting the coins on eCash first. The mainnet value 499,999,998 is also the one crypto-finance.com reports proposing to the developers ("eCash Replay Protection: Identifying and Solving a Cross-Network Risk").
- **Explorers:** explorer.ecash.com (the project's mempool.space instance) and explorer.blockfab.org (a second explorer titled "eCash Explorer", with the same API and a client-routed `/tx/{txid}` page; who runs it is not stated). On 2026-11-02 explorer.ecash.com served mainnet transaction d62d3e35…f71e at block 982,678 and both returned the same hash for block 982,673 (`/api/block-height/982673`: 0000…d4f0370b…ed547a), so both follow the same chain as the project's own explorer; on 2026-11-03 explorer.blockfab.org's `/api/tx/` answered for d815ff0c…f610 at block 982,846. No Tor or I2P explorer is known.
- **Name clash:** XEC, Bitcoin ABC's coin since 2021, is also called eCash and uses the `ecash:` address prefix. wECX is a wrapped token on Solana. Neither is ECX.

## Decision

### 1. Trade-only, single-network, transparent

`canPayListingFee: false` (the `fee_method` enum stays frozen at `blurt | btc | xmr | waived_first_buy`), `supportedNetworks: ['mainnet']`, `COIN_PRIVACY_CLASS.ECX = 'transparent'`, `optInPrivacyTech: null`, `freshAddressAdvice: 'hd-derived'`, no privacy-warning chip (no issuer can freeze it).

### 2. Always "eCash (ECX)"

The display name everywhere is "eCash (ECX)", never "eCash" alone, and the FAQ says it is neither XEC nor wECX.

### 3. Bitcoin's address and txid checks; the chain is named in words

The address shape is Bitcoin's (`address-shape-overlap-smoke` documents that BTC and ECX accept exactly the same strings, with all of Bitcoin's other overlaps). Because nothing in an address tells the chains apart:

- the chat address card for ECX carries a standing warning (`assets.ecx.address_share.warning`): pay on the eCash network only, from an eCash wallet; a Bitcoin wallet would pay bitcoin to this address, and it may not come back; split coins from before the fork (block 973,728), or received from such coins, first, or the same payment can also go out on Bitcoin;
- **no payment link**: `bitcoin:` would open a Bitcoin wallet and pay BTC to the same address, and `ecash:` is XEC's prefix. `buildPaymentUri` returns the bare address.

### 4. Replay warnings in plain words, no magic number

The FAQ (`what_is_ecx`), the ECX privacy guide, the order-form explainer, the cheat sheet, the payment-method description and the chat card all say that coins held before the fork exist on both chains, as can coins received since from such coins (a payment from unsplit coins is valid on both chains, so its outputs can exist on both), and must be split before trading; the short texts (explainer, cheat sheet, payment method) add "only splitting keeps the two chains apart", and the chat card that otherwise the same payment can also go out on Bitcoin. The FAQ and the guide also say that a Bitcoin payment from those coins can spend the ECX, that the node's own wallet adds no replay protection unless set up to (so assume a wallet adds none unless it says so), and that news reports say eCash's official wallet splits coins (finst.com and cryptoticker.io; the integration notes do not name a wallet). User texts do not quote an nLockTime value: the published notes and the code disagree, and setting it is the wallet's job (the node's own `send` and `walletcreatefundedpsbt` take a `locktime`).

### 5. Explorer links only to eCash explorers

A replayed payment has the same txid on Bitcoin, so a Bitcoin explorer would show the Bitcoin copy. The bundled default is `https://explorer.ecash.com/tx/{txid}`, with `https://explorer.blockfab.org/tx/{txid}` as the alternative; `MORPHIT_FRONTEND_ECX_CHAT_LINK_URL` overrides it. Hidden (Tor/I2P) pages show no link for ECX (`ECX: []` in hiddenExplorers.ts), exactly like Decred and Pirate Chain, rather than fall back to a Bitcoin onion explorer.

### 6. Jitter and price

Satoshi-precision jitter (`jitterUtxoAmount`, the 8-decimal coins). No price source: ECX quotes are "unknown", so orders use a fixed price.

### 7. Federation

An indexer on a version without ECX refuses an order in it (`asset_invalid`) and a barter listing that accepts it (`accepted_assets_entry_unknown`). When it upgrades, `reapplyObsoleteRejections` (apps/indexer/src/indexer/reconcileUpgrade.ts) replays those orders at boot with their recorded BLURT fee transfers, so the orders posted in ECX before a site upgraded show there too (test/integration/upgrade-new-coin-convergence.test.ts).

The replay judges each order as of its own position in the chain: its Sybil tier counts only the account's orders created before it that were made in the 24 hours before it or still live then, and the first-buy check only the orders before it, not the ones applied since (`OpContext.judgedOutOfOrder`). The order and its later replace/cancel/complete ops and fee attestations are healed in one transaction. Only dependent ops refused because the order (or its coin) was missing are replayed; an op refused for anything else is refused on every node and stays so. A handler that throws is refused as the live pass refuses it (`handler_threw:…`, or `handler_aborted_tx` for one that swallowed a failed statement), so a fresh node holds the same; anything else that fails (a passing database trouble such as a timeout or a deadlock, a lost connection) undoes the whole heal for the next boot to try again, and that account is not healed further this boot, so its later orders are never judged without it; an order whose fee transfers are not recorded yet holds its account the same way. These orders have their own scan, read until none is left, so rows of the older v1.19 scan cannot starve it; it replays orders in any coin this version knows, so a node that lagged through an earlier coin's addition converges too (test/integration/upgrade-replay-as-of-position.test.ts). On a node that indexed such orders with v1.21.7 or older, their fee transfers are recorded by a background back-fill after the first boot (`feeLegsBackfill.ts`, oldest block first), and they show at the first restart after it has reached them.

What a replay cannot undo: ops the lagging node APPLIED meanwhile were judged without the ECX order (a later order of the same account priced one tier lower; a first-buy waiver granted when the account's first order was in ECX; a fee transaction ID a later order claimed first; a permlink the account reused for a later order, which keeps it there (the ECX order stays refused, `permlink_taken_since`); loyalty milestones and BP delegations, which follow the order in which that node verified the fees), and chat messages, feature bids and reviews that cite an ECX order were refused there and are not replayed (they read state that has moved on). These differences are confined to accounts that used ECX while a site lagged. So operators should upgrade before ECX orders appear, and the coin is announced after the sites have upgraded.

## Consequences

- The coin-completeness, per-asset family, payment-rail, icon, overlap and wizard smokes now include ECX; `docs/ADDING-A-COIN.md` was the checklist.
- The amount-jitter FAQ names ECX on the satoshi line in all 10 locales.
- Sellers and buyers carry the replay risk the chain itself leaves open; Morphit's part is to say so wherever ECX is paid.
