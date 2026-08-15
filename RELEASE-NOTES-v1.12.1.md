# Morphit v1.12.1

**Theme: make the hidden RPC layer robust and honest. A stable i2pd that installs itself correctly and self-heals, a node card that shows real latency for the Tor/I2P nodes and reads calmly when a transport isn't enabled, and automatic use of a Blurt node running on the same box.**

## Added

**Automatically uses a Blurt node running on the same machine.** If you run a Blurt RPC node (for example the hidden-rpc package) on the same server as your Morphit instance, the indexer now detects it on the standard loopback port at startup and reads the chain from it directly — instant, private, and the read never leaves the machine — with no configuration at all. It shows on the RPC endpoints card as a **Local** node at near-zero latency. Opt out with `MORPHIT_INDEXER_LOCAL_RPC_AUTODETECT=false`.

**The node card fills in Tor/I2P latency on its own.** The RPC endpoints card now runs a quiet check right after it loads, so the hidden nodes show their real latency without you having to press refresh.

## Changed

**i2pd now installs from the maintained upstream build — not the crash-prone distro one.** The version of i2pd in Ubuntu's default repositories crash-loops on startup on some systems (a corrupt-database abort a few seconds in). Both the standard install and the offline bundle now use the maintained purplei2p build instead, and an install will upgrade a node that's already stuck on the broken version. This is why some nodes' I2P addresses were unreachable; they now come up and stay up.

**Clearer wording on the RPC endpoints card:** "The nodes that this Morphit site talks to for syncing blockchain data, trying them in order of privacy and fastest response."

## Fixed

**Hidden nodes read calmly when a transport isn't enabled — no scary red errors.** If your instance doesn't have Tor or I2P running, the baked-in hidden nodes now show a muted **"Requires Tor/I2P (not enabled on this instance)"** instead of an alarming red "connection refused." A node that's genuinely down still shows a normal error; this only softens the "this instance simply hasn't turned that transport on" case, so the layer reads as intentional rather than broken.

**Tor and i2pd recover on their own if they crash.** Both now install with a restart-on-failure policy (with a bounded retry budget so a persistent problem doesn't spin), so a transient daemon crash no longer silently takes the hidden layer down until someone notices.

## Notes

- No database migration in this release.
- The i2pd change means a node that was on the broken build gets upgraded on the next install/upgrade; existing healthy nodes are unaffected.
- Everything hidden-service related remains fail-safe: an instance without Tor/i2pd falls back to clearnet, and the local/auto-detect behavior is opt-out.
