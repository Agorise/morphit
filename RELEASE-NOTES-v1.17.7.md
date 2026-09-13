# Morphit v1.17.7

Finishes what v1.17.6 started: the snapshot publisher now works when run on a
schedule, and operator alerts stop repeating themselves. No protocol or consensus
change.

## Fixed

- **The snapshot publisher works on a timer.** It talks to IPFS by switching to
  the IPFS account first — and on a hardened server, *both* of the standard tools
  for doing that are blocked: one is refused outright by the service's security
  settings, the other is not permitted to change accounts at all. The job is
  already running with full privileges and does not need to switch accounts: the
  IPFS command line only reads a small file and then talks to the running service
  over a local connection. It now tries talking directly first, falls back to
  each account-switching tool in turn, and uses whichever actually works —
  reporting which one it chose. Guessing which tool a given server permits is
  what made this fail repeatedly.
- **Alerts stop repeating.** A unit that stayed broken produced a CRITICAL alert
  every five minutes, over and over, for the same unchanged fact. Alerts now fire
  when something *changes*: once when a unit fails, once when it recovers, and
  again if it fails afresh. A repeat failure is never swallowed, and if the
  bookkeeping cannot be written the behaviour falls back to alerting every scan
  — never to silence.

## Added

- **The alert monitor is now genuinely run during testing**, driven through a
  whole failure → recovery → failure-again cycle, because "alerts once and then
  stays quiet" is a property you can only observe by running it repeatedly.
- **The publish test now reproduces a server where both account-switching tools
  are blocked**, which is the exact situation that broke the live publisher.

## Notes

- No protocol/consensus change. Everything here is operator-facing.
- If you disabled the publish timer to stop the alerts, re-enable it after
  upgrading: `sudo systemctl enable --now morphit-snapshot-publish.timer`.
- `OPERATIONS.md` §52 covers the snapshot pipeline and how to check it.
