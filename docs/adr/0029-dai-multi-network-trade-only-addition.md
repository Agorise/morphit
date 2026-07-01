# ADR-0029: DAI (Dai stablecoin) multi-network trade-only addition

**Status:** Accepted
**Date:** 2026-05-18
**Deciders:** (@ken, claude)
**Supersedes:** N/A
**Superseded by:** N/A

## Context

Part 122 cp31 adds **DAI (Dai stablecoin)** as the 9th tradable asset, the
3rd Category-B (trade-only) stablecoin, and the 3rd multi-network asset
on Morphit.

DAI is the stablecoin issued by the MakerDAO protocol.  It's a USD-pegged
ERC-20-class token, multi-network across 4 chains: Ethereum (native),
Polygon (PoS), Base, and Arbitrum.  Unlike USDT (Tether Inc.) and USDC
(Circle), DAI has no single corporate issuer with direct address-freeze
power on the token contract.  It is governed by holders of the MKR
governance token via on-chain proposals.

DAI is requested because:
- Several active traders prefer DAI over USDT/USDC specifically for its
  more-decentralized governance and crypto-collateral history
- Adds a meaningful third stablecoin option for users who want fiat-pegged
  trading without committing to a single-issuer trust model
- Fits Morphit's federated, anti-chokepoint design philosophy

This ADR captures the design decisions, the honest privacy story (which
is more nuanced than USDT/USDC), and the per-asset trade-offs.

## Decisions

### 1. Networks supported: 4

Per the canonical MakerDAO deployments verified at addition time:

| Network    | Contract                                                | Explorer                  |
|------------|---------------------------------------------------------|---------------------------|
| Ethereum   | `0x6b175474e89094c44da98b954eedeac495271d0f`            | etherscan.io              |
| Polygon    | `0x8f3cf7ad23cd3cadbd9735aff958023239c6a063`            | polygonscan.com           |
| Base       | `0x50c5725949a6f0c72e6c4a641f24049a917db0cb`            | basescan.org              |
| Arbitrum   | `0xda10009cbd5d07dd0cecc66161fc93d7c9000da1`            | arbiscan.io               |

All four are EVM-format addresses (0x[40 hex]) — same cross-network-mis-send
foot-gun as USDC's three EVM networks (cp30 ADR-0028).  Network discriminator
is the only way to tell them apart.

**Networks intentionally NOT supported:**
- **Solana (SPL):** No canonical Maker-issued DAI on Solana.  Existing
  Solana DAI variants are wrapped/bridged tokens issued by third parties
  (e.g., Wormhole, Allbridge); using them on Morphit would require trusting
  ALSO the wrapper custodian, which defeats the "DAI is decentralized"
  rationale.
- **BNB Smart Chain (BEP-20):** Same concern — Binance-Peg DAI is wrapped,
  not Maker-native.  Same exclusion rationale as ADR-0028 §1 for USDC on
  BEP-20.
- **Tron (TRC-20):** No canonical Maker-issued DAI on Tron.
- **Arbitrum One vs Arbitrum Nova:** Only Arbitrum One (the main rollup)
  ships in cp31.  Nova is a separate chain with different security
  assumptions; adding it would be a separate decision.

If MakerDAO ships canonical native DAI on a new chain in the future, that's
a per-network addition under this ADR; the asset-level structure is
already in place.

### 2. Privacy warning: "partly_centralized" / DAI-specific tone

This is the trickiest design decision.  USDT and USDC both ship the
`*_centralized` warning class because each issuer can directly freeze
addresses.  DAI is different but NOT freeze-immune:

**What DAI gets right (compared to USDT/USDC):**
- The Dai token contract has **no admin-controlled freeze function**.
  Maker can't add an address to a blacklist and stop transfers.
- The protocol is governed by MKR token holders via on-chain votes; no
  single corporate entity controls it.
- A meaningful portion of DAI has historically been backed by overcollateralized
  ETH/WBTC vaults — pure-crypto collateral with no centralized dependency.

**What DAI honestly cannot claim (the nuance):**
- Since ~2020, DAI has used the **Peg Stability Module (PSM)** which holds
  USDC as collateral to dampen peg deviation.  When DAI is partly backed
  by USDC, Circle's freeze power over USDC affects the redemption side of
  DAI's peg.  This is a real, ongoing dependency.
- A future governance vote (MKR holders) could theoretically deploy a
  freeze mechanism or change the redemption mechanics.  This hasn't
  happened in practice but it's possible.
- DAI transactions are **publicly visible** on each chain.  Same on-chain
  transparency as USDT/USDC; no shielding on any supported network.

The warning key is `dai_partly_centralized` — distinct from the
`{usdt,usdc}_centralized` class to signal the different threat model.
i18n copy must give DAI credit for the no-direct-freeze-power point while
being honest about the PSM/USDC backing dependency and the governance-
upgradeability path.  No marketing-style hype — Morphit's grandma-friendly
principle requires plain factual statements that don't oversell.

### 3. Cross-network-mis-send warning: SAME AMPLIFICATION AS USDC

All 4 DAI networks use EVM `0x[40 hex]` address format.  A DAI-on-Polygon
address is visually identical to a DAI-on-Base address.  Buyer must
explicitly confirm network before sending.  Per-message cross-network
warning in `ChatMessage.svelte` follows the USDC pattern (orange/yellow
chip for DAI to keep it visually distinct from USDT amber and USDC
Circle-blue).

