# Morphit v1.9.20

**Theme: the end-of-install summary now checks and shows the health of every part of your node — not just "installed and running."**

When the guided install finishes, it prints a summary of what came up. In v1.9.20 that summary is far more thorough: instead of a short list, it verifies and displays the status of every subsystem, so you can tell at a glance that your whole node is actually healthy before you announce it.

## New

**The install summary now covers everything, with a live status for each.** After the install, you'll see a checked line for each of:

- Database, signup relay, and marketplace indexer — including a live "is it actually responding?" check against each service's health endpoint, and whether the indexer is caught up or still catching up (which is normal on a fresh node).
- Blurt RPC connectivity and the BTC/XMR price feeds (FX).
- Your **verified relay balance**, read live from the chain, shown as an amount and an estimate of how many signups it funds.
- The MCP read-only API server.
- The web firewall (BunkerWeb) and your website.
- HTTPS certificate.
- Firewall (UFW) and intrusion protection (fail2ban), now shown as two separate lines.
- Your Tor onion address — the actual `.onion` is shown so you can copy it — and your I2P address.
- The IPFS node and the hourly release-pinning that keeps the release available over IPFS/IPNS.
- Your warrant canary (with a freshness check) and PGP contact key.
- SEO surfaces (robots.txt and sitemap).
- Your instance settings, nightly backups, and (on a home install) automatic address updates.
- System resources (free disk and memory).
- A final roll-up confirming every background service and timer is active.

**Anything still warming up shows a "?", not a failure.** A fresh node often needs a minute for the indexer to respond, the price feeds to connect, or RPC to dial in. Those now show a neutral "still starting" marker and no longer hold up the offer to announce your instance — only a genuine failure (a service down, a missing certificate, an inactive firewall, an unfunded relay) does.

**Your "Contact this operator" link can now point to a Matrix room, not just an account.** The optional Matrix contact in the setup wizard now accepts either your account (`@you:matrix.org`) **or** a room (`#support:matrix.org`), so you can send traders to a shared support channel instead of a personal account if you prefer. It remains entirely optional — press Enter to skip.

## Notes

- No database migrations. No breaking changes.
- If any line shows a ✗ or ? right after install, it usually just means that piece is still starting — re-check any time with `sudo morphit-ops status`.
