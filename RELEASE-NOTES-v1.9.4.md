# Morphit v1.9.4

## Morphit now hosts its own releases — no outside company required

v1.9.2 had every Morphit instance pin the signed release to **IPFS**, the peer-to-peer file network. v1.9.3 finishes the job: keeping Morphit's own download alive no longer depends on **any** commercial pinning service. The release is content-addressed and served straight from Morphit's own nodes — the instance that publishes a release seeds it, and every other instance carries a copy — so the app's bytes stay reachable with zero reliance on a third party that could vanish or start charging. It's the same trustless idea as the mirrors, now with no middleman at all: you can still check any download against the hash and the IPFS address that Morphit itself published on the blockchain.

## One permanent address that always points to the latest release

Alongside each release's own address, Morphit keeps a single, **permanent name** that always resolves to the newest signed release. It's one stable link you can bookmark — it never changes, and every new release simply re-points it at the latest version. Pull `morphit-latest.tar.gz` from it and you've always got the current release, with the on-chain hash telling you exactly which version you received.

## A guard so "download over IPFS" is never a dead end

Publishing an address onto a blockchain is permanent, so Morphit now refuses to publish one until it has confirmed — on an independent public gateway — that the content is actually there and fetchable. If a release's IPFS copy isn't reachable yet, Morphit simply ships on the git mirrors and the signed tag (which are always available) and records no broken pointer. The verification anchors you rely on — the signed tag, the GPG signature, and the on-chain SHA-256 — are unchanged.

## For operators

Hosting the release is unchanged and still on by default. After an upgrade you can make your box an origin host for the new release in one step from `morphit-ops` (**Harden this server → "Seed this release to IPFS"**). The full details are in RUN-A-MORPHIT-NODE.md and OPERATIONS.md §48, and anyone can verify a download over IPFS or IPNS by following VERIFY-YOUR-DOWNLOAD.md.
