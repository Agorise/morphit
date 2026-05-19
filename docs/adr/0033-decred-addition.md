# ADR-0033: Decred (DCR) Addition — Trade-Only with Hybrid PoW/PoS Consensus and Opt-In CSPP Mixing

**Status:** Accepted (Part 122 cp43, 2026-05-19)

**Context:**

Following Pirate Chain (ADR-0032), Zcash (ADR-0031), Dogecoin (ADR-0030), Dash (ADR-0027), Litecoin (cp24), Bitcoin Cash (cp21), DAI (ADR-0029), USDC (ADR-0028), USDT (Part 121), and the founders' BLURT/BTC/XMR set, Morphit adds Decred (DCR) as the thirteenth tradable asset. Decred is a hybrid Proof-of-Work + Proof-of-Stake cryptocurrency launched in 2016. Every block is mined by PoW miners AND voted on by 5 PoS ticket-holders chosen pseudo-randomly from the staking pool — neither group can change protocol rules unilaterally. On-chain governance via Politeia lets stakeholders propose, debate, and ratify protocol changes; treasury funds (10% of block reward) flow through community vote.

The chain is transparent at the base layer (sender, recipient, and amount visible on chain like Bitcoin) but ships an opt-in CoinShuffle++ (CSPP) mixing protocol integrated into dcrwallet for users who want transaction-level privacy.

## Decision

### 1. DCR is a Category-B trade-only asset

Per Memory #23 the `fee_method` enum stays frozen at `{blurt, btc, xmr, waived_first_buy}`. DCR therefore ships with `canBeTraded: true` and `canPayListingFee: false`, matching the BCH/LTC/DASH/DOGE/USDT/USDC/DAI/ZEC/ARRR pattern.

### 2. Single-network mainnet

Decred has a testnet but Morphit trades only on mainnet, consistent with every other single-network asset.

### 3. Address regex — two receive formats (Ds + Dc)

The canonical registry's `addressShape` regex accepts both Decred receive-address formats:

```
^D[sc][1-9A-HJ-NP-Za-km-z]{33}$
```

- `Ds` prefix: P2PKH-Secp256k1 (most common receive format)
- `Dc` prefix: P2SH (multisig / escrow scripts)
- 33 base58 data chars after the 2-char prefix = 35 chars total
- Base58 alphabet excludes `0`, `O`, `I`, `l` (we use `[1-9A-HJ-NP-Za-km-z]`)

Other Decred prefixes exist but are REJECTED by this regex:
- `Dp` extended pubkey — used for HD wallet derivation, not for receiving payments
- `Dr` extended privkey — **SENSITIVE; never publish**; rejecting it defends against a user accidentally pasting their xprv-equivalent into the trade form
- `De` Edwards-curve — Decred supports Edwards-curve addresses but they're rarely used and not the canonical receive format

### 4. NEW `csppmix` privacy tech tag

CoinShuffle++ (CSPP) is a wallet-side multi-party mixing protocol integrated into dcrwallet. Users enable the "Mix Account" option; deposits flow through CSPP rounds with other participants before becoming spendable from the mixed account. Mixing rounds happen approximately every 20 minutes on mainnet.

`'csppmix'` is added as a new value to the `optInPrivacyTech` type union, joining `'mweb'` (LTC), `'cashfusion'` (BCH), `'coinjoin'` (BTC), `'payjoin'` (BTC), `'privatesend'` (DASH), and `'shielded-pools'` (ZEC, ARRR). The cp42-J-68 LL #51 discipline was applied — the type union was widened BEFORE the DCR entry was added, avoiding the bug class where cp39 ZEC and cp41 ARRR both shipped with TypeScript compile errors.

Per LL #49 (cp40), the i18n keys `privacy.opt_in_tech.csppmix.{name,explain}` were added × 10 locales same-turn. The cp40 defensive smoke `privacy-features-registry-smoke` walks every registered tech tag dynamically, so DCR's csppmix tag is automatically covered.

### 5. Chat-link explorer default — `dcrdata.decred.org`

The operator surveyed 4 candidate explorers at addition time. The bundled default is **dcrdata.decred.org** — the official Decred project explorer, project-aligned, no third-party tracking, supports both transparent and mixed-output transactions, full Politeia governance integration.

Full survey:

