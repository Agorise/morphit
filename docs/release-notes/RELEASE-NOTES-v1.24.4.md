# Morphit v1.24.4

Pirate Chain's new Ironwood addresses (`pirate1…`) now work for ARRR trades.

This release contains everything in v1.24.3. The deadline v1.23.5 set still stands: every site must
run v1.23.5 or later (so this release is fine) before **2026-11-22 00:00 UTC**.

## For people using the site

**You can share a `pirate1` address in an ARRR trade.** Pirate Chain added a second kind of
private address, Ironwood, on 3 October 2026. These addresses start with `pirate1` and are 82
characters long. Morphit refused them as "not a valid Pirate Chain address", and its help pages said
`zs1` was the only kind. Both kinds now work, and the FAQ, the cheat sheet, the order form and the
ARRR privacy guide describe both, in every language. A user spotted it.

**Some help text said the wrong thing about listing fees.** In Italian, Polish, Russian, Persian
and Chinese, the cheat sheet said ARRR, Dash, Ethereum and XRP could pay listing fees. They can't:
listing fees are paid in BLURT, BTC or XMR, as the English always said. The order form's ARRR line had
the same mistake. Both are fixed.

The home page's Discoverability card now says "trader reputation" instead of "user reputation", in
every language.

## For operators

Upgrade as usual. Nothing to configure.

## For developers

- **ARRR addresses:** `apps/web/src/lib/assets/registry.ts`, `apps/web/src/lib/chat/payload.ts`
  and `packages/asset-registry` accept `pirate1` + 75 bech32 characters (82 in all) beside `zs1` + 75.
  That is Pirate Chain's Ironwood payment address: plain bech32, prefix `pirate`, over 43 bytes
  (Pirate Chain `src/chainparams.cpp` `IRONWOOD_PAYMENT_ADDRESS`, `src/zcash/Zcash.h`), live on
  mainnet since block 4,161,185. `zs1` still receives. A `pirate1` address is Pirate Chain's alone;
  no other coin accepts it (`address-shape-overlap-smoke`).
- **Tests:** `arrr-trade-only-smoke` checks all four ARRR address checks against two `pirate1`
  addresses with real bech32 checksums, and eight near-misses (wrong length, the testnet prefix,
  upper case, a viewing-key prefix, trailing space). `everyCoinRoundTrip.test.ts` sends a `pirate1`
  address through a chat message and checks ZEC refuses it. All failed before the fix. Undoing each
  part of the fix on its own fails a test: 5 mutations.
- **Wording:** the ARRR strings in all 10 locales; the Dash, Ethereum and XRP cheat-sheet lines in
  it, pl, ru, fa, zh-CN and zh-HK; a Spanish word in the Italian Ethereum line;
  `home.priorities.discoverability.body` in all 10 locales.
- **Docs:** ADR-0032 has an update section on Ironwood; the brag list (item 338) and the metadata
  leak catalog name both address kinds. The media kit is rebuilt from the new brag list, and
  `apps/web/static/llms-full.txt` from the new FAQ.
- **Dependencies** (all build and lint tooling; a production install has none of them):
  - `@typescript-eslint/*` 8.59.3 → 8.73.0, which brings minimatch 10.2.6 → 11.0.9 and fixes
    GHSA-g3hv-75wg-m249. `apps/web/package.json` now requires `^8.73.0`. Also brace-expansion
    5.0.12 → 5.0.13 and tinyglobby 0.2.16 → 0.2.17, as `npm audit fix` lays them out. Every
    changed lockfile entry was checked against the npm registry.
  - Newly accepted, with the reason in `scripts/audit-allowlist.json`: GHSA-3r8g-jcqq-3p5j and
    GHSA-6cf5-gc4q-fm3x (SvelteKit remote functions; Morphit's static build has no SvelteKit server
    and no remote functions; fixed only in SvelteKit 3) and GHSA-fc5q-39xc-vjpf (picomatch, build
    tooling; no fixed version exists yet).
