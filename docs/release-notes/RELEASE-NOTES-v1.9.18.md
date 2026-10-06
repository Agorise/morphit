# Morphit v1.9.18

**Theme: another hotfix on the guided local-install path — the installer now gets through system-account setup and on into deploying the stack.**

A small follow-up to v1.9.17. Anyone installing locally (home computer, Raspberry Pi, or an old laptop running Linux) should use v1.9.18.

## Fixed

**The installer no longer stops while creating its system accounts.** On v1.9.17, a "Full guided install" got past the safety checks and began setting up, then stopped with `Group morphit-mcp does not exist` while creating one of Morphit's background-service accounts. One of those accounts was being created before its group existed. It now creates the group first, matching how the other service accounts are handled, so setup continues on into installing the database, relay, indexer, and web server.

## Changed

**Clearer wording about the download.** The "run a node" guide now notes that what you download is Morphit's source (a few tens of MB), and that the installer's first step downloads the software libraries (a few hundred MB) — so the `npm install` wait at the start is expected, not a hang.

## Notes

- No database migrations. No breaking changes.
- If a v1.9.17 local install stopped at the `morphit-mcp` group error, nothing needs undoing — the run stopped before deploying anything. Re-run the installer from a fresh v1.9.18 download.
