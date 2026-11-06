# Morphit v1.23.1

A small follow-up to the Blurt Nodes page (/witnesses). Nothing about fees, prices, trades or
chat changes.

## For people using the site

**The column headings stay in view.** On a computer or a large tablet, scroll down the
Blurt Nodes table and its heading row stays pinned just under the main menu, so you can still
see which column is which while the witnesses scroll beneath it. Scroll back up and the row
settles back into the table. Every heading still sorts the table when clicked.

**Pictures from image hosts that are gone.** Many witnesses' pictures were stored on image
hosts that no longer exist (see below). When a witness's own picture host fails, your
instance now asks the Blurt image proxy (`imgp.blurt.blog`) for that witness's picture
instead, still fetched by the instance, never by your browser. A witness that never set a
picture keeps the plain head.

## For operators

Nothing to do: upgrade as usual.

Seen on the first day of v1.23.0:

- **The "missed in the last day" flag starts after an hour.** The chain only gives each
  witness's lifetime total of missed blocks, so an instance writes the totals down every 10
  minutes and compares. A newly installed or newly upgraded-to-v1.23 instance shows no flags
  for its first hour, then counts the misses since it started watching, and covers a full day
  after 24 hours. Later upgrades and restarts keep the samples; only restoring an indexer
  snapshot (a fresh install or a resync) empties them, and the hour starts again. To see it
  working on a server:

  ```sh
  sudo -u postgres psql -d morphit_indexer -c "SELECT COUNT(*) AS samples, COUNT(DISTINCT owner) AS witnesses, MIN(sampled_at) AS first, MAX(sampled_at) AS last FROM witness_missed_samples"
  ```

  (OPERATIONS.md §55 has the details.)
- **`[witnesses] avatar_unavailable … has no DNS records` in the indexer log**: the
  witness's picture was on a host name that no longer exists in DNS. On 2026-11-05 the
  `blurt.world` domain moved to parking nameservers, taking `img.blurt.world` with it, and
  `images.blurt.buzz` does not exist; most witnesses' pictures were on one of the two. From
  v1.23.1 the indexer then asks the Blurt image proxy,
  `https://imgp.blurt.blog/profileimage/<witness>/64x64`, and logs `avatar_via_proxy`;
  `avatar_unavailable` now means both failed (its reason names both). The proxy sees your
  server's address and the witness's name (the picture host saw the server's address and the
  picture's URL); a zero-clearnet instance
  still fetches no pictures at all.

## For developers

- `routes/[lang]/witnesses/+page.svelte`: each header cell is `position: sticky` (`.wit-th`,
  a scoped style; cells rather than the `<thead>`, which not every browser sticks), at
  `--wit-sticky-top` = the main menu's measured height (a `ResizeObserver` on the layout's
  `<header data-site-header>` and on the row, since their heights change with language,
  branding and zoom). The cells get the header row's colours made opaque, from the theme tokens (dark: the
  `surface-950/40` tint over `surface-900`), so the rows pass under them and branded instances
  keep their colours; the row's bottom line moved from the `<thead>` border onto the cells (a
  collapsed border would not travel with them).
- The table's card is `overflow-clip` instead of `overflow-hidden`: `overflow: hidden` makes
  the card a scroll box of its own, so the header row would stick inside the card (that is,
  never), while `clip` still rounds the corners without that.
- Checked in a browser with a scroll script: 5 languages (including Persian) × 3 widths (1024,
  1280, 1600) × light and dark. At rest the heading row is at the table's top; scrolled, every
  cell sits exactly on the menu's bottom edge and nothing shows through; at the page's end it
  leaves with the table; scrolled back up it is back in place. The same script, run against the
  old `overflow-hidden` card, fails, so it does test the fix.
- `routes/[lang]/+layout.svelte`: the main `<header>` carries `data-site-header`.
- Review fixes to the sticky row (each checked in the browser, and seen to fail without the
  fix):
  - Keyboard focus: the site's `scroll-padding-top` (5rem) ended inside the stuck row, so a
    control reached with Shift+Tab sat under it (WCAG 2.4.11; a script pressing Shift+Tab 60
    times per page found 5 hidden steps per page). While the table shows, the page sets the
    padding to the menu + the row + 8 px, and puts the site's back when it goes
    (`lib/utils/stickyTableHead.ts`, PURE, with tests; 540 steps, none hidden).
  - The notification banner (`PermissionBanner.svelte`, sticky under the menu) now publishes
    its bottom edge (`lib/stores/stickyBanner.ts`); the row sticks below it, not under it.
  - The menu is measured to the fraction of a pixel (`getBoundingClientRect`), so no seam at
    zoom levels where it is not a whole number of pixels high.
  - High-contrast (forced colours) drops box shadows: the cells get an outline there.
  - A browser without `overflow: clip` (Safari before 16) rounds the corner cells themselves.
- Picture fallback (`indexer/witnessService.ts`): when the own picture URL fails (fetch,
  type or size check), `getAvatar` asks `avatarProxyUrl(owner)` =
  `https://imgp.blurt.blog/profileimage/<owner>/64x64`, whose answer must pass the same
  checks (PNG/JPEG/GIF/WebP, at most 1 MiB and 4096 px a side). Only for a witness with a
  picture URL (none → the plain head: the proxy is not asked for an account that set no
  picture); never twice when the
  picture is on the proxy already; a failure of both is remembered for the hour as before.
- `fetchPublicBytes` (`indexer/federationProbe.ts`) takes `sameOriginRedirects` (default 0,
  unchanged: a redirect is a failure). Above 0 it follows a 3xx ONLY to the same origin
  (https, same host and port; never another host, never down to http), and each hop goes
  through every check again: fresh lookup, public-address check, pinning, its own timeout.
  The proxy fallback allows 3 (`AVATAR_PROXY_REDIRECTS`); no caller gets more than 5
  (`FETCH_PUBLIC_MAX_REDIRECTS`), and the whole chain shares ONE timeout, each hop closing its
  pinned connection before the next starts (review). Tests: `fetchPublicBytesRedirect.test.ts` (7, the real guard
  code with only the network call stubbed) and 5 more in `witnessService.test.ts`; each
  guard was removed once to see its test fail (origin check, hop count, the proxy-already
  case, the proxy's redirect allowance).
