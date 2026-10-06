# Morphit v1.17.14

Three fixes to what an upgrade tells you and how long it interrupts your site.
No protocol or consensus change.

## Fixed

- **Your site is restarted once per upgrade instead of twice.** The web front end
  was rebuilt and restarted a second time moments after the first, every upgrade,
  even when nothing about it had changed — a short outage for no reason. The
  second pass exists for a real case (an older installer that does not rebuild),
  so it now asks the running site what settings it is actually using and does
  nothing when they already match.
- **The warrant-canary reminder now tells you the truth for your setup.** It said
  the canary "republishes on its own at the next scheduled weekly refresh". That
  is only true on an instance that runs that refresh itself. If you sign your
  canary on another computer, nothing on the server republishes anything — and
  believing otherwise would let it go stale after 14 days and show your visitors
  a false tamper warning. The reminder now checks which setup you have and says
  what actually applies.
- **A privacy-only instance no longer gets two contradictory messages.** One said
  a check was skipped because the instance is reached through Tor and I2P; the
  next told it to configure an ordinary web address it correctly does not have.

## Notes

- No protocol/consensus change. Everything here is operator-facing.
- If a recent upgrade warned that your privacy address was "advertised wrong",
  that came from the previous version doing the check. It settles once every
  instance is on this release.
