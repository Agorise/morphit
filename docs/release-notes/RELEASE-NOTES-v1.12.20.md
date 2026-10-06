# Morphit v1.12.20

**Theme: two fixes for things that silently didn't work.**

## Fixed

**Editing your instance title (or fee account) now actually takes effect on an Ansible install.** On a default install, `/etc/morphit/indexer.env` was sourced *after* `morphit.config.env` and carried its own copies of the branding keys (`MORPHIT_INSTANCE_NAME`, `_TAGLINE`, `_CONTACT_URL`) and the fee recipient — so a change made with `morphit-ops edit` was silently overridden by the install-time copy, and the instance kept self-reporting its old name to the federation directory. Those operator-editable keys now live only in `morphit.config.env` (the single source of truth the edit command writes), and the fee recipient moved there too. A guard keeps them from ever creeping back into `indexer.env`.

> **Existing Ansible installs:** re-converge the playbook to re-render `/etc/morphit/indexer.env` without the stale branding, or remove those keys from it by hand and restart the indexer. Fresh installs and ops-cli installs are unaffected.

**Firefox no longer paints saved-login fields olive-yellow.** The CSS that suppresses the browser autofill tint had `-webkit-` and `-moz-` autofill selectors combined in one list; because a CSS selector list is all-or-nothing, each browser rejected the other's prefix and dropped the whole rule — so the override worked in *neither*. It's now split into one self-contained rule per engine, and the field keeps the app's dark surface in Chrome and Firefox alike.

## Notes

- No database migration in this release.
- Everything from v1.12.19 and earlier is included.
