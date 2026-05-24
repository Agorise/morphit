# Morphit v1.0.0-beta.1

First public beta of Morphit — a federated, non-custodial, no-KYC peer-to-peer
marketplace for fiat ↔ BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE,
ZEC, ARRR, DCR, SOL, ETH, and XRP trades.

This release is for community operators who want to stand up an early
instance and for beta testers to try real trades on morphit.io.

## Install

See `docs/RUN-A-MORPHIT-NODE.md`.  ~30 minutes on a $5/mo VPS.

For the day-zero procedure (the morning-of and first-24-hour
operator runbook) see `docs/LAUNCH-DAY.md`.

For ongoing day-1-through-day-7 monitoring see
`docs/POST-LAUNCH-WEEK-ONE.md`.

## Verify the download

    sha256sum -c morphit-v1.0.0-beta.1.tar.gz.sha256

For belt-and-braces, see `docs/UPGRADING.md` "Belt-and-braces verification"
— it walks you through cloning the repo separately, running
`git tag -v v1.0.0-beta.1`, and re-deriving the manifest from a
clean checkout to compare against the tarball you downloaded.

## What's in the beta

This is the first public release.  Everything listed below is
shipped, smoke-tested, and source-verifiable against the tagged
commit.  For the exhaustive claim-by-claim breakdown, read
`MORPHIT-BRAG-LIST.md`.

### Trading

- Sixteen tradable assets out of the box: **BTC, XMR, BLURT, USDT, USDC,
  DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP**.  Three —
  **BTC, XMR, BLURT** — are the original core; listing fees can be paid in
  any of them.  The other thirteen are trade-only (peer-to-peer trading
  supported; listing fees still settle in BTC/XMR/BLURT).  Each is enabled
  by default at the operator's instance and can be turned off per-ticker via
  `MORPHIT_INDEXER_DISABLED_ASSETS` or interactively at install time via the
  setup wizard's trade-only-policy step.
  - **EVM-multi-network stablecoins** (USDT, USDC, DAI) span four networks
    each (Ethereum / ERC-20, Tron / TRC-20, Solana / SPL, BNB Smart Chain /
    BEP-20 where applicable) with a no-default-network rule so users can't
    accidentally cross-send.  Amount-jitter at 6-decimal precision applies
    (cp30 reversal of the earlier USDT pass-through decision — Circle/Tether
    freeze power is documented per-asset as a separate, independently-real
    threat).
  - **UTXO chains** (BCH, LTC, DASH, DOGE) accept their canonical address
    families: LTC accepts all four forms (legacy P2PKH `L…`, modern P2SH
    `M…`, deprecated P2SH `3…`, bech32/bech32m `ltc1…`); DASH accepts both
    base58 forms (P2PKH `X…`, P2SH `7…`); BCH covers CashAddr and legacy;
    DOGE base58 (`D…`).  DASH ships with optional **PrivateSend** awareness
    — a chain-level masternode-coordinated CoinJoin variant — surfaced in
    the per-asset privacy guide; users pre-mix in their Dash wallet before
    sharing the address.
  - **Shielded chains** (ZEC, ARRR).  ZEC supports both transparent (`t1`/
    `t3`) and shielded (`zs1` Sapling, `u1` Unified Address) — pick per
    trade.  ARRR is shielded-by-construction (Sapling only; no transparent
    option exists at the chain layer).
  - **Hybrid PoW/PoS chain** (DCR — Decred) with Politeia-anchored
    governance documented in the per-asset guide.
  - **High-throughput / smart-contract chains** (SOL, ETH, XRP).  ETH
    addresses are EIP-55 mixed-case-checksum-validated; XRP supports
    destination tags and respects the 10-XRP base reserve.  Block-explorer
    health-probed at install time and re-probed on every address-share.
- Listing fees in **BLURT, BTC, or XMR** — choice belongs to the
  poster.  Default operator-treasury target is ~$0.12/order.
- **First buy of BLURT is fee-waived** — new users can post their
  first order without holding any BLURT.
