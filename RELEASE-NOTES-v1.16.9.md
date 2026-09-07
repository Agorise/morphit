# Morphit v1.16.9

**Installs and upgrades self-heal the reverse-proxy WAF, and hidden/offline
upgrades no longer need a hand-signed tarball.** This release closes a cluster of
real operator-reported issues — a JSON-API firewall that was 4xx-ing legitimate
avatar/order broadcasts, a warrant canary that wouldn't publish on a same-box
setup, and several UI papercuts — and hardens the BunkerWeb self-heal so an admin
never has to run a diagnostic for something the upgrade can detect and fix itself.

## Fixed

- **BunkerWeb WAF no longer blocks the JSON APIs — self-healed on upgrade, three
  ways.** Three independent BunkerWeb layers were rejecting a legitimate
  `POST /v1/broadcast` (e.g. an avatar upload): (1) `MAX_CLIENT_SIZE` defaulted
  below the ~8 KB broadcast body → **413**; (2) bad-behavior counted the routine
  `400`s a JSON API returns when it rejects an invalid/expired broadcast, banning
  the client IP → **403** on everything; (3) OWASP CRS false-positived on the
  base64 payload → **403**. The upgrade now self-heals all three: sets
  `MAX_CLIENT_SIZE=1m` (the relay's 64 KB stays the real cap), removes `400` from
  the bad-behavior triggers, and exempts `/v1/`+`/relay/` from ModSecurity. Each
  fix is applied more than one way (the ModSec exemption as both an env var *and*
  a mounted config file), the reload uses a fallback chain, and the result is
  **verified against the running container** — no admin diagnostics, no
  back-and-forth. Fresh installs get the same settings from the Ansible template.
- **Offline / hidden-only upgrades verify against the on-chain SHA-256 — no more
  hand-signing.** A zero-clearnet or air-gapped node can now apply an offline
  tarball by checking it against the release hash `@morphit` published on-chain
  (read from the node's own indexer over its hidden RPC), instead of requiring a
  hand-made GPG `.asc`. The release also anchors the `-offline` bundle's own
  `offline_sha256`, and `decideTrust` gained an `onchain-anchored-sha256` proof.
- **Offline-bundle upgrades no longer print a scary "CID MISMATCH."** A
  `-offline` bundle is a different artifact than the standard tarball the on-chain
  IPFS CID anchors, so the self-seed can never match it — the upgrade now skips
  the seed cleanly with a one-line note instead.
- **`operator_tag` is stamped into the served `verify.json` on every deploy**, so
  a prebuilt-tarball upgrade no longer serves `operator_tag: null`.
- **Operators-page contact links render every scheme.** The operators page used
  an https-only validator that silently dropped email / Matrix / XMPP / Discord-
  invite / nostr / session / cwtch contacts; it now uses the shared, scheme-aware
  contact policy (and repairs a bare email to `mailto:`), matching the instances
  page.
- **Warrant canary: same-box setup publishes immediately.** Local (same-box)
  `canary setup` now hands the served `build/` dir over before the first publish
  (so it isn't a root-owned "permission denied"), and verifies the file actually
  landed. In the health report, a *not-yet-published* canary is now a yellow
  "pending" ⚠ with the exact publish command, not an alarming red ✗ — only an
  *expired* canary is red.
- **Compare-orderbooks page handles zero-clearnet + http/https, with accurate
  errors.** The instance-URL validator now accepts `http://` and `https://` (and
  defaults bare `.onion`/`.i2p`/`.loki` hosts to `http://`), so zero-clearnet
  instances can be compared. The stale "could not fetch" error now clears the
  moment you edit the field, so it never describes a previous input.
- **Sign-in key field resists Firefox autofill.** The import page's posting-key
  field starts read-only (unlocked on focus) with a unique name, so Firefox no
  longer dumps a saved site password into it on load.
- **The sliding "⇨" link arrow has breathing room.** A small text-facing gap
  (logical, so it's correct in RTL too) keeps the glyph from jamming against the
  label.

## Added

- **Two FAQ articles**, in all 10 locales, for the two things operators kept
  asking about: why login asks for your posting key instead of the password you
  set, and why a brand-new chat/order can take a moment to appear (indexer catch-
  up), with search-friendly wording.

## Notes

- No protocol/consensus change. Clearnet instances are unaffected by the
  offline/hidden verification change. The WAF self-heal only touches a BunkerWeb
  deployment and no-ops elsewhere; it is idempotent and skips its reload when the
  settings are already in place.
