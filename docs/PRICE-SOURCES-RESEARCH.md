# BLURT/USD price source research

**Status:** Research notes (not a design decision)
**Date:** 2026-04-21
**Scope:** Evaluate five proposed additional price sources
beyond the existing Klingex + Coingecko pair.
**Interacts with:** ADR-0011 (fee model consumes price),
OPERATIONS.md §13 (stale-price runbook)

---

## Context

The indexer's price path today:

```
Klingex → Coingecko → static_floor
```

Composite source with the first live feed winning, TTL
cache, and background refresh. `priceSource.current()`
returns the BLURT/USD rate used by order fee
verification in `apps/indexer/src/indexer/handlers/order.ts`.

The revisit list asked for evaluation of five additional
sources: **Tribaldex, Hive-Engine, CoinMarketCap,
Blockchair, Blockchain.com**. This document records what
I found about each and a recommendation for or against
integrating it.

The goal of additional sources is **not** diversification
for its own sake — every new source is another
background HTTP request, another failure mode, another
API policy to track. Additional sources earn their place
only if they narrow a real gap in the existing chain.

---

## Source-by-source findings

### CoinMarketCap — FEASIBLE, API KEY REQUIRED

- **Endpoint:** `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?slug=blurt&convert=USD`
- **Auth:** `X-CMC_PRO_API_KEY` header. Free tier exists
  with daily call-credit limit; paid tiers for higher
  volume.
- **Response shape:** `data.<id>.quote.USD.price` (number,
  USD per BLURT). Timestamp in `data.<id>.quote.USD.last_updated`.
- **BLURT is listed** on CMC (slug: `blurt`).
- **CAVEAT (important):** the BLURT page on
  `coinmarketcap.com/currencies/blurt` shows `$0 USD` trading
  volume as of 2026-04-21. This means either (a) CMC isn't
  aggregating volume from Tribaldex / Hive-Engine sidechain
  pools (the main BLURT trading venue today), or (b) the
  listing is stale. A price source that reports `$0` volume
  is a red flag even if it reports a non-zero price — the
  price may be a frozen historical value, not a live rate.
  **Operator verification required before making this a
  primary or secondary source.**
- **Policy risk:** CMC Terms of Service allow API use for
  data display, including commercial use on paid tiers.
  Free-tier limits (typically ~10,000 credits/month) are
  enough for an operator polling once every 60s
  (43,200/month) only on the lowest paid tier — free-tier
  polling must be slower (>5-min interval) to stay
  under.
- **Recommendation:** FEASIBLE but de-prioritized until an
  operator confirms the CMC BLURT price is live and
  actively updating. The `$0 volume` flag means CMC could
  be reporting a stuck number. If verified live, slot in
  as an optional source between Klingex and Coingecko.

### Tribaldex — NOT FEASIBLE AS DIRECT SOURCE (sidechain depeg risk)

- **What it is:** Tribaldex is a front-end for
  Hive-Engine sidechain trading. BLURT on Tribaldex is
  actually `SWAP.BLURT`, a **wrapped** BLURT token
  bridged via `blurt-swap`. Not BLURT itself.
- **Pricing geometry:** To derive BLURT/USD from
  Tribaldex you'd need:
  `SWAP.BLURT/SWAP.HIVE × HIVE/USD`
  (three-hop: cross-chain bridge peg × sidechain pair ×
  mainnet price provider)
- **Fundamental problem:** the `SWAP.BLURT` ↔ BLURT peg
  depends on bridge liquidity. Under thin liquidity or a
  bridge-operator issue, SWAP.BLURT can trade meaningfully
  below (or above) BLURT's "real" rate. Using this as a
  primary BLURT/USD feed would produce wrong fees during
  bridge stress events — exactly when fee accuracy matters
  most.
- **Endpoint details** (for reference if ever used as a
  sanity-check): Hive-Engine RPC at
  `https://api.hive-engine.com/rpc/contracts` — POST
  JSON-RPC call to the `market` contract's `metrics` table
  with `symbol: "SWAP.BLURT"` returns last price against
  SWAP.HIVE.
