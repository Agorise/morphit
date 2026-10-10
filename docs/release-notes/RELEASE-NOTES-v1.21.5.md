# Morphit v1.21.5

A Tor/I2P-only server can now copy the federation snapshot from its peers over Tor/I2P, and a brand-new
one can fast-sync privately instead of replaying the whole chain. The site names only the coins its
operator accepts, the homepage invites visitors to make their first trades, the stats page's RPC card
shows each node's real state again, and the BETA marker is gone from the logo.

**Upgrading:** `sudo morphit-ops upgrade` on every server. No database change. morphit.io first: its
next anchored snapshot then names its .onion and .b32.i2p. **Every instance must run v1.21.1 or later
before 2026-11-01 00:00 UTC**, when the stricter consensus rules start.

## The federation snapshot over Tor/I2P

- **The mirror asks the federation.** v1.21.4's fallback looked for peers only in operator registrations
  in @morphit's history. That history holds none (all 169 entries read on morphit.io, 2026-10-10), so on
  morphitlat it asked nobody ("no federation peer's .onion or .b32.i2p address was found"). It now asks,
  in order: the publisher's own addresses from the signed snapshot record, this server's federation
  directory (the same list its upgrades use; the publisher's instance first), then any registration in
  that history. A peer that does not hold the snapshot answers at once.
- **The snapshot record names the publisher's hidden addresses.** `ops/pin-indexer-snapshot.sh` adds
  `hidden_mirrors` (this server's .onion and .b32.i2p, as its indexer advertises them at `/v1/instance`)
  to the indexer_snapshot_v1 record, under the same signature. A new server fast-syncs before it has an
  indexer, so this is where it learns a private source. Servers that do not know the field ignore it
  (checked against the v1.21.3 validator); a malformed one is dropped, and the publisher refuses to
  sign one.

## The site

- **Homepage.** The "Run your own Morphit site" card is replaced by a card that invites a visitor to sign
  in and make a first few trades: three steps, and on a site whose relay pays them, the three rewards (a
  free account, a free first buy, 10 BLURT + 10 Blurt Power after the first completed trade on a paid
  listing). Its border light, glows and heading sheen move slowly, use only the theme's colours (so a
  branded site re-tints it), and stop for visitors who ask for reduced motion. Someone who already has an
  account on the device is sent to post or browse instead of to sign up.
- **Orderbook.** The "What you get on Morphit" card is gone.
- **Run a node.** The "You automatically earn" and "Your relay account pays" boxes have the new wording
  (the Startup cost per new account, Blurt Power (BP), retractable rewards, the rule of thumb).
- **Download.** The Install, Source code & releases, Setup walkthrough and Join the federation cards are
  gone. The intro says you can "install" an instance with an "app" icon or run your own node and be listed
  in the Federation directory, with links. The Codeberg mirror says, in red, "Crypto projects banned".
  "Morphit is 100% free and open source."
- **Stats → RPC endpoints.** The card asks the indexer to ping every node, and the indexer answers only
  once the slowest has answered or timed out — up to about 42 seconds when an I2P node is slow or down
  (two tries of up to 20 seconds). The browser waited 8 seconds, gave up, and kept the pool's passive
  snapshot: "Probing…" for the hidden nodes, which the pool seldom calls, and stale figures for clearnet
  nodes it had not used lately. The browser now waits for the probe. (The reverse proxy's 60-second limit
  for `/v1/` is longer than the indexer's worst case; a new smoke holds the three numbers together.)
- **Footer.** The "Source" link under Resources is gone.
- **licenses.txt.** Now also lists Vite (its small lazy-loading helper is in every page's code; Vite's own
  MIT licence only, not those of the build tools it bundles) and the Comfortaa font with its SIL OFL text,
  and shows every source as a plain https link.
- **Security page.** "Look at the Network tab in your browser." The zero-clearnet, chat and release cards
  were checked against the code and rewritten:
  - Zero clearnet: the software refuses clearnet and a firewall lets only Tor and I2P out; package updates
    and the clock go over Tor too; the node moves to Tor bridges by itself. Fee checks and prices travel
    over Tor (not I2P). The claim is the node's own, made when its own checks pass.
  - Chat: the encryption (X25519 and ChaCha20-Poly1305) and sender proof as before, plus key pinning and
    the 60-digit safety number; and plainly what is public — messages live on the Blurt chain, so who,
    when, which order and each message's length are visible.
  - Releases: the git tag is GPG-signed on main; the record also anchors the offline bundle's hash; the
    browser reads it from a public Blurt node and names any file that differs.
  - The directory's "Zero use of clearnet internet" badge now says, on hover, that it is the instance's
    own claim.
- **Privacy & terms.** "your chat conversations stay 100% private"; "a VPN, Tor, I2P, ENS or Lokinet";
  the zero-clearnet paragraph corrected the same way (and "a marketplace node with no clearnet address to
  block").
- **About this instance.** The "BTC fee key" row is gone: it showed a short key id a visitor could not
  check against anything. (Which BTC address an order's fee goes to is still checked in the browser
  against the key @morphit pinned on chain.) The file count is the number of files verify.json lists —
  per site and per version — and the text now says exactly that.
- **The coins this site accepts.** An operator who switches coins off (`MORPHIT_INDEXER_DISABLED_ASSETS`)
  now sees that everywhere the site names coins:
  - the homepage carousel (a network appears only while an accepted coin settles on it; barter only when
    accepted; the two rows stay within one icon of each other);
  - the cheat sheet's asset list and the privacy guides' index;
  - the FAQ: the entries about a switched-off coin are left out (and from "Related"), and the answers that
    list the coins traded here ("What is Morphit?", "Where can I buy Blurt?", the welcome bonus, the
    stablecoin warnings, privacy coins) list this site's coins and count them.
- **Plan.** "Phase 7 — Cryptocurrency support", planned.
- **Logo.** The BETA marker is gone for good. `morphit-ops branding apply --beta` now says so and stops;
  a `MORPHIT_INSTANCE_BETA_BADGE` line left in `morphit.config.env` is ignored.

## Correction to the v1.21.4 notes

- They said the mirror asks "the publisher's own .onion and .b32.i2p (from its on-chain registration)".
  @morphit has no such registration, so it asked nobody.

## Documentation

- docs/SECURITY.md said the release job fails without the signing key. It publishes without `.asc` files
  then, and installed nodes accept the tarball only by its SHA-256 in @morphit's signed record.
- docs/VERIFY-YOUR-DOWNLOAD.md named three git hosts; the source is mirrored to many.

## Tests (maintainer)

- ops-cli tests can no longer reach the internet (test/setup/noInternet.ts), judged by the address a name
  resolves to (CI's database is the container `postgres`).
- The snapshot mirror's lookup of its own directory names itself (`user-agent`), like every indexer fetch.
