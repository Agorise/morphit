# Morphit v1.9.14

**Theme: the warrant canary is now hands-off across upgrades — the served folder can't stay broken.**

Two things now protect the canary upload from an upgrade re-rooting the served
folder. The ownership-preserving fix from v1.9.13 takes effect for every upgrade
run by v1.9.13-or-newer code, so upgrades stop re-rooting the folder. On top of
that, the weekly canary refresh now self-heals: if it ever finds the served folder
re-rooted, it takes it back before uploading. Between the two, a canary upload can
no longer be left broken by an upgrade.

## Added

**The canary refresh self-heals a re-rooted folder.** The weekly refresh
(`~/.morphit/update-canary.sh`, written by `scripts/canary/setup.sh`) now makes the
served `build/` folder writable again — best-effort, before every upload — so even
if something leaves it root-owned, the next refresh fixes it and uploads cleanly
instead of failing with "permission denied." This runs from the machine you sign on,
not the server's installed code, so it protects the canary on any version. Re-run
`scripts/canary/setup.sh` once to pick it up.

## Notes

- No database migrations. No breaking changes.
- The self-heal fixes the folder with `sudo` on the server, and an unattended weekly
  timer can't type a password — so the self-heal runs on its own only if the upload
  account has **passwordless** sudo. Without it, the v1.9.13 ownership-preserving fix
  is what keeps upgrades from re-rooting the folder in the first place.
- New operators: `scripts/canary/setup.sh` already makes the served folder writable
  for you at setup time, so your first canary upload works; from then on it stays
  that way across upgrades.
- The canary's signing model is unchanged: signed with your own PGP key, off the
  served box when you want it that way, so it goes stale exactly when it should.
