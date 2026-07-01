# Morphit v1.0.0-beta.18

A small operator-quality release, plus one user-facing fix. For users: the
printable backup card on the onboarding screen now renders instead of producing
a blank page. For operators: it removes a recurring upgrade nag and makes the
upgrade's "is the new build actually live?" check reliable — both changes are in
`morphit-ops upgrade` itself, with nothing extra to do beyond deploying it. This
release also expands the default Blurt RPC pool to six independent nodes and
makes the client back off properly from rate-limited endpoints, so chain reads
and broadcasts are steadier.

## Fixed

- **The printable backup card no longer prints as a blank page.** On the
  onboarding "your keys are ready" screen, the *Print backup card* button could
  open the print/PDF dialog showing a single empty page. The card was isolated
  for printing using a `position: fixed` element inside a deliberately
  collapsed page subtree — a combination some print-to-PDF engines drop
  entirely. The card is now lifted to the top of the page and printed in normal
  flow, so it renders reliably as a single clean page. (The seed words still
  never leave your device — this is pure local rendering, no network, no PDF
  library.)
- **`morphit-ops upgrade` now tidies up old backups for you.** Each upgrade
  keeps a rotating set of `/opt/morphit.bak-<timestamp>` backups and prunes
  the oldest. Previously, if you happened to have a leftover login shell, or a
  pager left open from a `systemctl status …`, parked inside one of those old
  backup directories, the upgrade refused to delete it and printed a `[WARN]`
  asking you to go find and stop those processes — on every single upgrade.
  The upgrade now prunes those backups anyway, because a parked shell or pager
  is harmless (the system keeps it running fine even though its working
  directory is gone). It still refuses to delete a backup only when something
  is genuinely *running its code* from it — for example, a relay or indexer you
  started by hand from the old tree — since deleting that out from under a live
  service would be unsafe.
- **The post-upgrade "is the new frontend live?" check is now reliable.** That
  check, and the manual command it printed when it couldn't confirm
  automatically, used to grep a token out of the service worker — but that
  token is assembled at runtime and doesn't survive minification, so the check
  almost always came back "could not auto-verify" and the suggested
  `curl … | grep -o 'morphit-[0-9]*'` command returned nothing useful. It now
  reads the `morphit_version` field from `/verify.json` instead, which is a
  single, stable value. If you ever need to confirm the served version by hand,
  the upgrade now tells you to run `curl -s <your-site>/verify.json` and check
  that its `"morphit_version"` matches the build.
- **Two more Blurt RPC endpoints in the default pool, and rate-limited nodes
  now back off properly.** The default Blurt RPC set grew from four to six
  independent public nodes (added `rpc.drakernoise.com` and
  `blurtrpc.dagobert.uk`), giving more headroom when an endpoint is slow or
  down. Separately, when a node replies `429 Too Many Requests`, the client now
  parks it on a dedicated, longer cool-off (starting at 30 s and escalating)
  rather than re-trying it every couple of seconds — which was what kept
  re-triggering the rate limit. While a node is parked, requests are served
  from the other endpoints, so this is invisible in the UI; it just removes the
  needless 429 round-trips. **Operators running a hand-written reverse proxy or
  CSP:** if your deployment pins a `connect-src` allow-list, add the two new
  origins (`https://rpc.drakernoise.com https://blurtrpc.dagobert.uk`) to it
  and to your indexer/relay RPC env vars, or the browser/server will refuse to
  reach them. A fresh install picks all six up automatically.
- **A clearer error when the database URL was never expanded.** If a
  `MORPHIT_*_DATABASE_URL` was set to a value containing a shell command
  substitution — e.g. a host written as `$(docker inspect … )` — environment
  files are read literally (the shell never runs), so the substitution was
  passed through verbatim and `morphit-ops` failed with a baffling
  `getaddrinfo ENOTFOUND $(docker inspect … )`. The CLI now detects the
  unexpanded `$(…)`/backticks up front and tells you exactly what happened and
  how to fix it (resolve the host to a concrete IP, or publish the DB on
  localhost), instead of a cryptic DNS error.

## Under the hood

- The backup-prune safeguard previously keyed on whether any process had its
  current working directory under the backup tree. That is a weak signal —
  it caught harmless campers (shells, `less`/pager processes) and blocked the
  prune forever. The new `pidsRunningFrom` check instead looks at whether a
  process's executable (`/proc/<pid>/exe`) or an absolute path in its command
  line lives under the tree, which is the real "unsafe to delete" condition;
  a process that merely parked its cwd there no longer blocks pruning. A new
  regression smoke (`upgrade-backup-prune`) pins this so the prune cannot
  silently revert to the cwd-blocks-forever behaviour.
- The frontend freshness verification (`readBuiltVersion` /
  `resolveServedVersion`) now parses `build/verify.json`'s `morphit_version` on both
  the built side and the served side, replacing the brittle service-worker
  token grep. The `upgrade-frontend-deploy` smoke was updated to cover the new
  `parseVerifyJsonVersion` parser.
- The RPC pool gained a dedicated rate-limit cooldown ladder
  (`DEFAULT_RATE_LIMIT_COOLDOWN_LADDER_MS`, 30 s → 5 min) and an
  `isRateLimitError` predicate; a `429` now selects that longer ladder while
  any other transport failure stays on the generic one. The single source of
  truth for the default endpoint set (`@morphit/operator-config`
  `DEFAULT_BLURT_RPC_ENDPOINTS`) carries the two new nodes, and the
  non-importing copies (frontend `config.ts`, the two env examples, the
  four-surface CSP `connect-src`) are kept in sync by `rpc-endpoint-canon` and
  `csp-header-consistency`. New `rpc-pool-smoke` scenarios cover the rate-limit
  ladder and the predicate.
- `morphit-ops`' database-URL reader (`readDatabaseUrl`) now rejects an
  unexpanded shell command substitution (`$(…)` / backticks) with an actionable
  message before pg is ever handed the literal host; pinned by a new
  `instance-env-loader-smoke` scenario.
