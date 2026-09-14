# Morphit v1.17.9

Clears the whole remaining follow-up list. Mostly about instances telling you the
truth: catching an advertised address your own router does not actually host,
and not burying you in repeats of the same alert. No protocol or consensus change.

## Fixed

- **An instance now notices when it is advertising an address it does not host.**
  One instance published a privacy-network address that its own router had stopped
  serving — the key had been regenerated at some point and the setting was never
  updated. Every peer trying to reach it that way failed, for an unknown length of
  time, hidden by its other address still working. Your machine already knows the
  answer: both privacy services publish locally what they are really hosting. An
  upgrade now compares the two and, if they differ, prints both and the exact
  setting to change.
- **A check no longer explains away its own finding.** When that address was
  broken, the message said privacy tunnels are slow to start and to try again
  later — so nobody investigated. It now distinguishes "no answer yet", which
  genuinely deserves patience, from "an answer came back", which means the tunnel
  is working and something further along is wrong.
- **Alerts stop repeating themselves.** Background checks run on a timer, so an
  unchanged problem was re-announced every few minutes. The same condition is now
  reported at most once every six hours; any change is reported immediately, and a
  persisting problem still re-announces on that cadence so nothing is forgotten.
  If the bookkeeping cannot be written it goes back to reporting every time —
  never to silence.

## Added

- **You can now rehearse fast-sync from the menu.** "Fast-sync" accepts a rehearse
  option that finds, downloads and verifies the newest snapshot and then stops,
  touching nothing. It is safe on a running instance. Previously this required a
  hand-typed developer command, which meant the one thing most worth testing was
  never tested.

## Notes

- No protocol/consensus change. Everything here is operator-facing.
- If an upgrade reports an address mismatch, fix the setting it names and then
  re-publish your registration so other instances learn the working address.
- To rehearse: `sudo morphit-ops fast-sync --rehearse`.
