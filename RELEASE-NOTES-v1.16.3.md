# Morphit v1.16.3

**The "zero clearnet" story is now told across the site — because it's now true and proven — plus two defense-in-depth hardening fixes from a fresh security audit of the v1.16.x delta.** No consensus or protocol change; a content + hardening release.

## Added

- **"Run with zero clearnet" is now documented everywhere it should be.** With hidden-only clearnet elimination proven live in the directory, the capability is explained across the site: a new Security-page section, an expanded privacy FAQ answer, a rewritten brag-list entry, a new row in the comparison image, and a network-privacy note on the Privacy page — all translated across the ten locales. The framing is deliberately per-node and honest: a Morphit node *can* run with zero clearnet (every outbound path over Tor/I2P, verified by the seven-leg gate), and one — morphitlat — does, while a clearnet instance still uses clearnet by design. A publishable blog draft accompanies the release.

## Changed

- **Contact-link phishing hardening (audit finding v16-2).** The userinfo-phishing rejection (`https://matrix.to@evil.com`) now lives in the shared contact-URL detector and the render sanitiser, not only in the on-chain gate — so the on-chain handler, both entry validators, and the frontend renderer all enforce it and can no longer drift. Nothing exploitable was reachable before this (the on-chain gate already blocked it); this closes a consistency + defense-in-depth gap.
- **Hidden-transport address validation (audit finding v16-1).** The `clearnet_eliminated` transport legs now validate that an operator's advertised Tor/I2P address is a real `.onion` / `.i2p` host (via the shared strict classifier) instead of accepting any non-empty string, so a typo can't assert the leg.

## Notes

- **No behaviour change for clearnet nodes**, no migration, no protocol change. Offline-first preserved; no new external dependency.
- **Fresh security audit of the v1.16.0→v1.16.2 delta** (`docs/AUDIT-v1.16.x-DELTA-DEEP-DEEP.md`): the privacy keystone (clearnet-elimination gate) and hidden-transport layer were verified sound; the two findings above were the only gaps, both fixed. Threat models refreshed for the federation / clearnet-elimination / hidden-transport architecture (`docs/audit/2026-09-v1.16-delta-threat-model.md`).
- **CI now catches browser-bundle breaks earlier.** A new `web-build-smoke` runs `vite build` in the battery, so a Node-only import reaching the client bundle fails on push (and locally) rather than at release time — the exact class of break that slipped to CI in v1.16.2. Two guard smokes pin the audit invariants.
