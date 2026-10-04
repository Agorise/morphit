# Morphit v1.16.4

**Supersedes v1.16.3 (never released).** A content + hardening release: the "zero
clearnet" story is now documented across the site (it's true and proven), two
defense-in-depth security fixes from a fresh audit of the v1.16.x delta, a shield
on the verified badge, a fixed operators-page identicon, and a CI gap closed. No
consensus or protocol change.

## Added

- **"Run with zero clearnet" is documented everywhere it should be.** With
  hidden-only clearnet elimination proven live in the directory, the capability
  is explained across the site — a new Security-page section, an expanded
  operator FAQ answer, a rewritten brag-list entry, a new row in the comparison
  image, and a network-privacy note on the Privacy page — all across the ten
  locales. The framing is per-node and honest: a Morphit node *can* run with
  zero clearnet (every outbound path over Tor/I2P, verified by the seven-leg
  gate), and one — morphitlat — does, while a clearnet instance still uses
  clearnet by design.
- **A 🛡️ on the verified badge.** Instances that qualify now show
  "🛡️ Zero use of clearnet internet" in the directory — the shield renders only
  on the strong, provably-earned label.

## Changed

- **Contact-link phishing hardening (audit v16-2).** Userinfo-phishing rejection
  (`https://matrix.to@evil.com`) now lives in the shared contact-URL detector and
  render sanitiser, not only the on-chain gate, so all four consumers enforce it
  and can't drift.
- **Hidden-transport address validation (audit v16-1).** The `clearnet_eliminated`
  transport legs now validate that an advertised Tor/I2P address is a real
  `.onion` / `.i2p` host, so a typo can't assert the leg.
- **Operators-page identicons are unique again.** Account-name identicons were
  seeded from raw UTF-8 bytes, so accounts sharing a prefix (e.g. `morphit`,
  `morphitir`, `morphitlat`) rendered near-identical hearts. String seeds are now
  avalanche-hashed so any name change diverges every byte; real avatar-byte seeds
  are unchanged.

## Notes

- **No behaviour change for clearnet nodes**, no migration, no protocol change.
  Offline-first preserved; no new external dependency.
- **Fresh security audit of the v1.16.0→v1.16.2 delta**
  (an internal audit record): the clearnet-elimination gate and
  hidden-transport layer verified sound; the two findings above were the only
  gaps, both fixed. Threat models refreshed (since replaced by the 2026-10
  models in `docs/audit/`).
- **CI now catches browser-bundle breaks.** A new `web-build-smoke` runs
  `vite build` in the battery, so a Node-only import reaching the client bundle
  fails on push (and locally) rather than at release time. Two guard smokes pin
  the audit invariants.
- **Operator note (not shipped in code):** an instance's operators-page title is
  the on-chain operator `display_name`, set from `MORPHIT_INSTANCE_NAME` at
  registration. Changing the instance name updates the /instances card but not
  the operator record until the operator re-registers (`morphit-ops register`,
  an account-keyed upsert).
