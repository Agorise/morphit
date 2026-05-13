# Morphit — Plan v1.3 (Locked)

**Status**: locked 2026-04-16. Changes require an ADR (Architecture Decision
Record) in this directory.

> **2026-05-11 forward note (Part 120 audit):** Plan v1.3 is
> "locked," but Accepted ADRs in `docs/adr/` have since
> amended several specifics.  Where this doc and an ADR
> conflict, the ADR wins.  Specifically:
>
> - **Implementation language.**  This doc describes the relay
>   and indexer as "Go service" (§"Order book," §"Phase 3a,"
>   §"Phase 3b").  Both shipped as **Node.js/TypeScript**
>   services with `tsx` as the runtime.  See ARCHITECTURE.md
>   for the current topology + ADR-0008 (indexer architecture).
> - **Edit window.**  §"Immutability & fraud traps" already
>   carries the 15-minute window (per ADR-0001's 2026-05-07
>   amendment) but Phase 3c §"Order posting + enforcement"
>   still mentions "3-min replace-window."  15 minutes is
>   authoritative.  See `docs/adr/0001-custom-json-replacement.md`
>   Amendments.
> - **Nostr mirror.**  §"Order book" lists a "Secondary: Nostr
>   mirror" path.  This was never built; orderbook
>   distribution is via Blurt + federation gossip + SSE
>   streams.  See ARCHITECTURE.md.
> - **`REST + RSS`.**  Indexer exposes REST + **SSE** buses,
>   not RSS feeds.
> - **Payment-watcher.**  §"Origin decoupling" lists "payment-
>   watcher SSE" as a runtime data endpoint.  There is no
>   separate payment-watcher service; fee verification runs
>   inside the indexer process (`bitcoinExplorerVerifier.ts`,
>   `moneroProofVerifier.ts`).  See ARCHITECTURE.md "Fee
>   verification" subsection.
> - **`account_create_with_delegation` mechanism.**  §"Phase 3a"
>   describes inline-pay account creation.  Shipped uses
>   `create_claimed_account` consuming pre-minted ACTs per
>   ADR-0010 §4.
>
> This file is preserved as the historical plan-of-record;
> ADRs in `docs/adr/` and the runtime docs (ARCHITECTURE.md,
> OPERATIONS.md, FEES-AND-REWARDS.md) carry current truth.

## Brand

- Wordmark: `apps/web/static/brand/morphit-wordmark.svg`
- Round mark: `apps/web/static/brand/morphit-mark.svg`
- Typeface: **Nunito** (SIL OFL) — self-hosted, subsetted
- Palette: gradient `#8EEF26 → #00DA69 → #02A6B2`, accent `#7FED2D`

## Reach

Clearnet (morphit.io), vanity v3 .onion, vanity .loki, vanity .b32.i2p. Same
codebase, four endpoints, per-vhost CSP.

## Core principles (non-negotiable)

1. Non-custodial — operators never touch user trade funds
2. No KYC — keypair = identity, no email / phone / name
3. Grandma-friendly — 5-second comprehension rule
4. Perfect Forward Secrecy wherever secrets exchanged
5. Self-healing — multi-mirror, automatic failover
6. FOSS core — indexer, relay, bot all open-source
7. **Keys never leave the device** — client-side crypto only

## Identity

- In-browser keygen (WebCrypto + libsodium)
- Mandatory backup (seed phrase + encrypted keyfile)
- Two paths: *Build Reputation* (persistent) or *Maximum Anonymity* (fresh
  key per trade, no reputation)
- Blurt account creation atomic with first listing fee
- BLURT-denominated invite vouchers
- **No 2FA. No biometrics.** Password-encrypted keystore only.

### Display name (editable) vs. key identity (permanent)

- **Key identity is the permanent, unspoofable anchor.** Users are always
  shown as `<display name> (BLT7gHu8mn…A9bb)` — the truncated **posting**
  public key is the authoritative part, rendered in a monospace font next
  to the display name so it can't be forged or visually confused.
- **Display name is a human-readable label** the user can change at any
  time via a signed `morphit_profile_v1` `custom_json` op. The op carries
  the new display name; the indexer treats the latest signed profile op
  as current. Older names remain on chain (auditable history).
- **Display names have no uniqueness guarantee** — two users can both call
  themselves "Sally Doe"; the key disambiguates them. This is explicitly
  documented in the UI to prevent social-engineering confusion.
- **Length:** display name is capped at 40 characters, must be printable
  Unicode, cannot contain control characters, zero-width joiners, or
  bidirectional-override codepoints (all of which enable spoofing).
