# Morphit v1.12.17

**Theme: the hidden-RPC directory is now live on the stats page — pin a node, everyone sees it, no release required.**

## Changed

**The stats page's RPC list now reflects the on-chain directory, network-wide, automatically.** Previously the hidden-service (Tor/I2P) nodes shown on the stats card came from a value baked into each indexer at startup, so a node pinned to the chain (`morphit_rpc_v1`) never appeared without a rebuild. Now every indexer serves its RPC list as its configured seed **plus the live on-chain `rpc_directory`**, re-derived per request (cached ~60s). The effect:

- **Pin a hidden node on-chain → it appears on every instance's stats page** within the indexer's normal indexing lag, on the user's next visit. No per-operator action, no Morphit release.
- **Remove one → it drops off** (the directory is latest-wins).
- Clearnet nodes are unchanged (still hardcoded), still mixed in and sorted by latency.
- Privacy is preserved: a tor-only instance still never probes clearnet nodes; hidden directory nodes are reached over Tor/I2P as before.

This is the one-time wiring change. After this release, adding, updating, or removing hidden-RPC nodes is release-free forever.

## Fixed / Hardened

- **CI can no longer be tripped by a stray `vendor/` folder.** The offline-appliance build output (`vendor/`) is now git-ignored (root-anchored, so the real `ops/ansible/roles/vendor` is untouched), and the source-scan smoke skips broken symlinks instead of crashing on them.

## Notes

- No database migration in this release.
- Everything from v1.12.16 and earlier (the attack-resilience edge hardening, the incident runbook, the security-audit set, the CI supply-chain gate) is included.
