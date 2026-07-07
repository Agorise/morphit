# ADR-0032: Pirate Chain (ARRR) Addition — Trade-Only with Chain-Level Shielded Transactions

**Status:** Accepted (Part 122 cp41, 2026-05-19)

**Context:**

Following Zcash (ADR-0031), Dogecoin (ADR-0030), Dash (ADR-0027), Litecoin (cp24), Bitcoin Cash (cp21), DAI (ADR-0029), USDC (ADR-0028), USDT (Part 121), and the founders' BLURT/BTC/XMR set, Morphit adds Pirate Chain (ARRR) as the twelfth tradable asset. Pirate Chain is a proof-of-work cryptocurrency launched in 2018 as a fork of the Zcash codebase, configured so that the Sapling zk-SNARK shielded pool is the only available transaction type. Every transfer hides sender, recipient, and amount on chain via zero-knowledge proofs by construction — there is no transparent address option.

The chain forcibly migrated all transparent balances to the shielded pool early in its life and removed the `t1`/`t3` transparent address types from canonical wallets. Only one address format exists in production use: `zs1` Sapling shielded (bech32, 78 chars).

## Decision

### 1. ARRR is a Category-B trade-only asset

Per Memory #23 the `fee_method` enum stays frozen at `{blurt, btc, xmr, waived_first_buy}`. ARRR therefore ships with `canBeTraded: true` and `canPayListingFee: false`, matching the BCH/LTC/DASH/DOGE/USDT/USDC/DAI/ZEC pattern. The `'arrr'` sentinel was already present in `fee-method-enum-frozen-smoke.ts` FORBIDDEN_TICKERS list as a forward-looking guard — it stays. Both invariants (ARRR is a valid tradable asset; ARRR is NOT a valid fee_method) coexist on different axes.

### 2. Single-network mainnet

Pirate Chain runs one canonical mainnet. No testnet picker is mounted in the post-order form or address-share modal. Operators wanting to refuse Pirate Chain trades use `MORPHIT_INDEXER_DISABLED_ASSETS="ARRR"`.

### 3. Address regex — single zs1 Sapling format

The canonical registry's `addressShape` regex accepts only the Sapling shielded format:

```
^zs1[02-9ac-hj-np-z]{75}$
```

- `zs1` prefix + exactly 75 bech32 data chars = 78 chars total.
- Bech32 alphabet excludes `1`, `b`, `i`, `o` to avoid visual ambiguity (we use `[02-9ac-hj-np-z]`, matching the LTC MWEB and Zcash Sapling patterns).
- No transparent (`t1`/`t3`) format — Pirate Chain sunsetted the transparent pool early in the chain's life.
- No Unified Address (`u1`) format — Pirate Chain does not implement Zcash's NU5/Orchard pool.

The frontend mirror exposes a single `validateArrr` function backed by the same regex. Permissive shape check; chain-binding happens on the receiving wallet side.

### 4. Visual collision with Zcash Sapling addresses — context-disambiguation

A Pirate Chain `zs1` address is visually indistinguishable from a Zcash Sapling `zs1` address — same prefix, same bech32 alphabet, same length. Same chain code lineage (Pirate Chain forked from Zcash). Morphit's per-asset tab and placeholder are the only thing distinguishing them at the UI layer. Users selecting the "ARRR" tab when they meant "ZEC" (or vice versa) and pasting an address would publish the address against the wrong chain — chain-level routing rejects the cross-chain send, but the on-chain trace of the published address is recorded.

This is the cp41-NEW threat class that gets STRIDE-T-cp41-1 (LOW). Mitigation: per-asset tab labels are large and prominent; the address placeholder includes the asset name (`Your ARRR address (zs1...)` vs `Your ZEC address (zs1...)`).

### 5. Chat-link explorer default — `explorer.piratechain.com`

The operator surveyed 3 candidate explorers at addition time. The bundled default is **explorer.piratechain.com** — the official Pirate Chain project explorer, project-aligned, no third-party tracking, supports shielded-transaction lookups by txid (the txid is canonical even when sender/recipient/amount are hidden inside the shielded payload). Same privacy/decentralization rationale as `mainnet.zcashexplorer.app` for ZEC and `blockstream.info` for BTC: prefer a project-aligned explorer over third-party aggregators or exchange-affiliated services. Operators wanting a different default override via `MORPHIT_FRONTEND_ARRR_CHAT_LINK_URL`.

Full survey:

| Explorer | Disposition | Rationale |
| --- | --- | --- |
| `explorer.piratechain.com` | **Chosen** | Official Pirate Chain project explorer; project-aligned; no third-party tracking |
| `pirate.explorer.dexstats.info` | Available | Community-run, supports Komodo-ecosystem coins including ARRR; secondary |
| `blockchain.com/explorer/assets/arrr` | Available | Third-party aggregator; multi-asset; tertiary |

