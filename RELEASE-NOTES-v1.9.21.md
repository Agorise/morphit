# Morphit v1.9.21

**Theme: home-desktop installs no longer stop at the SSH-hardening step when the machine has no SSH server.**

This is a small hotfix for the guided install. If you install Morphit on a home computer that doesn't run an SSH server (common for a desktop you sit at and administer locally), the previous version stopped during setup with an error like *"Destination directory /etc/ssh/sshd_config.d does not exist."* Rented servers (VPS) always have an SSH server, so they were unaffected — but a home node could get stuck here.

## Fixed

**SSH hardening now applies only when an SSH server is actually installed.** The installer checks for an SSH server first:

- If one is present (always the case on a VPS, and on any machine where you added SSH for remote access), it is hardened exactly as before — root login and password login are turned off.
- If there is none (a typical home desktop you run locally), the installer prints a short note explaining there is nothing to harden and moves on, instead of stopping.

We deliberately do **not** install an SSH server for you. Whether to run one — and expose it — is your decision, not something the marketplace installer should make on your behalf. If you add an SSH server later for remote access, just re-run the installer and it will harden it.

Two small belt-and-braces fixes ride along so the same class of problem can't surface elsewhere: the scheduled security scans (AIDE, rkhunter) are guaranteed their scheduling directories, and the certificate-renewal hook is guaranteed its directory before it's written.

## Notes

- No database migrations. No breaking changes.
- If your last install stopped at the SSH step, you don't need to undo anything — just re-run the guided install with this version and it will pick up cleanly and finish.
