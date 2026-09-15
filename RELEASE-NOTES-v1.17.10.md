# Morphit v1.17.10

Removes a step that could hold a release hostage, and finishes the operator-facing
follow-ups from v1.17.9. No protocol or consensus change.

## Fixed

- **Publishing a release no longer waits on anyone else.** The release checklist
  ended with a step that asked a public gateway whether it could see the new
  version yet. Those gateways take minutes to notice fresh content, so a perfectly
  good release could sit there for half an hour, repeating "not yet" — and the
  operator had no way to tell a slow gateway from a real problem. That step is
  gone. The upgrade already proves the same thing better and earlier: it confirms
  the file it produced matches the one recorded for the release, and that it is
  being served over the instance's own address, its Tor address and its I2P
  address — which are the paths other instances actually use. A public gateway
  noticing later adds nothing and is outside anyone's control. The check is still
  available to run by hand if you ever want it; it simply cannot block a release.
- **When it is run by hand, it answers immediately.** Given the instance that just
  published, it asks that instance and returns in about a second instead of
  polling. Without one it says so plainly, with the exact command to re-run,
  rather than grinding through a long wait and looking like something is broken.

## Notes

- No protocol/consensus change. This is release-process and operator-facing only.
- Nothing you run on your servers changes. The difference is in the release
  checklist itself.
