# Morphit v1.0.0-beta.27

A small reliability release with one fix at its heart: your instance now routes
around a Blurt RPC node that has gone down, instead of getting stuck on it. Every
instance talks to a set of public Blurt nodes for reading the chain and
broadcasting operations, and it already prefers the fastest one and fails over
when a node times out or refuses the connection. But if a node's upstream proxy
answered with an "origin is unreachable" error (the 520–527 status range), the
instance treated that as a normal rejection and gave up on that request rather
than trying another node. That's fixed: those errors are now recognized as "this
node is unreachable — try the next one," so reads and broadcasts hop past a dead
node automatically.

The most visible symptom of the old behavior: a relay with a healthy BLURT
balance could still mint **zero** account-creation tokens if the one node it
reached for that broadcast happened to be down — the auto-minter would log a
single failure and stop. With this release, a single down node no longer stalls
account-creation token minting, signups, or anything else the relay or indexer
broadcasts; the instance simply uses a node that's up.

For operators: `morphit-ops upgrade` handles this release the usual way — it runs
`npm ci` and rebuilds the web frontend, the command-line tools, and the MCP
server for you. Like the last several betas, **this release changes no
third-party dependencies**, so there's no special install step. Managing which
Blurt RPC nodes your instance uses is the relay and indexer's job (with the
upgrade flow keeping the defaults current) — never something you should have to
hand-edit while the software is running.

## Fixed

- **Your instance routes around a downed Blurt RPC node.** When a node's upstream
  proxy returns an "origin unreachable" error (HTTP 520–527 — e.g. 521 "web
  server is down"), the instance now classifies it as an unreachable endpoint and
  rotates to a healthy node, applying the same back-off it already uses for
  timeouts and rate limits. Previously these surfaced as ordinary errors, so a
  single down node could dead-end a request. This is what could leave a
  fully-funded relay minting zero account-creation tokens — its fastest node was
  down and it didn't fail over. Reads and broadcasts both recover now.

## For operators

- **Fresh Ansible deployments point at the current Blurt nodes.** The Ansible
  deployment defaults pinned the indexer to a Blurt RPC node that has since been
  decommissioned (and the egress firewall opened only that node), so a brand-new
  Ansible install could come up unable to reach a working node. The defaults now
  use the current canonical set of six Blurt RPC endpoints, and the egress
  allowlist matches. If you deployed via Ansible and chose your own endpoints,
  nothing changes for you. (Installs created by `morphit-ops init` were never
  affected — they already used the canonical set.)

## Under the hood

- **More regression guards.** New automated checks pin both fixes so a future
  change can't quietly undo them: the RPC pool's "try another node" logic is
  tested against the full origin-unreachable status range (including the exact
  error a relay saw in the field), and the canonical-endpoint guard — which keeps
  every copy of the node list in sync — now also covers the Ansible deployment
  defaults, the one place the list had been allowed to drift.
