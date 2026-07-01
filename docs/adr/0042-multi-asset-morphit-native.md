# ADR-0042 — Multi-asset morphit_native price source (cp130: BTC + XMR alongside BLURT)

**Status:** Accepted (shipped 2026-05; pre-launch hardening campaign)

**Date:** 2026-05-23
**Deciders:** project maintainer (Ken)
**Related:** ADR-0039 (self-sovereign pricing — designed the generic factory; cp127 wired BLURT only); ADR-0040 (denomination configurability); ADR-0041 (cross-instance peer disagreement — already supports per-asset sampling, cp130 extends the wiring to spawn one monitor per asset).

## Context

ADR-0039 designed `createMorphitNativeFetcher({ asset, denominationFiat, ... })` as a generic factory — any (asset, fiat) pair, not BLURT-specific. cp127 wired BLURT only because that was the immediate use case (the listing-fee USD echo).

cp130 wires the other two primary tradable assets — BTC and XMR — through the same generic factory. The wiring change is small (the factory already supported it); what matters is the supporting infrastructure: per-asset upstream-chain choices, per-asset static-floor config, multi-asset peer monitoring.

The motivating use case is operator transparency. With `/v1/price/morphit-native/receipt?asset=BTC` returning a real derivation, operators can inspect what BTC/USD price their indexer would surface for any future feature that wants BTC price data (orderbook USD echo, fee oracle for non-BLURT fee modes, etc.). cp130 doesn't ship any UI consumer of BTC/XMR prices — that's deferred to cp131+ — but the backend is ready.

## Decision

### Generic asset factory

`apps/indexer/src/indexer/price/factory.ts` introduces:

- `createAssetPriceSource(config, options, db?)` — generic builder taking `AssetPriceSourceOptions` (asset, coingeckoCoinId, enableKlingex, staticFloor)
- `CP130_ASSET_DEFAULTS` — per-asset defaults for the cp130 launch set (BLURT, BTC, XMR)
- `createMultiAssetPriceSources(config, db?)` — returns `Map<string, BlurtPriceSource>` keyed by asset ticker
- `createPriceSource(config, db?)` — preserved as a backwards-compat wrapper for BLURT-only callers (listing-fee endpoint)

### Per-asset upstream chains

