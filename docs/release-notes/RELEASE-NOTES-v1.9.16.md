# Morphit v1.9.16

**Theme: a smoother path to running your own node — the guided installer now works the same however you install it, confirms more of what it set up, and can point visitors to your Matrix — plus a few interface fixes.**

Most of this release is for people running (or about to run) their own Morphit
instance. If you only trade, the visible changes are that usernames read
correctly in more places and the instances directory is a little tidier.

## Fixed

**Usernames read correctly in right-to-left languages, everywhere.** A follow-up
to v1.9.15: with Persian (Farsi) selected, a handle like `@alice` still rendered
as `alice@` in a few remaining spots — the operator handle on an instance card,
the account menu, the block explorer, and the compare view. All of those now
render left-to-right, `@` first, like the rest of the app.

**The guided installer no longer claims success when nothing installed.** A local
install could print "installed and running" while the playbook had actually
matched zero hosts and done nothing. The installer now confirms it has a host to
act on before it starts, and reports honestly.

**Several guided-setup fixes for operators,** including: the dynamic-DNS step no
longer insists on an `{ip}` placeholder your provider fills in for you; the fees
account defaults sensibly; and `morphit-ops` now installs as a real command, so
`sudo morphit-ops register` works from anywhere.

## Added

**The installer now asks for your instance title, a one-line description, and an
optional Matrix account.** The title and description appear on the shared
`/instances` directory that traders on other nodes browse. If you add a Matrix
account (like `@you:matrix.org`), the "Contact this operator" link on your
instance's card becomes live so traders can reach you — leave it blank if you
don't have one yet.

**The end-of-install summary confirms more of what it set up.** Your Tor onion
address, your I2P address, your warrant canary, and your PGP contact key each now
get a green check when they're in place, alongside the database, relay, indexer,
and HTTPS certificate.

**`morphit-ops harden` can set up your warrant canary and PGP contact key** — a
guided step that signs the canary off your public server (so it can't keep
stamping "all clear" if the box is ever seized) and posts your own PGP key.

## Changed

**Registering your instance works the same however you install it** — over SSH on
a VPS, locally on a Raspberry Pi or an old laptop, or by hand after the fact.
Running `sudo morphit-ops register` now finds everything it needs in all three
cases.

**The "you are here" marker on the instances directory is centered** between your
instance's name and its status, on the same line.

## Notes

- No database migrations. No breaking changes.
- The right-to-left handle fix is structural — applied to interface strings as
  they load — so it stays correct as translations change; the fixes in this
  release cover the few handles that are drawn directly rather than from a
  translation string.
