# Morphit v1.16.2

**Operators can point "Contact this operator" at any messenger, the minimum system requirements read the same everywhere, the setup/upgrade screens never sit silent, and hosting instances can serve their pinned release over `.onion`/`.i2p`.** A batch of operator-experience fixes plus the serving half of the hidden-only upgrade path that v1.16.1 flagged as still to come.

## Added

- **Messenger contact links.** An operator's `contact_url` now accepts the common secure messengers and app-handoff schemes — Matrix, Session, Signal, Telegram, Discord, XMPP, Briar, Cwtch, Jami, SimpleX, email, or a plain `https://` page — so "Contact this operator" deep-links straight to the operator's chosen channel. Addresses with no URL handler (Session, Cwtch) render as one-tap copy buttons instead of dead links. A single allowlist is the one source of truth for the on-chain registration gate, the installer, the frontend validator, and the render sanitizer, so all four agree; `http://` is refused everywhere (it was already refused on-chain). Translated across all ten locales.
- **Serve the pinned release over `.onion`/`.i2p` (the piece v1.16.1 flagged).** A hosting instance can now expose its Kubo gateway on the frontend at `/ipfs/<cid>` and `/ipns/<name>`, so a clearnet-censored node can fetch a release over the instance's hidden addresses — no clearnet, no third-party pinning service. `Gateway.NoFetch=true` is now always set, so the gateway serves **only** the CIDs this node has pinned (its own ~12 MB signed release) and never fetches an arbitrary CID — it is not an open proxy. Exposure is **opt-in and off by default** (`morphit_ipfs_gateway_expose`, default `false`): the default posture is unchanged (gateway loopback-only, and the frontend `/ipfs` routes return a clean 404). When enabled it binds the gateway to the Docker bridge exactly the way the relay and indexer already bind — public inbound stays closed by UFW default-deny.

## Changed

- **The braille spinner now covers every silent wait.** In addition to the wizard's DNS / chain-lookup / system-check / Tor-I2P steps, it now turns during the on-chain registration broadcast (install) and during release-source discovery, the tarball download, and the post-upgrade service poll (upgrade) — so a slow network step never looks frozen. TTY-aware; the security-critical key-wipe on the registration path is untouched.
- **Consistent minimum system requirements: 2+ CPUs, 4+ GB RAM, 80+ GB drive (SSD is best).** The frontend copy and the operator docs already said this; the installer's own pre-flight system check was still recommending ≥2 GB RAM / ≥20 GB disk. It now recommends ≥4 GB / ≥80 GB with matching ok/warn/error bands, so what the installer tells you matches what everything else does.

## Notes

- **No change for clearnet nodes**, and no change to any node's default posture: `Gateway.NoFetch` is a pure hardening win, and the gateway stays loopback-only unless an operator opts in.
- **The gateway-exposure path is unvalidated in CI** — it needs a live box that runs IPFS hosting to prove end-to-end, so it rides live-box validation before an operator turns it on. The always-on `NoFetch` setting and the default-safe routing are the parts that ship proven.
- **Offline-first preserved.** No new external dependency anywhere; the whole tree still installs and upgrades from the bundled tarball with no network.
