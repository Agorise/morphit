# Morphit — Phase 2 review

Status: **Phase 2 signs off** — the foundations for on-chain interaction
(reading profiles, broadcasting signed ops) are in place. No trading or
chat yet (that's Phase 3/4). The code ships with placeholder Blurt account
names (`morphit-unregistered`, `morphit-relay-unregistered`) which must
be replaced with the real account names once they're registered on Blurt
mainnet.

> **2026-05-11 forward note (Part 120 audit):** This is a
> dated Phase 2 review snapshot.  The placeholder account
> names mentioned in the status above have long since been
> replaced — Morphit currently uses `@morphit` for posting +
> `@morphit-fees` as the canonical treasury per
> FEES-AND-REWARDS.md and OPERATIONS.md.  The "3-min
> replace-window" referenced in the scheduled-work table
> below was amended to 15 minutes in ADR-0001's 2026-05-07
> amendment.  Use ARCHITECTURE.md and the latest ADRs for
> current behavior.

## What shipped

### BIP-39 compliance

The Phase 1 placeholder mnemonic (64-word custom wordlist) is gone.
`keygen.ts` now uses `@scure/bip39` with the canonical English wordlist
and BIP-39 seed derivation (PBKDF2-HMAC-SHA-512, 2048 rounds). A Morphit
seed is a real BIP-39 mnemonic — importable into hardware wallets and
other BIP-39 tools for backup purposes.

**Migration note:** a user generated under Phase 1 cannot derive the same
keys under Phase 2, because the derivation path is different. Since
Phase 1 shipped no registered accounts, this is safe — nobody's identity
is locked into the old derivation. Phase 1 users re-generate.

### Endpoint rotation client

`$lib/net/endpoints.ts`. Health-aware round-robin across a user-editable
list of Blurt RPC endpoints. Scores each endpoint by consecutive failures
and last measured latency; cools failing endpoints down with exponential
backoff (capped at 5 min); persists the endpoint list in `localStorage`
under a single key so user customizations survive reloads.

Default pool:

- `rpc.blurt.blog`
- `blurt-rpc.saboin.com`
- `rpc.beblurt.com`
- `rpc.blurt.one`

The user can add/remove/pin/reset via Settings → RPC endpoints.

### Blurt chain client

`$lib/blurt/client.ts` wraps our rotator in a read-shaped API:
`getAccount`, `getDynamicGlobalProperties`, `getLatestCustomJson`. An
escape-hatch `.call()` handles anything the typed wrappers don't cover.

`$lib/blurt/sign.ts` wraps `dblurt`'s crypto primitives (PrivateKey,
Transaction serialization, signing) so that we get dblurt's battle-tested
signing with Morphit's multi-endpoint transport — ie. dblurt's signing,
our broadcasting.

### Session identity store

`$lib/stores/identity.ts`. Holds the `LiveIdentity` for the session, plus
the encrypted keystore envelope for JIT unlocks. `bootFromEnvelope`
unlocks at sign-in; `reset` wipes private bytes on sign-out; a
`pagehide` listener does best-effort wipe when the tab closes.

Consuming components subscribe to `liveIdentity` and `isUnlocked`.

### Onboarding — confirm-seed step + nav guard

