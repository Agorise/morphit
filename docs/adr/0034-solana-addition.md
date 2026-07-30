# ADR-0034: Solana (SOL) Addition — Trade-Only with Delegated PoS, 9-Decimal Lamport Precision, and Same-Format Address Disambiguation

**Status:** Accepted (Part 122 cp45, 2026-05-19)

**Context:**

Following Decred (ADR-0033), Pirate Chain (ADR-0032), Zcash (ADR-0031), Dogecoin (ADR-0030), DAI (ADR-0029), USDC (ADR-0028), Dash (ADR-0027), Litecoin (cp24), Bitcoin Cash (cp21), USDT (Part 121), and the founders' BLURT/BTC/XMR set, Morphit adds Solana (SOL) as the fourteenth tradable asset. Solana launched in 2020 as a high-throughput Proof-of-Stake cryptocurrency. Delegated PoS consensus is combined with Proof-of-History sequencing (a verifiable ordering oracle) to achieve transaction throughput several orders of magnitude higher than traditional UTXO chains. Validators stake SOL and process blocks in rotation; no central freeze authority controls the chain.

The chain is transparent at the base layer (sender, recipient, and amount visible on chain). Solana has no native protocol-level mixing protocol; wallet-side address rotation is the user's primary privacy lever.

## Decision

### 1. SOL is a Category-B trade-only asset

Per Memory #23 the `fee_method` enum stays frozen at `{blurt, btc, xmr, waived_first_buy}`. SOL therefore ships with `canBeTraded: true` and `canPayListingFee: false`, matching the BCH/LTC/DASH/DOGE/USDT/USDC/DAI/ZEC/ARRR/DCR pattern.

### 2. Single-network mainnet

Solana has devnet/testnet and mainnet-beta. Morphit trades only on mainnet-beta, consistent with every other single-network asset.

### 3. Address regex — base58 32-44 chars

The canonical registry's `addressShape` regex accepts the full Solana address range:

```
^[1-9A-HJ-NP-Za-km-z]{32,44}$
```

- 32-byte public keys, base58-encoded
- Most addresses are exactly 44 chars; minimum is 32 (leading-zero byte case is rare but valid)
- Base58 alphabet excludes `0`, `O`, `I`, `l`

**Critical LL #50 case:** SOL addresses share their shape with USDT-Solana and USDC-Solana SPL token-account addresses. This is by design — Solana addresses ARE base58 32-byte public keys regardless of whether they hold native SOL, an SPL token-account for USDT, or an SPL token-account for USDC. The asset field on the order disambiguates at the order layer; cp42 `address-shape-overlap-smoke` documents 23 new SOL-related overlaps (49→72 entries) as intentional allowlist.

**Program-Derived Addresses (PDAs):** PDAs match the address regex but are off-curve — they have no associated private key and can only be controlled by the owning on-chain program. Sending SOL to a PDA generally works at the protocol level but the recipient cannot move funds out unless the owning program has a withdraw instruction. Morphit accepts the shape; receiver-side wallet UX is responsible for PDA-destination warnings.

**Wrapped SOL (wSOL):** The mint `So11111111111111111111111111111111111111112` is the famous wSOL identifier used for DEX interoperability. Morphit users trade NATIVE SOL — wSOL is not special-cased.

### 4. 9-decimal lamport precision — NEW jitterSolAmount

Solana uses 9 decimals (1 SOL = 1,000,000,000 lamports). This is a unique smallest-unit precision among Morphit's 14 assets: BTC family is 8, USDT/USDC/DAI is 6, BLURT is 3, XMR is 12. SOL therefore needs its own jitter calibration — no existing jitter function has 9-decimal arithmetic.

The new `jitterSolAmount` function in `apps/web/src/lib/chat/payload.ts` provides 9-decimal jitter at ~999-lamport range, which at cp45-era SOL price (~$150) is approximately $0.00015. Same caveats as the other jitter functions: round-UP-only (never underpay), CSPRNG-derived (not Math.random), idempotent on caller-side memoization. `jitterAmountForAsset` dispatches `asset === 'sol'` to the new function.

Per Ken's directive at cp45 ("implement as many of our privacy things with this as we have done with the others so far (jitter, etc)"), amount-jitter is wired same-turn.

### 5. Transparent base layer with no native mixing

`optInPrivacyTech: []` — Solana has no native protocol-level mixing protocol. Privacy is achieved through wallet-side address rotation (Phantom, Solflare, Cake Wallet for SOL, Trust Wallet all derive fresh addresses from HD seeds) and through RPC-provider rotation. The `privacy.guides.sol` × 10 locales documents these practices.

### 6. Chat-link explorer default — `explorer.solana.com`

Operator's 5-explorer survey at addition time. Bundled default is **explorer.solana.com** — the official Solana project explorer, project-aligned, run by Solana Labs, no third-party tracking, supports SPL token transfers and native SOL transfers, full validator/staking visibility.

