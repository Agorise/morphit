# Morphit v1.9.12

**Theme: the warrant canary is now hands-off — from first setup through every upgrade.**

v1.9.11 made the canary survive upgrades without re-fixing permissions by hand.
This release removes the last manual touches around it: fresh-server setup no
longer trips over folder permissions, home-hosted nodes restore the canary
automatically on upgrade, and a health check warns you if a canary ever starts
going stale.

## What's new

**Fresh-server canary setup just works — no first-time "permission denied".** On a
brand-new server the folder your site serves starts out owned by `root`, so the
very first canary upload used to be refused until you fixed the ownership by hand.
Now `scripts/canary/setup.sh`, when it sets up a remote server, hands that folder
to your upload account for you (if your login can use `sudo`), so the first
upload — and every one after — just works. If it can't, it points you at the
one-line fix; nothing fails silently.

**Home-hosted nodes restore the canary automatically on upgrade.** If you sign
your canary on the same machine that serves it (home hosting), upgrading Morphit
now puts the canary straight back for you — it re-runs your weekly refresh as part
of the upgrade, so there's nothing to do afterward. Operators who sign on a
separate laptop still get the one-command reminder, since the signing key isn't on
the server by design.

**A health check catches a stalling canary before your readers do.** Run
`morphit-ops health` and the Canary line now warns while a served canary is still
valid but running low on time — the sign that the weekly refresh has quietly
stopped — so you can re-run it before it expires and readers see a false alarm. A
missing or expired canary now shows in red.

## Notes

- No database migrations. No breaking changes.
- If you're already on v1.9.11, upgrading to this release needs no one-time
  ownership fix — v1.9.11 already restores the served folder for you.
- The canary's signing model is unchanged: signed with your own PGP key, off the
  served box when you want it that way, so it goes stale exactly when it should.
- New to canaries? `scripts/canary/setup.sh` is still the one guided command (see
  `docs/RUN-A-MORPHIT-NODE.md`).
