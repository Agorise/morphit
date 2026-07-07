# ADR-0036: Ripple (XRP) Addition — Trade-Only with XRPL Federated Byzantine Agreement Consensus, 6-Decimal Drops Precision, and Destination-Tag / Reserve-Requirement UX

**Status:** Accepted (Part 122 cp49, 2026-05-19)

**Context:**

Following Ethereum (ADR-0035), Solana (ADR-0034), Decred (ADR-0033), Pirate Chain (ADR-0032), Zcash (ADR-0031), Dogecoin (ADR-0030), DAI (ADR-0029), USDC (ADR-0028), Dash (ADR-0027), Litecoin (cp24), Bitcoin Cash (cp21), USDT (Part 121), and the founders' BLURT/BTC/XMR set, Morphit adds Ripple (XRP) as the sixteenth tradable asset. XRP launched in 2012 as the native digital asset of the XRP Ledger (XRPL). XRPL uses Federated Byzantine Agreement (FBA) consensus — validators on a Unique Node List (UNL) reach agreement on transaction ordering. The default UNL is published by the XRP Ledger Foundation (a non-profit), with the for-profit Ripple Labs Inc. historically influencing validator selection.

The chain is transparent at the base layer (sender, recipient, amount, and optional destination tag visible on chain). XRPL has no native protocol-level mixing protocol.

XRPL has two unique UX features that other Morphit-traded assets don't share:

1. **Destination tags** — a 32-bit integer that exchanges use to route XRP to user accounts under their omnibus wallet. Sending to an exchange-hosted address WITHOUT the required tag practically loses funds (recoverable via exchange support only).
2. **Reserve requirement** — XRPL accounts need a base reserve (currently 1 XRP) to exist. Sending less than 1 XRP to a never-funded address fails on-chain.

Both are documented in Morphit's privacy guide and FAQ.

## Decision

### 1. XRP is a Category-B trade-only asset

Per Memory #23 the `fee_method` enum stays frozen at `{blurt, btc, xmr, waived_first_buy}`. XRP ships with `canBeTraded: true` and `canPayListingFee: false`, matching the existing 12 Category-B coins.

### 2. Single-network mainnet

XRPL has testnets (Devnet, Testnet) but Morphit trades only on XRPL mainnet.

### 3. Address regex — `r` + 24-34 base58 chars

```
^r[1-9A-HJ-NP-Za-km-z]{24,34}$
```

