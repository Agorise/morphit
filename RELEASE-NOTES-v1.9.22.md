# Morphit v1.9.22

**Theme: the guided install now creates every drop-in configuration directory it writes into, so hardening can't stop on a "directory does not exist" error.**

This is the companion hotfix to v1.9.21. That release fixed the SSH-hardening step for machines without an SSH server; this one fixes the same *class* of problem one step later. On some machines the password-policy step stopped with *"/etc/security/pwquality.conf.d does not exist"* — the password-quality package installs its main config file but doesn't create the drop-in directory, so writing into it failed.

## Fixed

**Every hardening drop-in now ensures its directory first.** Instead of trusting each system package to have created its own `.d` drop-in directory (some do, some don't), the installer now creates the directory before writing into it — for the password policy, the audit rules, the AIDE integrity rules, and the SSH hardening. The result is the same hardened configuration; it simply no longer depends on a package having pre-made a directory.

We also added an internal build check that fails if any future drop-in write forgets to ensure its directory, so this whole class of "directory does not exist" install stoppage can't come back.

## Notes

- No database migrations. No breaking changes.
- If your last install stopped at the password-policy step, nothing needs undoing — re-run the guided install with this version and it will pick up cleanly and finish.
