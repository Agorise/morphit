# Morphit v1.0.0-beta.6

A round of operator-quality-of-life and front-end polish on top of
beta.5, driven by a real first install and a careful pre-release
review. Operators get a clearer status dashboard (including proof
their backups are running), a safer recovery command, and a
single-host deploy recipe that actually works the first time.
Visitors get a simpler "Get Morphit" page, a friendlier language
picker, shared links that no longer 404, and a new FAQ explaining
why Morphit's code is mirrored so widely. This release is
recommended for all operators.

## Added

- **Status dashboard now shows your recent backups.** `morphit-ops
  status` (menu item #10, "Status dashboard") ends with a **Backups**
  section listing your **last three** database backups — newest
  first, with each file's age and size — plus the backup directory
  and a reminder of how to copy a file off the host. It's the quick
  "are my backups actually happening?" check, and it gives you the
  exact path to download a backup or hand it to a developer if you
  ever need help. It's read-only and reads only the backup directory
  — never your database password or any keys. `--json` includes the
  same data. See `OPERATIONS.md` §31 and `RUN-A-MORPHIT-NODE.md` §10.

- **A "Why so many mirrors?" link on the Get Morphit page, and a FAQ
  answer to match.** Morphit's source code is mirrored across many
  independent code hosts on purpose — decentralization is the second
  design priority, right behind privacy. A project that lives in one
  place can be taken down in one place, so the AGPL source lives on
  our own Forgejo server (the canonical copy), on GitHub, on more git
  hosts as they come online, and as a content-addressed copy on IPFS
  that no single host controls. If any one of them blocks or drops
  Morphit, every other copy is still there and anyone can re-host it.
  The new FAQ ("Why is Morphit's source mirrored to so many code
  hosts?") explains the reasoning, and you can verify any running
  instance against the SHA-256 hashes published on the Blurt chain.

## Changed

- **`fast-forward` is now a recovery-only command, with a guard.** A
  normal install never needs it — the indexer starts at the Morphit
  genesis block and resumes from where it left off on every restart —
  so it's been moved out of the `morphit-ops` menu to keep it from
  becoming a footgun. It's still available directly when you need it
  for recovery, and it now **refuses to run if your indexer looks
  live** (its cursor was touched in the last ~90 seconds) unless you
  pass `--force`.

- **The `morphit-ops` menu now catches your eye when it matters.** The
  "Upgrade to the latest version" line turns bold yellow when a newer
  release is available, and the "Status dashboard" line turns yellow
  or red when your relay balance is getting low — so you notice
  before it becomes a problem.

- **The "Get Morphit" page is simpler and accurate.** Morphit installs
  as a Progressive Web App straight from your browser on Android,
  iPhone/iPad, and desktop — there is no APK, app-store listing, or
  native package, by design. The page now leads with that, and adds a
  "Source code & mirrors" section pointing at every place the code
  lives.

- **A friendlier language picker.** With ten languages the selector
  used to run off the bottom of the screen; it's now a compact grid
  that fits any screen and scrolls if needed.

## Fixed

- **Shared links with the language prefix stripped no longer 404.** A
  link like `/faq?q=...` (missing the `/en/` prefix) now detects your
  browser's language and redirects to the right page, preserving the
  query and anchor, instead of showing an error.

- **A single-host (one server) deploy now works the first time.** The
  documented nginx recipe now serves the prerendered site correctly
  (it was returning a 403 on locale pages) and routes the indexer and
  relay APIs to the right place (signup and the orderbook were
  failing). If you run the indexer, relay, and web app on one box,
  re-check `RUN-A-MORPHIT-NODE.md` §8.

- **Deploys can no longer leave the app showing a blank page.** The
  service worker now rebuilds redirected responses on navigations, so
  a page cached during a brief deploy-time redirect window can't break
  loading afterward. (If you ever hit a blank page mid-upgrade, a hard
  reload clears it.)

- **The "Create an account" link from the post page no longer 404s,**
  and the comparison/settings input fields now match the dark theme.

## Upgrading

Use `morphit-ops upgrade` (or the **Upgrade** menu item). Your
configuration, signing key, and per-network keys are carried forward
automatically, and the services restart on the new code. Most of this
release is front-end and documentation, but upgrading via a release is
still the cleanest path. There are no database migrations and no
configuration changes required.