New intermediate stage between "review your seed" and "done": quiz the
user on 3 random words from the seed they just saved. Completing the
quiz boots the identity store (encrypts the full identity with a
random in-session password if the user didn't provide one). A
`beforeNavigate` guard warns before accidental navigation away from
either sensitive stage, and wipes in-memory state if the user confirms
leaving.

### Settings rewrite

- Display name: local save, plus "Save + broadcast on Blurt" button
  when the session is unlocked (currently throws a user-friendly error
  because no Blurt account is registered yet — ready to work the moment
  the user's Blurt account name is set).
- RPC endpoints: full CRUD, status badges showing latency / failure
  count / cooldown state.
- Remembered addresses: per-currency forget buttons + forget-everything.
- Session: sign-out button, wipes live keys and returns to home.

### Service worker update banner

`$lib/components/UpdateBanner.svelte`. Subscribes to the service-worker
lifecycle; when a new worker is waiting, shows a dismissible banner.
Sends `APPLY_UPDATE` on confirm, reloads on `controllerchange`. Periodic
background `update()` triggers so users get prompted within a minute of
a release landing.

### Docs

- `docs/adr/0000-template.md` — ADR template.
- `docs/adr/0001-custom-json-replacement.md` — documents the layer-2
  replace-op decision.
- `docs/adr/0002-live-keys-policy.md` — documents the posting+memo-only
  invariant.
- `CONTRIBUTING.md` — workflow, Key Handling Contract checklist,
  authorship policy, ADR guidance, i18n expectations.

### Mid-phase additions (added after Phase 2 scope was first cut)

- **Italian locale.** Full translation landing in a mid-phase turn.
  `SUPPORTED_LOCALES` extended from 7 to 8 at that point. (See
  "late-turn additions" for the subsequent Russian + Persian bump to
  10 total.)
- **Language switcher → ISO pills.** Flags were considered and rejected:
  US-flag-for-English is Anglocentric for users in the UK / Australia /
  India; Spain-flag-for-Spanish is colonial-feeling for Latin American
  users; CN-flag-for-Mandarin is actively offensive in Taiwan. ISO pills
  (EN / ES / DE / PL / FR / IT / RU / FA / CN / HK) sidestep the whole
  issue. Each pill renders as a small gradient chip with the uppercase
  locale suffix — compact enough to fit in the top-nav next to the
  native name.
- **FAQ share button** on every open entry. Copies a canonical
  `/faq?q=<key>&lang=<code>` URL to the clipboard (with Web Share API
  fallback on mobile). The receiving FAQ route handles both the new
  `?q=` format and the legacy `#key` hash format; if the shared URL
  specifies a `lang`, the FAQ route auto-switches locale on load so the
  recipient sees the entry in the sender's language. Designed for the
  Matrix admin workflow: an operator can paste a link answering a
  repeat question rather than retyping the answer.
- **Three new FAQ entries**:
  - `video_tutorial` — answers "Is there a video tutorial?" by linking
    to blurt.media (PeerTube) rather than embedding. Embeds were
    considered and rejected: a PeerTube iframe would expose the
    viewer's IP to other peers in the P2P swarm, which is at odds
    with Morphit's privacy stance. The FAQ answer notes that a VPN or
    Tor Browser eliminates the trade-off.
  - `use_vpn` — recommends Mullvad (mullvad.net), notes they accept
    Monero payment.
  - `activity_level` — placeholder entry acknowledging that live
    statistics (trades completed, active users) need the Phase 3
    indexer. Includes a pointer for power users to count on-chain ops
    directly via `custom_json` with id `morphit_order_v1`.
- **Bug fixes during Phase 2 review:**
  - `BlurtClient` no longer caches a stale rotator reference. When the
    user edits endpoints in Settings (calls `refreshRotator()`), the
    client picks up the new rotator on the next call automatically.
  - `beforeNavigate` guard in onboarding no longer has a dead branch
    and correctly exempts same-page URL changes (FAQ deep-linking
    etc.) from the "are you sure?" dialog.
  - Hardcoded English error message in `broadcastProfile` is gone.
    `BroadcastError` class with stable codes (`no_account`, `locked`)
    maps cleanly to localized strings in Settings UI across all 8
    locales.

### SEO / crawler-friendliness (follow-on turn, now complete)

Ships under ADR-0003 (`docs/adr/0003-seo-policy.md`). Summary:

- **Per-route metadata.** A new `<Head />` component in
  `$components/Head.svelte` emits localized `<title>`, `<meta
  description>`, Open Graph, Twitter Card, canonical URL, and hreflang
  alternates for every supported language. Each route page pulls in
  `<Head routeKey="…">` with its key; i18n provides the localized
  title/description from `seo.<key>.*` in every locale file.
- **JSON-LD structured data.** The home page emits `Organization` +
  `WebSite` (with `SearchAction` — this is the lever that unlocks
  Google's sitelinks search box, which will search Morphit's FAQ
  directly from SERPs). The FAQ page emits a locale-reactive
  `FAQPage` schema with every entry as a `Question` node. This is
  what makes FAQ answers eligible for rich-snippet display in Google
  results.
- **Sitemap.** `scripts/build-sitemap.mjs` generates a full localized
  sitemap at build time (via an `npm run prebuild` hook). 70 URLs =
  7 indexable routes × 10 locales, each with `xhtml:link rel="alternate"
  hreflang="…"` entries for every locale plus `x-default` pointing
  at the English canonical. Written to `static/sitemap.xml`.
- **`robots.txt`.** Permissive per ADR-0003. Disallows only the
  recovery flow (`/onboarding/import`) and the per-user settings page
  (`/settings`). Points at the sitemap. No special scraper-class
  rules; Morphit's content is AGPL-3 and open to every reader.
- **Open Graph hero image.** `static/og-image.svg` — 1200×630 branded
  social card with the Morphit gradient, wordmark, coin badges
  (Bitcoin / Monero / BLURT), and network reachability list (clearnet
  / Tor / Lokinet / I2P). Rendered by Twitter, Mastodon, Matrix, and
  Discord link previews. SVG is fine for modern platforms; Phase 5
  adds a PNG fallback for aggregators that don't support SVG OG
  images (X/Twitter specifically).
- **Canonical + hreflang helpers.** `$seo/urls.ts` centralises the
  canonical origin (`morphit.io`) and hreflang-alternate generation;
  `$seo/routes.ts` is the single route registry consumed by both
  the `<Head />` component and the sitemap builder.
- **`<html lang>` + `dir` sync.** `hooks.client.ts` subscribes to
  `currentLocale` and mirrors the value onto `document.documentElement.lang`
  and `.dir` (from the locale's `rtl` flag). 9 of the 10 current
  locales are LTR; Persian (fa) is the first RTL locale and the
  infrastructure handles it correctly end-to-end. The invariant is
  also in place for future Arabic / Hebrew / Urdu locales.
- **Semantic HTML.** Every route has exactly one `<h1>`. Landmarks
  (`<header>`, `<main>`, `<nav>`, `<footer>`) were already in place
  from Phase 1 and were not disturbed.

SEO keyword clusters woven into the meta descriptions (see ADR-0003):
"peer-to-peer bitcoin exchange no kyc", "non-custodial monero trading",
"private crypto marketplace", "buy monero with cash", "decentralized
fiat to bitcoin", "localbitcoins alternative", "localmonero
alternative", "haveno alternative", "censorship-resistant bitcoin
exchange", "sell bitcoin without ID", "sell monero anonymously".

### Late-turn additions (Russian, Persian + RTL, prices, smooth scroll)

These shipped in the last Phase-2 working turn, after SEO closed.

- **Russian locale** (`ru`) — full 239-key translation. LTR, no
  structural changes needed beyond the usual translation.
- **Persian locale** (`fa`) — full 239-key translation. First RTL
  locale in the project. `SUPPORTED_LOCALES` entry has `rtl: true`;
  `hooks.client.ts` mirrors both `document.documentElement.lang` and
  `.dir` on every locale change (subscribing to `currentLocale`).
- **Persian RTL pass across UI components:**
  - `IdentityLabel.svelte` wraps the BLT fingerprint in `<bdi
    class="ltr-in-rtl">` so `(BLT7gHu…A9bb)` renders in the correct
    left-to-right direction even inside Persian prose. Without this,
    bidi reordering corrupts the parenthesised key visually.
  - Physical CSS properties converted to logical equivalents across
    `CryptoAddressInput` (right-3 → end-3), `FaqSearch` (left-4 →
    start-4, pl-12/pr-4 → ps-12/pe-4, left-0 right-0 → inset-x-0,
    text-left → text-start, ml-2 → ms-2), `LanguageSwitcher`
    (right-0 → end-0, origin-top-right → ltr:/rtl: pair),
    `IdentityLabel` (ml-0.5/ml-1.5 → ms-0.5/ms-1.5), `+layout.svelte`
    (focus:left-4 → focus:start-4), `onboarding/import` (file:mr-4
    → file:me-4).
  - `app.css` gets RTL helpers: `.auto-dir` (`unicode-bidi: plaintext`)
    for inputs whose direction should be sniffed from content, and
    `.ltr-in-rtl` (used by `IdentityLabel`) for Latin-script
    technical identifiers embedded in RTL prose.
- **Locale lazy-loading.** Already correct via
  `register(locale, () => import('./locales/X.json'))` — Vite
  code-splits each locale JSON into its own chunk. The client only
  fetches `en.json` by default; switching to Russian or Persian
  lazy-loads the relevant bundle on demand. Phase 3 can add
  `<link rel="modulepreload">` hints for the user's
  `navigator.language`-preferred locale to cut perceived switch
  latency, if desired.
- **Prices module** (`$lib/prices/`) — provider-swappable price feed
  interface. Ships with `fallbackProvider` as the Phase 2 default,
  returning hardcoded values (BTC $95k, XMR $180, BLURT $0.002 per
  Plan v1.3). A reactive `priceStore` Svelte readable lets UI subscribe
  to the latest quote per symbol. `getPrice`, `usdToSymbolAmount`, and
  `symbolAmountToUsd` compose with a 60s in-memory cache. Phase 3
  swaps in real providers (see ADR-0004) with a single
  `setProvider()` call — no consumer code changes.
- **`PriceFreshnessIndicator.svelte`** — small "prices updated N ago"
  chip that color-codes by staleness: green <60s, amber <10 min, red
  beyond. A 1Hz self-ticker updates the elapsed label without
  re-fetching. The current provider name appears in the hover
  tooltip (via the `source` field on the quote). 6 new i18n keys
  under `prices.*` translated to all 10 locales.
- **ADR-0004 — Price feed architecture** filed at
  `docs/adr/0004-price-feeds.md`. Documents all three candidate
  architectures (direct client CG+CMC, `morphit.io/api/prices`
  relay endpoint, on-chain `morphit_price_v1` oracle) with
  pros/cons and a recommended Phase 3 default. Phase 2's
  hardcoded-fallback provider is a conscious placeholder, not
  a shortcut.
- **Smooth scroll — anchor-only, motion-aware.** `app.css` gets
  `scroll-padding-top: 5rem` so a deep-linked FAQ entry doesn't
  hide under the sticky nav. No global `scroll-behavior: smooth` —
  only an opt-in `[data-anchor-scroll]` class that the FAQ
  components set on their scroll container. The existing global
  `@media (prefers-reduced-motion: reduce)` rule stays authoritative:
  users who opt out of motion get native-instant jumps regardless of
  the opt-in class.

### Phase-1 carry-forward items closed

| # | Item | Outcome |
|---|---|---|
| 1 | BIP-39 mnemonic | Closed — @scure/bip39 |
| 2 | $stores/identity.ts | Closed |
| 3 | `beforeNavigate` guard | Closed |
| 4 | CONTRIBUTING.md + ADR template | Closed |
| 5 | Confirm-3-random-seed-words | Closed |
| 13 | morphit_profile_v1 op + Settings wiring | Closed (awaiting account registration to actually broadcast) |
| 20 | Endpoint-rotation client | Closed |
| 21 | Update UI banner | Closed |
| 24 | Settings → forget-addresses | Closed |

## Carry-forward to Phase 3+

Status column updated 2026-04-18 when the user confirmed operator-action
prerequisites complete (Blurt accounts registered, Matrix room created,
BTC/XMR wallets ready). See ADR-0005 for the Phase 3 subphase split.

| # | Item | Target | Severity | Status |
|---|------|--------|----------|--------|
| P2-1 | Register `morphit` and `morphit-relay` Blurt accounts. Replace placeholders in `$net/config.ts`. | pre-3a | Blocking | **Closed** — both accounts exist on Blurt mainnet as of 2026-04-18. `$net/config.ts` updated to real names + pinned `@morphit` posting pubkey `BLT6CVC…eMp9` for release-discovery op verification. |
| P2-2 | Posting relay service (Go). Exposes an account-creation endpoint accepting owner-signed ops and paying RCs. Required for first-time registration flow. | 3a | High | Scheduled for 3a |
| P2-3 | Account-registration UI. Collects desired Blurt account name, checks availability, hands an owner-signed op to the relay, stores the name locally, enables on-chain broadcasts. | 3a | High | Scheduled for 3a |
| P2-4 | On-load fetch of `morphit_profile_v1` to populate the display name from chain on fresh sessions (single-source-of-truth read). | 3a | Medium | Scheduled for 3a |
| P2-5 | Indexer RSS endpoint + the rest of item #10 from Phase 1. | 3b | High | Scheduled for 3b |
| P2-6 | `morphit_order_v1` + `morphit_order_replace_v1` ops + broadcast UI + 3-min replace-window enforcement (ADR 0001). | 3c | High | Scheduled for 3c |
| P2-7 | Wire `useActiveKey` into the BLURT fee path (previously item #18). | 3c | High | Scheduled for 3c |
| P2-8 | The endpoint list that ships in the APK distribution (Phase 5) should prefer .onion / .loki / .b32.i2p aliases of the same physical nodes so the offline-reachability story is honored out-of-the-box. | 5 | Medium | still open |
| P2-9 | Threat-model note: `localStorage` for `morphit.blurtAccount`, `morphit.displayName`, `morphit.rpcEndpoints`, and the SHA-256 reuse sets are all unencrypted. A malicious local script (supply-chain or XSS) can enumerate them. Posting + memo privates are the only keys in memory; the scope of exposure from an XSS is bounded there. Add to SECURITY.md. | 3 | Low | **Closed** in Phase 2 via the SECURITY.md addendum |
| P2-10 | `test/` coverage for `endpoints.ts` (mock fetch, verify cooldown + failover priority). | 3 | Medium | Scheduled for 3a (arrives with first Go-side test harness) |
| P2-11 | `test/` coverage for BIP-39 round-trip (import exports a seed that re-imports to the same keys). | 3 | Medium | Scheduled for 3a |
| P2-12 | `test/` coverage for `broadcastCustomJson` and the dblurt signing boundary. Phase 2 depends on dblurt's API shape without an integration test; if a future dblurt release changes any signature it would only be caught at runtime. A single mocked round-trip test (build tx → sign → parse back → check the op body) would guard against this. | 3a | **Blocker** (upgraded 2026-04-18 — this turned out to be masking the curve bug below; real integration test required) | Open, linked to ADR-0007 |
| P2-13 | Live activity widget on the FAQ's `activity_level` entry — replace the placeholder copy with real counts once the Phase 3 indexer publishes a `/stats` endpoint. | 3b | Low | Scheduled for 3b |
| P2-14 | **New 2026-04-18**: Matrix room `#agorise:matrix.org` exists. Support-page "contact support" link should be updated from placeholder text to a real Matrix invitation URL. | 3a | Low | Scheduled for 3a |
| P2-15 | **New 2026-04-18**: BTC/XMR receiving wallets are generated. Phase 5 payment watcher will consume these; until then, no code change, but note in SECURITY.md that the hot-wallet seeds are held by the operator outside this repo and never touch the patch-handoff stream. | 5 | Medium | still open |
| P2-16 | **New 2026-04-18**: `keygen.ts` derives Ed25519 keypairs via libsodium; Blurt uses secp256k1. All Phase-2 on-chain-broadcast code paths were written against an incompatible curve and would have failed on first real RPC contact. Fix is to swap the keypair primitive to `@noble/secp256k1` while preserving the BIP-39 → BLAKE2b pipeline upstream. See ADR-0007. | 3a | **Blocker** | **Resolved 2026-04-18** — `deriveKeyForRole` now uses `secp256k1.getPublicKey()` with retry-on-out-of-range; new test `produces secp256k1-shaped keys` in `crypto.test.ts` pins 33-byte compressed pubkeys and 32-byte scalars. |
| P2-17 | **New 2026-04-18**: `apps/web/package.json` lists `"dblurt": "^0.2.3"` but the correct package is `@beblurt/dblurt`. The stated version doesn't resolve against the unscoped `dblurt` on npm, so `npm install` in the Phase-2 tree would have failed or installed an unintended package. See ADR-0007. | 3a | **Blocker** | **Resolved 2026-04-18** — `package.json` now lists `@beblurt/dblurt ^0.10.9` and `@noble/secp256k1 ^2.1.0`; `sign.ts` imports from `@beblurt/dblurt`. |

## Build / CI notes

- Two new npm deps: `@scure/bip39` (^1.4.0) and `dblurt` (^0.2.3). Both
  are publicly maintained, have type definitions, and bundle cleanly.
  Add `package-lock.json` to the repo at next `npm install`.
- CSP `connect-src` relaxed from `'self'` to include `https:` so the
  endpoint rotator can reach the community RPC pool. nginx config
  mirrors this at serve time.

**Phase 2 signs off.**