- **Featured-slot auction** with a minimum-hours floor (prevents
  micro-bid sniping), per-bidder bid history, **outbid push
  notifications** (cp17), and **anti-snipe soft-close**
  (cp18 — expiring top-5 bids extend by 5 minutes when a new
  bid arrives within the snipe window, capped at 6 extensions /
  30 minutes total).

### Identity, signup, and chat

- **No KYC, no email, no phone, no IP logging.**  Signup is a
  posting public key plus a chosen username.
- **Account creation is free to the user.**  The operator's relay
  pre-mints Account Creation Tokens (ACTs) in a weekly batch
  ceremony at ~100 BLURT each and consumes one ACT per signup
  via fee-free `create_claimed_account`.  The user pays nothing.
- **End-to-end encrypted chat** with per-message ECIES (X25519 +
  ChaCha20-Poly1305-IETF, libsodium).  Sender ephemerals are
  wiped after one use.  Ciphertext is stored on-chain;
  the indexer cannot decrypt.  See `docs/adr/0015-chat-crypto.md`
  for the threat-model rationale (why no Double Ratchet).
- **Opt-in 8-word out-of-band fingerprint verification** for
  belt-and-suspenders MITM protection beyond the chain-anchored
  TOFU pin.  PGP word list, never BIP39 — deliberately distinct
  from seed phrases.
- **Desktop QR pairing** (ADR-0022) — paired-readonly desktop
  session, posting key stays on phone, all writes route through
  phone for signing.  WhatsApp-Web mental model.

### Notifications

- **Web Push subscriptions** (cp13–cp16, hardened cp131) for
  chat / feedback / outbid events.  VAPID-protected; subscribe
  AND unsubscribe both require a valid posting-key signature
  over a canonical message binding account-name + endpoint +
  timestamp.  The canonical message ACTION keyword
  (`subscribe` vs `unsubscribe`) is part of the signed payload,
  so a captured subscribe signature cannot be replayed as an
  unsubscribe (and vice-versa).  Captured signatures expire
  after 5 minutes and cannot be replayed across accounts or
  devices.  Operators set
  `MORPHIT_RELAY_PUSH_REQUIRE_SIGNED=true` to require
  signatures (the default for new deployments); permissive
  mode is available for legacy clients during roll-forward.
- **In-tab ambient channels** (title-bar badge, favicon dot,
  audio cue, vibration) work even without VAPID keys configured.

### Operator setup

- **Setup wizard** (`npx morphit-ops init`, ~18 prompts) covers
  treasury addresses (BTC + XMR), explorer URLs with live health
  probes, listing-fee USD target with live price recompute, VAPID
  keys for Web Push, operator-tag for federation cost attribution,
  and the trade-only asset policy (per-ticker enable/disable for
  every Category-B asset: USDT, USDC, DAI, BCH, LTC, DASH, DOGE,
  ZEC, ARRR, DCR, SOL, ETH, XRP).
- **Federated cost attribution** — each operator's relay pays only
  for ops that route through their own instance (operator tag
  registered on-chain via `morphit_operator_register_v1`).
- **Operator kill-switch** for compromise scenarios — relay-side
  flag disables signups and posts a banner pointing users at
  other instances.  See `docs/BETA-INCIDENT-RUNBOOK.md`.
- **Reproducible builds** — every tarball is rebuildable
  byte-for-byte from its tagged commit; bundle hashes are
  broadcast on-chain via `morphit_release_v1`.

### Privacy

- **No cookies, no analytics, no third-party CDN, no Cloudflare.**
- **No IP logging.**  The relay extracts client IP as an in-memory
  rate-limit bucket key and discards it when the window passes.
  The code carries this as a binding contract — adding IP logging
  would require an ADR and a security advisory.
- **XMR view-key privacy** — the operator's private view key is
  strictly env-only on their box, never published on-chain, in
  APIs, in logs, or in release ops.  Per-payment proofs are
  user-supplied at trade time.
