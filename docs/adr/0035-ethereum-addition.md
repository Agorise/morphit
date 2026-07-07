# ADR-0035: Ethereum (ETH) Addition — Trade-Only with Post-Merge Proof-of-Stake, 6-Decimal Display-Clamp Jitter, and EVM-Wide Address Shape

**Status:** Accepted (Part 122 cp47, 2026-05-19)

**Context:**

Following Solana (ADR-0034), Decred (ADR-0033), Pirate Chain (ADR-0032), Zcash (ADR-0031), Dogecoin (ADR-0030), DAI (ADR-0029), USDC (ADR-0028), Dash (ADR-0027), Litecoin (cp24), Bitcoin Cash (cp21), USDT (Part 121), and the founders' BLURT/BTC/XMR set, Morphit adds Ethereum (ETH) as the fifteenth tradable asset. Ethereum launched in 2015 and transitioned from Proof-of-Work to Proof-of-Stake in September 2022 ("The Merge"). Validators stake ETH and process blocks in rotation; no central freeze authority controls the chain.

The chain is transparent at the base layer (sender, recipient, and amount visible on chain). Ethereum has no native protocol-level mixing protocol. Tornado Cash existed as a smart-contract mixer but has been sanctioned in many jurisdictions; Morphit does not recommend or rely on it.

## Decision

### 1. ETH is a Category-B trade-only asset

Per Memory #23 the `fee_method` enum stays frozen at `{blurt, btc, xmr, waived_first_buy}`. ETH ships with `canBeTraded: true` and `canPayListingFee: false`, matching the existing 11 Category-B coins.

### 2. Single-network mainnet

Ethereum has testnets (Sepolia, Holesky) but Morphit trades only on mainnet. Layer-2 networks (Arbitrum, Optimism, Base) are SEPARATE chains — Morphit doesn't treat ETH-on-Arbitrum as the same asset as ETH-on-mainnet. If L2 ETH is ever added, it ships as multi-network expansion similar to USDT-on-{ERC20,TRC20,SPL,BEP-20}.

### 3. Address regex — `0x` + 40 hex chars

```
^0x[a-fA-F0-9]{40}$
```

- 20-byte addresses, hex-encoded with `0x` prefix (exactly 42 chars total)
- Both lowercase and EIP-55 mixed-case checksum forms accepted
- Same shape across all EVM chains

**MAJOR LL #50 OVERLAP:** ETH addresses share their shape with USDT-ERC20, USDC-ERC20, DAI-ERC20, USDC-Base, USDC-Polygon, USDC-Arbitrum, DAI-Polygon, DAI-Arbitrum, DAI-Base — every EVM token-account address. Asset field (plus network field for multi-network assets) disambiguates at the order layer. Cp42 `address-shape-overlap-smoke` extended at cp47 with ETH specimens; 9 new overlaps added to allowlist (72→81 entries).

**Contract destinations:** ETH can be sent to a smart-contract address that may not implement a `payable receive()` or `fallback()` function. The 0x-40-hex regex doesn't distinguish EOAs from contracts; Morphit accepts the shape and the wallet UX warns about contract destinations.

**ENS names:** `alice.eth` NOT resolved by Morphit. Users must paste raw 0x addresses. Resolving ENS would require a centralized RPC dependency, violating the distributed-no-SPOF design priority.

### 4. 18-decimal on-chain, 6-decimal display-clamp jitter — NEW jitterEthAmount

Ethereum uses 18 decimals on-chain (1 ETH = 10^18 wei) — same EVM-standard ERC-20 precision as DAI. Per the cp31 DAI design choice (ADR-0029), Morphit clamps jitter to 6-decimal display precision regardless of the underlying token's on-chain precision. At cp47-era ETH price (~$2500) a 0-999 microether jitter range is ~$0.0025 max — the same $0.001-magnitude jitter UX the stablecoins use.

The new `jitterEthAmount` function in `apps/web/src/lib/chat/payload.ts` provides 6-decimal output (matching DAI semantics). A separate function (rather than reusing `jitterStablecoinAmount`) provides clarity (ETH is not a stablecoin) and future flexibility (ETH-specific tuning like EIP-1559 base-fee aware jitter).

Cp46 `asset-payload-precision-parity-smoke` captures `expectedJitterDecimals: 6` for ETH with comment-anchor matching this rationale. Per Ken's directive at cp47 ("implement as many of our privacy things with this as we have done with the others so far (jitter, etc)"), amount-jitter is wired same-turn.

### 5. Transparent base layer with no native mixing

`optInPrivacyTech: null` — Ethereum has no native protocol-level mixing protocol. Tornado Cash was an external smart-contract mixer but is sanctioned in many jurisdictions; Morphit doesn't advertise it. Privacy is achieved through wallet-side address rotation (MetaMask, Rabby, Frame, Rainbow, Trust Wallet all derive fresh addresses from HD seeds) and RPC-provider rotation. The `privacy.guides.eth` × 10 locales documents these practices.

### 6. Chat-link explorer default — `eth.blockscout.com`

Operator's 9-explorer survey at addition time. Bundled default is **eth.blockscout.com** — the open-source Blockscout instance for Ethereum mainnet, project-aligned with Ethereum's transparency ethos, frequently used by Ethereum L2s (Optimism, Base, Gnosis Chain all run Blockscout instances), self-hostable.

