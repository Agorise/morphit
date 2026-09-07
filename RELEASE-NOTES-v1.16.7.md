# Morphit v1.16.7

**Three operator-facing robustness fixes, all found by one node's real incident.**
A cosmetic branding field could crash-loop and take an instance offline; an
operator's tag could read as null even when correctly registered; and the WAF
could 403 a legitimate avatar upload. All three are fixed, and the fixes apply
themselves on upgrade — no ansible re-run, nothing to do by hand.

## Fixed

- **A bad contact URL can no longer take an instance down.** A bare email typed
  into `edit → branding` (no scheme, so not a URL) used to fail the indexer's
  config validation and crash-loop the whole node offline. Now:
  - the indexer treats an invalid `MORPHIT_INSTANCE_CONTACT_URL` as *unset* with a
    warning instead of a fatal error — a contact typo degrades gracefully;
  - `edit → branding` validates the link, repairs a bare email to `mailto:…`, and
    refuses anything it can't make into an allowlisted contact URL — with a clear
    message, before writing;
  - **upgrade auto-repairs** a bare-email contact URL already on disk, so any node
    that has one is healed by upgrading rather than left broken.
- **`operator_tag` no longer reads as null when it's actually set.** verify.json's
  builder resolved the operator tag from a config path that the upgrade's frontend
  build didn't always see (it can run from a subdirectory), leaving `operator_tag:
  null` even when the tag was correctly registered on-chain. It now resolves the
  install-root config via absolute paths and a walk-up, so a set tag is reported.
- **The WAF no longer 403s the avatar upload.** bunkerweb's OWASP CRS at high
  paranoia flagged the base64 payload of a legitimate avatar broadcast. The
  `/v1/` (indexer) and `/relay/` (relay) JSON APIs — which are validated by their
  own op-allowlist, schema, invite gate, altcha, and rate limits — are now exempt
  from ModSecurity; the human-facing web surface keeps full WAF protection. The
  upgrade applies this to existing nodes automatically and reloads bunkerweb.

## Notes

- No protocol/consensus change, no migration, no data change; offline-first
  preserved. `morphit-ops upgrade` applies all three fixes on its own — operators
  don't re-run the installer or touch bunkerweb by hand.
- New `contact-url-resilience-smoke` (17 checks) pins every part: the
  normalize/repair helper, the indexer's non-fatal load, the edit-branding
  validation, the upgrade auto-repair (contact URL + WAF), and the verify.json
  path resolution.
