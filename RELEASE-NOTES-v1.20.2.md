# Morphit v1.20.2

Pages load faster and are easier to read, Bitcoin fees go to a separate address for each order,
Monero fee checks no longer depend on two websites, and the compare page works again. There are
no database changes.

## Faster pages

- **Each page downloads about half the text it used to.** The FAQ, the privacy guides, "run a
  node" and the cheat sheet now load only with their own page. Before, every page downloaded all
  of them (and, in any language but English, the English copy too): about 100 KB less per page,
  and 200 KB less for a visitor reading another language.
- **The logo shows first.** The browser now fetches the header logo before the app's code, keeps
  its space reserved while it loads (nothing jumps), and downloads it once instead of twice. Its
  occasional shine is drawn by the graphics card instead of repainting the logo.
- **Fonts:** one font file was downloaded twice under two names; it is now downloaded once, all
  three fonts start loading at once, and the browser keeps them for a month.
- **The update check waits.** The check for a newer version (an 80 KB file) no longer competes with
  the page while it loads, and no longer runs on every switch back to the tab.
- On a simulated slow phone, the home page's PageSpeed score went from 61 to 77–80; accessibility
  and SEO from 96 and 92 to 100.

## Easier to read and to find

- **Grey text is readable.** The muted grey used for hundreds of labels was too faint on the dark
  background (3.4:1); it now meets the 4.5:1 readability standard everywhere. Operator colour
  themes get the same lift.
- **A missing file is a real "not found".** Asking for a file that does not exist (for example
  `/.well-known/ai-catalog.json` or `/favicon.ico`) used to return the app's page, so search
  engines and AI tools were told those files exist. They now get a proper 404.
- **Screen readers:** the "Start" button says what it does (sign in or create an account), the
  logo links no longer announce an English "home" in every language, and the footer's headings are
  in the right order.
- **Pages are isolated from other sites' windows** (Cross-Origin-Opener-Policy).
- **The privacy guide list** showed a raw text key for goods trades (which have no guide). Fixed.

## New — fees

- **Each Bitcoin fee gets its own address.** This release pins the treasury's Bitcoin account key.
  From this release on, every order paid in BTC gets a fresh address of that account, and a
  payment to it can only ever count for that one order. Nobody can claim someone else's payment.
- **More sources check Monero fees, and payers don't get stuck.**
  - Three public Monero nodes join the three explorers. A node gets only the transaction id (never
    the payer's transaction key), and the indexer checks the payment itself, so a node cannot fake
    one.
  - Two sources still have to agree. If only ONE can be reached for two hours and nothing
    contradicts it, its answer is accepted once the payment is 10 blocks deep. Sources that
    disagree never settle it; the log names what each one said.
  - The upgrade removes the three explorers that stopped answering (still listed on nodes set up
    before v1.20.0) and adds the newer sources, once. A default you remove later stays removed.

## Fixed

- **The compare page.** It could not reach other instances at all: each page's security policy
  lets the browser talk only to its own instance, so the request was refused before it left
  ("Failed to fetch"). The instance now fetches the other instance's orderbook itself, only for
  instances registered on chain, over their onion address when they have one. Messages are clear
  and in every language.
- **Pages switching language by themselves.** On a slow connection, a browser set to another
  language could turn an English page into that language a few seconds after it loaded. The
  page's own language now always wins.
- **The treasury setup scripts.** The Bitcoin key script lost the key when run as documented, and
  the Monero self-test stopped before printing anything when run from the repo folder. Both work
  now. The Bitcoin script also refuses an account that has ever received coins.
- **A dependency.** devalue (used by SvelteKit) is updated to 5.9.4 for three advisories.

## New — checks

- **Block check (report only).** For every block, the indexer recomputes the chain's own
  fingerprints (the transactions' merkle root, the block id and its link to the block before) and
  counts whether they match what the RPC node served. Nothing is refused yet. `sudo morphit-ops
  health` shows it as "Block check".

## Upgrading

Run `sudo morphit-ops upgrade` on each server. Nothing needs doing by hand.

- The Monero source list is updated by the upgrade where needed.
- The web container is rebuilt from this release's config (missing files, font caching, the
  opener policy) — on clearnet and on Tor/I2P-only servers alike.
- Check `sudo morphit-ops health` → "Block check" a day after upgrading.
