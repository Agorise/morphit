# Morphit v1.9.19

**Theme: the guided local install now clears system-hardening and the database setup — two more crashes fixed, one of them before anyone hit it.**

A follow-up to v1.9.18 on the guided-install path. Anyone installing locally should use v1.9.19.

## Fixed

**The installer no longer crashes during system hardening.** On v1.9.18, a local "Full guided install" completed the base setup and then stopped while writing the hardened SSH configuration, with an `'ansible_user' is undefined` error. A commented example line in the SSH config template referenced a value that only exists for remote installs — and it was being evaluated even though the line was commented out. It's now handled for local installs, so hardening runs through.

**The installer no longer renames your computer to "localhost."** On a local install, the setup was setting the machine's hostname to `localhost`. That step is now skipped for local installs, leaving your computer's name unchanged (it still applies for remote server installs, where it's intended).

**The database step no longer crashes (caught pre-emptively).** While validating the install end-to-end, we found that the PostgreSQL setup would have failed the moment it ran, because it looked up the installed-package list without first gathering it. This is now fixed before it could affect anyone.

## Under the hood

- A new internal check scans every hardening/service template for the class of "undefined on a local install" reference that caused two of the crashes above, so it can't recur.

## Notes

- No database migrations. No breaking changes.
- If a v1.9.18 local install stopped during hardening, nothing needs undoing — re-run from a fresh v1.9.19 download.
