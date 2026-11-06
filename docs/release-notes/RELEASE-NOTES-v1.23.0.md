# Morphit v1.23.0

A new page: **Blurt Nodes** (`/witnesses`), where anyone can see every Blurt witness and vote
for the ones that keep the chain running well. Nothing about fees, prices or trades changes.

## For people using the site

**The Blurt Nodes page.** The Blurt network is run by hundreds of independent people, each
running a "witness node" that produces the chain's blocks. The new page lists all of them,
linked at the bottom of the footer's Federation column. Unlike the usual witness list, it is
not ordered by vote rank: the witnesses that have produced blocks the longest, missed the
fewest and run a current version come first, and gold stars (in thirds) show how reliable
each one is. Every row shows:

- how long the witness has produced blocks, with a link to its own announcement;
- how many blocks it has missed since it started;
- its vote rank and its stars;
- how much more vote it needs to move up one place ("#1 right now" for the first);
- the version it runs (in amber only when it is a whole version behind, like 0.8.x).

A witness that missed blocks in the last day gets a red flag saying how many. Click any
column's heading to sort by it, and again to reverse; on a phone or a small tablet each witness
is a compact card instead, with a sort menu and a reverse button at the top. Witnesses that
are switched off or have not produced a block in 30 days are hidden behind a link at the bottom.

**Voting.** Signed in, click the arrow next to a witness and confirm to vote for it; click
the lit arrow and confirm to take the vote back. The heading shows how many of your 30 votes
are left. A witness vote is signed
with your Active key, in your browser, like Power Up: with a password-protected Active key
you enter your password; signed in with your Posting key only, you paste your Active key for
that one vote. A vote moves no BLURT; Blurt splits your Blurt Power evenly across the
witnesses you vote for, so a few good votes count for more than many. Signed out, the arrow
takes you to sign in and straight back to the page — also when you sign in on a new device with
your Posting key, by QR code from a signed-in phone, or by just unlocking a locked session (a
seed or key file import first asks for your account name, as before).

**Pictures stay off until you ask.** Each witness shows a plain head by default. "display"
shows their pictures, which your own instance fetches and serves: your browser still talks
to nobody but the site you are on. On a Tor/I2P-only site there is no "display" link.

## For operators

Nothing to set up. Your indexer now:

- reads the witness list from the chain at most once a minute while people look at the page,
  and every 10 minutes writes down each producing witness's total of missed blocks for the
  "missed in the last day" flag (a new local table, `witness_missed_samples`, schema v72:
  about 30 rows every 10 minutes, kept 26 hours, never in a snapshot). A newly upgraded
  instance shows the flag after its first hour, as "missed in N h", and "in 24 h" after a
  day;
- on a clearnet instance, fetches a witness's picture from the host the witness chose — only
  after a visitor clicks "display", at most once a day per picture — through the federation
  probe's guarded fetch (https only, every DNS answer checked public and the connection
  pinned, no redirects, 1 MiB at most, only PNG/JPEG/GIF/WebP kept). The host sees your
  server and `User-Agent: morphit-indexer/witness-avatar`. A zero-clearnet instance never
  does this;
