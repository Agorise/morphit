# Morphit v1.11.0

**Theme: run a marketplace with no clearnet domain at all — reachable purely over Tor and I2P, listed in the federated directory, registered on-chain by its .onion. Maximum privacy, zero paperwork.**

## Added

**Tor-only nodes: a full marketplace with no domain, no certificate, no port-forward.** When the setup wizard asks how people will reach your marketplace, you can now choose **Tor-only** instead of a clearnet web address. The node then runs with no domain to buy, no HTTPS certificate to obtain, no router port to forward, and no dynamic DNS — it's reachable at an auto-generated Tor `.onion` (and, when i2pd is installed, its I2P address too). It registers itself on the federated directory by that onion and advertises it as its on-chain address automatically. This is the strongest posture Morphit offers: there is no domain to seize, no certificate authority in the trust path, and nothing inbound to firewall. The wizard is a few questions shorter, too. You can add a clearnet domain later without losing the onion — see `docs/OPERATIONS.md`.

**The federated directory now shows real, live status for hidden-service nodes.** An indexer that runs Tor now probes `.onion` (and I2P) peers *through* its own Tor/I2P proxy, so their directory status reflects whether they're actually up — not just that they registered. If your own Tor happens to be off, a healthy hidden peer is simply listed rather than wrongly marked unreachable.

**Hidden-service nodes are labelled "No clearnet reliance" in the directory.** A node with no clearnet domain shows that plainly on its directory card and always links to an address that actually works (its onion or I2P name), instead of displaying a bare, un-clickable hostname.

**An `Onion-Location` header for clearnet visitors.** A node that also serves a clearnet site now advertises its `.onion` via the standard `Onion-Location` header, so Tor Browser and Brave offer visitors the onion automatically.

**A quieter "install this app" prompt.** The web app now offers a native install banner on supported devices.

## Fixed

**The relay's health now reports correctly in a node's own status.** A default configuration gap could make a perfectly healthy relay show as down in a node's health report. It now points at the right internal health URL by default.

**The post-install reachability self-check no longer runs when it can't.** The clearnet reachability probe added in v1.10.10 is now correctly skipped on nodes where it doesn't apply (Tor-only, and offline installs), instead of reporting a confusing failure.

**Small polish to the setup review and the warrant-canary question.** The final review step now reads in a more natural order, and the canary setup pre-fills your instance address so you don't retype it.

## Notes

- **No database migrations. No breaking changes.** Existing clearnet nodes are unaffected.
- **On-chain compatible.** Hidden-service registrations use an `http://<onion>` origin (Tor and I2P encrypt and authenticate at the network layer, so a clearnet TLS certificate is neither obtainable nor meaningful for a `.onion`). Older indexers that predate this release simply record the registration; upgraded indexers probe it for real status. Nothing about the on-chain format changed for clearnet nodes.
- **Tor-only nodes need Tor running** (and i2pd too, if you want an I2P address). The guided installer sets both up for you.
- If your ISP blocks inbound 80/443, a Tor-only node reaches the world with no port-forwarding at all.
