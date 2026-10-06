# Morphit v1.12.18

**Theme: name your hidden-RPC nodes, and stop the stats card crying wolf.**

## Added

**Optional operator names for hidden-RPC nodes.** A node pinned to the on-chain directory (`morphit_rpc_v1`) can now carry an optional handle — a hostname like `oldpc`, or a Blurt `@handle` — so a misbehaving node can be identified and its operator reached. The name is **opt-in** (omit it and nothing lands on the chain), cosmetic, and never used to route or trust a node. Names appear on the public `/v1/rpc-endpoints` JSON, and — like adding or removing a node — a name change propagates to every instance within about a minute, **no release required**.

**`/v1/rpc-endpoints` is now sorted by latency.** The endpoint list (clearnet and hidden together) is returned fastest-first, with unmeasured nodes last — matching the stats page's ordering.

## Fixed

**The stats page no longer flags a healthy node as "unreachable" on a single blip.** The card shows the smoothed pool health, then fires one fresh probe and repaints with it — so a node on flaky WiFi or a jittery Tor/I2P circuit could miss that *one* ping and flash red while being up the vast majority of the time. A lone transient miss on a node the smoothed snapshot still considers healthy now stays up with its last-known latency. A genuine outage still shows red — the smoothed health drops and the failures climb.

## Notes

- Database migration in this release: an additive, idempotent column on `rpc_directory` for the optional node names (safe on a running database; nothing to do by hand).
- Everything from v1.12.17 and earlier (the live on-chain hidden-RPC directory on the stats page, the attack-resilience edge hardening, and the incident runbook) is included.
