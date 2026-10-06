# Morphit v1.16.0

**The privacy foundation for max-privacy "hidden-only" nodes (Tor *and* I2P as equals), a faster optional catch-up engine, and two fixes that were locking operators out of their own servers.**

This is a feature release. The headline work is the first wave of the **hidden-only** architecture — a node that reaches the chain, its prices, and (soon) its upgrades over Tor/I2P and never touches a clearnet host. It ships behind a strict, provable gate that stays **off** until every leg is real, so nothing claims more than the code enforces.

## Added

**Hidden-only privacy foundation (opt-in; a node becomes hidden-only when its clearnet RPC pool is empty).**
- **Fail-closed clearnet routing.** On a hidden-only node, a public clearnet origin is *refused* at the dispatcher — errored, never sent over the open internet — so the node can't deanonymize itself even if a code path slips a clearnet URL through. Local/loopback and `.loki` are unaffected; `.onion`→Tor and `.i2p`→i2pd still route. Clearnet-RPC nodes are byte-for-byte unchanged.
- **Federation-syndicated pricing.** A hidden-only node no longer calls any clearnet price API. It prices from the **federation median** of peers' signed `morphit_native` receipts, fetched over each peer's on-chain `.onion`/`.i2p` address (I2P preferred). The peer set is chain-driven, so a newly-registered instance joins the syndication automatically — no config anywhere.
- **Local-only frontend, enforced.** A build-time smoke fails CI if the served bundle ever auto-loads an external clearnet resource (font/script/style/analytics). Today it's clean.
- **Verified hidden upgrade fetch (core).** The release-fetch logic pulls the tarball from peers' hidden IPFS gateways, races several peers (first verified wins), checks it against the on-chain SHA-256 (anti-rollback), and fails closed with no clearnet fallback. (Transport wiring into the upgrade command lands next.)
- **The `clearnet_eliminated` gate.** A strict AND of seven legs — chain-hidden, **Tor**, **I2P**, price-federated, frontend-local, upgrade-hidden, matrix-clean. Dual-transport is mandatory (a Tor-only node can't claim it), and a clearnet Matrix homeserver voids it. Exposed on `/v1/instance` with a `clearnet_eliminated_missing` diagnostic so an operator sees exactly which legs are open. **Currently false everywhere** — the strong "zero clearnet" claim renders nowhere until a node proves every leg.

**Adaptive flow-backfill (opt-in, default `fifo`).** A new out-of-order reorder-buffer catch-up path (`MORPHIT_INDEXER_BACKFILL_MODE=flow`) that keeps every healthy RPC endpoint busy and applies the contiguous block prefix as it fills, so a slow Tor/I2P endpoint no longer head-of-line-blocks a genesis replay. Memory-governed (cgroup-aware, backpressure + RSS safety valve), with a cursor-window hedge and bounded retries. Strict in-order apply is preserved.

## Fixed

**The hardening step no longer locks you out of your own server.** On a Contabo/OVH-style box (password-only root, no SSH key), enabling hardening used to disable password + root login with no key in place — a guaranteed lockout. Hardening now detects whether any SSH public key exists and, if none does, **leaves password login enabled** and prints exactly how to add a key and re-run — so it can never lock you out, and never silently half-hardens.

**The warrant-canary refresh stops asking for your passphrase three times.** The refresh made several separate SSH connections (a dir check + two uploads), each prompting again. It now reuses **one** authenticated SSH connection (ControlMaster) across all of them, so a remote-hosted canary refresh prompts once for SSH instead of per-operation.

## Docs

- The "Make it your own" section now lists the exact brand files and their sizes (mark ~1.55:1, wordmark ~5.8:1, favicon, PWA icons 512×512 with a maskable safe-margin), plus the `hero_title`/`hero_body` and header/footer i18n keys — so a new operator can rebrand without guessing.

## Notes

- **No breaking change for existing clearnet nodes.** Every hidden-only behaviour activates only when the clearnet RPC pool is empty; flow-backfill is opt-in. Upgrade in place.
- Additive schema only; safe to upgrade mid-sync (migrations are idempotent and the indexer resumes from its persisted cursor).
- New env: `MORPHIT_INDEXER_BACKFILL_MODE`/`_MAX_BUFFER_MB`/`_MEM_FRACTION`/`_HEDGE_FACTOR`, `MORPHIT_INSTANCE_MATRIX_HOMESERVER` (all optional, safe defaults).
- Still in flight for a later release: the upgrade command's Tor/I2P transport + peer kubo-gateway-over-hidden infra (the `upgradeHidden` leg), and the operator-facing "zero clearnet" content — both land only once provable on a live box, keeping the gate honest.