- relays `account_witness_vote` through `/v1/broadcast` (added to the allow-list: it changes
  only the signer's own vote and moves no funds).

OPERATIONS §55 has the details and the log lines to look for.

## For developers

- `apps/indexer/src/indexer/witnessRanking.ts` (pure): the stars — `5 × time × reliability ×
  version`, rounded down to a third; time = weeks ÷ 260 (at most 1), reliability =
  1 ÷ (1 + missed per week ÷ 50), version = 0.75 a whole major.minor behind the newest one at
  least three producing witnesses run (0.9.0 counts as 0.9.1; the chain records whatever version a
  witness's blocks claim, so one witness reporting "0.255.0" cannot put everyone else behind). The factors multiply: an additive draft put
  a witness missing ~456 blocks a week above most others. Only producing witnesses (signing
  key set, a block within 864 000 blocks) are scored; the rest are listed by rank after them.
  Also: BP from votes, "needs" to the next rank, safe announcement links (http(s) only, no
  credentials), picture URLs (https on 443, never a hidden-service name), the missed-in-24-h
  baseline. `test/indexer/witnessRanking.test.ts` (16, on real chain rows from 2026-11-05,
  the numbers blurtwallet shows: khrom 16.54 M BP, agorise-witness "507 K to level up");
  4 mutations caught (additive score, rounding to nearest, comparing patch versions, the
  30-day window off by one).
- `apps/indexer/src/indexer/witnessService.ts`: the cached, coalesced list (paged
  `get_witnesses_by_vote`, 1000 a page), the 10-minute sampler, the hourly accounts read for
  picture URLs, and the picture cache (per witness and URL; a day; failures an hour; 48 MiB in
  all, oldest dropped; 4 fetches at once; one fetch for many askers; only for an account in
  the list; never when `clearnetRefused()`). `test/indexer/witnessService.test.ts` (16);
  6 mutations caught, one of them only after a test was added for an instance that stops
  reaching clearnet after picture URLs were already known.
- `fetchPublicBytes` lifted out of `fetchJson` (`indexer/federationProbe.ts`), so the pictures
  go through the same SSRF-guarded code, not a copy; `fetchJson` is now a thin JSON wrapper over
  it. Its deadline now starts before the DNS lookup and covers it (it used to start after); the
  pictures resolve through c-ares (`resolvePublicIpCares`: own timeout, every A/AAAA record
  public) instead of `dns.lookup`, whose 4 shared threads a host that never answers could hold.
- Review fixes (each with a test that fails without it): pictures only for producing witnesses
  (anyone can register a witness; a producing one has real votes), and both gates tested on their
  own; the fetch limit handed from a finishing fetch straight to the next (a new request in
  between used to make it 5); expired failures dropped; the last list served while the chain
  cannot be read; pictures over 4096 px a side refused (read from the PNG/GIF/JPEG/WebP header,
  real Pillow-made fixtures); the route's parameter is `:witness`, because `owner` is one of the
  security middleware's account parameters and forced `no-store` on the pictures; pictures have
  their own rate-limit bucket (`witness-avatar`), so a page of them cannot push a vote to 429;
  `needs_bp` 0 (tied votes) shows "tied with #N". `test/indexer/witnessReviewFixes.test.ts`;
  `test/integration/witness-missed-samples.test.ts` runs the sampler's SQL on PostgreSQL.
- `apps/indexer/src/api/witnesses.ts`: `GET /v1/witnesses`, `/v1/witnesses/votes/:account`,
  `/v1/witnesses/avatar/:witness` (pictures cached an hour, `nosniff`, `default-src 'none'`).
  `test/api/witnesses.test.ts` (3). Documented in `docs/API.md`.
- Migration 72 + `schema.sql`; `witness_missed_samples` is in `LOCAL_ONLY_TABLES`.
- `/v1/broadcast` allows `account_witness_vote`; `broadcast-op-allowlist-smoke` checks it
  passes (and fails without it).
- Web: `routes/[lang]/witnesses/+page.svelte`, `PartialStars.svelte` (SVG stars clipped to
  thirds; `PartialStars.test.ts`, 4), `WitnessVoteModal.svelte` (PowerModal's active-key
  flow), `prepareUnsignedAccountWitnessVote` in `blurt/sign.ts`, `formatMonthYearShort`
  ("Nov '25"), the route in `seo/routes.ts` and the sitemap, the footer link.
  `UnlockActiveKeyModal` takes `purpose="vote"` so it no longer calls a vote a payment.
- `?next=`: the same-origin check moved from `/login` into `lib/utils/safeNext.ts`
  (`safeNext.test.ts`, 5), and the import flow honours it once the account name is known.
- 10 locales: the page, the footer link, the page's SEO title and description, and the
  Active-key box's vote wording. Counts are ICU plurals carrying the number, so Persian shows
  its own digits and Polish/Russian get the right word forms. The native-translations floor
  snapshot is rebuilt (533 new native pairs, none lost).
- Web review fixes (each checked in a browser or with a test that fails without it):
  - Layout: the table starts at `lg` (it overflowed the card by 70–220 px on 768–820 px
    tablets); below that, three-line cards with short forms under 400 px ("↑568K") and the
    "needs" text dropped under 360 px. A layout script measured 10 locales × 8 widths (320–1280
    px) for overflow, clipped versions and the vote button leaving the card, and was confirmed
    to catch the old `md` breakpoint.
  - Announcement links go through `lib/utils/safeWitnessLinkUrl.ts` (http(s) only, no
    credentials, 512 characters at most; registered with `href-xss-smoke`); picture paths
    through `witnessAvatarUrl()` in `lib/indexer/client.ts`, which accepts only the indexer's
    own `/v1/witnesses/avatar/<name>?v=<hex>` shape.
  - Your votes: a loading/failed/ready state tied to the account it was read for, so an answer
    for a previous account (or a slow first answer) can never light the wrong arrows; buttons
    wait while loading; a failed read shows a Retry. The proxy and 30-votes notices are toasts.
    A session without an account name is sent to Settings instead of a dead end.
  - Sorting: every column, the phone sort menu and a reverse button; by stars, producing
    witnesses stay above the rest in either direction.
  - `formatMonthYearShort`: French/Spanish/Italian/Polish/Russian/German use the locale's
    short month ("juil. '21"), Chinese "21年7月", Persian its own calendar and digits.
  - Right-to-left: stars fill from the right, names and versions in `<bdi>`, logical
    padding, the row's hover bar on the reading side.
  - Accessibility: the vote dialog traps focus and gives it back to the arrow; every arrow,
    sort heading and the reverse button has a name that says what it does; the table has a
    caption; the vote arrow's "take back" look also shows on keyboard focus, not only on hover.
  - `?next=`: `safeNextPath` also refuses a path that normalises to `//host`
    (`/.//evil.example`); `/login` honours `next` when only unlocking, and the QR sign-in passes
    it on (`unlock-redirect-next-smoke` checks `safeNextPath` itself).
  - `@sveltejs/kit` 2.70.4 (npm-audit gate); the schema-head smoke pins v72; the media kit zip
    is rebuilt.

## For monitoring scripts: new JSON

`GET /v1/witnesses` (new). `/v1/health` is unchanged apart from `version`.
