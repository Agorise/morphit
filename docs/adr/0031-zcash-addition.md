# ADR-0031: Zcash (ZEC) Addition — Trade-Only with Per-Address Privacy Choice

**Status:** Accepted (Part 122 cp39, 2026-05-19)

**Context:**

Following Dogecoin (ADR-0030), Dash (ADR-0027), Litecoin (cp24), Bitcoin Cash (cp21), DAI (ADR-0029), USDC (ADR-0028), USDT (Part 121), BLURT/BTC/XMR (founders' tradeable set), Morphit adds Zcash (ZEC) as the eleventh tradable asset. ZEC is a proof-of-work cryptocurrency launched in 2016 as the first practical deployment of zero-knowledge proofs (zk-SNARKs) in a cryptocurrency. The protocol supports two address families that coexist on the same chain:

- **Transparent addresses** (t1 / t3, base58, ~35 chars) — publicly visible amounts and parties, similar in shape to Bitcoin's legacy addresses.
- **Shielded addresses** (zs1 Sapling, u1 Unified Address bundling Orchard receivers) — sender, recipient, and amount hidden on chain via zero-knowledge proofs.

Per-trade, each participant picks the address type that matches their preferred posture. Both are first-class on the protocol.

## Decision

### 1. ZEC is a Category-B trade-only asset

Per Memory #23 the `fee_method` enum stays frozen at `{blurt, btc, xmr, waived_first_buy}`. ZEC therefore ships with `canBeTraded: true` and `canPayListingFee: false`, matching the BCH/LTC/DASH/DOGE/USDT/USDC/DAI pattern.

### 2. Single-network mainnet

ZEC supports testnet and regtest for development but the only canonical home for the asset on Morphit is mainnet. No network picker is mounted in the post-order form or address-share modal.

### 3. Address regex covers all four formats

The canonical registry's `addressShape` regex accepts all four protocol-valid address types:

```
^(t[13][1-9A-HJ-NP-Za-km-z]{33}|zs1[02-9ac-hj-np-z]{75}|u1[02-9ac-hj-np-z]{30,300})$
```

- `t1`/`t3` transparent: base58 alphabet, 33 chars after the prefix.
- `zs1` Sapling shielded: bech32 alphabet (excluding `1`, `b`, `i`, `o` per Bech32 spec), exactly 75 data chars after the `zs1` prefix.
- `u1` Unified Address: bech32m alphabet, variable length (typically 90–300 chars depending on whether transparent, Sapling, and/or Orchard receivers are bundled).

The frontend mirror's `validateZec` splits the union into three named regexes (`ZEC_T_RE`, `ZEC_ZS_RE`, `ZEC_U_RE`) for clearer error reporting and test coverage. Permissive shape check; chain-binding happens on the receiving wallet side.

### 4. Chat-link explorer default — `mainnet.zcashexplorer.app`

The operator surveyed 7 candidate explorers at addition time. The bundled default is **mainnet.zcashexplorer.app** — community-run, project-aligned, no third-party tracking, supports both transparent and shielded transaction lookups by txid. Same privacy/decentralization rationale as `insight.dash.org` for DASH and `blockstream.info` for BTC: prefer a project-aligned or community-run explorer over third-party aggregators or exchange-affiliated services. Operators wanting a different default override via `MORPHIT_FRONTEND_ZEC_CHAT_LINK_URL`.

Full survey:

| Explorer | Disposition | Rationale |
| --- | --- | --- |
| `mainnet.zcashexplorer.app` | **Chosen** | Community-run, project-aligned, no third-party tracking |
| `blockchair.com/zcash` | Available | Third-party aggregator; already used for DOGE so operators preferring CSP-origin consolidation can choose this |
| `zcashinfo.com` | Available | Community-run; lower traffic; secondary recommendation |
| `3xpl.com/zcash` | Available | Third-party aggregator; less focused |
| `blockexplorer.one/zcash/mainnet` | Available | Generic multi-chain aggregator |
| `zcash.tokenview.io` | Available | Tokenview multi-chain; vendor-hosted |
| `cipherscan.app` | Available | Newer privacy-focused explorer; smaller community footprint at launch |

### 5. Universal no-favoritism principle for privacy-coin framing

Adopted as a same-checkpoint design principle for all privacy-relevant assets on Morphit:

> Morphit never ranks privacy approaches across assets or implies one privacy coin is "the most private." Each privacy-focused chain gets respectful framing describing what it *is* (its privacy technology, address types, and trade-offs) without comparative claims that one is stronger than another. This avoids tribal in-fighting between privacy-coin communities and respects each user's free choice of which chain matches their priorities.

This is universal — it applies to ZEC, XMR, DASH, DOGE, BTC, BCH, LTC, BLURT, and any future privacy-relevant addition. The principle replaces previously-shipped language like "For Morphit's strongest privacy posture, use XMR" with neutral descriptions of each chain's privacy properties. Cleaned at cp39 across:

- Canonical asset-registry comments (DASH and DOGE entries).
- Frontend asset-registry comments (LTC, DASH, and DOGE entries).
- Privacy-guide i18n strings × 10 locales (`privacy.guides.xmr.intro`, `privacy.guides.dash.caveats`, `privacy.guides.doge.caveats`).
- FAQ string `faq.entries.what_is_doge.a` × 10 locales.
- DOGE smoke source docblock.

### 6. Privacy framework — `optInPrivacyTech: ['shielded-pools']`

Zcash's privacy mechanism is per-address: shielded addresses (zs1/u1) use zk-SNARKs to hide sender, recipient, and amount; transparent addresses (t1/t3) reveal them. The `privacyFeatures` struct registers `'shielded-pools'` as the opt-in tech tag and `privacyGuideKey: 'zec'` points at the `/privacy/zec` guide page (registry-driven; the `[asset]` dynamic route auto-renders).

The privacy-guide content describes the difference between shielded-to-shielded (both sides hidden), mixed (one side revealed), and transparent-to-transparent (both revealed) transactions, plus wallet-support notes (Zashi, Zecwallet, Nighthawk).

### 7. `zcash:` URI scheme (ZIP-321)

The payment-URI builder emits `zcash:<address>?amount=<decimal>` per ZIP-321. ZEC addresses are unambiguous within the URI scheme: the four prefixes (t1/t3/zs1/u1) disambiguate transparent versus shielded receiver intent.

### 8. Decimals = 8

ZEC uses 8 decimals (zatoshi = 10⁻⁸ ZEC), matching the BTC family's smallest-unit semantics. Amount-jitter routes through `jitterUtxoAmount` (same as BTC/BCH/LTC/DASH/DOGE).

### 9. Brand color `text-yellow-400`

Distinct from DOGE's `text-yellow-500` and USDT's `text-amber-400` and the other 8 accent colors. Yellow-400 lands the Zcash gold brand color (`#F2B525`) within Tailwind's palette without colliding with existing assignments.

## Consequences

- ZEC is enabled by default on every fresh Morphit instance. Operators preferring not to support ZEC can disable via `MORPHIT_INDEXER_DISABLED_ASSETS="ZEC"` (or any longer list including `ZEC`).
- The frozen `fee_method` enum is unaffected. Listing fees stay BLURT/BTC/XMR.
- Per-address privacy choice means Morphit users will sometimes receive ZEC at transparent addresses and sometimes at shielded addresses. The chat-link explorer renders txids the same for both — the txid is canonical even when sender/recipient/amount are hidden inside the shielded payload.
- No favoritism re-introduction guard: future asset additions must follow the §5 principle. The DOGE smoke docblock (cleaned at cp39) is the template for how registry-comments and smoke source should describe each privacy chain — factually, without comparative ranking.

## References

- ADR-0026 (Transparent-chain privacy framework — established the `privacyFeatures` struct).
- ADR-0027 (Dash addition — first chain with opt-in mixing).
- ADR-0030 (Dogecoin addition — single-network template that ZEC mirrors).
- ZIP-321 (Payment Request URI specification) — https://zips.z.cash/zip-0321
- Zcash protocol specification — https://zips.z.cash/protocol/protocol.pdf
- Memory #23 (fee_method enum frozen at BLURT/BTC/XMR).
- Memory #29 (NEW-asset i18n native-en/es/fr/de + EN-fallback for it/pl/ru/fa/zh-CN/zh-HK).
- Cp32 LL #36 (payment-rail axis same-turn discipline).
- Cp33 CODE-3 (atomically widen all 4 wire-format gates).