- **No moderation, no registry.** Morphit operators never curate or
  reserve names; doing so would mean operators ranking users, which
  contradicts the non-custodial principle.

## Order book

- Primary: Blurt `custom_json`, user-signed
- Secondary: Nostr mirror (indexer-managed keypair, no user action)
- Posting relay: FOSS, pays RCs, broadcasts signed ops; multi-endpoint failover
- Indexer: FOSS Go service, uses public Blurt RPC pool
  (`rpc.blurt.blog`, `blurt-rpc.saboin.com`, `rpc.beblurt.com`) with rotation;
  exposes REST + RSS; gossips with peer indexers
- No local Blurt full node in v1

## Immutability & fraud traps

**Important: `custom_json` ops are not mutable at the Blurt protocol level.**
"Edits" in Morphit are implemented at layer 2 by posting a signed
`morphit_order_replace_v1` op that references the original order's `id`.
Indexers treat the latest replacement (by on-chain timestamp, signed by the
same account) as canonical **only if posted within the edit window**.
Replacements posted after the window are ignored by conforming indexers.
Both the original and the replacement remain on chain forever, so history
is auditable.

- Orders: replaceable only while `open` AND **<15 minutes since post**
- Lock on `negotiating` regardless of clock (the first counterparty
  expression of interest closes the window)
- Feedback: never replaceable (no `morphit_feedback_replace_v1` op exists)
- Chat: tamper-evident (each message AEAD-authenticated under
  a per-message key; sender-bound by the chain transaction
  signature)
- **Anti-sybil fee escalation** (per 24h per Blurt account):
  - Orders 1–3: standard $0.25
  - Orders 4–10: +25% each successive
  - Orders 11+: +50% each
  - Resets when old orders cancel / expire
- **Self-trade detection**: indexer correlates fee-payment patterns and
  account timing; flagged pairs' feedback weighted to zero, marked publicly
- **Account age** displayed prominently on profiles

### Rationale for the 15-minute edit window

The original ADR-0001 chose 3 minutes specifically to close a
bait-and-switch attack window: a seller could post favorable
terms, wait for an interested buyer to DM, then silently replace
the terms with worse ones during "negotiation." Three minutes
was claimed to be long enough to fix a typo and short enough
that no realistic trade conversation has begun.

In pre-launch Sally walkthroughs the 3-minute figure proved
punishing: a user who steps away from the keyboard for ~4
minutes after posting and then notices a typo has no recovery
except cancel-and-repost (paying another listing fee). The
threat-model re-analysis in ADR-0001's 2026-05-07 amendment
showed the bait-and-switch attack is bounded by two structural
mitigations independent of window length: (a) trade-side
commitment requires a separate Blurt broadcast and renders the
order-version hash inline, so a switched listing is visible at
commitment, (b) every replace leaves a permanent on-chain audit
trail, so a switch-after-DM is forensically detectable and
reputationally costly under the feedback system. The window
was extended to 15 minutes for the typo-fix case while
documenting the reduced (but still present) bait-and-switch
asymmetry.

The full amendment lives in
`docs/adr/0001-custom-json-replacement.md` "Amendments →
2026-05-07."

## Trade lifecycle

States: `open → negotiating → in_progress → completed | cancelled | expired`

- Default orderbook-visible: **14 days** (user-adjustable 1–30)
- Default in-progress payment: **5 days** (user-adjustable 1–14)
- Optional business-hours mode pauses payment timer on weekends / holidays
- One mutual extension per trade via countersigned op

## Assets & fees

### Cryptos (all pairs tradeable)

- BTC
- XMR
- BLURT

### Fiat methods (20, fixed list)

1. Cash in person
2. Cash by mail
3. National bank transfer
4. SEPA (EU)
5. SWIFT (international wire)
6. PayPal
7. Wise
8. Revolut
9. Zelle (US)
10. Venmo (US)
11. CashApp (US/UK)
12. MoneyGram
13. Western Union
14. Bitso (MX / LatAm)
15. Gift cards (Amazon, Steam, etc.)
16. Mobile money (M-Pesa, etc.)
17. Alipay (CN)
18. WeChat Pay (CN)
19. UnionPay (CN / Asia)
20. Other — discuss in chat

### Monetization

- Standard listing: **$0.25 USD-equivalent**
- **BLURT discount: 50% off** when fee paid in BLURT
- Featured bump: dynamic auction (floor-above-next), cheapest in BLURT
- BLURT/USD price: klingex.io primary, **$0.002 hardcoded fallback**, labeled
  `live` vs `fallback` in UI
- No donations page, no paid support tier

## Payment UX

