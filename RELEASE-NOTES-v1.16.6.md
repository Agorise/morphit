# Morphit v1.16.6

**A privacy-critical fix.** A hidden-only, zero-clearnet instance was fetching its
own software upgrade over clearnet (git.agorise.net, with a Codeberg probe) instead
of over Tor/I2P. This release makes a hidden-only node resolve its upgrade entirely
over hidden services — or refuse — and say exactly which hidden gateways it used.
Ship this immediately if you run any hidden-only node.

## Fixed

- **Hidden-only upgrades no longer touch clearnet.** The upgrade's hidden-only
  detection had two faults, each enough to send a zero-clearnet node down the
  clearnet path:
  1. It read `morphit.config.env`, but the RPC pool that signals hidden-only
     (`MORPHIT_INDEXER_RPC_ENDPOINTS`) lives in `indexer.env` — so it never found
     the key and defaulted to clearnet.
  2. Even against the right file, the value-matching regex used `\s*`, which
     matches newlines, so an empty `MORPHIT_INDEXER_RPC_ENDPOINTS=` captured the
     *next* config line and read as non-empty.
  The result: on a hidden-only box the release was downloaded from git.agorise.net
  over HTTPS. Both are fixed, and the detection is now **authoritative**: it asks
  the local indexer's `/v1/instance` for `clearnet_eliminated` — the same
  seven-leg gate that earns the directory badge — and only falls back to the
  (now correctly-read) config file if the indexer is unreachable. A hidden-only
  node fetches the release over Tor/I2P from a federation peer's IPFS gateway,
  verified against the on-chain SHA-256, and **fails closed** — it never falls
  back to a clearnet mirror.

## Changed

- **The upgrade now names the hidden services it used.** On a hidden-only node it
  reports the IPNS target, the hidden gateways it is fetching over (host + Tor/I2P
  tag), and the gateway that served the verified tarball — and states plainly that
  no clearnet host was touched. No more guessing where the bytes came from.

## Notes

- No behaviour change for clearnet instances; no protocol change; no migration.
- New `hidden-upgrade-detection-smoke` (13 checks) pins both faults closed: the
  file heuristic keys off the right variable and can't be fooled by an empty
  value, the detector prefers `clearnet_eliminated`, the caller reads
  `indexer.env`, and the resolver reports the hidden gateway and states
  "zero clearnet."
- If you already upgraded a hidden-only node to v1.16.5 (which fetched over
  clearnet), upgrading to v1.16.6 restores the hidden-only path for all future
  upgrades.