| Explorer | Disposition | Rationale |
| --- | --- | --- |
| `dcrdata.decred.org` | **Chosen** | Official Decred project explorer; project-aligned |
| `blockchain.com/explorer/assets/dcr` | Available | Third-party aggregator; multi-asset |
| `dcr.tokenview.io` | Available | Tokenview multi-chain explorer |
| `bitinfocharts.com/decred/` | Available | Community analytics + block explorer |

Operators wanting different defaults override via `MORPHIT_FRONTEND_DCR_CHAT_LINK_URL`.

### 6. Universal no-favoritism principle (adopted at cp39, reapplied at cp41 and cp43)

Decred ships chain-level transparency with opt-in wallet-side mixing. Per the universal no-favoritism principle adopted at cp39 (ADR-0031 §5) and reapplied at cp41 (ADR-0032 §6), Morphit's framing of DCR describes what the chain *is* (hybrid PoW/PoS consensus with on-chain governance via Politeia; opt-in CSPP wallet-side mixing for transaction-level privacy) WITHOUT comparative claims against XMR, ZEC, ARRR, DASH, BTC, or any other privacy-enabled chain. The phrase "the most private" does not appear in any DCR-related copy.

### 7. `decred:` URI scheme

The payment-URI builder emits `decred:<address>?amount=<decimal>` — BIP-21-style. Both receive-address formats (Ds P2PKH and Dc P2SH) are handled under the same scheme. Decred wallets (dcrwallet, Decrediton, Cake Wallet for DCR) recognize the `decred:` scheme.

### 8. Decimals = 8

DCR uses 8 decimals — same smallest-unit semantics as the BTC family. Decred inherited this from a Bitcoin-derived codebase. Amount-jitter routes through `jitterUtxoAmount` (same as BTC/BCH/LTC/DASH/DOGE/ZEC/ARRR).

### 9. Brand color `text-teal-500`

Distinct from all 12 existing accent classes. Decred's brand palette is teal-green (#2dd8a3) and blue (#2970ff); `text-teal-500` lands the teal accent without collision. Verified at cp43 via the cp42 `asset-accent-class-uniqueness-smoke`.

## Consequences

- DCR is enabled by default on every fresh Morphit instance. Operators preferring not to support DCR can disable via `MORPHIT_INDEXER_DISABLED_ASSETS="DCR"`.
- The frozen `fee_method` enum is unaffected. Listing fees stay BLURT/BTC/XMR.
- Pre-launch operators who configured their instance before cp43 are unaffected by DCR addition; the indexer-client mirror declares `dcr?: string | null` as optional and the frontend's defensive-fallback uses the bundled `dcrdata.decred.org` default when the response field is missing.
- Users coming from the Decred community see their chain's framing as factual — no Morphit copy compares DCR's privacy posture against XMR, ZEC, ARRR, DASH, or BTC coinjoin.
- The new `csppmix` tech tag enriches the privacy framework. Future asset additions with wallet-side mixing protocols can either reuse `csppmix` (if they implement CoinShuffle++) or add a new tag — applying the cp42-J-68 LL #51 discipline (widen the type union BEFORE adding the entry that uses it).

## References

- ADR-0026 (Transparent-chain privacy framework — established the `privacyFeatures` struct).
- ADR-0031 (Zcash addition — established the `shielded-pools` tech tag; adopted universal no-favoritism principle).
- ADR-0032 (Pirate Chain addition — reaffirmed universal no-favoritism principle; LL #50 same-format-different-chain).
- Decred protocol — https://docs.decred.org (project documentation)
- CoinShuffle++ paper — https://decred.org/research/ruffing2017-coinshuffle.pdf
- Memory #23 (fee_method enum frozen at BLURT/BTC/XMR).
- Memory #29 (NEW-asset i18n native-en/es/fr/de + EN-fallback for it/pl/ru/fa/zh-CN/zh-HK).
- Cp32 LL #36 (payment-rail axis same-turn discipline).
- Cp33 CODE-3 (atomically widen all 4 wire-format gates).
- Cp40 LL #49 (defensive smokes must verify i18n existence for dynamic-key reads — auto-covered DCR's csppmix tag).
- Cp42-J-68 LL #51 candidate (widen `optInPrivacyTech` type union BEFORE adding entries that use new tags — applied proactively at cp43, no TS compile error).
