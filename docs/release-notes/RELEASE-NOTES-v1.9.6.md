# Morphit v1.9.6

## Two more independent mirrors — the code is harder than ever to take offline

Morphit's source is mirrored across the web so it stays reachable even if one host is blocked or disappears. This release adds two more independent mirrors — **gitea.com** and **framagit.org** (Framasoft's forge) — bringing the mirror total to nine, alongside the peer-to-peer IPFS copy and the hash Morphit publishes on the blockchain. More independent homes means the code is that much harder to take down, and you can still check any copy against the signed tag and the on-chain SHA-256 to know it's the genuine, unmodified release.

## The permanent "always latest" address now resolves peer-to-peer — no DNS, no third party

Morphit keeps one permanent name that always points to the newest signed release. This release makes that name resolve the way it always should have: **natively over the peer-to-peer network**, with no DNS lookup and no company in the middle. Morphit signs the pointer once per release and every running instance re-announces it to the network on its own, so the address stays alive as long as a single instance is up — and no one, not even an operator, can quietly re-point it somewhere else.

## Two ways to grab the latest release

The download page now offers the always-latest release two ways: a pure peer-to-peer **`ipns://`** address (for an IPFS-capable browser like Brave, or your own node) and a plain **IPFS link** that works in any ordinary browser. The permanent address is also shown as copyable text so you can paste it straight into your own node. Whichever route you use, the on-chain hash still tells you exactly which version you received.

## For operators

There is nothing new to do. Keeping the peer-to-peer address alive is folded into the same one-step release-hosting setup you already run (**`morphit-ops` → Harden this server → "Set up IPFS release hosting"**): your instance re-announces the latest release automatically, on a timer, and never holds any signing key — it only relays the pointer Morphit already signed. The full details are in OPERATIONS.md §26, and anyone can verify a download by following VERIFY-YOUR-DOWNLOAD.md.