- **Recommendation:** DO NOT add as a primary or secondary
  source. Could serve a niche role as a **divergence
  alarm** — if `SWAP.BLURT/SWAP.HIVE × HIVE/USD` disagrees
  with the Klingex/Coingecko consensus by >10%, log a
  warning for operator attention. But even that is
  nice-to-have; a three-hop derived price isn't worth
  the infrastructure it requires.

### Hive-Engine — SAME AS TRIBALDEX

- **Same chain, same problem.** Tribaldex IS a
  Hive-Engine front-end; there's no independent
  Hive-Engine "price" distinct from what Tribaldex
  surfaces.
- API documentation:
  `https://hive-engine.github.io/engine-docs/` (contract
  tables) and
  `https://hiveengine.readthedocs.io/en/latest/hiveengine.api.html`
  (Python library reference, useful for endpoint
  shapes).
- **Recommendation:** treat as identical to Tribaldex.
  Do not integrate.

### Blockchair — NOT APPLICABLE

- **Supported chains:** ~48 blockchains as of 2025,
  covering Bitcoin family (BTC, LTC, BCH, DOGE, DASH, ZEC, ARRR,
  DGB, XEC, GRS), Ethereum family, Solana, TRON, Polygon,
  and similar account-model / UTXO chains.
- **Graphene-family chains (BLURT, Hive, Steem) are NOT
  supported.** Blockchair's model is built around
  indexing UTXO and account-model chains; delegated-PoS
  social chains like BLURT aren't in scope.
- **Not a BLURT price source at all.** Blockchair can't
  return BLURT/USD because it doesn't index BLURT.
- **Useful elsewhere?** Yes — for BTC/XMR
  fee-attestation. When an order's `fee_method` is
  `btc` or `xmr` (ADR-0011 sub-phase 4b), an attestor
  verifies the claimed payment on the external chain.
  Blockchair's `/bitcoin/dashboards/transaction/{hash}`
  endpoint is a clean way to look up a payment. This is
  a separate workstream from BLURT/USD pricing — I'm
  logging it here but it belongs in the attestor-UX
  design, not in `priceSource`.
- **Recommendation:** do NOT integrate into
  `priceSource`. Revisit in the ADR-0011 sub-phase 4b
  attestor workstream as an explorer-rotation candidate.

### Blockchain.com — NOT APPLICABLE

- **Explorer APIs** are Bitcoin-focused: block data,
  transaction lookup, charts/stats for BTC. Not a
  multi-chain indexer.
- **Exchange API** lists pairs they run on
  `exchange.blockchain.com` — BTC-USD, ETH-USD, etc.
  **BLURT is not listed.**
- The `exchange_rates_api` endpoint returns fiat/BTC
  conversion rates, not altcoin prices.
- **Recommendation:** do NOT integrate for BLURT price.
  Same as Blockchair, could be useful in an attestor
  role for BTC fee verification (as a Blockchair
  alternate), but that's a separate workstream.

---

## Summary table

| Source | BLURT/USD? | Verdict | Priority |
|---|---|---|---|
| Klingex | direct | already integrated (primary) | — |
| Coingecko | direct | already integrated (fallback) | — |
| CoinMarketCap | direct (but volume=$0 concern) | FEASIBLE pending operator verification | Medium |
| Tribaldex | three-hop derived | NOT RECOMMENDED (sidechain depeg risk) | Low (divergence alarm only) |
| Hive-Engine | same as Tribaldex | NOT RECOMMENDED | Low |
| Blockchair | does not index BLURT | NOT APPLICABLE | — (reconsider for BTC attestor) |
| Blockchain.com | does not list BLURT | NOT APPLICABLE | — (reconsider for BTC attestor) |

---

## Recommendations

**Short term (this audit cycle):**

