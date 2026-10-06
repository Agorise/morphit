# Morphit v1.21.1

A small release: a calmer upgrade, a working language filter, and branded pictures in Blurt posts.

**Upgrading:** `sudo morphit-ops upgrade` on every server, Tor/I2P-only ones
included. One small database migration (a column description) runs by itself at start-up. This
upgrade is still run by v1.21.0's upgrade program: read any warning lines it shows, even if its last
lines say there is nothing else to do.

## Upgrade output

- The upgrade prints what changed and what is left for you, not every routine check. Checks that found
  nothing to do are counted in one line ("✓ N other checks found nothing to change").
- From the upgrade after this one (the upgrade program itself is updated by this release): builds,
  `npm ci` and the frontend rebuild show their output only when something fails, the release notes are
  shown as a short summary with a link, and the upgrade ends with one summary: "Left for you:" (with
  the commands to run), or "Nothing else to do."
- The firewall body-limit probe no longer reports a false "could not reach … 000".
- On a Tor/I2P-only server, the frontend's new web-server base image is now fetched through Tor in the
  background (up to 15 minutes), then the frontend is rebuilt on it. No manual `docker pull` needed.

## Orderbook

- **The language filter works.** Choosing a language showed every order posted before v1.15.0 (they
  carry no language). Now a language filter shows only orders written in the chosen languages; with no
  language chosen, every order shows (the filter's hint says so). Users who saved preferred languages in
  Settings start with that filter on, so they see older orders after clearing it.

## Open to every country

- **No instance blocks visitors by country.** People behind national firewalls (China, Iran, North
  Korea, …) must be able to reach the instance of their choice; that is what federation is for. The
  upgrade empties any BunkerWeb country list (`BLACKLIST_COUNTRY`, `WHITELIST_COUNTRY`, also per-site
  ones) and checks BunkerWeb runs without one. v1.21.0's note that country blocks "still work" is
  withdrawn.
- The instances page badge reads "🏅 Zero use of clearnet internet" again.

## Branding

- **Blurt posts show the instance's own picture.** On a branded instance, the first-trade post to the
  Morphit community and the per-order post to a user's blog lead with the instance's own link-preview
  picture, never Morphit's (none when it has none of its own). Blurt loads such a picture only from an
  `https://` address, so a post made over Tor or I2P carries none. Unbranded instances keep Morphit's
  pictures. See `docs/BRANDING.md`.

## Security

- The MCP server's SDK is updated to 1.32.1 (an advisory about its OAuth client, which Morphit does not
  use).

## Repository

- The release notes now live in `docs/release-notes/` and the claims list is
  `docs/MORPHIT-BRAG-LIST.md`, so the top of the repository holds only the installer, the main documents
  and the source folders.
