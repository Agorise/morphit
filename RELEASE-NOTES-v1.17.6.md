# Morphit v1.17.6

Two things get fixed here: operator alerts that were unreadable, and a snapshot
publish timer that could not complete a single run. Both had the same underlying
cause — code that was only ever run by hand, never under the conditions it runs
in for real. No protocol or consensus change.

## Fixed

- **Operator alerts arrive in ONE conversation, and you can read them.** The alert
  bot remembered which private conversation to use only until it restarted — and
  it restarts on every upgrade. So each upgrade started a brand-new conversation,
  filling your inbox with duplicates, and because each new one needed its own
  encryption keys shared to a device the bot had never been introduced to, most
  alerts arrived as "Unable to decrypt message". The conversation is now
  remembered across restarts, and encryption is off by default for alerts: an
  alert you cannot read is worth nothing, and these are notices to your own
  account, not secrets. Set `MORPHIT_MATRIX_ENCRYPT=1` to turn it back on.
- **Recovering from an encryption-key conflict no longer loses your place.** That
  recovery deleted the bot's entire saved state — which also held its position in
  the alert stream and the conversation it uses — so "fixing" encryption started
  yet another conversation. It now clears only the encryption keys.
- **The snapshot publish job can complete a run.** Under the service manager it
  failed at a different step each time, for five unrelated reasons, none of which
  appeared when the same script was run by hand: the file was not marked
  executable; a failure discarded the explanation instead of printing it; moving
  the finished snapshot out of a private temporary area failed because it crossed
  a storage boundary; the tool used to switch to the IPFS account is not permitted
  under the service's own security settings; and the check for "is IPFS up?" gave
  up instantly even though this very script restarts IPFS moments earlier.
- **Two other background jobs could never start either.** The release monitor and
  the treasury re-pin were shipped without the executable flag, so the service
  manager refused to run them. Probably for some time, silently.
- **A failing publish now tells you why.** Several steps sent a failed command's
  output to the bin and reported only "failed". They now print what the command
  actually said.

## Added

- **The publish and mirror jobs are now really run during testing**, against
  stand-in IPFS and chain services, instead of only being read. Every failure
  listed above was reproduced and confirmed to be caught by these new tests. The
  mirror test also confirms it refuses a snapshot whose contents do not match the
  published fingerprint, and one published for a different chain.
- **A standing check across every background job**: each must be executable, must
  not use a privilege tool its own security settings forbid, and must not discard
  the output of a command whose failure it is reporting.

## Notes

- No protocol/consensus change. Everything here is operator-facing.
- If your alert inbox has several "Morphit alerts" conversations, you can leave
  the old ones; after upgrading, the bot settles on one and stays there.
- `OPERATIONS.md` §52 covers the snapshot pipeline, publishing, and how to check
  it.
