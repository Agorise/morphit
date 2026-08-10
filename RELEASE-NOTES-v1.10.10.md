# Morphit v1.10.10

**Theme: a true offline install, a home node that tells you the truth about its own reachability, and Tor/I2P that actually serve the marketplace. Hardening from a full second-node bring-up.**

This is a maintenance release. There are no database migrations and no breaking changes.

## Fixed

**Tor (.onion) and I2P (.b32.i2p) now serve the whole marketplace, not a 404.** The hidden services were pointed at the sign-up relay, which only answers a few paths, so visiting your .onion returned "not found" for the site and the public API. They now reach the web frontend — the same fan-out clearnet visitors get — so the full site, order book, and read-only API work over Tor and I2P. For a node whose owner can't open clearnet ports (see below), this is the path that reaches the world.

**A truly offline install no longer reaches the internet for git or Ansible.** Two pieces were still fetched online during setup — git, and Ansible plus its Galaxy collections. They are now included in the offline bundle and installed from it, so a genuinely air-gapped install completes with the network cable unplugged.

**Backups no longer report a scary "unreadable" on a brand-new node.** A freshly installed node hasn't run its first nightly backup yet, so the backup folder doesn't exist. The health check mislabeled that as a permissions error. It now correctly says "no backup yet" and tells you how to run one immediately.

**The warrant canary now lands where the site actually serves it.** On a home install the canary was written into the source folder instead of the deployed one, so `/canary.txt` didn't load. It now goes to the served location, and the weekly auto-refresh follows it there too.

**The setup wizard's step counter ("Step 15 of 14") is fixed.** A home install has 15 steps; the counter said 14.

## Added

**A post-install reachability self-check.** After a home install, Morphit now checks — from an outside vantage point, using the Tor network it already runs — whether the public internet can actually reach your node on 80/443. Many home ISPs silently block inbound web ports; instead of discovering that hours later via a stale directory listing, you're told immediately and pointed at your .onion, which works regardless.

## Notes

- No database migrations. No breaking changes.
- The install sets the machine's timezone to UTC (standard for servers); your local wall-clock time will differ. This is intentional.
- If your ISP blocks inbound 80/443, your .onion reaches the world with no port-forwarding.
