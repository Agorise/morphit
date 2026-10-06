# Morphit v1.17.13

Stops an upgrade interrupting operators who sign their warrant canary on a
separate computer. No protocol or consensus change.

## Fixed

- **An upgrade no longer stops to ask about your warrant canary if you already
  have one.** If you sign your canary on another machine and upload it, a
  redeploy clears the copy on the server until you upload the next one. The
  upgrade only remembered as far back as the previous install, so if you ever
  skipped an upload, the next upgrade concluded you had never had a canary and
  offered to create one on the server — which would have made a second signing
  key competing with your real one, and stopped an unattended upgrade waiting
  for an answer. Your instance now remembers permanently that you have a canary,
  and also checks whether your live site is serving one. A brand-new instance
  with no canary at all is still offered one, as before.

## Notes

- No protocol/consensus change. Everything here is operator-facing.
- If a recent upgrade asked you about setting up a canary and you sign yours
  elsewhere, answering "no" was correct. After this release it will not ask again.
