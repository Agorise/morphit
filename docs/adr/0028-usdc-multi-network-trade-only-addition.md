# ADR-0028 — USDC (USD Coin) multi-network trade-only addition + stablecoin amount-jitter design correction

**Status:** Accepted (Part 122 cp30)
**Date:** 2026-05-17
**Deciders:** project maintainer
**Supersedes:** none
**Superseded by:** none
**Related:** ADR-0023 (USDT multi-network — the structural pattern
this ADR follows), ADR-0026 (transparent-chain privacy framework
— amount-jitter is one of the privacy techniques described there),
ADR-0027 (DASH addition — same Category-B trade-only shape).

---

## Context

USDC is the second-most-traded fiat-pegged stablecoin (after USDT)
and the only major USD-pegged stablecoin issued by a US-based,
publicly-disclosed issuer (Circle, USA).  Ken requested that Morphit
add USDC support and "implement as many of our privacy things with
this as we have done with the others so far."  The ask carried two
design questions worth decision-record treatment:

1. **Which networks should Morphit support for USDC?**  USDC is
   issued on more chains than USDT (Circle has been more aggressive
   about multi-chain native issuance).  The operator's canonical
   block-explorer list at addition time was:
     - https://blockchair.com/tokens/usd-coin (aggregator)
     - https://etherscan.io/token/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 (Ethereum)
     - https://solscan.io/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (Solana)
     - https://basescan.org/token/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 (Base)
     - https://polygonscan.com/token/0x3c499c542cef5e3811e1192ce70d8cc03d5c3359 (Polygon)
   That's four chain-specific URLs.  Ken subsequently asked
   whether BNB Chain USDC ("if USDC IS on BNB Chain, then go
   ahead and use that one too if it's useful") should be added
   as a fifth network.

2. **Should USDT and USDC trades get the amount-jitter privacy
   technique** that Morphit ships for the other transparent-chain
   trades?  The cp26 generalization of amount-jitter to all
   transparent UTXO chains (BTC, BCH, LTC, DASH) plus BLURT
   explicitly excluded USDT with the reasoning "USDT's privacy
   issue is centralization not amount-correlation; jitter doesn't
   address Tether freezes."  Ken pushed back on this during cp30:
   "if usdc and usdt trades could benefit from the jitter option,
   then why not add it?"

This ADR records the resolution of both questions.

---

## Decision

### Decision 1 — USDC network set: four networks, not five

Morphit ships USDC support on **ERC-20 (Ethereum mainnet), SPL
(Solana), Base, and Polygon PoS** — the four chain-specific
explorers the operator surveyed.  These four share a critical
property: **Circle natively issues USDC on each of them**, and
all four use **6-decimal precision** (Circle's standard for
USDC's `decimals()` ERC-20 / SPL token-mint return value).

**BEP-20 (BNB Smart Chain) USDC is INTENTIONALLY NOT supported
in the initial set.**  Two reasons, either of which is
sufficient grounds for the decision:

1. **It's a Binance-Peg wrapper, not native Circle issuance.**
   The BSC USDC contract at
   `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d`
   is labeled "Binance-Peg USD Coin" on BscScan and is backed
   by USDC custodied by Binance (via Binance Bridge), not by
   USDC minted directly by Circle on the BSC chain.  CoinDesk
   distinguishes this asset under a separate ticker (BPUSDC) and
   notes that "since Binance Bridge manages this asset on the
   Binance Network, the original project [Circle] is not
   responsible for any issues or vulnerabilities that may arise
   with the bridged token."

   Adopting Binance-Peg USDC would stack a second custodial
   chokepoint (Binance) on top of the existing one (Circle).
   That violates Morphit priority #2 (decentralization /
   unstoppability — no mandatory central chokepoints): the more
   custodians sit between the user and their dollar, the more
   ways a regulatory or operational disruption can sever them
   from their balance.  Tether's BEP-20 USDT is comparable
   shape (centralized stablecoin on BSC) but is NOT a wrapped
   version — Tether issues it natively on BSC — so the
   centralization story there is "one custodian (Tether) we
   can't change."  Binance-Peg USDC's story is "two custodians
   (Binance + Circle) we can't change," which is strictly worse
   on the decentralization axis Morphit cares about.

2. **Decimals divergence: 18 vs 6.**  Binance-Peg USDC uses
   18-decimal precision (the default for BSC tokens), where
   Circle's native USDC on every other chain uses 6 decimals.
   Morphit's wire-format amount strings (in
   `apps/web/src/lib/chat/payload.ts`) do not carry decimal
   metadata — the assumption everywhere is that a given asset
   has a fixed canonical precision.  Adding a 5th network at
   18-decimal precision while the other 4 are 6-decimal would
   either require a per-network decimal-precision field on
   `AssetEntry` (a significant data-model change) or risk a
   foot-gun where users typing "100 USDC" expecting 100 USDC
   on BSC could send 100 × 10⁻¹² USDC by 6-decimal interpretation
   (or 100 × 10⁶ USDC by 18-decimal interpretation, depending
   on which side gets confused).  Either way is a loss-of-funds
   class bug we choose to avoid.

