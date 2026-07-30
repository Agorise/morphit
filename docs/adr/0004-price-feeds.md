# ADR-0004: Price feed architecture

**Status:** Accepted (implemented in `apps/indexer/src/indexer/price/`)
**Date:** 2026-04-17 (proposed); 2026-05-06 (status updated — Phase 3 indexer-side shipped); 2026-05-25 (cp138 — frontend wiring partially complete; live prices on indexer at `/v1/price/...`, frontend still fallback-only pending an `ApiRelayProvider` + Settings opt-in)
**Deciders:** project maintainer

> **2026 forward note (cp367 — Klingex removed; cp376 — multi-source
> median):** This ADR was
> written when Klingex (the Blurt-community-run CEX) was BLURT's
> primary external upstream. Klingex went out of business in 2026.
> The Klingex fetcher, its `MORPHIT_INDEXER_KLINGEX_BASE_URL`
> config, and its slot in the chain were removed. Initially CoinGecko
> became the sole external source; cp376 then replaced that
> single-upstream risk with an **outlier-rejected median across many
> independent external feeds** (Coingecko, CoinPaprika, CryptoCompare
> for every asset; plus Kraken/Binance/Coinbase/OKX/Bybit where the
> asset is listed; plus CoinLore and the key-gated CoinCap/Messari
> when configured), with the opt-in self-sovereign `morphit_native`
> source and the static floor behind it. Any feed that returns
> nothing is dropped from the median, so no single provider can ban,
> rate-limit, or skew the published price. References to Klingex
> below are retained as the original decision-record context; read
> "Klingex → Coingecko" as "the external-feed median" for current
> behavior.

## Context

Morphit needs USD-equivalent prices for BTC, XMR, and BLURT so that:

1. A buyer asking "I want $50 worth of BLURT" can see how many BLURT
   that is at current market rates before agreeing to a trade.
2. Listing fees (quoted as "~25 cents USD" in Plan v1.3) can be
   computed in the chosen fee currency (BTC, XMR, or BLURT).
3. Order filters like "show offers within 5% of market price" work.
4. The orderbook can warn on obviously off-market listings so new
   users don't get scammed.

Typical crypto apps solve this by calling `api.coingecko.com` or
`api.coinmarketcap.com` directly from the browser. Morphit's
architecture makes that choice non-obvious because:

- **Privacy cost.** Every page load would reveal the user's IP address
  to CoinGecko and/or CoinMarketCap. Both log these calls. A user on
  Tor Browser would either (a) leak their exit-node IP to these
  services or (b) have the request fail when CG/CMC blocks
  known-Tor IP ranges, breaking the feature entirely.
- **Reliability cost.** A client-side direct call creates a runtime
  dependency on `api.coingecko.com` and `api.coinmarketcap.com` being
  reachable. Phase 1's REVIEW explicitly listed "no runtime dependency
  on morphit.io" as a non-negotiable claim; by the same logic, no
  runtime dependency on any single-source third-party service should
  be baked in.
- **CSP cost.** Our strict `connect-src` currently allows `'self'` +
  `https:` for the Blurt RPC pool. Adding two more well-known
  origins increases the attack surface.
- **Rate limits.** CoinGecko free tier is 10–30 req/min per IP.
  A shared Tor exit IP would blow through this in seconds.
  CoinMarketCap's free tier requires an API key; embedding one in
  the client bundle leaks it immediately.
- **BLURT thin float.** BLURT market depth on listed exchanges
  (klingex.io primarily) is thin enough that a naive
  `last_trade_price * quantity` calculation can be off by 10-30% vs.
  realistic execution price. A real pricing layer would need to also
  estimate depth-weighted prices.

## Decision

**Phase 2 ships a provider-swappable `$lib/prices/` interface** with a
hardcoded-fallback provider as the default. Real network-fetching
providers and on-chain oracle providers land in Phase 3 alongside the
orderbook.

The interface:

```typescript
interface PriceProvider {
	readonly name: string;
	getPriceUsd(symbol: 'BTC' | 'XMR' | 'BLURT'): Promise<PriceQuote>;
}
interface PriceQuote {
	symbol: 'BTC' | 'XMR' | 'BLURT';
	usd: number;
	fetchedAt: number; // Unix ms
	source: string;   // provider name; shown in the "prices updated X ago" tooltip
}
```

The UI displays a **"prices updated X seconds ago"** indicator
wherever a USD-quoted value is shown, colored yellow if the quote is
>60s stale and red if >10min stale. This turns price staleness into
a visible user signal rather than a silent correctness bug.

## Alternatives considered (kept for Phase 3 decision)

### Option A — Direct client-side CoinGecko + CoinMarketCap

