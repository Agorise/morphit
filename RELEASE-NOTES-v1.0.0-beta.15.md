# Morphit v1.0.0-beta.15

A large release on top of beta.14, accumulating three batches of front-end
polish plus a critical mobile fix, notifications and AI-agent discovery
enabled by default, a relay security hardening, and operator-tooling
reliability improvements. **Recommended for all operators and users** — the
mobile fix in particular resolves a blank-page issue some phone users hit
after the beta.14 deploy.

## Added

- **Web push notifications, on by default.** A fresh install now generates a
  VAPID keypair once and starts the relay's web-push delivery automatically,
  so order and chat notifications work out of the box. Operators who don't
  want it can leave it off; see the run-a-node guide.

- **AI-agent discovery (MCP) enabled by default, kept isolated.** The
  read-only MCP server — which lets AI agents discover a node's public
  orderbook with no KYC and hands any actual trading back to the user's own
  device — is now installed, enabled, and started automatically as a separate
  low-privilege service. You can turn it on or off at any time with `sudo
  morphit-ops mcp`.

- **The orderbook RSS feed now mirrors your full search.** A per-asset feed
  URL can carry the same filters as the orderbook — buy/sell side, fiat
  currency, region, payment methods, and minimum completed-trades — and the
  feed's title spells out the active filters. The feed picker reflects the
  search you're looking at. (Feeds stay newest-first regardless of the sort
  you chose on screen, so a reader never silently misses new matching orders.)

- **A "Payment methods accepted" filter on the orderbook**, with an animated
  example of the methods an instance supports and a dropdown that lists every
  method — the previous build silently cut off the end of the alphabet.

## Fixed

- **Mobile: the app no longer shows a blank/black page after an update.** The
  service worker now fetches the page shell network-first and self-heals
  cached assets, so a freshly deployed update can no longer leave a stale
  shell pointing at files the server has already rotated away. (This changes
  the worker to serve the latest deployed shell rather than pinning a
  consent-gated bundle; the chain-signed release-manifest check remains in the
  app as a tamper backstop.)

- **Orderbook multi-select filters stay open.** The Fiat-currency and
  Payment-method fields no longer close after each pick, so you can select
  several at once; pressing outside still closes them.

- **FAQ search lands in the right place.** Clicking a search result now
  scrolls so the question title sits just below the sticky header instead of
  being pushed above the top of the screen.

- **Identicon avatars render everywhere.** The generated heart avatars no
  longer appear as a broken-image icon in Safari/WebKit.

- **The "Back up your keys" tooltip is clickable.** Its "Learn more" link is
  now reachable by both mouse and keyboard.

- **The printable backup card prints on a single page**, instead of with
  large blank bands above and below (sometimes spilling onto extra pages).

- **The login QR code renders correctly** — the finder squares now have hollow
  centers.

- **`sudo morphit-ops` works on systemd deployments.** The Status dashboard
  and the rest of the "Check & operate" menu — the database-backed views —
  now load the instance environment, so they no longer error with "No
  database URL configured" on a systemd install.

- **`morphit-ops upgrade` now refreshes installed systemd unit files.** A fix
  to a unit template (for example, a missing `RestrictAddressFamilies` entry
  that crash-looped a relay) now reaches an already-installed node on the next
  upgrade, instead of leaving the stale unit in place.

- **The relay "not reachable" health message is clearer**, naming both the
  loopback and Docker-bridge addresses it tried, with a hint to check the
  relay is running and publishing its port.

## Security

- **Relay HMAC secrets can no longer ship as a publicly-known placeholder.**
  The relay's invite-token and Altcha HMAC secrets now refuse a known
  placeholder value and require a minimum length when set; leaving them unset
  still produces a secure random per-boot secret (the intended default).
  Previously a manual-install operator who copied the example environment file
  and deployed it unedited could have run with a publicly-known secret —
  enabling forgeable one-time invite tokens and an Altcha proof-of-work
  bypass. Operators on the Ansible install path were never exposed (those
  values are not templated). **Recommended for all manual-install operators.**

## Changed

- **The signed-out top-right button now reads "Start"** (was "Login /
  Register") and is sized to match the language selector.

- **The orderbook filter card is a single accessible expand/collapse
  control** and now stays open until you collapse it (no more auto-collapsing
  on each change).

- **Onboarding polish.** The two path cards ("Build Reputation" / "Maximum
  Anonymity") now read and behave as buttons, and a couple of copy lines were
  clarified (the "no account" prompt and the "this is how you appear" note).

- **Barter is now labelled "Barter (goods/services)"** with an icon.

- **The animated wordmark sheen** was slowed and softened.

## Under the hood

- **A comprehensive security and correctness audit ("deep-deep").** All 17
  indexer transaction handlers were read end-to-end, and the privacy defaults
  (no analytics, no third-party requests, self-hosted fonts), fee arithmetic
  (90/10 BLURT, 100/0 BTC/XMR), and operator docs were re-verified against the
  code. It surfaced the relay HMAC issue fixed above and otherwise returned a
  clean bill of health.

- **Continuous-integration reliability.** Three test scripts whose pass lines
  the CI tally couldn't read (they would have been miscounted as failures)
  were corrected, the chunked test runner was repaired so the full test
  battery is runnable end-to-end, and two guard tests were added so neither
  class can recur.

- **Repo cleanliness.** Removed hardcoded build-environment paths that had
  leaked into four helper scripts.

- **More install coverage.** New tests cover the by-default web-push and MCP
  install wiring and its idempotency, and the media kit's README now documents
  the brand color standards.

---

### Upgrade notes

A drop-in upgrade from beta.14.

- **Web push** is generated and started automatically on a fresh Ansible
  install — a VAPID keypair is created once and never rotated (rotating it
  would drop every existing subscription). On an existing node, follow the
  run-a-node guide's web-push section if you want it enabled.

- **The MCP server** is deployed and started automatically as an isolated
  `morphit-mcp` service running from its own restricted directory as a
  separate low-privilege user. Turn it off with `sudo morphit-ops mcp` if you
  don't want AI-agent discovery on your node.

- **Systemd units now refresh automatically on `morphit-ops upgrade`** — no
  manual re-install is needed for unit-template fixes.

- **Manual-install operators:** if you previously set
  `MORPHIT_RELAY_INVITE_HMAC_SECRET` or `MORPHIT_RELAY_ALTCHA_HMAC_SECRET` to a
  placeholder value, set them to real secrets (≥16 characters) or remove them
  to use the secure per-boot default; the relay now refuses known
  placeholders.

- **Mobile users** affected by the blank-page issue get relief once this
  release is deployed. Until then, the workaround is to clear site data /
  unregister the service worker on the affected device.

- The front-end and copy fixes appear once the indexer restarts on beta.15 and
  the frontend redeploys; the health-endpoint and tooling changes need no
  further action.
