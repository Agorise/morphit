# Morphit v1.10.8

**Theme: a smooth, honest first install. The security-baseline step no longer stalls the wizard, guided installs on an online box stop showing a false "APT is corrupt" warning, health reporting is fixed and expanded, and the install ends with a single "is everything green?" command.**

This is a maintenance release. There are no database migrations and no breaking changes.

## Fixed

**The filesystem-integrity baseline no longer blocks — or can time out — the install.** Building the AIDE baseline fingerprints the whole disk and, on a low-power machine, ran long enough to exceed the install's time budget and fail the whole run. It now builds in the background at idle priority after the install finishes, so the wizard completes quickly and the node starts syncing right away. The build is reboot-safe (an interrupted build never corrupts anything and simply resumes), removes its own one-shot service when finished, and — importantly — a background failure is not silent: it stays visible, logs a high-priority error, and is reported through the operator's alerting.

**No more false "Your APT configuration is corrupt" warning on an online guided install.** The offline install bundle used to redirect the system's package manager to its bundled local repository even on a machine that had a working internet connection, which made the OS's Update Manager complain. It now only does that when the machine genuinely can't reach its normal package mirrors; an online install keeps its normal configuration.

**The node-health CPU figure is no longer always blank, and memory reads correctly.** A hardening setting on the indexer hid the system files that the health endpoint reads for CPU and memory, so the CPU percentage was permanently blank and memory fell back to a coarse source. The setting has been relaxed just enough to read those system statistics, while still hiding other processes.

## Added

**A one-command health check that actually verifies the install.** `Node health` (option 13 in `morphit-ops`) now confirms, in one place: the indexer is syncing in parallel across your Blurt RPC nodes, the relay is up, the Matrix alert bot is targeting the address you entered, automated backups are scheduled, the HTTPS/TLS certificate is valid (with days-to-expiry), and the integrity baseline built. The post-install summary now points here first.

**More Blurt account sign-up options** are shown during setup.

## Notes

- No database migrations. No breaking changes.
- If a guided install previously failed while building the integrity baseline, this release resolves it.