This decision is non-breaking: a future Circle native
six-decimal USDC issuance on BSC (or an explicit operator opt-in
for Binance-Peg) can be added by appending `'bep20'` to
`USDC_NETWORKS` in `apps/web/src/lib/assets/networks.ts`,
extending `USDC_NETWORK_METADATA`, adding `bep20: string | null`
to the instance-store sub-map, and shipping the matching
i18n keys.  A REVISIT-LIST entry tracks the question for future
re-evaluation.

**TRC-20 USDC is similarly NOT supported, but for a different
reason:** Circle does not natively issue USDC on Tron.  Any
USDC presence on Tron today is community-bridged.  Same
"second-custodian" objection as BSC, but without a
Binance-Peg-style heavyweight wrapper to even consider —
just not in scope at all.

### Decision 2 — Amount-jitter for stablecoins: enabled

The cp26 USDT-no-jitter decision was wrong, or at least
incomplete.  The original rationale ("USDT's privacy issue is
centralization not amount-correlation; jitter doesn't address
Tether freezes") was a correct observation but an unsound
argument: the absence of jitter benefit on the centralization
threat does not refute the jitter benefit on the
amount-correlation threat.  Both threats are real and
independent.

**The amount-correlation threat applies to stablecoin trades
identically to how it applies to UTXO and BLURT trades.**  An
off-platform observer who knows the agreed price for a trade
("Alice is buying $5,000 of USDC from Bob for $5,000 cash")
can fingerprint the matching on-chain transfer by matching the
exact amount (`5000.000000 USDC`).  This works on Ethereum,
Solana, Base, and Polygon the same way it works on Bitcoin,
Bitcoin Cash, Litecoin, and Dash.  The Circle/Tether freeze
power is a separate concern that lives in the per-asset
privacy guides (`/privacy/usdt`, `/privacy/usdc`) and the
privacy-warning chip — not a justification for skipping the
amount-correlation defense.

cp30 ships `jitterStablecoinAmount(base)` (in
`apps/web/src/lib/chat/payload.ts`) parallel to
`jitterMoneroAmount`, `jitterUtxoAmount`, and
`jitterBlurtAmount`.  6-decimal precision, 0–999 micro-unit
random jitter (under one tenth of a US cent at peg), CSPRNG-
derived, round-up-only.  The `jitterAmountForAsset` dispatcher
routes both `'usdt'` and `'usdc'` through this function.  Toggle
is the same UI affordance as the other jittered assets: visible
right under the amount field in the address-share modal,
default ON.

The `monero_amount_jitter` FAQ entry (× 10 locales) is rewritten
in this same checkpoint to remove the "USDT is excluded" clause
and add USDT + USDC to the per-asset jitter range table.

### Decision 3 — Operator-stance freedom remains via env var

Same as USDT (ADR-0023) and the cp21–cp27 trade-only assets:
operators who prefer not to host USDC trades on their instance
disable it via `MORPHIT_INDEXER_DISABLED_ASSETS=USDC` (or the
ops-cli wizard's "Trade-only asset policy" step, which now
includes USDC in the per-ticker per-asset prompt).  USDC ships
**default-ON** (Memory #25).  Federation still surfaces other
operators' USDC orders to the user's orderbook regardless of
this operator's stance.

### Decision 4 — Canonical wire format

`'usdc'` joins `'usdt'` as the second multi-network entry in
`ChatAssetTicker`.  The wire-format `network` discriminator
field on `AddressPayload` and `FundsSentPayload` is REQUIRED
when `method === 'usdc'` (one of `'erc20'|'spl'|'base'|'polygon'`).
Critical UX consequence: **three of USDC's four supported
networks share the EVM `0x[40 hex]` address shape** (ERC-20,
Base, Polygon all use Ethereum-format addresses).  The network
field is the only thing telling the sender's wallet which
chain to broadcast on — the address alone can't disambiguate.
The cross-network warning copy in the UsdcNetworkPicker
component surfaces this explicitly.

The fee_method enum stays frozen at BLURT/BTC/XMR per
ADR-0011 + ADR-0023's freeze.  USDC cannot pay listing fees.

---

## Rationale (additional notes)

### Why ship USDC at all, given the centralization concern?

The same answer ADR-0023 gave for USDT: **Morphit is a
peer-to-peer marketplace, not a privacy-pure escrow service.**
Some users want stablecoin trades because their
counterparty does, because the fiat-denominated round numbers
match their off-platform planning, or because they're moving
funds between custodial exchanges that quote in USDC.  Morphit's
job is to facilitate the trade without holding funds; the
privacy posture of the underlying chain is documented honestly
per ADR-0026 (transparent-chain privacy framework) and the
per-asset privacy guide at `/privacy/usdc`.  Operators who
disagree have the `MORPHIT_INDEXER_DISABLED_ASSETS` env var as
the documented opt-out.

### Why surface the "EVM address shapes are identical" warning
### so prominently?

This is genuinely a class of foot-gun unique to USDC's four-
network set.  Among the multi-network stablecoins, USDT's four
networks split cleanly across format families: ERC-20 (0x...)
vs TRC-20 (T...) vs SPL (base58) vs BEP-20 (0x...).  A USDT
user can tell at a glance whether an address is for an
EVM-family network (ERC-20 or BEP-20) vs Tron vs Solana.

USDC's four networks split the OTHER way: ERC-20 + Base +
Polygon all share the same `0x[40 hex]` EVM address format.
A user looking at `0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48`
cannot tell whether it's a Base address, an Ethereum address,
or a Polygon address.  They are all valid receiving addresses
on all three chains — they're the same wallet — but each chain
has its own separate USDC balance at that address.  Sending
USDC on Polygon to "the same address" the receiver gave you
for Base will not produce a balance the receiver can spend
on Base; the funds are on Polygon and need a Polygon-side
wallet to access.

The network discriminator field, the picker UI, the per-
message cross-network warning in `ChatMessage.svelte`, and
the explicit copy in `crossNetworkWarning` i18n key all exist
to make this unmissable.

### Why no jitter for the centralization threat?

Jitter doesn't help against Circle/Tether freezing.  The freeze
applies to the address regardless of the amount being received
there.  The per-asset privacy guide and the privacy-warning
chip carry that part of the story.  Jitter only addresses the
amount-correlation linkability threat — but that threat is
real and independent.

---

## Files touched (this checkpoint)

Code:
- `packages/asset-registry/src/index.ts` — USDC AssetEntry, ASSET_TICKERS expanded to 8
- `apps/web/src/lib/assets/networks.ts` — USDC_NETWORKS, USDC_NETWORK_METADATA, validateUsdcAddress, validateUsdcTxid, bundledUsdcExplorerUrl, isUsdcNetwork, getUsdcNetworkMetadata, module-doc updated
- `apps/web/src/lib/assets/registry.ts` — validateUsdc + AssetMetadata USDC entry
- `apps/web/src/lib/chat/payload.ts` — ChatAssetTicker widened, isValidUsdcAddress, isValidUsdcTxid, jitterStablecoinAmount, dispatcher gates extended, network-field decoder extended, jitter dispatcher routes USDT+USDC through jitterStablecoinAmount
- `apps/web/src/lib/explorer/urls.ts` — usdcExplorerUrl
- `apps/web/src/lib/stores/instance.ts` — chat_link_urls.usdc sub-map, FALLBACK, fetch normalization
- `apps/web/src/lib/prices/providers/coingecko.ts` + `fallback.ts` — `usd-coin` ID + $1.00 fallback
- `apps/web/src/lib/payments/registry.ts` — pay_usdc entry
- `apps/indexer/src/indexer/handlers/operatorPaymentMethod.ts` — pay_usdc in RESERVED_CANONICAL_KEYS
- `apps/matrix-bot/scripts/api-response-shape-smoke.ts` — usdc sub-schema in ChatLinkUrlsSchema
- `apps/ops-cli/src/init/steps.ts` — CATEGORY_B_DESCRIPTIONS USDC entry + disabled-assets wizard explanation
- `apps/web/src/lib/components/UsdcNetworkPicker.svelte` (new)
- `apps/web/src/lib/components/AddressShareModal.svelte` — full USDC dispatch
- `apps/web/src/lib/components/FundsSentModal.svelte` — full USDC dispatch
- `apps/web/src/lib/components/ChatMessage.svelte` — USDC pill, explorer URL, mark-sent type widening, cross-network warning
- `apps/web/src/lib/components/ConversationView.svelte` — markSentArgs widening, initialUsdcNetwork prop
- `apps/web/static/icons/icon-usdc.svg` (new)
- `apps/web/static/icons/networks/icon-network-base.svg` (new)
- `apps/web/static/icons/networks/icon-network-polygon.svg` (new)

Locales (10 × ~25 new strings + 5 FAQ-asset-enum extensions × 10 + jitter FAQ rewrite × 10):
- en/es/fr/de native, it/pl/ru/fa/zh-CN/zh-HK EN-fallback per cp27 precedent
- Locale parity 2,644 × 10 = 26,440 → 2,673 × 10 = 26,730

Docs:
- `docs/adr/0028-usdc-multi-network-trade-only-addition.md` (this file)
- `docs/REVISIT-LIST.md` — BEP-20-USDC decline entry + cp30 native-QA entry + jitter-design-correction note
- `docs/AUDIT-2026-05.md` — cp30 entry
- `docs/MORPHIT-BRAG-LIST.md` — #29 amount-jitter extended; ADR count 27→28; asset-enum entries; new #280
- `docs/RUN-A-MORPHIT-NODE.md` — trade-only-assets section USDC env-var examples
- `docs/PRE-LAUNCH-CHECKLIST.md` — USDC awareness
- `docs/OPERATIONS.md` — USDC awareness
- `docs/GRANDMA-FRIENDLY-INVESTIGATION.md` — asset enumerations
- `ops/env/indexer.env.example` — MORPHIT_INDEXER_DISABLED_ASSETS examples
- `apps/web/static/llms.txt` + `llms-full.txt` regenerated via `scripts/build-llms-full.mjs` (header bumped)
- `TARBALL.md` — cp30 entry prepended

Smokes:
- `packages/asset-registry/scripts/usdc-trade-only-smoke.ts` (new, ~13 scenarios mirroring usdt-trade-only-smoke)
- `apps/web/scripts/wiring-completeness-smoke.ts` — cp30-usdc-p2p CHECK row
- `apps/web/scripts/amount-jitter-utxo-smoke.ts` — extended with stablecoin scenarios (or new sibling smoke)

---

## Consequences

- USDC trades happen end-to-end on Morphit at parity with USDT,
  with the additional safety of amount-jitter (which USDT now
  also gets retroactively in this same checkpoint).
- The "EVM-family addresses are identical across chains"
  foot-gun is surfaced loudly via the network-picker warning;
  Circle's freeze power is documented honestly in the per-asset
  privacy guide.
- Operators have first-class control via env var + wizard.
- The non-breaking add path for future networks (including
  Binance-Peg or future native-Circle BSC USDC) is documented
  in this file and in the REVISIT-LIST.

## Tracking

Brag-list entry #280 (added this checkpoint).
REVISIT-LIST entries: BEP-20-USDC reconsideration; native-QA
for cp30 USDC i18n in the 6 EN-fallback locales (parallel to
the existing DASH/BCH/LTC native-QA REVISIT).

This decision-record file replaces the cp30-mid TARBALL.md
notes with a permanent on-disk explanation.  Future asset
additions that follow this multi-network pattern should
reference this ADR for the per-network design (alongside
ADR-0023).
