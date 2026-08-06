# Morphit v1.9.17

**Theme: a hotfix for v1.9.16 — the guided installer now completes on a home computer or a local Raspberry Pi / old laptop.**

This is a small, targeted follow-up to v1.9.16. If you already run a node, or install onto a remote server over SSH, nothing here affects you. Everyone installing locally should use v1.9.17.

## Fixed

**The guided installer no longer crashes partway through a local install.** On v1.9.16, a "Full guided install" on your own machine got as far as the safety checks and then stopped with an `'ansible_user' is undefined` error — before anything was actually set up. The pre-flight that checks you're not about to lock yourself out over SSH was evaluating a value that simply doesn't exist on a local install. It now recognises a local install correctly (and still refuses a risky root-over-SSH remote install), so the installer runs all the way through to the summary and the "put your instance on the shared map" step.

**A harmless-but-alarming warning is gone.** The installer no longer prints Ansible's "discovered Python interpreter… future installation could change the meaning of that path" notice during setup. Nothing was wrong; it just looked scarier than it was.

## Notes

- No database migrations. No breaking changes.
- If your v1.9.16 local install stopped at the safety-check error, you don't need to undo anything — nothing was deployed. Just re-run the installer from a fresh v1.9.17 download (see the recovery steps if you were following along with support).
