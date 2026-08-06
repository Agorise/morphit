# Morphit v1.0.0-beta.5

Two operator-facing improvements on top of beta.4. First, your
instance is now far more resilient to flaky Blurt RPC nodes — a
single dead or rate-limited node no longer stalls your sync, and
you can check your endpoints before you rely on them. Second, you
can now moderate your own instance: review the abuse signals the
indexer already collects and hide a troublesome account's listings
— without touching the chain, anyone's funds, or any other
instance. This release is recommended for all operators.

## Added

- **Instance-local moderation — review flags and block accounts.**
  Morphit's indexer already watches for two abuse patterns: accounts
  that review each other suspiciously often (reciprocity rings) and
  accounts that look like the same person behind several names.
  beta.5 turns those signals into something you can act on. Run
  `morphit-ops moderation` (or pick **Moderation** from the
  `morphit-ops` menu) to review the flagged accounts and block any of
  them right there; you can also block or unblock any account by name
  with `morphit-ops block <account> [reason]` and `morphit-ops
  unblock <account>`.

  A block is **instance-local**. It hides that account's listings
  everywhere *your* instance shows them — the public orderbook, the
  per-account view, featured slots, the RSS feeds, and the live
  stream — and nothing more. It does **not** broadcast anything to
  the chain, does **not** touch anyone's funds, keys, or identity,
  and has **no effect on any other Morphit instance**. It is fully
  reversible. A blocked person signed in on your instance sees a
  clear, non-alarming banner explaining that their posts are hidden
  on this instance only and remain visible on every other Morphit
  instance, with a link to reach you — which is the whole point of a
  federation: no single instance can censor anyone across it. See
  `OPERATIONS.md` §6a and `RUN-A-MORPHIT-NODE.md` §9.1.2.

- **RPC endpoint health — checked before, and visible during, a run.**
  `morphit-ops doctor` and the setup wizard (`morphit-ops init`) now
  test each Blurt RPC endpoint you have configured — a real chain
  query, not just a DNS lookup — and tell you in plain English
  whether they are all reachable, some are down, or all are dead,
  *before* you depend on them. (Pass `--no-rpc` to `doctor` to skip
  it.) And `/v1/health` now reports how many of your RPC endpoints are
  currently healthy, with full per-endpoint detail in the verbose
  view, so you can tell at a glance whether a sync problem is an RPC
  problem.

- **The `morphit-ops` menu now shows your version and pending flags.**
  The menu lists your installed version next to **Upgrade** (and the
  latest available release, when it can reach the release server),
  and the number of unresolved moderation flags next to
  **Moderation**, so both are visible the moment you open the menu.

## Fixed

- **A single dead or rate-limited RPC node no longer stalls your
  instance.** Two related fixes. The indexer now ships with the same
  built-in list of working Blurt RPC nodes the relay already had:
  previously the indexer required you to configure endpoints with no
  fallback, so a node set up with a list that later went dead — while
  the relay quietly ran on its own good defaults — could freeze the
  indexer's sync. Both services now fall back to the same vetted
  four-node list when the setting is absent, and the setup wizard
  writes that same list to both. Separately, an RPC node that is up
  but rate-limiting you (HTTP 429) or briefly erroring (502/503/504)
  is now treated as a reason to rotate to the next node and back off,
  instead of surfacing as a hard failure — so a throttling or flaky
  node is routed around automatically.

- **Quieter, clearer RPC logs.** The noisy `Didn't failover…` lines
  the underlying Blurt library printed on every transport hiccup are
  now suppressed. Your real endpoint health is on `/v1/health`
  instead.

## Everything from beta.4 still applies

beta.4 added `morphit-ops doctor` (a read-only "will my node start?"
check) and fixed an indexer boot crash that happened when a Matrix
**room** was set for operator alerts, plus two settings the setup
wizard was not writing. See `RELEASE-NOTES-v1.0.0-beta.4.md` for
details.

## Upgrading

- If you installed cleanly from a recent release and your node runs,
  just `npx morphit-ops upgrade` to pick this up (it carries your
  config and keys forward). After upgrading, it is worth running
  `morphit-ops doctor` once — it now checks your RPC endpoints too.
- No configuration change is required on your side. If you had
  manually copied RPC endpoints into `MORPHIT_INDEXER_RPC_ENDPOINTS`
  as a workaround, you can keep them or remove them — the indexer now
  has a safe built-in default either way.

## Verify the download

```
sha256sum -c morphit-v1.0.0-beta.5.tar.gz.sha256
```

Output must say `OK` before you extract.

## Status

Pre-launch beta. Not yet recommended for production traffic. The
canonical public instance is morphit.io. Community operators
welcome — start at `docs/start-here/`.
