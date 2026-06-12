# Morphit v1.0.0-beta.14

A broad release on top of beta.13: operator tooling (a one-command systemd
installer and a single consolidated node-health view), several front-end
fixes, and warrant-canary improvements. **Recommended for all operators.**

## Added

- **A one-command systemd installer.** `sudo bash
  ops/scripts/install-systemd-units.sh` installs the indexer, relay, and
  matrix-bot units pointed at the directory you actually cloned into —
  `/opt/morphit`, `~/morphit`, or anywhere else — so they start without a
  hand-written `systemctl edit` drop-in. (The MCP server and the weekly
  mint-acts job keep running from their own restricted directories as
  separate low-privilege users; that isolation is intentional, and the
  installer leaves it alone.)

- **A consolidated "Node health" view.** `morphit-ops health` now reports
  the indexer, the relay, the matrix-bot and MCP service states, and
  warrant-canary freshness on one screen. It also auto-discovers an
  indexer or relay bound to the Docker bridge gateway, so it no longer
  reports "could not reach the indexer" on container deployments where the
  service isn't on loopback — no flag needed.

- **The indexer health endpoint now explains its block lag.** `GET
  /v1/health` already reported `lag_blocks` (how many blocks behind chain
  head the indexer is); it now also returns `lag_blocks_note` — a plain
  hint like `0-30 is normal (~90s behind; Blurt makes a block every 3s)` —
  so you can tell whether a given lag is fine without memorising
  thresholds. The `morphit-ops health` view shows the same context line.

## Fixed

- **The instances list now shows a "Syncing" status.** A node that is
  reachable but still catching up to the chain after a restart shows
  **Syncing** rather than **Unreachable**, and every status pill has a
  hover tooltip explaining what it means.

- **Consistent form-field focus styling.** Every input, select, and filter
  across the site now shows a single consistent focus ring; the
  Fiat-currency and Payment-method fields no longer draw a doubled border.

- **Glossary tooltips on the run-a-node guide.** The hover popovers now
  position correctly near the top of the page, stay reachable long enough
  to click through to the glossary, and that deep link now works.

- **Dates display consistently.** Absolute dates across the instances
  list, the explorer, profiles, and order details now render in one
  localised "11 June, 2026" format.

- **The "Load it now" update prompt is now verified end-to-end.** After an
  upgrade, the tool confirms that the freshly built frontend is actually
  what your site serves, and tells you whether returning visitors will get
  the reload prompt — instead of failing silently when a stale build is
  being served.

- **A malformed line in the matrix-bot systemd unit.** The
  `morphit-matrix-bot.service` unit carried a comment written inline after
  a directive (`MemoryDenyWriteExecute=false  # ...`). systemd only treats
  a line as a comment when it *starts* with `#`, so it logged a parse
  warning and ignored that directive — harmless, because the ignored value
  matched the default, but noise in the journal. The comment is now on its
  own line.

## Changed

- **The orderbook filter card collapses once you apply a filter**, freeing
  space above the fold; a +/x toggle re-opens it.

- **The warrant canary's news-entropy feed now defaults to Cointelegraph**
  (still overridable per operator).

- **The `morphit-ops` main-menu headings are de-numbered** so they no
  longer collide visually with the numbered actions.

## Under the hood

- **New regression smokes** cover the systemd installer, the consolidated
  health view's auto-probe and canary-freshness parsing, the "Syncing"
  status path, and the upgrade's frontend-serve verification.

- **Operator-doc cleanup.** The "Set up systemd services" section of the
  run-a-node guide now points at the installer, and the old `systemctl
  edit` drop-in workaround is retired.

---

### Upgrade notes

A drop-in upgrade from beta.13. After upgrading you can — optionally — run
`sudo bash ops/scripts/install-systemd-units.sh` to (re)install the units
pointed at your checkout; that's useful if you'd previously hand-edited
paths, or if any service was still running outside systemd. The
health-endpoint note and the front-end fixes need no action — they appear
once the indexer restarts on beta.14 and the frontend redeploys.
