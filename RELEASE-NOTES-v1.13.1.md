# Morphit v1.13.1

**Theme: the node-status display finally tells the truth about a slow or reconnecting RPC node — a healthy-but-onion-routed node no longer looks dead.**

## Improved

**A reconnecting hidden node is no longer mislabelled "unreachable."** In the RPC-endpoint list, a Tor or I2P transport that's momentarily down but whose *same node* is answering on its other transport is now shown as amber **"re-establishing"** instead of a red "unreachable." The reasoning is honest: if a node answers over I2P, the box is clearly up, so its quiet Tor onion is just re-publishing its descriptor (which takes a few minutes after any reconnect) — not gone. A node that's genuinely down on every transport still shows red. This is inferred purely from what the pool already measures, with no cooperation needed from the node.

**RPC latency is now colour-coded to what it actually means.** Endpoint round-trip time reads green under 5 seconds, amber from 5–10 seconds, and red at 10 seconds or more. Tor and I2P legitimately take a few seconds, so onion-routed nodes running 1–5 s now read as the healthy green they are, instead of a washed-out "slow" grey — and only a genuinely sluggish node turns amber or red.

Both changes apply consistently to the in-app RPC-endpoints card and to `morphit-ops health` on the server, so the browser and the CLI agree.

## Notes

- Display-only release: no database migration, no on-chain changes, no behaviour change to how the pool selects nodes.
- Everything from v1.13.0 and earlier is included.