| Explorer | Disposition | Rationale |
| --- | --- | --- |
| `explorer.solana.com` | **Chosen** | Official Solana project explorer; project-aligned |
| `solscan.io` | Available | Third-party aggregator; most popular by traffic |
| `solanabeach.io` | Available | Validator-focused explorer |
| `oklink.com/solana` | Available | OKX-affiliated, third-party |
| `solana.fm` | Not surveyed | Per Ken's note at addition time — "not working?"; unreachable |

Operators wanting different defaults override via `MORPHIT_FRONTEND_SOL_CHAT_LINK_URL`.

### 7. SOL txid format differs from BTC family

Solana transaction signatures are 64 bytes encoded as base58, surfacing as 87-88-character strings. Notably DIFFERENT from the BTC/ZEC/ARRR/DCR family's 64-hex-character txid convention. The canonical `SOL_TXID_RE` regex is `/^[1-9A-HJ-NP-Za-km-z]{87,88}$/`, distinct from every other asset's txid regex.

### 8. Universal no-favoritism principle (adopted at cp39, reapplied at cp41/cp43/cp45)

Solana ships with chain-level transparency and no native mixing. Per the universal no-favoritism principle adopted at cp39 (ADR-0031 §5) and reapplied at cp41/cp43, Morphit's framing of SOL describes what the chain IS (high-throughput delegated PoS with Proof-of-History sequencing; transparent base layer; wallet-side address rotation as the privacy lever) WITHOUT comparative claims against any other chain. The phrase "the most private" does not appear in any SOL-related copy. The phrase "better than" does not appear. SOL is described factually as a fast PoS chain — neither superior nor inferior to any other Morphit-traded asset.

### 9. `solana:` URI scheme (Solana Pay)

The payment-URI builder emits `solana:<address>?amount=<decimal>` — BIP-21-style. This is the Solana Pay specification. Native SOL transfer only — Morphit doesn't generate Solana Pay URIs for SPL token transfers (USDT/USDC SPL transfers use their own per-asset URI builders).

### 10. Brand color `text-violet-500`

Solana's brand gradient runs purple (#9945ff) to green (#19fb9b). `text-violet-500` lands the violet accent distinct from all 13 existing assignments (BTC amber-500, USDT amber-400, USDC blue-500, DAI yellow-600, BCH lime-500, LTC slate-400, DASH sky-500, DOGE yellow-500, ZEC yellow-400, ARRR amber-600, XMR orange-500, DCR teal-500, BLURT morphit-emerald). Verified at cp45 via cp42 `asset-accent-class-uniqueness-smoke`.

### 11. LL #52 discipline applied

Per cp44 LL #52 (workspace-typecheck-smoke catches type-union widening bugs), no new tech tags were introduced at cp45. SOL's `optInPrivacyTech: []` uses an existing union member (the empty array). Final `tsc --noEmit` on `packages/asset-registry/` is clean.

## Consequences

- SOL is enabled by default on every fresh Morphit instance. Operators preferring not to support SOL can disable via `MORPHIT_INDEXER_DISABLED_ASSETS="SOL"`.
- The frozen `fee_method` enum is unaffected. Listing fees stay BLURT/BTC/XMR.
- Pre-launch operators who configured their instance before cp45 are unaffected — the indexer-client mirror declares `sol?: string | null` as optional and the frontend's defensive-fallback uses the bundled `explorer.solana.com` default when the response field is missing.
- The 23 new cross-asset overlap entries added to `address-shape-overlap-smoke` document the intentional same-format-different-chain class. Future asset additions on Solana-shaped chains (or any chain using 32-byte base58 addresses) extend this allowlist with same-turn discipline.
- Users coming from the Solana community see their chain's framing as factual — no Morphit copy compares SOL's throughput or privacy posture against any other chain.

## References

- ADR-0026 (Transparent-chain privacy framework).
- ADR-0031 (Zcash addition — established universal no-favoritism principle).
- ADR-0032 (Pirate Chain addition — LL #50 same-format-different-chain).
- ADR-0033 (Decred addition — LL #51 proactive type-union widening discipline).
- Solana protocol — https://docs.solana.com
- Solana Pay specification — https://docs.solanapay.com
- Memory #23 (fee_method enum frozen at BLURT/BTC/XMR).
- Memory #29 (NEW-asset i18n native-en/es/fr/de + EN-fallback discipline).
- Cp32 LL #36 (payment-rail axis same-turn discipline).
- Cp33 CODE-3 (atomically widen all 4 wire-format gates).
- Cp40 LL #49 (defensive smokes verify i18n existence for dynamic-key reads).
- Cp42-J-68 LL #51 + cp44 LL #52 (workspace-wide compiler smoke catches type errors the runtime smoke battery misses).
