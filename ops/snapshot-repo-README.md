# Blurt blockchain snapshot (block_log)

A periodically-refreshed, **self-verifying** snapshot of the Blurt chain's raw
`block_log`, used to bootstrap new [hidden-rpc](https://git.agorise.net/agorise/hidden-rpc)
nodes in hours instead of days.

The file is tracked with **Git LFS** (it's ~9 GB — far too big for ordinary git).

## Current snapshot

| | |
|---|---|
| **File** | `block_log-62905338.tar.zst` |
| **Height** | `62905338` |
| **SHA-256** | `450106efd678237e69c3d892b7fa0a61d2cc3f83785376c4c4441b5232026b72` |
| **Size** | ~9.1 GB compressed |
| **Contents** | `block_log` (+ `block_log.index`), zstd-compressed tar |

## Why you don't have to trust this host

You never trust the download. The snapshot's SHA-256 is published **on-chain** in a
signed `chain_snapshot_v1` op from `@morphit`, and after extraction blurtd runs
`--replay-blockchain`, which re-checks **every block's signature and prev-hash**. A
tampered or corrupt file fails at replay. So this repo is just a convenient mirror —
the on-chain pointer + replay are the trust anchors, not this server.

The hidden-rpc installer fetches this automatically (IPFS gateways first, then this
https mirror as a fallback). You normally never touch this file by hand.

## Verifying by hand (optional)

```bash
sha256sum block_log-62905338.tar.zst
# must equal the SHA-256 above AND the one in the on-chain chain_snapshot_v1 op
```

## Refreshing (maintainers)

A newer snapshot is produced with `make-snapshot.sh` on a synced hidden-rpc node
(Star/Jade), committed here (LFS), tagged by height, and re-pointed on-chain by
broadcasting a new `chain_snapshot_v1` op. Higher on-chain `block_height` wins.