- **Pros:** simplest; no infrastructure; always fresh; average of two
  sources is robust against single-provider manipulation.
- **Cons:** privacy-violating by construction (two third-party
  services see every user's IP on every page load); Tor users are
  broken entirely (CG/CMC block known Tor exits); CSP widening;
  CMC API key leaks into client bundle; rate limits make shared IP
  infrastructure (corporate networks, VPNs, public WiFi) unreliable.
- **Verdict for Phase 3:** not recommended as sole strategy. Could
  work as an **optional user-selectable** provider for users who
  want freshest data and accept the privacy tradeoff — ship it behind
  a Settings toggle, default off.

### Option B — `morphit.io/api/prices` server endpoint

- **Pros:** user IPs hidden from price sources; CMC API key
  server-side; single authoritative source; 60-second server-side
  cache keeps us within CG/CMC free-tier rate limits even at
  arbitrary user scale; consistent prices across all users (no
  quote-to-quote variance).
- **Cons:** requires a server component; adds a single point of
  failure outside the user's control; violates the "no runtime
  dependency on morphit.io" promise by making pricing depend on the
  morphit.io origin being up.
- **Verdict for Phase 3:** reasonable as the **default** provider,
  *if* we also ship Option C as a fallback that kicks in when
  `/api/prices` is unreachable. Any community-run mirror (.onion,
  .loki, etc.) can run its own `/api/prices`; clients discover via
  the configured endpoint list rather than hardcoded to morphit.io.

### Option C — On-chain `morphit_price_v1` custom_json

- **Pros:** pure P2P, no third-party dependency at request time;
  verifiable history on Blurt; works from Tor/Lokinet/I2P without
  caveat; withstands any single-provider compromise because multiple
  oracle accounts can publish and clients can median-of-N them.
- **Cons:** staleness is bounded by oracle posting frequency (we'd
  target ~1 post per 5 minutes per oracle); requires running a
  price-oracle service (a tiny Go program that calls CG+CMC and
  broadcasts the result). Running at least 3 independent oracles is
  needed to prevent manipulation by a single compromised one.
- **Verdict for Phase 3:** **strong default** for privacy-preserving
  users; runs on community Morphit nodes transparently; single
  oracle start is acceptable for launch, more added as community
  grows.

### Option D — Hardcoded fallback only

- **Pros:** trivially private; trivially reliable; zero dependencies.
- **Cons:** BLURT has thin float and real price moves ~10-30% on
  any given week; using a static number means a buyer asking for
  "$50 of BLURT" could end up with anywhere from $35 to $65 of BLURT
  at actual execution. Tolerable when no orders exist (Phase 2);
  unacceptable once orders do (Phase 3).

## Phase 3 plan (NOT YET DECIDED; candidate)

Ship three providers, let the user pick:

1. **`BlurtOracleProvider`** (default for privacy mode) — reads
   `morphit_price_v1` ops from a configured oracle account list
   (seeded with a handful of community oracles, user-editable in
   Settings the same way RPC endpoints are). Picks the median of the
   N most recent quotes per symbol, filtering any older than 15 min.

2. **`ApiRelayProvider`** (default for standard mode) — calls
   `$CURRENT_INDEXER/api/prices` via the endpoint rotator, which
   means price requests automatically fail over across community
   indexers just like RPC requests do.

3. **`DirectClientProvider`** (opt-in only) — direct CoinGecko +
   CoinMarketCap average, behind a Settings toggle with a clear
   privacy warning. User's explicit choice to widen the CSP for
   freshest data.

All three speak the `PriceProvider` interface; swapping is a
one-line change in `$lib/prices/index.ts`.

## Consequences of the Phase 2 decision

### Positive

- No privacy regression in Phase 2. No new third-party origins in
  the CSP. No API keys shipped.
- Interface is stable; Phase 3 adds providers without touching any
  consumer code.
- "Prices updated X seconds ago" indicator puts staleness in front
  of users from day one, which trains them to trust fresh data and
  be cautious of stale.

### Negative

- The hardcoded fallback is, by definition, stale. Plan v1.3 pegs
  BLURT/USD at $0.002. If real-world BLURT settles at $0.0025 at
  Phase 2 launch, every displayed USD equivalent is off by 25%.
  **Mitigation:** Phase 2 has no order-posting flow yet; the only
  place USD equivalents are visible is the FAQ's description of the
  $0.25 fee. Static error there is academic.
- BTC/XMR fallback values are likewise static. Updating them
  requires a code change and release.

### Follow-up work

- Phase 3: decide between Options B, C, or both; implement.
- Phase 3: add a Settings control that lets the user choose which
  provider to use (if we ship multiple).
- Phase 3: CMC API key management (if Option B chosen) — document
  key rotation, embed in relay config, not client.
- Phase 5: consider adding an optional `morphit_price_oracle_v1`
  attestation signing so an oracle can be verifiably associated
  with a known operator (optional, but useful for high-stakes
  price-sensitive actions).

## References

- Plan v1.3 — BLURT/USD $0.002 hardcoded fallback.
- ADR-0001 — `custom_json` immutability (applies to
  `morphit_price_v1` the same as other ops).
- `$lib/net/endpoints.ts` — the endpoint-rotation pattern the
  `ApiRelayProvider` will reuse.

## Amendments

### 2026-05-09 (Part 90, Category I ADR-fidelity audit) — reconcile with shipped state

The status header says "implemented in `apps/indexer/src/indexer/price/`"
but the body's "Phase 3 plan (NOT YET DECIDED; candidate)" section
described a different architecture than what shipped.  This
amendment reconciles the two without rewriting history.

**What actually shipped (Phase 3, indexer-side):**

- `apps/indexer/src/indexer/price/compositeSource.ts` —
  `CompositeCachedPriceSource` aggregates results from a list of
  fetcher providers and serves cached, time-stamped quotes.
- `apps/indexer/src/indexer/price/coingeckoFetcher.ts` and
  `apps/indexer/src/indexer/price/klingexFetcher.ts` — concrete
  upstream fetchers, each implementing the same minimal
  fetcher interface; the operator picks which to enable via
  config flags.
- `apps/indexer/src/indexer/price/factory.ts` — assembles the
  composite source from operator config at boot.

The indexer is the privacy boundary: it makes the upstream
calls (CoinGecko, Klingex), and frontend pages read the
indexer's `/v1/price/...` endpoint via the standard endpoint
rotator.  This is the `ApiRelayProvider` design from the
"Phase 3 plan" section, generalized — there's no separate
`BlurtOracleProvider`, since the on-chain oracle approach
proved unnecessary for Phase 3 launch.

**What also shipped (frontend, `$lib/prices/`):**

- `apps/web/src/lib/prices/index.ts` — provider registry +
  `setProvider()` / `getQuote()` API.
- `apps/web/src/lib/prices/providers/fallback.ts` — the
  hardcoded fallback the original ADR specified for Phase 2.
  **This is the only provider actually wired into the live
  UI today.**  The reactive `priceStore` + `getPrice()` API
  in `index.ts` defaults to `fallbackProvider` at boot and
  there is no Settings toggle to swap it.
- `apps/web/src/lib/prices/providers/coingecko.ts` —
  reference implementation of a direct-client price fetcher
  (corresponds to `DirectClientProvider` in the original
  Phase 3 plan).  **Not currently imported anywhere.**
  Retained as RFC code for a future "users who want freshest
  prices and accept the IP leak" opt-in.
- `apps/web/src/lib/prices/providers/composite.ts` — reference
  implementation of a multi-upstream chainer.  **Not
  currently imported anywhere.**  Retained as RFC code for
  the same future opt-in path.

The frontend serves prices from the static `fallback` quotes
only.  To get live prices into the UI, the next step is to
ship an `ApiRelayProvider` that calls the indexer's
`/v1/price/...` endpoint and wire it via a Settings toggle
("opt-in to live prices?  may slightly degrade privacy by
relaying through your home instance").  Until that ships, the
ADR's user-facing privacy promise (indexer is the privacy
boundary, frontend never speaks to CoinGecko directly) is
trivially upheld because the frontend doesn't fetch prices
at all.

### 2026-05-25 (cp138 audit) — accuracy correction to the 2026-05-09 amendment

The 2026-05-09 amendment overstated the frontend wiring.  It said
"frontend defaults to fallback prices unless the user explicitly
opts into the indexer-relayed feed via Settings" and "a direct-
CoinGecko provider also exists and ships [...]; a user who wants
freshest prices and is OK with the IP leak can flip to it."  In
reality:

- No Settings toggle for price-provider switching exists.
- `setProvider()` is exported but uncalled.
- `composite.ts` and `coingecko.ts` are unimported (and so unused).
- The frontend serves fallback quotes only.

That overstatement was caught by the cp138 deep audit's orphan-file
sweep.  The amendment text above has been corrected to describe the
actual state — RFC code parked for a future Settings opt-in, with
no semantic regression vs. the original Phase 2 promise (which was
"fallback only at Phase 2 launch").

The follow-up work is tracked in `REVISIT-LIST.md` as
"Ship `ApiRelayProvider` + Settings toggle (drift-resolved
in cp138; future Phase-3-completion work)."