1. **Do NOT add any new primary price sources.** The
   existing Klingex → Coingecko → static_floor chain is
   working and the proposed additions each have
   disqualifying issues.

2. **Have an operator verify CMC BLURT price freshness.**
   If the `$0 volume` flag is just cosmetic (CMC not
   aggregating sidechain volume, but price feed is live),
   CMC slots in cleanly as a third provider. Required
   check: poll
   `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?slug=blurt`
   with a trial API key across a week, compare the
   returned `price` against Klingex and Coingecko over
   the same interval. If CMC tracks within 5% of the
   consensus and `last_updated` advances steadily, green-
   light integration.

3. **Document the decision not to integrate Tribaldex
   and Hive-Engine** in `docs/adr/0004-price-feeds.md`
   (the existing price feeds ADR) so the question
   doesn't come back in a future session.

**Medium term (ADR-0011 sub-phase 4b):**

4. **Revisit Blockchair and Blockchain.com in the
   attestor-UX design workstream.** For BTC/XMR
   fee-attestation, a user who's attesting that a
   payment landed needs to query an explorer to verify
   the claimed tx. An explorer rotation with Blockchair +
   Blockchain.com + mempool.space + one or two others is
   the right shape for that problem, but it's separate
   from `priceSource`.

**Long term (if BLURT gets listed on a major CEX):**

5. **Add direct exchange tickers** as primary sources
   when they become available. Binance, Kraken, Gate.io
   etc. would all be preferable to aggregators if BLURT
   ever gets there. Today, no major CEX lists BLURT, so
   this isn't actionable.

---

## What I'd integrate code-wise (if operator green-lights CMC)

Minimal skeleton (for reference, not shipped this
session):

```ts
// apps/indexer/src/indexer/priceFetchers/coinmarketcapFetcher.ts
export function createCmcFetcher(
  apiKey: string,
  baseUrl = 'https://pro-api.coinmarketcap.com'
): PriceFetcher {
  return async (): Promise<PriceSample | null> => {
    const url = `${baseUrl}/v1/cryptocurrency/quotes/latest?slug=blurt&convert=USD`;
    const res = await fetch(url, {
      headers: {
        'X-CMC_PRO_API_KEY': apiKey,
        Accept: 'application/json'
      }
    });
    if (!res.ok) return null;
    const body = await res.json();
    // Shape: { data: { <id>: { quote: { USD: { price, last_updated } } } } }
    const entries = Object.values(body.data ?? {});
    const first = entries[0];
    if (!first || typeof first !== 'object') return null;
    const quote = (first as any).quote?.USD;
    if (!quote || typeof quote.price !== 'number') return null;
    return {
      blurtUsd: quote.price,
      source: 'coinmarketcap',
      fetchedAt: new Date(),
      observedAt: new Date(quote.last_updated)
    };
  };
}
```

Order in composite: `Klingex → CMC → Coingecko → static_floor`.
CMC slots in between Klingex and Coingecko because it's
the most authoritative aggregator; Coingecko remains
the backstop because it's free-tier-friendly.

Config additions needed:
- `MORPHIT_INDEXER_CMC_API_KEY` (secret, env-only, never
  in logs)
- `MORPHIT_INDEXER_CMC_BASE_URL` (default
  `https://pro-api.coinmarketcap.com`, override for
  testing)
- `MORPHIT_INDEXER_PRICE_MODE` gains `cmc` as a valid
  value, mostly for test scenarios.

---

## Files that would change if we ship CMC

- `apps/indexer/src/indexer/priceFetchers/coinmarketcapFetcher.ts` (new)
- `apps/indexer/src/indexer/priceFactory.ts` (wire cmc into
  composite)
- `apps/indexer/src/config/index.ts` (+ 2 config fields)
- `OPERATIONS.md §13` (how to acquire a CMC API key, what
  happens if CMC rate-limits)
- `docs/adr/0004-price-feeds.md` (document the third
  source)

No schema changes. No migration. Pure additive.