### 6. Universal no-favoritism principle (adopted at cp39, reapplied at cp41)

Pirate Chain is a privacy-focused chain. Per the universal no-favoritism principle adopted at cp39 (ADR-0031 §5), Morphit's framing of ARRR describes what the chain *is* (chain-level shielded transactions via Sapling zk-SNARKs; every transfer hides sender, recipient, and amount on chain by construction) WITHOUT comparative claims against XMR, ZEC, DASH, or any other privacy-focused asset. The phrase "the most private" does not appear in any ARRR-related copy. Users come from different privacy-coin communities; Morphit lets each user pick the chain that matches their priorities without taking a side.

### 7. Privacy framework — `optInPrivacyTech: ['shielded-pools']`

Pirate Chain shares the underlying Sapling zk-SNARK protocol with Zcash. The `'shielded-pools'` tech tag (added to the canonical privacy framework at cp39 for ZEC) is reused. Per LL #49 (cp40), the i18n key `privacy.opt_in_tech.shielded-pools.{name,explain}` is verified by `privacy-features-registry-smoke` to exist in `en.json` — that check now covers ARRR's tech tag automatically because the smoke walks every registered tech, not a hardcoded allowlist.

ARRR's privacy guide (`/privacy/arrr`, registered as `privacyGuideKey: 'arrr'`) clarifies that **ARRR's posture is chain-level by default** — unlike ZEC where shielded is opt-in per address, every Pirate Chain transaction goes through the shielded pool by construction. This is documented in `privacy.guides.arrr.intro` and `.caveats` without using comparative-superiority language.

### 8. `arrr:` URI scheme

The payment-URI builder emits `arrr:<address>?amount=<decimal>` — BIP-21-style. Pirate Chain wallets (Treasure Chest, Pirate.Black, Verus-integrated Pirate) recognize this scheme. ARRR addresses are unambiguous within the URI scheme (only one format exists: `zs1` Sapling).

### 9. Decimals = 8

ARRR uses 8 decimals — same smallest-unit semantics as the BTC family. Pirate Chain inherited this from the Zcash codebase, which inherited it from Bitcoin. Amount-jitter routes through `jitterUtxoAmount` (same as BTC/BCH/LTC/DASH/DOGE/ZEC).

### 10. Brand color `text-amber-600`

Distinct from the existing 11 accent classes (BTC amber-500, USDT amber-400, USDC blue-500, DAI yellow-500-different-shade, BCH/LTC/DASH-respective, DOGE yellow-500, ZEC yellow-400). Amber-600 lands the rich gold tone of the Pirate Chain brand (`#b38c30`–`#f2de98` gradient on the supplied logo) without collision.

## Consequences

- ARRR is enabled by default on every fresh Morphit instance. Operators preferring not to support ARRR can disable via `MORPHIT_INDEXER_DISABLED_ASSETS="ARRR"` (or any longer list including `ARRR`).
- The frozen `fee_method` enum is unaffected. Listing fees stay BLURT/BTC/XMR.
- Pre-launch operators who configured their instance before cp41 are unaffected by ARRR addition; the indexer-client mirror declares `arrr?: string | null` as optional and the frontend's defensive-fallback uses the bundled `explorer.piratechain.com` default when the response field is missing.
- Users coming from the Pirate Chain community see their chain's framing as factual — no Morphit copy compares ARRR's privacy posture against XMR, ZEC, or other privacy coins.
- LL #50 candidate: same-format-different-chain visual collision (zs1 prefix shared between ZEC Sapling and ARRR). Both are first-class privacy chains on Morphit; both legitimately use the `zs1` prefix because both derive from the Zcash Sapling protocol. Future deep-deeps should look for similar visual-collision risks when adding chains with shared protocol lineage.

## References

- ADR-0026 (Transparent-chain privacy framework — established the `privacyFeatures` struct).
- ADR-0031 (Zcash addition — established the `shielded-pools` tech tag and per-address-privacy documentation pattern; adopted universal no-favoritism principle).
- Pirate Chain protocol — https://piratechain.com (project home)
- Bech32 specification — BIP-173
- Memory #23 (fee_method enum frozen at BLURT/BTC/XMR).
- Memory #29 (NEW-asset i18n native-en/es/fr/de + EN-fallback for it/pl/ru/fa/zh-CN/zh-HK).
- Cp32 LL #36 (payment-rail axis same-turn discipline).
- Cp33 CODE-3 (atomically widen all 4 wire-format gates).
- Cp40 LL #49 (defensive smokes must verify i18n existence for dynamic-key reads — protects ARRR's shielded-pools tag automatically).
