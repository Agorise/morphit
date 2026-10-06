# Morphit v1.15.8

**A successful upgrade now ends with a clear success banner instead of a bare "Terminated" that made a perfectly good upgrade look like it had failed.**

## Fixed

**The upgrade no longer terminates itself at the finish line.** The last step of an upgrade sweeps up stale worker processes left over from the previous version and stops them. It identified them by "any process whose working directory is inside the old install dir" — but the upgrade process itself (and its shell, `sudo`, and launcher) all run with their working directory in that dir, which the upgrade had just renamed to the `.bak` backup. So the sweep sent `SIGTERM` to its own process: the box upgraded fine, but the command died with a lone `Terminated`, and the remaining steps — pruning old backups, the Docker-aware backup check, the success banner, and the canary refresh — never ran. To an operator it looked like a failed upgrade. The sweep now excludes the upgrade's own process and its entire ancestor chain, so it stops genuine stale workers without ever killing itself, and the upgrade runs to completion.

**Upgrades end with a friendly confirmation.** Instead of a terse one-liner (or nothing, when the self-termination cut it off), a completed upgrade now prints a clear banner — "Success — your Morphit server is now running vN.N.N", the version it came from, that every service was restarted and the new frontend is live, and where the previous install was kept — so a non-technical operator knows without doubt that it worked.

## Notes

- No schema change, no on-chain change — a UI/robustness fix to the upgrade path only. Upgrade in place.
- Includes v1.15.7 (federation-probe column fix + parity smoke + legacy I2P b32), v1.15.6 (sealed-credential auto-unlock + paste-hardened prompt), v1.15.5, and v1.15.4.
- Pinned by smoke: `selfAndAncestorPids()` is verified to walk `/proc` and include the running process and its parent, the sweep is checked to exclude those PIDs at every scan point, and the success banner is asserted to congratulate and name the version.