### 4. Fee category: trade-only (Category B), `fee_method` enum FROZEN

Per Memory #23 + ADR-0014 + cp30 ADR-0028 §5: listing fees can ONLY be
paid in BLURT, BTC, or XMR.  DAI joins USDT/USDC/BCH/LTC/DASH as a
trade-only asset.  `canPayListingFee: false`.

The `fee_method` enum stays exactly `'blurt'|'waived_first_buy'|'btc'|'xmr'`.
This is enforced by three independent smokes (fee-method-enum-frozen-smoke,
disabled-assets-wizard-smoke, dai-trade-only-smoke).

### 5. Amount-jitter: ENABLED, same as USDT + USDC

DAI gets 6-decimal-precision microunit jitter via the same
`jitterStablecoinAmount` dispatcher cp30 added.  Same rationale as ADR-0028
Decision 2: the centralization-vs-amount-correlation orthogonality applies
here too.  Amount-jitter doesn't address the PSM/USDC-backing dependency
or governance upgradeability, but it does address the amount-correlation
linkability threat that's independent of those.

### 6. Operators can disable DAI: same env-var mechanism

`MORPHIT_INDEXER_DISABLED_ASSETS` accepts DAI as a value.  Operators
running privacy-purist instances who want to keep their instance free of
stablecoins can disable DAI alongside USDT and USDC.

### 7. Brand presentation: respectful, factual, no marketing hype

Per Ken's standing instruction (Memory #29: "Marketing copy about any
asset must be respectful to that coin's community — factual trade-offs,
no value-judgments"), DAI's presentation:

- Acknowledges its decentralization advantages over single-issuer
  stablecoins
- Does NOT use marketing words like "true decentralization" or
  "censorship-resistant" that overstate the PSM/governance reality
- Does NOT denigrate USDT/USDC — different design choices serve different
  users
- The per-asset privacy guide at `/privacy/dai` gives users a complete
  factual picture so they can choose

### 8. Wire-format: identical pattern to USDC

DAI follows the cp30 USDC wire-format playbook exactly:
- `network` field REQUIRED for DAI in chat AddressPayload + FundsSentPayload
- `asset_network` field REQUIRED for DAI orders + orderReplace
- Cross-validation: per-network address shape against decoded network
  (cp30-DD-DD SEC-3 pattern)
- Defense-in-depth template validation for the 4 new per-network chat-link
  URLs (cp30-DD-DD SEC-1 pattern)
- Symmetric encoder validation (cp30-DD-DD SEC-6 pattern)
- 0x-prefix normalization for all 4 EVM networks (cp30-DD-DD SEC-4 pattern)
- Replace handler locks asset_network as substance (cp30-DD-DD CODE-3 pattern)

The 4 canonical wire-format surfaces (cp30-DD LL #23) all extended in the
same checkpoint:
1. Frontend store interface + defensive fallback + fetch normalization
2. Indexer-side InstanceResponse interface + body construction
3. Indexer-client mirror
4. Matrix-bot api-response-shape-smoke ChatLinkUrlsSchema

## Consequences

### Smoke count

- New: `dai-trade-only-smoke.ts` (~14 scenarios mirroring usdc-trade-only-smoke)
- Updated: every smoke that grep's asset-ticker enumeration (cp30-DD-DD LL #25)
- Wiring-completeness CHECK rows added for DAI inclusion

### Asset count

- ASSET_TICKERS goes from 8 → 9
- ChatAssetTicker union: 8 → 9 lowercase variants
- Multi-network assets: USDT, USDC, **DAI** (3 of 9)
- Category B trade-only assets: USDT, USDC, BCH, LTC, DASH, **DAI** (6 of 9)

### Locale parity

3 new FAQ entries × 10 locales + DAI per-network metadata + privacy
warning copy + post-order tooltip + per-asset guide copy ≈ +150-200 keys
per locale.  Exact final parity confirmed at end of cp31.

### Mediakit + brag list

New brag entries: DAI peer-to-peer multi-network + DAI per-asset privacy
guide + the more-decentralized-but-honest framing.

## Alternatives considered

### Single-network DAI (Ethereum only)

Would lose Polygon/Base/Arbitrum users (high gas on mainnet is the main
DAI complaint).  Multi-network gives users cheap-trade options.  Rejected.

### Include Wormhole/Allbridge wrapped DAI on Solana

Defeats the "DAI is decentralized" rationale — wrapper custodian becomes
another trust assumption.  Rejected.

### Same `*_centralized` warning class as USDT/USDC

Misrepresents DAI's actual properties.  Lumping DAI in with the directly-
freezable stablecoins would unfairly penalize the design choices Maker
made.  Rejected in favor of a distinct `dai_partly_centralized` warning
class with honest, specific copy.

### No warning at all (treat as decentralized)

Misrepresents DAI's PSM/USDC backing dependency and governance
upgradeability path.  Grandma-friendly principle requires plain factual
disclosure.  Rejected.

## References

- ADR-0023 (USDT multi-network, cp3)
- ADR-0028 (USDC multi-network, cp30) — the playbook this ADR follows
- Memory #19 (privacy is priority #1)
- Memory #23 (fee_method enum frozen)
- Memory #29 (asset marketing respect)
- cp30-DD-DD LL #23 (4 canonical wire-format surfaces)
- cp30-DD-DD LL #27 (16 changes per 4-network asset addition)
