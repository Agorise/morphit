# Morphit v1.9.13

**Theme: the warrant-canary upload survives upgrades on a root-owned install — for real this time.**

v1.9.12 was meant to keep the canary upload working across upgrades without
re-fixing folder permissions by hand. On a root-owned `/opt/morphit` install it
didn't: the upgrade read the served folder's ownership from the freshly-extracted
(root-owned) tree instead of your previous install, found no non-root owner to
preserve, and left the folder root-owned. This release fixes that, and also
removes an internal chat-debugging facility that is no longer needed.

## Fixed

**Canary upload no longer breaks on upgrade (root-owned installs).** If you serve
Morphit from a root-owned `/opt/morphit` and sign your canary on a separate
machine, every upgrade used to re-root the served folder, so your next canary
upload failed with "permission denied" until you fixed the ownership by hand. The
upgrade now reads the folder's owner from your *previous* install — where your
ownership actually lives — and restores it, so the upload just works.

**One-time note for this upgrade:** an upgrade runs the version you're upgrading
*from*, so the fix takes effect on the *next* upgrade after this one. On a
root-owned install, run `sudo chown -R <your-ssh-user> /opt/morphit/apps/web/build`
once more right after you upgrade to v1.9.13 — and you won't need it again after
that.

## Changed

**Removed the chat delivery debug tracer.** The opt-in chat tracer (the
`?chatdebug` / `morphit.debug.chat` toggle) built during an earlier chat
investigation is gone — the investigation is resolved, and removing it drops a
console-debug path from production and trims the footprint. No effect on normal
use.

## Notes

- No database migrations. No breaking changes.
- Home-hosted (user-owned install) nodes were never affected by the canary bug and
  need nothing here.
- The canary's signing model is unchanged: signed with your own PGP key, off the
  served box when you want it that way, so it goes stale exactly when it should.