- BLURT: ~6s spinner, instant feel
- BTC: 1 confirmation (~10 min); on-chain only
- XMR: 1 confirmation (~2 min); no zero-conf
- All flows: human-readable status, elapsed time, dismissible
  ("come back later"); notification on confirm

## Receiving-address policy

When a user is asked to enter their own BTC or XMR receiving address (as
part of an order where someone will be paying them):

- **BTC**: we accept P2PKH (1…), P2SH (3…), SegWit v0 (bc1…), and
  Taproot (bc1p…). All mainnet formats are treated equally by validation;
  the UI surfaces the detected type as a small badge. Testnet,
  signet, and regtest addresses are rejected.
- **BTC — fresh-address recommendation**: the client warns (soft — does
  not block) if the user enters an address they've used in a past order.
  Reuse tracking is local-only: SHA-256 hashes of past addresses live in
  localStorage, keyed by currency. The rationale is shown inline via a
  Tooltip linked to the `why_fresh_addresses` FAQ entry.
- **XMR**: **subaddresses only** (prefix `8`, length 95 chars, mainnet).
  Standard addresses (prefix `4`, length 95) are rejected with a specific
  error message explaining that subaddresses are Monero's modern privacy
  default. Integrated addresses (prefix `4`, length 106) are also
  rejected — they pre-date subaddresses and have been superseded. This
  is a hard block, not a soft warning, because the privacy delta is
  large and the UX cost of pasting a subaddress is zero.
