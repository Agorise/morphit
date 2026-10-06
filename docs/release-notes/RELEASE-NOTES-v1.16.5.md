# Morphit v1.16.5

**A big usability + robustness release, all in the browser client.** One source of
truth for chain-write errors so no save ever fails cryptically, a real fix for
duplicate operator identicons, the zero-clearnet story on the privacy policy, a
guard that stops a doomed operator re-registration, and a hardened avatar upload.
No consensus or protocol change; no migration.

## Added

- **One source of truth for chain-write errors.** Every operation that writes to
  the chain — saving your profile, posting an order, leaving or responding to
  feedback, blocking someone — now routes failures through a single classifier
  that names the exact problem *and* the fix, in all ten locales, and never a
  dead-end "try again" or "open DevTools." Covered causes: your instance being
  unreachable or unable to reach the Blurt network (including network/country
  filtering), you being offline, too little liquid BLURT for the operation fee, an
  oversized payload, an unauthorized signing key, a device-clock skew that expires
  the transaction, a duplicate, and — for anything unrecognized — the raw chain
  reason verbatim.
- **Zero-clearnet on the Privacy policy.** The privacy-terms page now explains, in
  all ten locales, that a Morphit node can run with zero use of the clearnet
  internet (every path over Tor/I2P, verified) — alongside the existing Security
  page, FAQ, brag list, and comparison coverage.

## Changed

- **Operator-page identicons are unique again — for real this time.** The fix now
  lives in the component that actually renders them (`IdentityLabel`), which was
  seeding from raw UTF-8 bytes, so accounts sharing a prefix (`morphit`,
  `morphitir`, `morphitlat`) drew near-identical hearts. String seeds are now
  avalanche-hashed; real avatar-byte seeds are untouched. A structural regression
  pins that the render path uses the hasher, so a fix that misses it can't pass.
- **Avatar upload, hardened end to end.** The "getting close to the size limit"
  nag is gone (a file under the cap needs no warning); a very long or space-laden
  filename is shown truncated and can't overflow the card; a double-click can't
  fire — or pay the fee for — the broadcast twice; and a pixel-bomb (a small file
  that decodes to enormous dimensions) is rejected up front by reading the header,
  before it can freeze the tab, with an accurate "downscale it" message.
- **Wording: Blurt uses a liquid-BLURT fee, not resource credits.** Broadcast
  error copy now describes the real Blurt model (a small per-operation fee paid
  from liquid BLURT) instead of the Steem/Hive "resource credits" it does not use.

## Notes

- **A doomed operator re-registration is now caught before broadcast.** The
  federation tag is immutable; `morphit-ops register` now checks your account's
  existing on-chain tag against the local indexer first and refuses (with the
  exact fix) if they differ, instead of emitting an op the chain silently rejects
  as `tag_immutable`.
- No behaviour change for existing data; offline-first preserved; no new external
  dependency. New guard smokes pin the classifier (39 checks), avatar robustness
  (44), and the tag guard (9).
