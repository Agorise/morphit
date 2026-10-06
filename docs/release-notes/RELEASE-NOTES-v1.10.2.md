# Morphit v1.10.2

**Theme: a reboot shouldn't take your node down. This release fixes a database-permission defect that could stop the indexer from coming back after a restart, and repairs the gitea.com release mirror.**

This is a small but important maintenance release for anyone running a Morphit instance installed the guided (ansible) way. There are no database migrations and no breaking changes.

## Fixed

**The indexer now always comes back after a restart or reboot.** On instances set up with the guided installer, the database's host-permission file (`pg_hba.conf`) was left without a rule allowing the indexer and relay to log in over the local network connection they actually use. Everything ran fine until PostgreSQL next re-read that file — typically the first reboot — after which the indexer would fail to connect and restart in a loop, taking `/v1/health` (and anything that depends on the indexer) down with it. The installer now writes the correct, tightly-scoped permission rule (only the indexer's own database user, only over the loopback address, password-authenticated), so a restart or power cut no longer locks the indexer out. A regression guard was added so this can't silently come back.

If you hit this before upgrading, the symptom in the logs was `no pg_hba.conf entry for host "127.0.0.1"`. After upgrading to v1.10.2 the installer repairs the rule for you; on a node you've already patched by hand, the upgrade simply confirms the rule is present.

**The gitea.com release mirror now publishes.** Forgejo reserves secret names beginning with `GITEA_`, so the token for the gitea.com mirror can't be stored under the name the release workflow originally expected. The workflow now reads the token from a name Forgejo allows (`GITEACOM_TOKEN`), so — with that secret set — each new release is mirrored to gitea.com alongside codeberg.org, keeping upgrades working even if the main forge is unreachable.

## Notes

- No database migrations. No breaking changes.
- Instances installed the manual (`morphit-ops`) way were not affected by the database-permission defect; it was specific to the guided/ansible database setup.
