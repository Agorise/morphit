# Morphit v1.17.3

Follow-up to v1.17.2, driven entirely by what two real upgrades revealed. The
headline item is that **nobody could set up a warrant canary** — the setup script
was being killed mid-prompt by a shell error, and the same defect sat in the
weekly refresh that keeps an existing canary alive. No protocol or consensus
change.

## Fixed

- **Warrant-canary setup no longer dies mid-prompt.** Answering the questions
  would get as far as "Operator name" and then stop with "Canary setup didn't
  finish", with no explanation. The script was not finishing early — it was being
  terminated. It looks for your instance URL to offer as a default, and the
  search used a pipeline that reports "not found" as an error; combined with the
  script's own abort-on-any-error setting, the first configuration file that
  lacked that setting killed it outright. Since almost no existing instance has
  that setting recorded, this affected essentially everyone. The lookup now
  tolerates a miss, tries more places, and on a Tor-only box falls back to your
  `.onion` as the default.
- **The weekly canary refresh had the same defect.** Identical construct in the
  refresh job that the timer runs. A node whose configuration lacked one
  particular setting — or that simply had no `.onion` among its chain endpoints —
  would have its refresh killed silently, letting a published canary go stale on
  its own schedule with no error any operator would ever see. That is the worse
  version of the bug, because nothing surfaces it until readers notice the date.
- **The seeding self-check can find your addresses again.** Every instance was
  reporting "no hidden address configured" and skipping the frontend check, even
  with a live `.onion` and a working domain. Two causes: the check read one
  setting from one file, and it runs as an unprivileged user that cannot read
  Tor's address file at all. The upgrade now looks these up itself — where it has
  the permission to — and hands them down, with more fallbacks and a message
  naming exactly where it looked when it still finds nothing.
- **The snapshot mirror installs itself on hand-built servers.** Its weekly timer
  was only installed by the automated server setup, which never runs on an
  instance that was installed by hand — including the canonical one. The upgrade
  now installs and enables the timer directly, so the feature is not silently
  inert on exactly the servers that matter most.
- **The stray "New major version of npm available!" banner is gone.** It was
  printing after the upgrade's own success message, which read like part of the
  result. Suppressed at the last step that could emit it, so it holds however
  that step is run.

## Changed

- **The "Zero use of clearnet internet" badge now shows a medal (🏅) instead of a
  shield (🛡️)** in the instance directory. It marks an achievement a node has
  earned by proving all seven outbound paths are hidden, not a protective
  feature — the medal reads that way.

## Security

- The address lookup deliberately does **not** read hidden addresses from the
  chain-endpoint configuration. That file lists other operators' `.onion`
  addresses, and reading it would have made this instance probe a stranger's node
  and report it as its own working seeder.

## Notes

- No protocol/consensus change. Everything here is operator-facing: setup,
  upgrade, seeding and reporting accuracy.
- If your canary setup failed on v1.17.2, re-run it after upgrading —
  `sudo morphit-ops` → "Harden this server", or
  `sudo bash /opt/morphit/scripts/canary/setup.sh`.
- `OPERATIONS.md` §52 covers the snapshot mirror pipeline and how to check it.
