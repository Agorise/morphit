# Morphit v1.12.4

**Theme: tor-only nodes work end to end, and operators can move between clearnet and tor. A node installed with no clearnet — no domain, no TLS — now boots cleanly, reports its health honestly, and (once you re-register) advertises its .onion to the federation. Plus: relay keys are always encrypted, and the stats page gained the RPC-endpoints view.**

## Fixed

**Tor-only nodes now boot.** A node installed in tor-only mode previously crash-looped: the relay rejected its own `http://…onion` origin (demanding https), and the indexer had no public origin set (the template assumed a clearnet domain). Both are fixed — `.onion`/`.i2p` origins are recognized as self-authenticating and served over http, and the tor-only install now points the indexer's public origin at the onion.

**The .b32.i2p address is written correctly.** The i2p-address derivation split the address across two lines, corrupting the value and printing a harmless-but-alarming shell error at every service start. It's now a single clean line. This affected every install with i2p enabled, clearnet included.

**Health tells the truth when it can't see the chain.** A node that hasn't established a chain head yet — just restarted, or offline — no longer reports a false "synced" with a bogus zero-block lag. It reports "unknown" until it has a real chain head to compare against.

## Changed

**Operators can update their registration — and move between clearnet and tor.** Re-registering now updates your instance's origin, display name, and contact URL instead of being refused as "already registered." This is how you switch a node from a clearnet domain to a `.onion` (or back) and have the federation follow you. Your **tag stays permanent** (first-come-first-served, so nobody can take a name that's yours), and only the account that owns the registration can change it.

**Relay keys are always stored encrypted.** The setup wizard and key-rotation no longer offer a plaintext option. The relay unlocks an encrypted key automatically at boot from a host-bound sealed credential — no prompt, and a stolen disk can't decrypt it — so plaintext storage carried real risk for no benefit.

**Stats page: RPC endpoints and the data note now live here.** The "updated / building an aggregator" note is on its own card, and the RPC-endpoints list moved from settings to the stats page, where it's public transparency about which nodes an instance syncs from.

## Notes

- No database migration in this release.
- The registration change is consensus-level: every indexer applies the same upsert, so the federation converges. It's backward-compatible — a first-time registration behaves exactly as before.
- Existing clearnet nodes are unaffected by the tor-only fixes.
