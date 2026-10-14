# Morphit v1.21.8

A branded site never shows Morphit's logo or colours, not even for an instant on a first visit. The
Operators page shows, for every operator, how many orders came through its site and what it has
earned since it started. The thin bright edge a main button lights on hover shows again on sites with
bright (gold) buttons, an upgrade puts back a warrant canary signed on another computer, and Morphit
works with hidden-rpc v1.3.0's built-in snapshot mirror. Plus a Morphit entry in the glossary and the
requested wording changes on the homepage, the privacy pages and the FAQ.

**Upgrading:** `sudo morphit-ops upgrade` on every server. One database change (migration v68, three new
tables), applied by the upgrade. After it, the indexer fills in the operator earnings from fee
payments it indexed before by reading them from the chain again, in the background; the Operators
page's earnings can be short until it finishes (it reads 25 blocks with fee payments every 10 seconds;
`fee_legs_backfill_pass` in the indexer log).
Like every change to the upgrade, the canary fix starts with the upgrade AFTER the one that installs
it: this upgrade still clears a canary signed on another computer, so re-sign it once more afterwards,
on that computer (`bash ~/.morphit/update-canary.sh`). **Every instance must run v1.21.1 or later
before 2026-11-01 00:00 UTC.**

## A branded site never shows Morphit's look

- **What happened.** Opening some pages of a branded site for the first time — an order, a chat, a
  profile: the pages the app draws in the browser — showed Morphit's logo and colours for a moment
  before the site's own. Those pages start from one shared page that branding does not rewrite, and
  learned the site's name and colours from `/brand/brand.json`, which arrives after the first paint.
  And a browser that had visited the site before it was branded kept showing the old Morphit logo
  until a refresh, because the stored copy was shown first and the new one fetched in the background.
