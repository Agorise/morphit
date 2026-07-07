# Morphit v1.0.0-beta.16

This release has three threads: it makes the AI-agent (MCP) endpoint actually
reachable over the network, lands a batch of frontend fixes (chat links, the
currency picker, RSS filtering, the onboarding flow, and the in-app update
prompt), and — from a top-to-bottom security and correctness audit — fixes a
moderation bug that affected operators running a separate operator account.
Most people simply get the frontend improvements; the MCP and moderation
items matter only to operators who enabled those features.

## Fixed

- **The MCP server now actually runs as a network service.** The persistent
  `morphit-mcp` service previously started and then stopped within a second
  because it only spoke stdio, leaving nothing on its port and making the
  advertised `/mcp` discovery URL unreachable. It now serves a real HTTP
  endpoint and stays up.

- **Upgrades roll the MCP forward automatically.** `morphit-ops upgrade` now
  redeploys the MCP's isolated copy and restarts it as part of the upgrade
  (only if you have it installed), so you no longer have to redeploy it by
  hand after every version bump.

- **Operator instance blocks now take effect when a separate operator
  account is configured.** If you set `MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME`
  to an account different from your official account, accounts you blocked
  were still appearing in your instance's orderbook, live stream, RSS feeds,
  and per-account listings — the block was recorded under the operator
  account, but the public surfaces were filtering by the official account.
  They now all filter by the operator account, so a block applies
  everywhere. The same fix was extended to two further paths: your
  instance's derived (native) price feeds no longer count a blocked
  seller's orders, and `morphit-ops block` now writes the block under the
  operator account so the CLI command is effective too. Instances that do
  not set a separate operator account were never affected.

- **Links in chat messages are now clickable.** http/https URLs that a peer
  sends are rendered as links (opening in a new tab, with no-referrer and
  no-follow), while the rest of the message stays plain, escaped text.

- **The currency picker now reaches every currency.** The orderbook's fiat
  filter previously stopped at the 50th currency alphabetically (it cut off
  around Georgian lari); all currencies are now reachable.

- **RSS feeds honor every filter, including on the all-assets feed.** The
  global `/rss/orderbook.{xml,atom,json}` feed now applies the same side,
  currency, region, payment-method, and minimum-trades filters the per-asset
  feeds already supported, and the orderbook's RSS button now appears for
  filtered all-asset views as well.

- **The onboarding "Leave anyway" button now actually leaves.** A guard bug
  could re-cancel the navigation so the confirmation did nothing; it now
  navigates as expected.

- **Switching language during onboarding no longer wipes your progress.**
  The language switcher now changes locale in place on the onboarding
  screens instead of reloading the page, so your current step, your inputs,
  and any freshly generated keys survive the switch.

- **The in-app "update available" prompt is back.** A new version was
  silently auto-activating and reloading the page mid-task instead of
  showing the "Load it now / Later" prompt; updates are once again
  consent-gated. The offline-shell recovery is unaffected (it comes from
  network-first navigation, not from the auto-activation that was removed).

- **The "Back up your keys" help tooltip is fixed.** It now flips above the
  icon when there is no room below (so it is not cut off at the bottom of
  the screen), its "Learn more" opens the FAQ in a new tab (so it cannot
  discard your in-progress keys), and tapping the info icon reliably opens
  it on touch devices.

## Added / changed

- **Hardened HTTP transport for the MCP.** It binds loopback by default and
  is locked down in depth: DNS-rebinding protection (Host/Origin
  allowlists), a per-client rate limit, a hard request-body cap, a
  concurrent-connection ceiling, slow-client timeouts, and a fail-closed
  bind that refuses all-interfaces or a public address unless you explicitly
  opt in. Local AI tools that launch the server themselves (Claude Desktop,
  Cline, Cursor, and the like) keep using the simpler stdio mode — no change
  for them.

- **Works behind a dockerized reverse proxy (e.g. BunkerWeb).** Because a
  containerized proxy cannot reach the host's loopback, you can bind the MCP
  to the Docker bridge gateway instead — set `MORPHIT_MCP_HTTP_HOST` to your
  bridge address (commonly `172.18.0.1`) in `/etc/morphit/mcp.env`, exactly
  the way the indexer and relay are reached. Private and bridge addresses are
  allowed without any override; only public binds require one.

- **A `/health` endpoint** so you can confirm the MCP is up directly:
  `curl http://127.0.0.1:8124/health` (or your bridge address). It is also
  reflected in `morphit-ops health`, alongside a new web-push status line in
  the relay block.

- **Lighter first load on the orderbook.** The payment-method filter's data
  now loads on first use instead of shipping in the initial bundle (the
  currency filter already worked this way), so the orderbook page starts
  smaller.

- **Smaller polish.** The side, minimum-trades, and sort dropdowns now show
  a pointer cursor; password, key, and seed-phrase fields carry sensible
  maximum lengths that never truncate a valid value.

## Under the hood

- New behavioral and static smoke tests exercise the HTTP transport end to
  end (protocol handshake, tool listing, and every defense — Host/Origin
  rejection, method/path/content-type guards, body cap, rate limit, and the
  bind guard for all-interfaces and public addresses versus private and
  bridge ones). Operator-block filtering is now guarded too, so a read
  surface cannot drift back to filtering by the wrong account.
- ADR-0044 records the MCP transport decision (stateless JSON, loopback,
  security posture, stdio retained for local agents).
- The operator docs (OPERATIONS, run-a-node) were reconciled — they had both
  claimed the MCP was "stdio, no HTTP health endpoint" and, elsewhere,
  described an HTTP `/mcp` reverse-proxy block; they are now consistent, and
  a manual-install ordering issue (deploying before creating the service
  user) is fixed. A troubleshooting entry was added for broken account
  avatars, which are caused by a stale deploy-side Content-Security-Policy
  rather than by any code change.
- Peer-sent chat links are made safe without unescaping any peer text, and
  developer-only comments were removed from the served HTML shell.
- A top-to-bottom security and correctness audit was completed — covering
  forged-field resistance across every chain handler, the fee and feedback
  mechanics, the featured-slot auction, the smoke battery itself, and the
  operator documentation. It surfaced the operator-block account mismatch
  above; a follow-up review then found and fixed the same mismatch in two
  more places — the derived price feeds and the operator CLI — so the block
  now applies consistently across every surface. Each is covered by a
  regression test.