| Asset | Klingex | Coingecko | morphit_native | Static floor |
|---|---|---|---|---|
| BLURT | ✅ (primary; Klingex's flagship pair is BLURT/USDT) | ✅ (fallback) | ✅ (opt-in) | ✅ (last resort) |
| BTC | ❌ (Klingex doesn't trade BTC/USDT at scale) | ✅ (primary; coinId='bitcoin') | ✅ (opt-in) | ✅ |
| XMR | ❌ (same; Klingex BLURT-only) | ✅ (primary; coinId='monero') | ✅ (opt-in) | ✅ |

The `enableKlingex` flag in `AssetPriceSourceOptions` controls per-asset Klingex inclusion. BTC and XMR get a 3-tier chain (Coingecko → morphit_native → static); BLURT keeps its 4-tier chain (Klingex → Coingecko → morphit_native → static).

### Coingecko generalization

`coingeckoFetcher.ts` previously hardcoded `vs_currencies=usd` in the URL and accessed `.usd` in the response. cp130 generalizes:

- New `vsCurrency: string` field in `CoingeckoConfig` — lowercased per Coingecko API convention
- URL: `vs_currencies=${vsCurrency}`
- Response extraction: `body[coinId][vsCurrency]`

This means the factory can pass `config.priceFeedDenominationFiat.toLowerCase()` as the vs_currency, so a EUR-denominated instance gets EUR-priced BTC/XMR feeds directly from Coingecko (CG supports many vs_currencies natively).

### Per-asset static-floor config

Two new env vars, both with sane USD-shaped defaults:

| Env var | Default | Purpose |
|---|---|---|
| `MORPHIT_INDEXER_PRICE_FEED_BTC_STATIC_FLOOR` | `60_000` | Fallback BTC/USD price when all live upstreams have failed and nothing has cached since boot |
| `MORPHIT_INDEXER_PRICE_FEED_XMR_STATIC_FLOOR` | `200` | Same for XMR/USD |

Operators in non-USD denominations should override these to their unit (a EUR-denominated instance might set `BTC_STATIC_FLOOR=55_000` for ~BTC/EUR; a XAU-denominated instance might set `BTC_STATIC_FLOOR=0.011` for BTC-per-ounce-of-gold). Static floors are intentionally rough — they never surface in normal operation; the composite source consults them only when every live upstream has failed.

The existing `MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR` continues to be the BLURT static floor (preserved for backwards compatibility).

### Per-asset denomination — NOT added (item #3 collapsed)

Ken's "six bullet" list included item #3 (per-asset denomination configurability). cp130 collapses this into "global denomination applies to all assets" instead of adding per-asset configurability:

- An operator who sets `priceFeedDenominationFiat=EUR` gets BLURT/EUR, BTC/EUR, XMR/EUR — a coherent display unit across the whole instance.
- The use case for per-asset denomination ("operator wants BTC priced in USD but BLURT in EUR") is plausible but speculative. No concrete user request.
- Adding per-asset config would mean either 16 env vars (one per asset; bad for grandma's grandfather the operator) or a JSON-map env var (still operator complexity).

**If a concrete need appears later, revisit.** The factory's `denominationFiat` parameter is per-asset already (it accepts a string per call site); only the wiring code in `factory.ts:createMultiAssetPriceSources` hardcodes `config.priceFeedDenominationFiat` for all assets. Replacing that hardcoding with a per-asset map is a small change when motivation exists.

### Multi-asset peer monitor wiring

cp129's `peerPriceMonitor.ts` already supports per-asset operation — the module's signature is `runPeerPriceSampleCycle(cfg)` with `asset` and `denominationFiat` in the cfg. cp130 wires `main.ts` to spawn one monitor instance per (asset, denomination_fiat) pair when peer monitoring is enabled:

```typescript
for (const [asset, source] of multiAssetSources) {
  const stop = startPeerPriceMonitor({ db, priceSource: source, asset, denominationFiat: ... });
  stopPeerPriceMonitors.push(stop);
}
```

The schema-v36 `price_peer_observations` table already supports per-asset rows (indexed on `(asset, denomination_fiat, observed_at DESC)`); no schema change needed. Each per-asset monitor independently queries peers' receipt endpoint with that asset parameter, stores observations tagged with the asset, and alerts on per-asset disagreement.

### Receipt endpoint

`/v1/price/morphit-native/receipt?asset=BTC&denomination_fiat=USD` already worked pre-cp130 — the endpoint calls `deriveMorphitNativePrice(asset, denomination_fiat, ...)` directly with the query params. cp130 doesn't change the endpoint code; it makes the backend able to actually serve meaningful BTC and XMR derivations because the upstream chain now exists for those assets.

## Resilience scenarios

### Operator queries BTC/USD via receipt endpoint
- `deriveMorphitNativePrice(asset='BTC', denomination_fiat='USD', ...)` runs the Tier 1/2/3 cascade against on-platform BTC-vs-USD-fiat orders (Tier 1) and BTC-vs-stablecoin orders (Tier 2) just like BLURT.
- Operator sees the derived price + contributing-traders + tier_used.
- Forensics work identically to BLURT.

### Operator on EUR denomination
- Coingecko URLs use `vs_currencies=eur` for all three assets — CG returns EUR-priced BLURT, BTC, XMR directly.
- morphit_native fetcher's Tier 1 looks for BLURT-vs-EUR / BTC-vs-EUR / XMR-vs-EUR orders.
- Tier 2 (stablecoin-anchored) uses the same stablecoinKeys list (USDT/USDC/DAI by default) — they're USD-pegged, so EUR-denominated Tier 2 results will be off by the USD/EUR ratio. Operator should either accept this (Tier 2 is supplementary) or set `priceFeedStablecoinKeys=''` to disable Tier 2 entirely on EUR-denominated instances. (Same caveat as cp128 ADR-0040; nothing new in cp130.)

### Coingecko 429-rate-limits the BTC query
- Returns null from the Coingecko upstream for BTC.
- Composite source falls through to morphit_native (if enabled) or the BTC static floor.
- BLURT and XMR queries continue independently (each has its own composite source instance and its own request to Coingecko — they're not bound to the same fetch).

### morphit_native disagreement between BTC peers
- Defense F's per-asset monitor independently watches BTC observations.
- If my indexer's BTC/USD derivation disagrees with the peer median by >25% sustained for >4 hours, the alert fires with the BTC asset tag.
- BLURT monitor + XMR monitor continue independently.

### One asset's morphit_native data is too thin
- E.g. only 1-2 BTC-vs-fiat orders on the platform in the last 8 hours.
- morphit_native returns null for BTC (insufficient traders).
- Composite source falls through to Coingecko for BTC.
- BLURT can be Tier 3-derived from its own thicker data; BTC fails gracefully.

## What this design DOESN'T solve (honest limitations)

- **Per-asset denomination override** — deliberately deferred (see "Per-asset denomination — NOT added" above). Revisit if a concrete use case appears.
- **Klingex for non-BLURT** — Klingex doesn't trade BTC/USDT or XMR/USDT at scale, so adding Klingex tier for BTC/XMR would just be a noisy fallback that always returns null. Skipped honestly.
- **No new external sources for BTC/XMR** — Coingecko + morphit_native is the chain. Adding e.g. Kraken or Binance fetchers would broaden the external set but adds maintenance burden + each new external dependency is a new privacy surface (per-instance HTTP calls to that exchange). Defer until concrete operator need.
- **No UI consumer of BTC/XMR prices** — cp130 ships the backend only. Future cp131+ orderbook USD-echo work would consume these prices. Ken explicitly noted item #6 (USD-equivalent orderbook display) is deferred indefinitely; that's fine — the backend stays useful even without UI consumption (operator inspection via receipt endpoint, possible API consumers).
- **No new stablecoin-pegged-to-non-USD asset additions** — EUR-pegged stablecoins (EURC/EURT/EURS) would unlock Tier 2 for EUR-denominated instances. Ken explicitly retired this item ("probably never"). Tier 2 on non-USD denominations continues to be effectively disabled in practice; documented honestly in ADR-0040.

## Operator action required

- **None mandatory.** Default `MORPHIT_INDEXER_PRICE_FEED_ENABLED=false` is unchanged; if you don't have the price feed enabled, nothing about cp130 affects you.

- **Optional:** if you enable the price feed AND want to override the per-asset static floors, set `MORPHIT_INDEXER_PRICE_FEED_BTC_STATIC_FLOOR` and/or `MORPHIT_INDEXER_PRICE_FEED_XMR_STATIC_FLOOR`. Defaults are USD-shaped (60_000 and 200); operators in non-USD denominations should override to their unit.

## Privacy + decentralization posture

Per priorities #1 and #2:

- **Same outbound calls as cp127 for BLURT** plus 2 new outbound paths (Coingecko queries for BTC + XMR every 5 minutes when refresh fires). All over HTTPS, no API keys required for the free tier.
- **No new federation requirement** — cp130 doesn't depend on any peer behavior.
- **No new operator-mandatory config** — defaults work.
- **No new central authority** — each operator's per-asset price sources are independent.

## Smokes

`apps/indexer/scripts/multi-asset-factory-smoke.ts` — 20 structural scenarios across 10 dimensions: (CP130-1) public surface area, (CP130-2) CP130_ASSET_DEFAULTS shape + launch set, (CP130-3) Klingex BLURT-only enforcement, (CP130-4) Coingecko coin-id correctness, (CP130-5) multi-asset map keying + instance distinctness, (CP130-6) backwards-compat wrapper, (CP130-7) per-asset static-floor wiring, (CP130-8) empty-db / morphit_native-disabled path, (CP130-9) denomination flowing through to all assets, (CP130-10) doc-comment design-pillars manifest.

## Future work

- **More external sources for BTC/XMR** if operators report Coingecko-only being too narrow. Candidates: Kraken (public API, no key needed for ticker), CoinPaprika (free tier with higher limits than CG), Bitstamp (BTC primarily). Each adds privacy surface; pick based on operator demand.
- **Per-asset denomination override** if/when a concrete use case appears.
- **Per-asset peer monitor thresholds** — today all assets share the same `PEER_DISAGREEMENT_THRESHOLD=0.25`. BTC's price is much less volatile per-day than BLURT's; a tighter threshold for BTC (say 10%) might catch finer manipulation. Defer to operator feedback.

## Related code/docs

- `apps/indexer/src/indexer/price/factory.ts` — generic asset factory + multi-asset map builder
- `apps/indexer/src/indexer/price/coingeckoFetcher.ts` — vsCurrency generalization
- `apps/indexer/src/config/index.ts` — per-asset static-floor env vars + Config fields
- `apps/indexer/src/main.ts` — multi-asset boot + per-asset peer monitors + lifecycle
- `apps/indexer/scripts/multi-asset-factory-smoke.ts` — 20 structural scenarios
- `apps/indexer/test/testutils/context.ts` — fakeConfig defaults extended
- `ops/env/indexer.env.example` — documented new env vars
