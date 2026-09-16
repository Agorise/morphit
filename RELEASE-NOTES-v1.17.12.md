# Morphit v1.17.12

Fixes a mistake introduced in v1.17.11 that stopped an upgrade finishing its
final checks. No protocol or consensus change.

## Fixed

- **The last step of an upgrade completes again.** v1.17.11 added a check that
  skips an irrelevant test on privacy-only instances. On an ordinary instance
  that check looked at a value that had not been set yet, which stopped the
  script on the spot. The release itself was never at risk — it was published,
  recorded on-chain and pinned before this point — but the instance stopped
  before confirming it serves the new version over Tor and I2P, so other
  instances could not be sure they could fetch it from you. Upgrading applies
  the fix; nothing else is needed.
- **The retry advice now works.** The message shown when that step fails pointed
  at a command that could not run on its own. It now names the menu entry that
  does the job, and says plainly what was left unfinished rather than implying
  the whole thing failed.
- **No more "new version of npm available" after an upgrade.** That notice was
  already meant to be silenced, but it was silenced too late in the process to
  take effect. It advised an upgrade you should not perform, since each release
  ships with the versions it was tested against.

## Notes

- No protocol/consensus change. Everything here is operator-facing.
- If your last upgrade ended with a warning about the self-seed step, this
  release is the fix. After upgrading, that step runs to completion on its own.