- **Transparent-chain privacy framework (cp26 + cp30).**  Registry-driven
  per-asset privacy practices surface in the address-share modal
  and at `/[lang]/privacy/{asset}`:
  - **Amount-jitter on every transparent asset** (BTC, BCH, LTC, DASH,
    DOGE, ZEC transparent, DCR, BLURT — XMR has been jittered since cp3,
    and stablecoins USDT/USDC/DAI jitter at 6-decimal precision per cp30):
    default ON; adds a small random extra (≤999 sat for UTXO chains, ≤99
    milliblurt for BLURT, scaled per-asset for the others) to defeat
    amount-correlation between the orderbook post and the on-chain
    transfer.
  - **Client-side address-reuse warning**: localStorage-only,
    never transmitted to any Morphit server; surfaces an amber
    chip when the user is about to share an address they've
    shared from this device before.
  - **Optional PayJoin (BIP-78) endpoint for BTC**: when both
    seller and buyer wallets support BIP-78, the seller pastes
    their PayJoin endpoint URL into the BTC address-share modal
    and Morphit relays it via `pj=` in the `bitcoin:` URI.
    Wallets without PayJoin support fall back to a normal
    payment — zero footgun.
  - **Per-asset privacy guides** at `/[lang]/privacy/{asset}` for every
    tradable ticker, covering fresh-address practice, opt-in privacy
    tech (MWEB for LTC, CashFusion for BCH, PrivateSend for DASH,
    CoinJoin + PayJoin for BTC, Sapling/Orchard shielded sends for
    ZEC, shielded-by-default for ARRR, CoinShuffle++ for DCR),
    universal practices, and asset-specific caveats.  Registry-driven:
    the next asset Morphit adds gets a privacy guide automatically by
    populating one struct field.
  - **No wallet recommendations.**  Even reputable wallets have
    been compromised — Morphit names protocol standards, not
    wallet software.
- **DASH PrivateSend awareness (cp27).**  Dash's masternode-
  coordinated CoinJoin variant is documented in the per-asset
  privacy guide at `/privacy/dash`.  Pre-mixing happens
  entirely wallet-side BEFORE the address is shared on Morphit
  — Morphit does not coordinate the mix, hold the funds, or
  expose users to masternode-trust trade-offs beyond what their
  wallet already does.  The privacy guide explains the
  trade-offs honestly: anonymity set depends on simultaneous
  participants, and for the strongest privacy on Morphit XMR
  is still the right tool.

### Internationalization

- **10 languages**, fully translated: English, Spanish, French,
  German, Italian, Polish, Russian, Persian, Simplified Chinese,
  Traditional Chinese.
- **Per-locale prerendering** — 200 static HTML files (20 routes
  × 10 locales) so non-English speakers never see a flash of
  English content.

### Audit and integrity

- **Several thousand self-checking smoke scenarios** ship with
  the source — the exact count grows release-over-release as
  defenses are added.  Run them yourself: `bash scripts/run-smokes.sh`.
  Triple-pulse them (three times back-to-back) to filter flakes.
- **Audit log** in `docs/AUDIT-2026-05.md` (~25,400 lines), public
  in the repo, with every finding, every fix, every accepted
  risk documented.
- **41 architecture decision records** in `docs/adr/0001-…`
  through `0042-…` (the 0016 slot is reserved-but-unused; its
  planned work shipped as ADR-0022).
- **AGPL-3.0-only.**  Operators running modified instances must
  make their source available to their users.

## Reach

Morphit instances are reachable over the public web, Tor `.onion`
hidden services, I2P `.b32` addresses, Lokinet, and Nostr.  The
federation directory at `/instances` on any node shows the other
known instances and their alt-network addresses.

## Reporting issues

Bug reports: open a New Issue on Forgejo
(`git.agorise.net/agorise/morphit`) — the bug-report template
auto-loads with the fields needed.

**Security disclosures** go to the operator's Matrix DM channel
listed in §16 of the bug-report template (or in
`docs/SECURITY.md`).  Do NOT post security issues as public
Forgejo issues or in the community Matrix room.

## Acknowledgements

Built on Blurt for the chain layer.  The audit campaign is
publicly readable in this repo, and so are the design tradeoffs
— we made arguable calls, especially around chat-crypto
primitives, and the reasoning is in the ADRs for you to push
back on.

---

**Tag:** `v1.0.0-beta.1`
**Built by:** Forgejo Actions from a signed annotated tag (see
`.forgejo/workflows/release.yml`)
**License:** AGPL-3.0-only
