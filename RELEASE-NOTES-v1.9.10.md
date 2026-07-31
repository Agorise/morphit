# Morphit v1.9.10

**Theme: a warrant canary that's hard to knock offline, and easy for anyone to set up.**

This release makes every instance's warrant canary far more resilient, and turns
its setup from a hand-rolled chore into one guided command that works for a home
box and a rented server alike.

## What's new

**The canary is much harder to knock offline.** Each week the canary embeds a few
"proof it's fresh" facts — the latest Blurt and Bitcoin block, and a news
headline. Those come from third-party sites, and if one is down or blocked the
canary used to stop. Now:

- the **Bitcoin block** is read from **five independent providers** (Blockstream,
  mempool.space, Blockchain.com, Blockchair, BlockCypher) instead of one — it
  tries each in turn until one answers;
- the **news headline** falls through **six independent feeds** (your own, then
  BBC, The Guardian, NPR, Al Jazeera, the New York Times);
- the Blurt block already rotated across the full node list.

The Bitcoin block and news are secondary to the Blurt block, so even if *every*
one of their providers is unreachable, the canary still signs (recording them as
unavailable) instead of failing. One provider having a bad day can no longer make
your canary look tampered-with.

**Setting up the canary is now one guided command.** `scripts/canary/setup.sh`
ships in the repo, so every operator has it. Run it once on the machine you want
to sign on and it does the rest, then keeps the canary fresh on a weekly timer:

- it asks whether Morphit runs **on this same computer** (home hosting) or **on a
  separate server** (a VPS), and does the right thing for each — signing locally
  and either placing the file or uploading it;
- if you don't have a PGP signing key yet, it **offers to create one** and
  publishes the matching public key for readers to verify against;
- it's built into the flow: `morphit-ops` points you to it during setup, and
  reminds you to re-run it after an upgrade (a rebuild clears the served files).

Nothing is required beyond re-running your canary refresh after upgrading, exactly
as before. See `docs/RUN-A-MORPHIT-NODE.md` (warrant canary) for the friendly
version and `docs/OPERATIONS.md` §36 for the security reasoning — including why
the strongest canary is signed on a machine separate from the server.

**Clearer order titles.** An order's one-line title now names the crypto a seller
accepts by its ticker — "…for LTC, DOGE, or SOL" — instead of the long form
("…for Litecoin (LTC), Dogecoin (DOGE), …"). That keeps the title to a single line
on desktop (two on a phone) so it no longer runs into the Message button, matching
how barter listings already read. The full order page still shows everything.

**Farsi and other right-to-left languages now display correctly.** If you use
Morphit in Persian — or if you type your order terms, a barter title, or your
instance's name and description in a right-to-left script — the text now reads in
its natural direction on every page, instead of scrambling where it mixed with
left-to-right tokens like amounts and tickers. A Persian order reads right-to-left
and an English one left-to-right, whichever language the site is set to. Persian
pages now also load in the correct direction immediately (and for visitors with
JavaScript turned off), and are correctly labelled as Persian for search engines
and screen readers.

## Notes

- No database migrations. No breaking changes.
- The canary's signing model is unchanged: signed off the served box with your own
  PGP key, so it goes stale exactly when it should.
