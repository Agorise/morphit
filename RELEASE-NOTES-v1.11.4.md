# Morphit v1.11.4

**Theme: reading the chain without depending on the clear net. A Morphit node can now reach Blurt RPC over Tor and I2P, cross-checks what it reads across independent nodes, and — on Tor Browser — even verifies its own release without a visitor's IP ever touching the clear net. Plus a smoother first install and a round of polish.**

## Added

**Censorship-resistant chain reads over Tor and I2P.** Your indexer can now read the Blurt chain through hidden-service RPC nodes (`.onion` / `.b32.i2p`) in addition to the usual clearnet pool. Clearnet stays primary (it's faster), with the hidden nodes serving as a censorship-resistant fallback — if the clearnet RPC nodes are ever blocked, your node keeps reading the chain over Tor/I2P. On a standard install (which already runs Tor and i2pd), this turns on automatically: the installer seeds the hidden pool for you, so there's nothing to hand-edit. A node without Tor/i2pd is unaffected and stays clearnet-only.

**Your node cross-checks the chain data it's given.** Reaching a node over Tor/I2P hides *where* you read, not *whether* what you read is true — so a node you don't control could lie about the chain. Every few minutes your indexer now asks several independent RPC nodes for the same finalised block and confirms they agree on it before trusting it. A disagreement (a node serving a forged or forked chain) is logged loudly; agreement is silent. This runs across both clearnet and hidden nodes, so it protects your reads regardless of transport, and never blocks indexing.

**Privacy-first release verification.** Every Morphit page verifies, straight from the chain, that the instance is serving the exact official release. That one check is the single time your browser talks to a Blurt node directly. It now tries a hidden-service node **first**: on Tor Browser (or with an I2P proxy) that verification rides the hidden network and no clearnet node ever sees your IP. On an ordinary browser it falls back to a clearnet node exactly as before.

**Hidden nodes show on the Settings → RPC endpoints card.** The card now badges each node by how your instance reaches it — **Tor**, **I2P**, or clearnet — so you can see at a glance that your pool spans censorship-resistant transports.

## Fixed

**The first backup now runs at install.** The installer set up the daily backup timer but didn't take the first dump, so `morphit-ops health` showed a "no backup has ever run" warning until the next daily cycle. It now takes one backup immediately after setup, so you see a real backup on day one.

**Your warrant canary publishes soon after the box is online, not a week later.** On an offline/air-gapped install the first canary publish is deferred until the box has internet — but the only thing that published it was the weekly timer, so it could sit missing for days. It now also refreshes a few minutes after the machine boots, so the deferred first canary appears the first time the box is online, as promised.

**The Matrix alert bot installs even before you have a token.** Setting up alerts required pasting a bot access token during the install, and there was no guidance on how to get one — so choosing alerts without a token left the bot uninstalled. Now the wizard explains exactly how to obtain a bot token, and if you don't have one yet it offers to install the bot anyway, fully staged and ready. `morphit-ops health` then shows **"token needed"** (instead of "not installed"), and you add the token any time with `morphit-ops` → Matrix alerts — no reinstall.

**A clearer message when there's no HTTPS certificate.** The health line for a missing certificate now explains *why*: a clearnet node must be reachable from the internet on ports 80/443 for the certificate challenge, so a home/CGNAT connection can't get one (use Tor-only mode there), while a Tor-only node needs no certificate at all.

**"About this instance" polish.** The git commit is shown as the full hash in one clean line; the Matrix group-chat link now opens your own Matrix client directly (no third-party redirect, no encoded characters); and every card's columns line up.

**The compare page can fetch order books again.** A too-large request meant both order books failed with a "must be less than or equal to 100" error; the request now stays within the limit.

**A quieter install.** npm's "a new version of npm is available" banner no longer prints at the end of the setup wizard.

## Notes

- **No database migrations. No breaking changes.**
- Hidden-service chain reads are opt-out (empty the endpoint list to disable) and fail safe: if Tor/i2pd or a hidden node is unreachable, your node simply uses the clearnet pool.
- Clearnet-only nodes behave exactly as before — the hidden-service routing is installed only when hidden endpoints are configured.