- Starts with `r` (unique among Morphit assets — no other asset uses this prefix)
- Followed by 24-34 base58 chars (XRPL's base58 alphabet differs from Bitcoin's but Bitcoin's charset is a superset)
- Most real-world XRP addresses are 33-34 chars total

**Destination tags** are NOT part of the address regex. They ride in the URI query string `?dt=N` (XRPL Pay-style) and on-chain as a separate transaction field. Morphit's address regex matches the address part only; the `ripple:` URI builder supports the `?dt=N` parameter; privacy guide warns users to check whether the recipient requires a tag.

**LL #50 OVERLAP:** XRP addresses share their base58 shape (32-44 char range) with USDT/USDC SPL-network paths and SOL addresses. The asset field disambiguates at the order layer. Cp42 `address-shape-overlap-smoke` extended at cp49 with XRP specimens; 6 new overlaps added (81→87 entries). NO reverse-direction overlaps — USDT/USDC/SOL specimens don't start with `r`, so they don't pass the XRP regex.

### 4. 6-decimal drops precision — NEW jitterXrpAmount

XRPL uses 6 decimals on-chain (drops; 1 XRP = 10^6 drops). Same smallest-unit precision as USDT/USDC/DAI/ETH-display, but XRP is the native token of XRPL, not an ERC-20 stablecoin and not a smart-contract-platform native.

The new `jitterXrpAmount` function in `apps/web/src/lib/chat/payload.ts` provides 6-decimal output. A separate function (rather than reusing `jitterStablecoinAmount` or `jitterEthAmount`) provides clarity (XRP is not a stablecoin, not an EVM asset) and future flexibility (XRP-specific tuning if needed).

**Jitter range:** 0..999 microXRP (drops). At cp49-era XRP price (~$2.50) that's about $0.0000025 max per jitter event — effectively zero financially but full decorrelation against exact-amount-matching heuristics on the public XRPL.

**Reserve invariant:** Jitter only ADDS drops (round-UP-only), never subtracts. An order of "1.000000 XRP" jitters to "1.000NNN XRP" which is still above the 1.0 reserve; jitter never threatens the reserve invariant.

Cp46 `asset-payload-precision-parity-smoke` captures `expectedJitterDecimals: 6` for XRP with comment-anchor matching this rationale. Per Ken's directive at cp49 ("implement as many of our privacy things with this as we have done with the others so far (jitter, etc)"), amount-jitter is wired same-turn.

### 5. Transparent base layer with no native mixing

`optInPrivacyTech: null` — XRPL has no native protocol-level mixing protocol. Privacy is achieved through wallet-side address rotation (Xaman/Xumm, Crossmark, Bifrost, GemWallet, Trust Wallet all derive fresh addresses from HD seeds) and RPC-provider rotation. The `privacy.guides.xrp` × 10 locales documents these practices.

### 6. Native XRP cannot be frozen — `privacyWarningKey: null`

XRPL has a `freeze` flag that issuers can set on **issued tokens (IOUs)** — but this applies ONLY to issued tokens, NOT to native XRP. Native XRP cannot be frozen by any central authority including Ripple Labs Inc., the XRP Ledger Foundation, or any validator coalition.

This is materially different from the stablecoin freeze-power class (USDT/USDC have direct contract-level freeze authority — documented in ADR-0023 and ADR-0028). XRP gets `privacyWarningKey: null` matching the BTC/XMR/LTC/SOL/ETH convention.

### 7. Chat-link explorer default — `livenet.xrpl.org`

Operator's 5-explorer survey at addition time. Bundled default is **livenet.xrpl.org** — the XRP Ledger Foundation's (non-profit) official mainnet explorer, separate from Ripple Labs Inc. (the for-profit company that created XRP).

| Explorer | Disposition | Rationale |
| --- | --- | --- |
| `livenet.xrpl.org` | **Chosen** | XRP Ledger Foundation non-profit; project-aligned |
| `xrpscan.com` | Available | XRPL-focused third-party |
| `bithomp.com` | Available | XRPL-focused with token/NFT support |
| `blockchair.com/xrp-ledger` | Available | Multi-chain aggregator |
| `blockexplorer.one/xrp/mainnet` | Available | Multi-chain third-party |

Operators wanting different defaults override via `MORPHIT_FRONTEND_XRP_CHAT_LINK_URL`.

### 8. XRP txid format

XRPL transaction hashes are 256-bit (32 bytes) hex, conventionally uppercase but case-insensitive on the chain. 64 hex chars, NO prefix. The canonical `XRP_TXID_RE` regex is `/^[a-fA-F0-9]{64}$/`, same shape as the BTC-family hex txids (BTC/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR). Asset field disambiguates.

### 9. Universal no-favoritism principle (adopted at cp39, reapplied 6th consecutive checkpoint)

XRP ships with chain-level transparency, FBA consensus, and a UNL with documented influence from Ripple Labs Inc. Per the universal no-favoritism principle (cp39 → ADR-0031 §5), Morphit's framing of XRP describes what the chain IS (FBA consensus, UNL composition documented factually, transparent base layer, destination tag UX, reserve requirement) WITHOUT comparative claims. The phrase "the most decentralized" does not appear. The phrase "better than" does not appear. The phrase "centralized" does not appear as a judgment — UNL composition is documented as fact, not as a political stance. XRP is described as a payment-focused cryptocurrency with FBA consensus — neither superior nor inferior to any other Morphit-traded asset.

### 10. `ripple:` URI scheme

The payment-URI builder emits `ripple:<address>?amount=<decimal>&dt=<destination-tag>` for native XRP transfers. There is no Ethereum-EIP-681-style standardization for XRPL URIs, but `ripple:` is the de facto scheme that Xaman/Xumm, Crossmark, Bifrost, GemWallet, and Trust Wallet all parse correctly.

Native XRP only — Morphit doesn't generate `ripple:` URIs for issued-token (IOU) transfers; those use different transaction types and are not currently in scope.

### 11. Brand color `text-cyan-600`

XRP's brand color is #008dff (a specific blue). `text-cyan-600` lands a clean cyan accent distinct from all 15 existing assignments (DASH uses sky-500, USDC uses blue-500 — cyan-600 is visually distinct from both). Verified at cp49 via cp42 `asset-accent-class-uniqueness-smoke`.

### 12. LL #52 + cp46 asset-payload-precision-parity + cp48 stand-in meta-assertion discipline applied

Cp44 LL #52 (workspace-typecheck-smoke) catches type-union widening bugs at smoke time. Cp46 asset-payload-precision-parity-smoke pins per-asset jitter precision, URI scheme, and txid shape. Cp48 structural defense (synthetic non-ticker + meta-assertion) closes the "unknown stand-in becomes valid" recurring class. All three ran clean during cp49 XRP wiring.

## Consequences

- XRP is enabled by default on every fresh Morphit instance. Operators preferring not to support XRP can disable via `MORPHIT_INDEXER_DISABLED_ASSETS="XRP"`.
- The frozen `fee_method` enum is unaffected. Listing fees stay BLURT/BTC/XMR.
- The 6 new cross-asset overlap entries added to `address-shape-overlap-smoke` document the intentional base58-charset overlap with USDT/USDC SPL paths and SOL. No reverse-direction overlaps because no existing asset's specimens start with `r`.
- Users coming from the XRP community see their chain's framing as factual — no Morphit copy compares XRP's consensus to PoW or PoS chains, and no copy editorializes about Ripple Labs' role in the UNL.
- Destination tag UX is explicitly documented in three places (FAQ what_is_xrp, privacy.guides.xrp.caveats, ops-cli CATEGORY_B_DESCRIPTIONS) to prevent first-time users from losing funds to exchange-hosted addresses.
- Reserve requirement UX is documented in the same three places.
- IOU (issued token) transfers remain explicitly out-of-scope. Morphit trades native XRP only.

## References

- ADR-0026 (Transparent-chain privacy framework).
- ADR-0031 (Zcash addition — established universal no-favoritism principle).
- ADR-0032 (Pirate Chain addition — LL #50 same-format-different-chain).
- ADR-0033 (Decred addition — LL #51 proactive type-union widening).
- ADR-0034 (Solana addition — first 9-decimal asset, NEW jitter function pattern).
- ADR-0035 (Ethereum addition — established post-Merge PoS framing).
- XRPL protocol — https://xrpl.org/
- XRPL base58 alphabet — https://xrpl.org/base58-encodings.html
- XRPL destination tags — https://xrpl.org/source-and-destination-tags.html
- XRPL reserves — https://xrpl.org/reserves.html
- Memory #23 (fee_method enum frozen at BLURT/BTC/XMR).
- Memory #29 (NEW-asset i18n native-en/es/fr/de + EN-fallback discipline).
- Cp32 LL #36 (payment-rail axis same-turn discipline).
- Cp33 CODE-3 (atomically widen all 4 wire-format gates).
- Cp40 LL #49 (defensive smokes verify i18n existence for dynamic-key reads).
- Cp42-J-68 LL #51 + cp44 LL #52 (workspace-wide compiler smoke).
- Cp46-O-1 (asset-payload-precision-parity-smoke pinning runtime arithmetic).
- Cp48-O-1 (stand-in meta-assertion closing unknown-literal-becomes-valid class).
