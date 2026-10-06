# Morphit v1.12.0

**Theme: the privacy RPC layer grows up. Your node can now read the chain from a node running on the same box (instant, and the read never leaves the machine), the network of censorship-resistant RPC nodes publishes itself on-chain so every instance adopts new ones automatically, and `morphit-ops` shows the health of every RPC node — not just a count. Plus a round of install fixes from a real from-scratch field test.**

## Added

**Read the chain from a node on the same machine — instant, and it never leaves the box.** If you run a Blurt RPC node (for example the hidden-rpc package) on the same server as your Morphit instance, point the indexer at it over loopback (`MORPHIT_INDEXER_LOCAL_RPC_ENDPOINTS=http://127.0.0.1:8091`) and it becomes your fastest, most private chain source: no network hop, no IP exposure, near-zero latency. Clearnet and hidden nodes stay as fallback. Only loopback addresses are accepted, so the setting can never be pointed at an outside host.

**An on-chain directory of privacy RPC nodes — self-adopted, no config edit.** The project publishes the canonical list of public hidden-service (`.onion` / `.b32.i2p`) RPC nodes as a signed on-chain record; every trusting indexer reads it and merges those nodes into its pool automatically. A vetted node added to the directory reaches the whole network with no code change and no per-operator edit, and the directory now persists across restarts. The record is only honoured when its signer and on-chain key match the pinned project values, so a forged directory can't inject hostile nodes.

**The public hidden nodes now show on every instance.** The Settings → RPC endpoints card shows the project's public hidden-service nodes — badged **Tor** / **I2P** — on every install, not just Ansible ones, so the censorship-resistant layer is visible everywhere. An instance without Tor/i2pd simply shows them unreachable; clearnet still carries all traffic.

**`morphit-ops` health now breaks out every RPC endpoint.** Under the `Blurt RPC: N/M reachable` line it now lists each node with its transport (clearnet / Tor / I2P / local), a shortened address, latency, and reachability — so you can see at a glance which nodes are up, including the hidden ones, instead of just a count.

## Fixed

**The first backup actually runs on a fresh Ansible install.** Two stacked bugs stopped it: the backup service's writable-path setting didn't match the install's data directory (failing with a mount-namespace error before the script even ran), and the backup authenticated to Postgres the wrong way for the Ansible layout. Both are fixed — a fresh node now writes its first dump a couple of minutes after setup, and `morphit-ops` shows a real backup.

**The warrant canary sets itself up on a root install.** The canary setup only tried a per-user timer, which a root (sudo) install can't use, so it silently fell back to a manual step that was easy to miss. It now installs a proper system timer when run as root, so the canary publishes and refreshes itself automatically.

**The install wizard reads like a smooth success — no scary words.** On a normal (and especially an offline) install, a few things looked alarming even though nothing was wrong: a couple of internal task names contained the word "Fail," the post-install checklist showed red `✗` marks for pieces that were merely still starting (RPC connectivity, the HTTPS certificate, the canary), and a firewall reminder said a setting was "wrong." All reframed — task names say "Verify…," pending items show a calm "still starting" rather than a failure, and the reminder is now an optional "if you ever notice…" note.

**`/v1/health` and `morphit-ops health` now agree about the relay.** On a containerized deployment the public health endpoint could report the relay **down** while the local check saw it **up**. The indexer now probes the relay at the container's gateway address (where a containerized relay actually binds), so the two agree.

**Hidden RPC nodes are no longer undercounted while they warm up.** The health probe used one short timeout for every node, which is fine for clearnet but too short for Tor and I2P (which take longer to connect, especially on a fresh node). Tor and I2P nodes now get a longer, transport-appropriate window, so healthy-but-slow hidden nodes are counted correctly.

## Notes

- **New database migration** (adds a small table to persist the RPC directory). No breaking changes.
- Everything hidden-service related is fail-safe: an instance without Tor/i2pd simply falls back to clearnet, and the local/loopback and hidden-node settings are opt-in and overridable.