- **Rotating placeholder text**: the address input cycles through
  3 short nudges in the active locale ("Paste a fresh BTC address" →
  "Use a new address for each trade" → "Never reuse addresses — it hurts
  your privacy"), pausing while the field is focused or typed into.
- **On-blur validation**: invalid addresses show a locale-specific error
  inline with a red border; reused addresses show an amber soft warning;
  valid addresses show a green border and a small badge indicating the
  type (Legacy / P2SH / SegWit / Taproot / Subaddress).
- **No address phoned home.** Validation is pure-TS, runs entirely in
  the browser, and never touches the network. Reuse memory lives in
  localStorage as SHA-256 hashes, never as plaintext addresses.

## Chat (private, persistent, partial PFS)

- X25519 + ChaCha20-Poly1305 ECIES (libsodium); see ADR-0015
- Per-message sender ephemerals (one-sided forward secrecy)
- Long-term chat identity derived from posting key (BLAKE2b)
- Ciphertext on Blurt, decryption local only
- Full decrypted history available to participants
- AEAD MAC makes tampering detectable
- NO per-message receiver-key rotation (deliberate; full
  rationale in ADR-0015 and FAQ)

## Feedback & reputation

- Signed feedback op on Blurt per trade, includes `role: buyer | seller`
- Profile displays: total trades, positive/negative by role, account age,
  first-seen, response-time avg, BLURT stake (opt-in)
- Response to feedback supported, never editable after posting
- Self-trade flagged pairs weighted to zero

## Escrow

- **none — ever**. Morphit is a pure bulletin board with reputation as
  safety. We will never offer escrow, multisig, or arbitration of any
  kind. Reintroducing custody at any layer would reintroduce the
  middleman the project exists to remove.

## Assets & media

- Icons (flags, currency, method): bundled SVGs, SVGO-optimized, zero network
- Avatars: ordered URL list + SHA-256 hash in Blurt profile; client verifies
  hash, falls back through list, then to deterministic identicon
- SVG avatar "pro mode": power users store tiny SVG directly in `custom_json`

## Unstoppability

- Fully static frontend (SvelteKit SSG)
- Multi-mirror by default, automatic failover
- PWA + service worker cache (installed app survives host outages)
- IPFS release mirror (IPNS address)
- APK / Flatpak / signed tarball distribution
- Blurt `custom_json` release-discovery op (metadata only — version + IPFS
  CID + mirror list)
- RSS consumable independent of frontend
- Two-way indexer gossip
- Four parallel network transports

### Origin decoupling (applies to PWA and APK alike)

Once a Morphit client is installed — whether as a PWA from `morphit.io` or
as an APK / F-Droid package — it never depends on `morphit.io` again:

- **Every static asset** (HTML, JS, CSS, fonts, icons, locale bundles) is
  precached by the service worker on install. The running app has zero
  origin dependency for rendering.
- **Data endpoints** (indexer REST / RSS, relay, payment-watcher SSE) come
  from an in-app configurable endpoint list, seeded with several
  community-run indexers and refreshable from the Blurt release-discovery
  op. `morphit.io` may be one of many entries and is not privileged.
- **Update policy** is pin-on-install. A new release is fetched and
  precached into a new versioned cache, but the running app continues to
  serve from the current one until the user consents to switch. This
  prevents a compromised edge host from silently replacing the bundle.

The design implication: the APK / Flatpak distribution (Phase 5) is
structurally the same app — it just arrives via a different channel.
`morphit.io` is a distribution convenience, not a runtime dependency.

## No-JS & performance

- **No-JS read-only** mode: browse orders, profiles, feedback (SSG HTML)
- JS required for trading (client-side crypto only, never escapes browser)
- Zero third-party JS, zero analytics, zero tracking, zero cookies, no logs
- Optional **Privacy Mode**: sessionStorage only, service worker off
- Budget:
  - &lt;100KB gzipped JS for trading paths
  - &lt;20KB gzipped CSS
  - Nunito subset ~25KB/weight
  - CJK loaded on demand for Mandarin / Cantonese
  - WebP / AVIF with PNG fallback, lazy-loaded
  - Brotli + gzip pre-compressed static assets
  - Low-data mode toggle (no avatars, batched requests)
- Tested on simulated 2G + old Android WebView

## FAQ

- **Searchable with auto-complete**, multilingual (all 10 languages)
- **Tooltips across the UI deep-link to matching FAQ entries**, multilingual
- Mandatory topics:
  - What is Morphit?
  - Is it safe?
  - What do I need to sign up?
  - How do I buy / sell crypto?
  - What are the fees? (incl. BLURT discount)
  - Order timeouts (14-day default, 5-day payment, 3-min replace lock,
    weekend pause option)
  - Order editing (3-min replace window via layer-2 replacement op,
    locked on negotiation, chain keeps full history of both ops)
  - Chat privacy (E2E encrypted via per-message ECIES; sender-side
    forward secrecy; never decryptable by Morphit)
  - Feedback immutability (no edits, response allowed)
  - What data does Morphit collect? (none)
  - Lost keys / password (unrecoverable — non-custody tradeoff)
  - What is BLURT? (+ link to klingex.io)
  - Troubleshooting
  - Who runs this?

## Languages (at launch)

English (default), Spanish, German, Polish, French, Italian, Russian,
Persian, Mandarin, Cantonese.
JSON bundles, lazy-loaded per language, instant live switch.

## Support

- Matrix bot bridges in-app widget ↔ private Matrix room
- Admin replies from any Matrix client (Element, Cinny, FluffyChat, etc.)
- Zabbix monitors infra separately, alerts to Matrix

## Tech stack (locked)

- **Frontend**: SvelteKit (SSG), Tailwind CSS, svelte-i18n
- **Backend services** (Go, single-binary):
  - `morphit-indexer` — Blurt/Nostr → PostgreSQL → REST + RSS
  - `morphit-relay` — signed-op broadcast
  - `morphit-payment-watcher` — BTC/XMR/BLURT address monitoring
  - `morphit-avatar-server` — static + upload + resize
- **Support bot**: Python
- **Database**: PostgreSQL 16
- **Crypto libs**: libsodium (chat AEAD + keystore), blurt-js, bitcoinjs-lib,
  monero-js (address validation only — never custody)
- **Reverse proxy**: nginx (four vhosts: clearnet + Tor + Lokinet + I2P)
- **Hidden-service daemons**: Tor (v3), Lokinet, i2pd
- **CI**: Forgejo Actions (lint + test + reproducible build)

## VPS

- 4 cores / 8 GB RAM / 80 GB SSD / Ubuntu 24.04 LTS
- WireGuard mesh for inter-service comms
- Unprivileged systemd units per service, each in its own directory
- Only 80/443 + hidden-service ports exposed publicly
- fail2ban + crowdsec on edge, **no IP logging anywhere**
- Nightly encrypted PostgreSQL dumps
- Reproducible builds where possible

### Questions for VPS provider

1. Does my VPS have a dedicated public IPv4, or am I behind CGNAT / NAT?
2. Are any inbound ports blocked by default? I need 80, 443, and custom
   TCP/UDP ports.
3. Do you support reverse DNS (PTR) changes?
4. Is IPv6 provisioned with a routed subnet?

### Answers (Agorise primary operator, confirmed 2026-04-20)

1. Dedicated public IPv4 — **Yes.** No CGNAT; inbound reachability is
   unobstructed. Clearnet users can connect directly; Tor/Lokinet/I2P
   hidden services reverse-proxy cleanly to local sockets.
2. Inbound port policy — **No defaults blocked.** 80, 443, and the
   custom TCP/UDP ports needed for the relay and indexer will land
   without provider-side intervention.
3. Reverse DNS (PTR) — **Yes**, operator can set PTR to match the
   forward record. Useful for legitimacy signals on any outbound
   connection and for future email (operator notifications) if we
   ever add it.
4. Routed IPv6 subnet — **Yes.** Operator can assign distinct v6
   addresses per service if useful; IPv6-first futures are available.

No deployment blockers. Proceed from `docs/OPERATIONS.md`.

## Vanity hidden-network addresses

Generated on operator hardware, keys never transmitted:

- Tor v3 `morphit…`: `mkp224o`
- Lokinet `morphit.loki`: `lokinet-vanity`
- I2P `morphit…b32.i2p`: i2pd / `eepgen`

## Development phases

1. **Phase 1** (complete): repo, SvelteKit shell, Nunito design system,
   i18n (10 languages), keygen + backup, searchable FAQ, no-JS read-only
   paths, CSP / SRI / reproducible-build scaffolding
2. **Phase 2** (complete): BIP-39 mnemonic, session identity store,
   endpoint-rotation client, Blurt chain read + sign client, profile-op
   broadcast, onboarding confirm-seed step, update banner, Italian /
   Russian / Persian locales (Persian adds first-class RTL support),
   ISO-pill language switcher, lazy-loaded locale bundles, FAQ share
   links, SEO foundations, provider-swappable price feeds with
   hardcoded fallback + "prices updated X ago" UI indicator (ADR-0004)
3. **Phase 3 — Relay, indexer, orderbook.** Split into three subphases,
   each shipping a standalone tarball so progress is testable as it
   lands rather than at the end:
   - **3a (this subphase): Posting relay + account creation.** Go
     relay service (`apps/relay/`) that accepts owner-signed
     `account_create_with_delegation` ops from clients and pays the
     Blurt RC cost. Client-side account-registration UI that checks
     name availability, collects a chosen account name, signs locally
     with the user's owner key via `useOwnerKey()`, hands the signed
     op to the relay, and stores the confirmed account name on success.
     First real on-chain flow: a new user onboards and ends up with
     a Blurt account without ever touching a third-party service.
     Display-name broadcast (Phase 2's `morphit_profile_v1` path) now
     works end-to-end because the `morphit` account exists and posts
     discovery ops the client can read.
   - **3b: Indexer + orderbook read.** Go indexer service
     (`apps/indexer/`) that streams the Blurt chain, keeps a Postgres
     table of `morphit_order_v1` / `morphit_order_replace_v1` /
     `morphit_order_cancel_v1` ops, exposes REST + RSS endpoints with the
     full filter set promised in the `rss_feeds` FAQ entry
     (pair / side / location / method / min_rep / min_age /
     max_deviation), and gossips with peer indexers. SvelteKit
     orderbook route reads live data and renders filterable
     results. Users can browse real offers even before posting is
     wired up. Includes a self-hosting guide
     (`docs/self-hosting/indexer.md`) per Phase 1 carry-forward #11.
   - **3c: Order posting + enforcement.** Client-side order compose
     UI, `morphit_order_v1` + `morphit_order_replace_v1` ops, 3-min
     replace-window enforcement at the indexer (ADR-0001), sybil fee
     logic (escalating-per-24h), self-trade detection, optional
     featured-slot auction. JIT `useActiveKey()` wired into the
     BLURT fee path. Users can post an order and someone else can
     see it. End of this subphase: Morphit has a functional,
     minimum-viable P2P orderbook visible across multiple
     community-run indexer instances.
4. **Phase 4**: encrypted chat, feedback with roles, reputation display,
   attack-surface log
5. **Phase 5**: payment flow (BTC / XMR / BLURT), featured-bump auction,
   payment watcher, Matrix bot, Zabbix monitoring, Tor / Lokinet / I2P
   vhosts, IPFS release pipeline, APK / Flatpak, klingex research,
   WhaleVault / Gravity browser-extension signing path

## Operator action items (outside this repo)

Completed (as of Phase 3 kickoff):
- ✓ Register `morphit` + `morphit-relay` on Blurt — keys stay with operator
- ✓ Create Matrix admin account + `#agorise:matrix.org` community room
- ✓ Generate BTC / XMR receiving wallets

Still outstanding:
- SSH access to Forgejo (Phase 3 workflow improvement; patch
  handoff continues via tarballs until this is resolved)
- VPS provider questions (Plan §342 — noisy-neighbor, IP history,
  Tor exit-node policy, censorship-takedown history)

## Change control

Changes to this plan require a numbered ADR in `docs/adr/NNNN-title.md`,
referencing which section of Plan v1.3 is being amended and why.