- **Now.** Every page links a small stylesheet, `/brand/theme.css`, in its head; the browser paints
  nothing until it has it. Branding writes the site's colours into it, and its name, so every page —
  prerendered or drawn in the browser — has the site's look from its very first frame, with no wait
  for `brand.json`. On an unbranded site the file sets nothing. The logo, icons, `theme.css` and
  `brand.json` are now always asked of the server first, so a visitor who saw the site before it was
  branded, or before a change, gets the new look on the very next page, without a refresh. The
  browser's stored copy is used only when the server cannot be reached at all (offline, or the
  connection drops) — since it may be from before the site was branded, it is never handed out
  because the server is slow, nor in place of an error (a 404 or 503, or a server that has not
  answered within 30 seconds (45 on a .onion, .i2p or .loki address): the logo is then missing rather than
  possibly Morphit's). Only
  `theme.css` keeps its stored copy over an error, since without it the page would show Morphit's
  look anyway. Where `theme.css` names the site, `brand.json` is no longer read at all, so a copy
  stored before a re-brand cannot paint the old colours back. (A page now waits for that small
  file, as it already waits for the page itself.)
- **Until the new service worker takes over.** A returning visitor's browser keeps running the old
  service worker until the visitor accepts the update or closes every tab of the site, and that
  worker handed out its stored logo first. The pages now ask for the logo as
  `/brand/site-logo.svg?fresh=1` (and the footer's likewise), which the old worker, too, always
  fetches from the server — so those pages show the site's logo as well.
- **The browser's own colour.** A phone's address bar (`theme-color`) took Morphit's green until
  `brand.json` arrived; it now takes the site's colour from `theme.css`, before the page renders.
- **Also branded:** the minimal page an operator can serve under heavy load (`degraded.html`) now
  links `theme.css` and takes the site's colours (background, panel, text and accent), and the
  banner that offers to install the site as an app is tinted in the site's colour instead of
  Morphit's green (on an unbranded site, a shade different from before).
- Nothing to do: the upgrade re-applies your branding, which writes the new file. A site branded
  before this release keeps working the old way until then.

## Branding

- **The hover edge on bright buttons.** The 1px edge a main button (Start, top right, and the other
  solid-colour buttons) lights on hover was drawn in the accent colour. On a theme with bright buttons
  the accent colour *is* the button's own colour, so the edge never showed — on Vigilante Trading's gold
  buttons (`champagne-gold`) it was gold on gold. It now has a colour of its own: on bright buttons the
  theme's lightest colour, lifted until it stands out (a pale gold, `#fff9e8`, on `champagne-gold`); on
  deep buttons the accent colour, as before. With some colours of your own a deep button sat right on
  the accent colour too (1.01:1); the edge is lifted lighter there as well. In every theme the edge, as
  drawn (at 90% opacity over the button), is at least 1.8:1 from the button — lighter than it, or, on a
  button so light that not even white stands out from it (Morphit's emerald, yellows, cyans, white), a
  darker shade of it. (Many buttons
  inside dialogs, chat and settings also brighten by 10% on hover, edge included; there it stands out
  a little less — about 1.6:1 on `champagne-gold`, where it used to be invisible.) An unthemed site
  paints exactly as before (Morphit's emerald edge).
  Nothing to do: the upgrade re-applies your branding — on a branded site its output shows
  "✓ Applied your branding (…) to the live frontend." near the end. If, after the upgrade, the edge
  still shows the old colour on your buttons (whatever the upgrade printed — an upgrade whose last
  step ran out of time can leave the old look), run `sudo morphit-ops branding apply` on that server.
- **Branding stopped half-way.** The server sends the pre-compressed copies of a page (`.gz`, `.br`)
  to most browsers. If applying the branding stopped half-way (a full disk, a power cut) after the
  page was rewritten but before its compressed copies were, the next run saw the page already
  branded and skipped it — and browsers kept getting the old compressed copy. Branding now writes
  the compressed copies before the page and checks them too before skipping a file, and a reset puts
  back every original, compressed copies included, even after a run that stopped half-way.

## Operators page: orders and earnings for every operator

- **What was wrong.** The page promised each operator's orders and earnings, but showed them only on
  the operator's own site, only for BLURT listing fees, and only from the version that started
  counting them — so nearly every operator showed nothing, everywhere.
- **Now** every operator has both figures, since it started, and the list is ordered by orders,
  then earnings:
  - **Orders** — orders posted through its site (carrying its operator tag) whose fee this site holds
    as paid (verified, or verified by attestation): paid in BLURT, BTC or XMR, or a free first buy,
    whatever the order's status now. This is each site's own count: a site that does not list an
    asset has none of its orders, and BTC and XMR payments are confirmed by each site's own
    explorers, so sites can differ a little.
  - **Earned** — the BLURT that reached its fees account in Morphit fee payments: listing fees,
    first-contact fees and featured-slot bids. Computed from the chain alone, so it is the same on
    every Morphit site, whatever assets or settings each has. It follows the money: each payment is credited to the
    operator whose registered fees account received it, as registered when it was paid (a payment
    from before an operator first registered its fees account counts for the first account it
    registers, if the payment names that operator). The 10% that goes to the Morphit treasury is
    nobody's earnings, and neither is a fee paid from an operator's fees account itself (it cannot
    pay itself, so that fee goes wholly to the treasury; BLURT a fees account sends itself never
    counts). A payment counts only when the treasury
    got its tenth — the check every fee already passes — so BLURT sent round in a circle cannot
    inflate the figure for free, and registering someone else's account claims nothing paid into it
    before. A featured-slot bid is credited by the tag of the order it features, as that order's own
    op on the chain carries it. BTC and XMR fees go entirely to the treasury, so they add orders, not earnings. For an operator whose fees account is the Morphit treasury (morphit.io, or a site that
    left its fees account blank) the page says "Paid to the Morphit treasury" under the figure.
- The indexer now records every fee payment with the transfers that paid it (two new tables,
  `fee_payments` and `fee_payment_legs`, carried in snapshots). Payments indexed before this version
  are filled in after the upgrade from the chain: each original transaction is fetched again through
  the node's own RPC pool and checked against its id before anything is recorded; a block that
  cannot be fetched is set aside and tried again every 10 minutes. At most 16 transfers are recorded
  per fee payment (a fee has at most two), so a crafted transaction cannot make the count expensive.
- The figures are computed in the background into a third small table, `operator_stats` (local, not
  in snapshots): within a minute of a new fee payment and at least every 10 minutes, so the page
  never waits on the count. `/v1/operators` adds `fee_account`, and `stats` for every operator
  counted (an operator registered since the last count has none until the next one, and every
  operator has none until the first count after the upgrade, which waits until the node has caught
  up with the chain).

## Pages and wording

- **Glossary:** a "Morphit" entry — the open source software that runs this site and many others,
  each run by its own operator, developed by the Dev Team at Agorise; every site reads the same
  Blurt blockchain, so your account works on all of them, and the software never holds your coins
  or your keys.
- **Homepage:** the first sentence ("Anonymously trade cryptocurrencies, fiat, goods, services and
  more") is 10% smaller at every screen size, and the logo above it sits a little higher.
- **Privacy & terms:** "We go further than encouraging privacy" links to the privacy page.
- **Privacy page:** "the next asset we add will get a guide automatically", and the large heading
  at the top (and on each asset's guide) is drawn in the site's own colours, like the other pages'
  headings, instead of plain white.
- **FAQ:** every edit requested, in all ten languages — "Who runs Morphit?", the comparisons with
  LocalBitcoins/LocalMonero, BasicSwap and Bisq/Haveno, the fees, Blurt and BP answers, the chat and
  privacy answers (with the @-name examples), the operator answers — and two more "Related" links:
  "How do I sell crypto?" → "What are the fees?", and "How does the chat inbox work?" → "If I block
  someone, will they know?". "encrypted chat chat" in the request was written "encrypted chat".
- **The bookmark tip** on the Instances page names ENS addresses too, in every language.
- **Translations:** a round of fixes found by a native-language review (Spanish, French, Italian,
  German, Polish, Russian, Persian and both Chinese) — grammar, a wrong word or two, terms that must
  stay in English; the FAQ question about the Blurt-blog checkbox now quotes the checkbox as it
  reads (French, German, Polish, Russian, Persian, Chinese). In Persian, an @-name, a Matrix
  address (@agorise:matrix.org) and a /@name path in the middle of a sentence now read left to
  right instead of being reordered by the right-to-left text around them.
- **Narrow phones.** On a 320 px screen the menu row under the header, in Russian, German, Polish,
  Spanish and Italian, pushed its last link (Help) off the screen, and in French the header's Start
  button (also at 768 px, a tablet, in French and Russian); all now fit, and no label is cut in the
  middle of a word. A long FAQ question and the
  Instances page's filter menu no longer push past the screen's edge either. The Operators page
  keeps long operator tags inside the screen and writes its numbers the page language's way
  (1,234 in English, 1.234 in German), not the browser's.
- **Without JavaScript** the notice says "This site works without JavaScript — partly." and "This
  site never sees your keys." On a branded site, the pages the app draws in the browser (an order, a
  chat, a profile) said "Morphit" there.

## Hidden RPC nodes (hidden-rpc v1.3.0)

- hidden-rpc v1.3.0 puts a small gateway in front of blurtd on every hidden RPC node, which serves
  the indexer snapshot (checked against `@morphit`'s signed SHA-256) and passes JSON-RPC through.
  Checked against Morphit's own code before this release: `fast-sync` downloads and accepts the
  snapshot from it, the snapshot mirror imports and pins it, and single and batch JSON-RPC calls
  reach blurtd byte for byte. Nothing changes in Morphit's code; the docs now say that nodes on
  hidden-rpc v1.3.0 or later serve the snapshot (OPERATIONS.md, HIDDEN-RPC-SNAPSHOT-MIRROR.md).

## Warrant canary

- **An upgrade puts your canary back.** An upgrade installs a fresh served folder, which has no
  `canary.txt` or `pgp_keys.asc`. A canary signed on the same server was signed anew by the upgrade,
  but one signed on another computer (the recommended set-up for a VPS) stayed missing until you re-ran
  `bash ~/.morphit/update-canary.sh` there — a canary that disappears reads as one that tripped. The
  upgrade now puts the canary served before it and its public key back, the same bytes (so the
  signature still checks), and says until when the canary is valid; its "Valid through" date still runs
  out on its own, so a canary you stop signing still goes stale as before. The upgrade's last lines ask
  you to re-sign when it could not put the canary back (and says why), when the canary it put back runs
  out within 5 days (or has, or has no readable date), or to publish the public key again when the key
  could not be put back — each with the command for where the canary is signed; otherwise there is
  nothing to do. Where the canary is signed on the server itself and the upgrade can run its refresh
  (its timer, or the uploader's refresh script), it is signed anew there, replacing the one put back.
- It copies only what a canary is. The upgrade runs as root and reads a folder your canary upload can
  write, so a file is copied only when it is a regular file with one name (checked again after it
  is read, so a second name made in the meantime is caught too), reached with no link anywhere
  inside the old install (so nothing planted there — a link, or a second name for another file — can make the
  upgrade copy out a file only root can read), of a canary's or a key's size, and, as a whole, a signed
  Morphit canary or PGP **public** key blocks. Anything else is left behind, and the upgrade says so.

## Tests (maintainer)

- `apps/indexer/test/integration/operator-earnings-v1218.test.ts` (real dispatcher, handlers,
  Postgres and `/v1/operators` route): every operator's orders and earnings from listing,
  first-contact and featured-slot fees; the treasury leg of a split fee and a fee paid from a fees
  account itself credit nobody; BLURT sent to a fees account without the treasury's tenth (1,000,000
  BLURT with a refused op, or 9% to the treasury) credits nobody; an operator that registers, later,
  an account others were paid in claims none of it (also at the boundary block); an operator that
  changes its fees account, twice in one block, is credited by the account in force at each
  payment's block; a treasury-account operator is credited only for whole fees that name it; an
  operator that registers its fees account after a payment is credited for it; a second operator
  registering the same account later is not; an underpaid order counts no order but its BLURT; a
  decoy transfer is ignored; every fee op is recorded, even one refused before any handler; the
  back-fill reproduces the same figures from the chain, runs in the background (the indexer goes on
  while its block fetches are out), fetches nothing once done, and records nothing for a transaction
  served altered (the rest of its block is recorded). Seen failing on v1.21.7's code, and with each
  rule removed or loosened in turn (the treasury's tenth, the whole-fee treasury rule, the
  named-operator preference, the first-registration preference, the legacy grace and its naming
  condition, each end of the as-of-block interval); the back-fill test failed while a pass still
  held the indexer.
- The same test file, after the deep review: two nodes with different settings (another fees
  account, BTC not listed) compute the same earnings; orders whose fee was verified by attestation
  count; a fee op with 20 transfers records 16; a NUL character in a memo or payload is recorded
  the same way live and by the back-fill; a featured-slot bid takes the tag from the featured order's own op, not from this
  node's orders table; a back-fill whose RPC fails for a while sets those blocks aside and fills
  them in once the RPC answers; and the real poller loop back-fills and computes the figures on its
  own. Each seen failing with its rule removed (mutation runs: the feature tag, the payload tag, the
  leg cap, the signer check, the payload cleaning, attested orders, the retry, the set-aside
  handling, the named-operator preference, each of the poller's two calls).
- `api-response-shape-smoke` (matrix-bot): `/v1/operators` entries with `fee_account` and `stats`,
  and the shapes that must be refused. Seen failing.
- `apps/web/src/lib/brand/brandCss.test.ts`: the site name survives the trip through `theme.css` for
  every usable name (accents, Hebrew, Chinese, punctuation), as one CSS identifier that nothing can
  break out of; anything else names no site; a page the app draws in the browser has the name before
  anything renders, without `brand.json`; a stylesheet that names no site falls back to `brand.json`;
  a prerendered page keeps its stamped name. Seen failing before the change. Also: the address
  bar's colour comes from `theme.css` while `brand.json` never answers, and from a stylesheet that
  arrives late; a name hidden inside a longer value is not read as one.
- `apps/web/src/lib/net/serviceWorkerBrand.test.ts`: the service worker's whole answer to a brand
  request, with real requests and a cache that matches as the browser's does — a logo stored before
  the branding is never handed out while the server answers, nor in place of an error; offline the
  stored copy is used; a `?fresh=1` read never gets it; the logo URLs the pages use carry
  `?fresh=1`. Each check seen failing (six mutations).
- `apps/web/src/lib/net/brandResponse.test.ts`: the service worker answers brand files from the
  network first, keeps its copy for offline use only, and waits for a slow server rather than hand
  out a copy that may predate the branding. Seen failing with the old stale-while-revalidate order.
- `apps/ops-cli/test/branding.test.ts`: branding writes `theme.css` (and its gzip copy) with the name
  and the colours, and a colour theme alone writes it too. Seen failing before the change. A full
  disk (injected) while writing a page's `.gz`, while saving its original `.gz`, and a page an older
  version left with its old `.gz`: the next apply finishes the job (and, after the failure while
  saving the originals, a reset restores every byte). Seen failing with the old skip check.
- `theme-tokens-smoke` TT-10: the shipped `theme.css` sets nothing, and `app.html` links it
  render-blocking, before any script.
- The service worker is now type-checked (`tsconfig.sw.json`, in `npm run check`, the workspace
  typecheck smoke and CI): `svelte-check` skipped it and the build only warned.
- Checked in Chromium, frame by frame: on a `champagne-gold` build, a brand-new browser opening a
  profile, the orders page and the glossary, and a browser that had the unbranded site (and its
  service worker) before it was branded, paint the branded background and logo from the first frame
  and never Morphit's — also with every `/brand/*` answer held back 1.5 s and 3 s. (The same check on
  an unbranded build finds Morphit's logo in the header, so it would see it.) A first try that
  served the stored copy after a 2 s deadline showed the old Morphit logo for a whole page with 3 s
  answers; that deadline was dropped.
- `theme-tokens-smoke` TT-9: reads the hover rule and the button's face from the CSS (the sources, and
  the built frontend when present), resolves both to theme tokens, takes the rule's own opacity, and
  checks that the edge as painted stands out from the face (1.8:1) in every preset with deep and bright
  buttons, on white and near-white bright buttons, and in 200 random themes the engine accepts. Seen failing with the hover
  painted in brand-primary (the shipped bug: `champagne-gold/bright` 1.00:1), with the old deep-button
  rule (1.01:1), with a white bright button (1.00:1), with the contrast measured on the opaque colour
  (1.72:1 as painted) and with the rule's opacity lowered to 0.5.
- `apps/ops-cli/test/theme.test.ts`: the edge token, deep and bright, on 240 random themes and on white
  and near-white bright buttons.
- `apps/ops-cli/test/canaryCarry.test.ts`: the canary put back byte for byte (also with bytes that are
  not UTF-8, and with CRLF line ends and armor headers as gpg writes them); a link in the file's name or
  in a folder above it, a hard link, a FIFO, an oversized file, contents that only start like a canary
  or a key, a crafted key file of 4 million lines and a file already in the new folder are not copied
  (and never make it throw); a failed write leaves nothing behind; the last lines' words for a canary
  that runs out soon, has run out, has no date, or lost its key; a second name made for the file
  while it is read; a canary uploaded with a strict umask is still readable by the web server; a
  canary without its marker or with an odd armor line is refused. Each check seen failing with its
  protection removed.
- `upgrade-frontend-deploy-smoke`: the upgrade puts the canary back before it hands the served folder to
  the canary uploader, and does not then call the canary cleared.
- Reviewed three times by a separate reviewer attacking the change and then each round of fixes, with
  real gpg output, a real bind mount and Chromium's own pixels; every finding fixed and guarded, except
  the dimmer edge on buttons that brighten on hover, where the wording now says what holds.
- Then a deep review of the whole release by eight separate reviewers (indexer, web and service
  worker in Chromium, ops-cli, security, the release checklist, and three translation reviewers),
  and a second round of two reviewers attacking the fixes, whose findings were fixed in turn:
  - earnings: a featured-slot bid is credited by its order's own op, not an earlier malformed one
    or a later repeat with the same name; BLURT a fees account sends itself counts for nobody; a
    block set aside gets its three tries again after its time aside; the figures are counted
    without holding the indexing loop; `operator_stats` never leaves the node in a snapshot
    (`snapshot-trust`). Each seen failing.
  - branding: a full disk while saving a page's original, or its `.br`, then the next apply and a
    reset; a page left with a new `.gz` but its old `.br`; a full disk as the page itself is
    written (its compressed copies are already branded). Each seen failing.
  - canary: whether the last lines call the canary cleared, over every case; a canary with
    something before its signed message is not copied. Each seen failing.
  - web: the logo URLs the components actually render carry `?fresh=1`
    (`MorphitLogoBling.test.ts`); a stored `brand.json` is not handed out over an error; a server
    that never answers gets the worker's 504 for a logo, while `theme.css` keeps its stored copy;
    colours from `theme.css` are never painted over by an older `brand.json`, and a late
    stylesheet sets the toolbar colour; the Operators page's numbers follow the page language
    (`i18n-formatters-smoke`); Persian Matrix addresses and /@paths (`rtl-handle-and-footer-tasks-smoke`).
    Each seen failing.
  - Two tests no longer depend on the machine they run on: the canary tests point every upgrade
    state file into their own folder, and the relay heal test's self-heal records its web heal
    there too (it wrote `/var/lib/morphit-ops/web-heal.json` on the test machine). The fake
    `docker` in `bunkerwebWafIdentify.test.ts` writes its state atomically: two `docker inspect`
    calls at once could read it half-written and fail the test now and then (also on v1.21.7).
  - Checked in Chromium on a fresh build, branded and unbranded: no horizontal overflow at 320,
    360, 375 and 768 px in all ten languages on the home, FAQ, Instances, Operators, orderbook,
    glossary and privacy pages (none at 800, 900 and 1024 px on the home page either), and no menu
    label cut mid-word from 320 to 600 px.
- `rtl-handle-and-footer-tasks-smoke`: an @-name in Persian text is kept left to right, and an
  e-mail address, a link or a `code` span is not touched; other languages get no invisible marks.
  Seen failing.
- TT-9 reads the edge's opacity only from `rgb(var(--…) / <number>)`; any other way of writing it
  fails the check instead of counting as fully opaque.
- Checked in Chromium: hovering Start on a `champagne-gold` build draws `#fff9e8` at 90% on the
  `#d6b26a` face (was `#d6b26a`); the unthemed build still draws `#00da69`; a build branded by v1.21.7's
  code and then by this release's (the upgrade's order) ends with the pale-gold edge. Compiled-CSS
  comparison with v1.21.7: 1511 rules each, every one paints the same values.
