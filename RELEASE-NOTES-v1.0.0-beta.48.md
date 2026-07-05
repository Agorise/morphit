# Morphit v1.0.0-beta.48

A critical bug-fix release on top of beta.47. The headline: **order terms now
support full markdown, including line breaks and blockquotes.** Previously, if
you wrote your terms across multiple lines — a heading, a bulleted list, a
`>` blockquote, or just paragraphs separated by a blank line — the order was
silently rejected the moment it reached the network, *after* the listing fee
had already been paid, and it never appeared anywhere: not on the order book,
not on your My Orders page, not on its own detail page. That's fixed, and two
safeguards are added so it can't cost anyone a fee again. **Strongly
recommended for all operators.**

## Fixed

- **Order terms with line breaks no longer disappear.** The terms field is a
  multi-line markdown box, but the network was rejecting any terms that
  contained a line break (or a tab). Because the rejection happened after the
  order was already broadcast and its fee paid, the result was the worst
  possible one: a spent fee and an order that showed up nowhere. Terms now
  accept the full markdown you'd expect — headings, **bold**, *italics*,
  `>` blockquotes, and numbered or bulleted lists — with line breaks preserved,
  and they render properly on the order's detail page. Editing an order's terms
  to add line breaks works too.

## Added

- **The post and edit forms now stop you before a fee is wasted.** If your
  terms contain a character that can't be stored (a hidden or control
  character — line breaks and ordinary markdown are always fine), the form now
  shows a clear message and won't let you continue *until you remove it*. So an
  order that the network would reject can no longer be broadcast in the first
  place, and you never pay for one that won't appear.

- **The block explorer shows multi-line values readably.** When you expand the
  raw JSON for an operation in the explorer, long multi-line values — an
  order's terms, a post's body — now display with real line breaks instead of
  a wall of literal `\n`, so they read the way they were written. This is a
  display improvement only; the underlying data is unchanged.

## Changed

- **The order book is a little tidier.** The small "Indexed block" line that
  used to sit under the last listing has been removed — it wasn't useful to
  traders.

## Operators

- **The fix lives in the indexer**, so upgrading your node (which rebuilds and
  restarts the indexer) is all that's needed for new orders to accept
  multi-line terms.

- **Recovering an order that was already rejected.** If a multi-line-terms
  order was posted against your node on a previous version, its fee settled but
  the order was dropped. Because the operation is still on-chain, you can bring
  it back — and reuse the fee that was already paid — by having the indexer
  re-scan the block it's in: stop the indexer, set the indexer cursor
  (`indexer_state.last_applied_block`, row `id = 1`) back to one block below the
  order's block, then start the indexer again. It re-processes forward to the
  chain head; every handler is idempotent (nothing is duplicated), the order
  now validates, and its original fee is matched from the same transaction, so
  it goes live and verified. Take a database snapshot first. If you'd rather not
  touch the database, the order can simply be re-posted (the original fee stays
  spent in that case).