| Explorer | Disposition | Rationale |
| --- | --- | --- |
| `eth.blockscout.com` | **Chosen** | Open-source Blockscout; project-aligned |
| `etherscan.io` | Available | Most popular but third-party closed-source |
| `blockchair.com/ethereum` | Available | Multi-chain aggregator |
| `ethplorer.io` | Available | Token-focused |
| `oklink.com/ethereum` | Available | OKX-affiliated, third-party |
| `blockchain.com/explorer/assets/eth` | Available | Multi-asset exchange-affiliated |
| `blockexplorer.one/ethereum/mainnet` | Available | Multi-chain third-party |
| `routescan.io` | Available | Multi-chain aggregator |
| `beaconcha.in` | Not chosen | Consensus-layer (beacon chain) only — not suitable for regular transaction lookups |

**Note:** Unlike Solana (Solana Labs runs the official explorer) or Decred (the Decred project runs dcrdata), there is no single Ethereum-Foundation-blessed explorer. Etherscan is the de facto popular choice but is closed-source and third-party. Blockscout is the most aligned with Ethereum's open-source ethos.

Operators wanting different defaults override via `MORPHIT_FRONTEND_ETH_CHAT_LINK_URL`.

### 7. ETH txid format — same as EVM stablecoins

Ethereum transaction hashes are 32 bytes hex with optional `0x` prefix (64 hex chars, 66 with prefix). The canonical `ETH_TXID_RE` regex is `/^(0x)?[a-fA-F0-9]{64}$/`, same shape as USDT-ERC20, USDC-ERC20, DAI-ERC20, USDC-Base, etc.

### 8. Universal no-favoritism principle (adopted at cp39, reapplied 5th consecutive checkpoint)

Ethereum ships with chain-level transparency and no native mixing. Per the universal no-favoritism principle (cp39 → ADR-0031 §5), Morphit's framing of ETH describes what the chain IS (post-Merge PoS, transparent base layer, wallet-side address rotation as privacy lever) WITHOUT comparative claims. The phrase "the most private" does not appear. The phrase "better than" does not appear. ETH is described factually as a smart-contract platform with PoS consensus — neither superior nor inferior to any other Morphit-traded asset.

### 9. `ethereum:` URI scheme (BIP-21-compatible)

The payment-URI builder emits `ethereum:<address>?amount=<decimal>` — BIP-21-style. EIP-681 defines a richer Ethereum-native form (with `@chainId`, `/transfer` for tokens, `value` in wei), but the simpler form is parsed correctly by all major wallets (MetaMask, Rabby, Frame, Rainbow, Trust Wallet) for native ETH transfers. Native ETH only — Morphit doesn't generate `ethereum:` URIs for ERC-20 transfers.

### 10. Brand color `text-indigo-500`

Ethereum's brand color is #627EEA (blue-purple). `text-indigo-500` lands an indigo accent distinct from all 14 existing assignments. Verified at cp47 via cp42 `asset-accent-class-uniqueness-smoke`.

### 11. LL #52 + cp46 asset-payload-precision-parity discipline applied

Cp44 LL #52 (workspace-typecheck-smoke) catches type-union widening bugs at smoke time. Cp46 asset-payload-precision-parity-smoke pins per-asset jitter precision, URI scheme, and txid shape. Both ran clean during cp47 ETH wiring: 7/7 workspaces TS-clean, and the precision-parity smoke (extended to 57 scenarios) passes with ETH at 6-decimal jitter, `ethereum:` URI, and 64-hex txid shape.

## Consequences

- ETH is enabled by default on every fresh Morphit instance. Operators preferring not to support ETH can disable via `MORPHIT_INDEXER_DISABLED_ASSETS="ETH"`.
- The frozen `fee_method` enum is unaffected. Listing fees stay BLURT/BTC/XMR.
- Pre-launch operators who configured their instance before cp47 are unaffected — the indexer-client mirror declares `eth?: string | null` as optional and the frontend's defensive-fallback uses the bundled `eth.blockscout.com` default when the response field is missing.
- The 9 new cross-asset overlap entries added to `address-shape-overlap-smoke` document the intentional EVM-wide same-format-different-chain class. Future EVM-asset additions extend this allowlist with same-turn discipline.
- Users coming from the Ethereum community see their chain's framing as factual — no Morphit copy compares ETH's throughput, gas economics, or privacy posture against any other chain.
- ENS resolution remains explicitly out-of-scope. Users must paste raw 0x addresses. This is a UX trade-off accepted in service of the no-SPOF design priority.

## References

- ADR-0026 (Transparent-chain privacy framework).
- ADR-0029 (DAI addition — established 6-decimal display-clamp design for 18-decimal on-chain tokens).
- ADR-0031 (Zcash addition — established universal no-favoritism principle).
- ADR-0032 (Pirate Chain addition — LL #50 same-format-different-chain).
- ADR-0033 (Decred addition — LL #51 proactive type-union widening).
- ADR-0034 (Solana addition — first 9-decimal asset, NEW jitter function pattern).
- Ethereum protocol — https://ethereum.org/en/developers/docs/
- EIP-681 (Ethereum URI scheme) — https://eips.ethereum.org/EIPS/eip-681
- EIP-55 (Mixed-case checksum address encoding) — https://eips.ethereum.org/EIPS/eip-55
- Memory #23 (fee_method enum frozen at BLURT/BTC/XMR).
- Memory #29 (NEW-asset i18n native-en/es/fr/de + EN-fallback discipline).
- Cp32 LL #36 (payment-rail axis same-turn discipline).
- Cp33 CODE-3 (atomically widen all 4 wire-format gates).
- Cp40 LL #49 (defensive smokes verify i18n existence for dynamic-key reads).
- Cp42-J-68 LL #51 + cp44 LL #52 (workspace-wide compiler smoke).
- Cp46-O-1 (asset-payload-precision-parity-smoke pinning runtime arithmetic).
