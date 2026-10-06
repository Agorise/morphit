# Morphit v1.10.4

**Theme: instances can finally see each other. This release fixes a bug that stopped every instance from health-probing its peers, so the federation directory shows real, live status for other operators.**

This is a maintenance release. There are no database migrations and no breaking changes.

## Fixed

**Peer health probes now work.** The indexer probes other instances over their public address and, as an anti-DNS-rebinding measure, pins the resolved IP for the connection. The code that pinned the IP used an older callback style that the current HTTP library rejects, so the connection failed immediately with an internal "invalid IP address" error — on *every* peer. The result: other operators' cards in the directory were stuck on "Unreachable" and never picked up their name, tagline, contact link, or Tor/I2P addresses, even when the instance was perfectly reachable. An instance's *own* card was unaffected because it fills in from local configuration, which is why this stayed hidden until a second instance joined. The IP-pinning now uses the shape the library expects, so probes connect and the directory reflects real peer status. A regression test covers the exact callback contract.

## Notes

- No database migrations. No breaking changes.
- After upgrading, previously "Unreachable" peers will flip to their real status (good / syncing / quiet) on the next probe.
