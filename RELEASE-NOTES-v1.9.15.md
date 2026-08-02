# Morphit v1.9.15

**Theme: interface polish — correct right-to-left usernames, a tidier footer, and a calmer orderbook.**

This release is a batch of front-end fixes and cleanups, most visible if you use
Morphit in Persian or spend time on the orderbook.

## Fixed

**Usernames read correctly in right-to-left languages.** With Persian (Farsi)
selected, a handle like `@alice` was rendering as `alice@` — and since the address
only works as `/@alice`, never `/alice@`, the misplaced `@` read as a different,
invalid handle. Handles now always render left-to-right, `@` first, in every
language.

## Changed

**The orderbook hides the "Featured" card when nothing is featured.** Instead of
showing an empty "no featured-slot bids yet — be the first" card, the card simply
isn't there until a featured order or bid exists.

**A tidier footer.** Dropped two lines of chrome (the "Peer-to-peer. Private.
Yours." tagline and the "Also reachable via" label) and reorganized the footer
links into five clear, labeled columns — Federation, Resources, Security, Media,
and Support — that stack cleanly on a phone and lay out correctly in right-to-left
languages.

**The run-a-node page's "See the repo" button now opens the download page,** where
the guided setup and every download live.

## Notes

- No database migrations. No breaking changes.
- The right-to-left handle fix is structural: it's applied to every interface
  string as it loads, so it can't drift back out of sync as translations change.
