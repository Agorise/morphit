# Morphit v1.21.1

A calmer upgrade, a working language filter, branded Blurt post pictures, and fixes to the consensus
rules before they switch on.

**Upgrading:** `sudo morphit-ops upgrade` on every server, Tor/I2P-only ones included. **Every
instance must run v1.21.1 before 2026-11-01 00:00 UTC**, when the stricter consensus rules start
(v1.21.0 is not enough: this release corrects some of them). One small database migration (a column
description) runs by itself at start-up. This upgrade is still run by v1.21.0's upgrade program: read
any warning lines it shows, even if its last lines say there is nothing else to do.

## Consensus rules (from 2026-11-01)

- A featured-slot bid's place no longer depends on when a server's own fee re-check happened to run:
  every instance reaches the same answer.
- The look-alike name check gives the same answer on every Node.js version.
- The site no longer sends text every instance would drop (some invisible characters): an order with
  one would have lost its listing fee. "Mark complete / review" sends the completion before the review,
  so the review is not dropped. Profile links are sent in the form instances store.

## Upgrade output

- The upgrade prints what changed and what is left for you, not every routine check ("✓ N other checks
  found nothing to change"). From the upgrade after this one it ends with one summary: "Left for you:"
  (with the commands), or "Nothing else to do." — including how the background web-proxy checks ended.
- Every long step shows the spinner; a failed step keeps its full output in `/var/log/morphit/`.
- On a Tor/I2P-only server the frontend's web-server base image is fetched through Tor in the
  background and the frontend rebuilt on it; nothing to do by hand.

## Orderbook

- **The language filter works.** A language filter shows only orders written in the chosen languages;
  with no language chosen, every order shows, including those posted before v1.15.0 (they carry no
  language). The filter you leave on the orderbook is kept for your next visit on that device.

## Open to every country

- **No instance blocks visitors by country.** People behind national firewalls (China, Iran, North
  Korea, …) must be able to reach the instance of their choice; that is what federation is for. The
  upgrade empties a BunkerWeb country list (`BLACKLIST_COUNTRY`, `WHITELIST_COUNTRY`, also per-site
  ones) in BunkerWeb's settings file, removes one saved in BunkerWeb's web UI from BunkerWeb's database
  (keeping a copy of the database first), and checks BunkerWeb runs without one; a list set any other
  way is named in the upgrade's output and in `sudo morphit-ops status`, with where to clear it.
  v1.21.0's note that country blocks "still work" is withdrawn.
- The instances page badge reads "🏅 Zero use of clearnet internet" again.

## Branding

- **Blurt posts show the instance's own picture, never Morphit's on a branded instance** — also when
  the brand cannot be read at that moment (then no picture). Blurt loads such a picture only from an
  `https://` address, so a post made over Tor or I2P carries none. Unbranded instances keep Morphit's
  pictures. A logo given without a name no longer puts "Morphit" next to it in the preview picture,
  and an own `og-image.png` that is not 1200 × 630 is named in a warning. See `docs/BRANDING.md`.

## Security

- Root's files no longer live where the service account could redirect them: the web-proxy and
  mirror state moved to `/var/lib/morphit-ops/`, `/var/log/morphit` becomes root's (the upgrade fixes
  existing servers), and nothing root writes follows a link there.
- The MCP server limits each visitor, not everyone behind the web proxy together, and counts every
  call in a batch. Its SDK is updated to 1.32.1.

## Releases

- A release whose IPFS address could not be computed is no longer broadcast without one: the
  ceremony's Block 4 stops and says how to pass the address the release server printed.
- The release notes now live in `docs/release-notes/` and the claims list is
  `docs/MORPHIT-BRAG-LIST.md`.
