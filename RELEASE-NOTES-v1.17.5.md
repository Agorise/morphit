# Morphit v1.17.5

The fast-sync snapshot pipeline now actually runs. Three separate faults meant it
had never worked end to end — which is why no snapshot had ever been published
since the feature shipped. All three were found by rehearsing the thing for real
rather than by inspecting it. No protocol or consensus change.

## Fixed

- **Publishing a snapshot works.** The publisher read the snapshot's own
  description sheet by handing it to a small helper program down the same channel
  the program itself arrives on — so the description was discarded and the helper
  received nothing. It failed on the very first attempt, every time, which is why
  no federation snapshot had ever been published. The description is now handed
  over separately.
- **Mirroring a snapshot works.** The mirror job looked for the IPFS data store in
  the wrong place: it ran as the system administrator, whose data store is empty,
  rather than as the account that owns the real one. So it refused to fetch a file
  the very same machine was already serving. It now uses the right account, and
  its start-up check confirms the data store is genuinely reachable instead of
  merely confirming the software is installed — a check that could not tell the
  two situations apart.
- **The fast-sync rehearsal needs no database.** `--verify-only` was meant to
  fetch and check a snapshot without touching anything, but one leftover database
  lookup ran before it finished, so it failed on any machine without a configured
  indexer. That lookup is only needed when actually restoring, and is now skipped.
- **A rehearsal no longer demands invented settings.** It insisted on four
  configuration values it never used. It now fills in the ones it does not need
  and asks only for the chain identifier — which is deliberately never guessed,
  because it is the check that stops a node accepting a snapshot from a different
  chain.
- **Snapshot size reads correctly.** A 583 kB snapshot was reported as "0 MB",
  which looked like the export had failed.

## Notes

- No protocol/consensus change. Everything here is publisher- and
  operator-facing.
- The first federation snapshot is now published and anchored on-chain, and has
  been fetched and verified from an unrelated machine over a public gateway. New
  instances can fast-sync.
- `OPERATIONS.md` §52 covers the pipeline, how to publish, and how to check it.
