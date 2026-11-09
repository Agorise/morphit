# Morphit v1.23.5

Trading with the same person again now builds your reputation, a branded site's links show its
own name, and Vigilante Trading's logo can be bigger.

v1.23.4 was tagged but never published on chain, so no site installed it. This release contains
everything in it: see [RELEASE-NOTES-v1.23.4.md](RELEASE-NOTES-v1.23.4.md).

## For people using the site

**Trading again with the same person counts.** Until now, only the latest review from a person
counted toward your rating, however many times you two traded. Now each earlier trade with them
counts too, at half the weight of a new partner. It counts when the trade is proven: you reviewed
each other for that order within a week of it being completed, its owner marked it completed
naming the other, and its listing fee was paid in BLURT (or it was a free first buy; a BTC or XMR
fee is checked by each site at its own pace, so it cannot prove a trade the same way everywhere).
And the trades that count are at least 3 days apart. Nobody has to type anything
for this: it follows from the two reviews and the completion. So when a trade goes well, review
your partner back. The reminder to review back now also shows for a review that does not count
yet, since reviewing back is what makes it count.

A pile of reviews from one side still counts once: someone who reviews you again and again, on
order after order, without you reviewing them back, still counts only with their latest review.

Two people who trade with each other often are no longer flagged as a review ring for it.

**Links to a branded site show its name.** A link to vigilante.trading sent in a text message or a
chat app showed "Morphit — No-KYC P2P Marketplace…" as its title. The bare address, and links to a
profile, an order or a chat, now show the site's own name and its preview picture, as its other
pages already did.

## For operators

Upgrade before **2026-11-22 00:00 UTC**. From that time (by block timestamp) the review and
partner-name check stops treating a proven repeat trade as ring evidence: an indexer still on an
older release would refuse reviews the others accept and disagree with them from then on. A
snapshot from an older release, exported on or after that time, is refused on restore, and an
indexer that an older release ran past that time does not start on v1.23.5 (its log says
`repeat_trades_gap`; `docs/UPGRADING.md` has the two ways on).

- The upgrade (database schema v73) adds the new columns. Then, at every start, before it applies
  a block, the indexer records when each order's partner was named where that is missing (from
  the completion ops it holds: `order_naming_times_set` in the log), which order admitted each
  review that has none recorded (`review_order_accounts_set`), and what each review weighs
  (`review_weights_worked_out`); at the first start, and after an older version has applied
  blocks, it also re-checks the review-ring flags a proven trade could make wrong
  (`review_signals_redone`). All of it reads only what your indexer already holds and gives
  the same result as indexing afresh; until the first start finishes, ratings count each
  reviewer's latest review only, as before.
- The web server now answers `/` and the app's own pages (profiles, orders, chats) with
  `spa-shell.html`, a copy of `index.html` that branding names your site in, and falls back to
  `index.html` when a build has none. `/index.html` itself is still served as is: visitors'
  browsers check it against the on-chain record, and now also check that `spa-shell.html` loads and
  runs exactly what `index.html` does. A BunkerWeb box gets the new web server config
  with the upgrade, and the upgrade switches a hand-copied bare-metal `web.conf` too.
- **A bigger logo for a logo that reads small:** `sudo morphit-ops branding apply --logo-size 120`
  shows the header and homepage logo at 120 % of the standard height (50–200; `--logo-size 100`
  goes back). It is saved as `MORPHIT_INSTANCE_LOGO_SIZE` and re-applied on every upgrade. The
  footer logo keeps its size. On vigilante.trading, run that once after this upgrade (120 is
  what we recommend there; Morphit's own sites need nothing).

## For developers

- Repeat trades (`indexer/reputation/repeatTrades.ts`):
  - Proven (`provenTradeSql`): the other party reviewed back citing the same permlink, both
    reviews were admitted by the same order (`feedback.order_account`), that order was completed
    naming the other, and both reviews fall within 168 hours of its `completed_at`. The recorded
    order is the citation rule's first choice among the orders whose fee verdict is the same on
    every node from the block that posted them (`pinnableOrderSql`: a BLURT fee on an order
    posted from the consensus v2 activation time on, or a first-buy waiver): a BTC or XMR fee
    becomes verified when each node's explorer check gets to it, and the BLURT re-check may still
    raise an older order on its legacy grace whenever it runs, so either would let two nodes
    record different orders. A review admitted only by such an order records
    none and proves nothing (its admission is unchanged). So a fee-free order posted under the
    same permlink, or an old paid order completed with someone else, proves nothing, and neither
    does naming a partner on an order completed long ago (G7). Worked out from `feedback` and
    `orders` whenever it is needed, never stored. With `asOf`, only the back review and a partner
    named (`orders.counterparty_named_at`, the completion time when not recorded) by then count;
    with `since`, only reviews stamped from then on.
  - `citationCandidatesSql` (`indexer/reviewCitation.ts`) is the citation rule as one SQL text,
    used by the handler and by `healOrderAccounts`, which at every start records the admitting
    order of each review from before the activation time without one, as of the review's own
    time (the order completed naming the other is preferred only if it was named by then); what a
    later review recorded live, none included, is final. `healNamingTimes` fills in
    `counterparty_named_at` at every start, before any block (the upgrade replay included), from
    the latest applied completion op naming that partner, else the completion time.
  - `feedback.review_weight`: 1 for the reviewer's latest order-bound review of the subject (as
    before), 0.5 for an earlier one that is proven and spaced (walking the pair's reviews in
    (created_at, id) order: proven and at least 72 hours after the last spaced one, an unproven
    review using up nothing) and at least 72 hours before the latest one, else 0
    (`pairWeights`). Worked out again for both directions of a pair on each review and completion
    between them (`rewalkPairsOfTrade`, in a savepoint) and for every review at start
    (`rewalkAllPairs`, one read, bulk writes of what changed). Display only. The aggregates
    (`countedFeedbackFrom`), the profile summary and lists (`reviewWeightSql`) and the receipt read
    it; a review not worked out yet weighs by the latest-review rule (a partial index keeps that
    branch free once all are worked out). The weighted rating multiplies each decay weight by the
    review weight, and the composite score's count is the weight sum (`feedback_weight` on the
    order rows; the receipt's `count_weighted`, and each row's `review_weight` and `proven`).
  - Signals B and D leave a pair's proven reviews out of the pair's own count only (the
    averages, the reviewer's other subjects and the totals are as before), so they only ever flag
    less. `reciprocityEverHeld` takes `ignoreProven` the same way, which `hasVerifiedChat` (the
    review and partner-name gate) always passes, counting as proven only trades whose two reviews
    are both stamped at or after `CONSENSUS_V3_ACTIVATION_TIME` (2026-11-22T00:00:00Z; each such
    review recorded its order live on every node): before that time the verdict is exactly the
    old one, and from then the gate accepts more, never less. The fee-attestation quorum is
    unchanged.
  - `redoReviewSignals` (`indexer/reviewSignalsRedo.ts`), when due
    (`indexer_state.review_signals_redo_due`: the first start, and whenever `repeatTradesGuard`
    finds blocks an older version applied): each Signal B flag on a pair with a proven review,
    and each Signal D flag on a reviewer with one, is dropped and its detector run again at each
    review time live indexing ran it, as of that time, in one transaction. That reproduces exactly what live indexing under the new rule raises, partners
    named late included.
  - `checkRepeatTradesRule` (`indexer/repeatTradesGuard.ts`, the waiver-evidence guard's
    pattern): `indexer_state.repeat_trades_through_block` follows the applied block, and if an
    older release applied blocks stamped at or after the activation time the indexer stops with
    `RepeatTradesGapError`. The snapshot check refuses a pre-v73 snapshot exported at or after
    that time.
  - `/v1/accounts/:account/feedback` items carry `pair_flagged` (the pair is flagged by the
    anti-ring signals); the review-back reminder skips only those, not every review that does
    not count yet.
  - Migration v73 adds `feedback.order_account`, `feedback.review_weight`,
    `orders.counterparty_named_at`, `indexer_state.repeat_trades_through_block` and
    `review_signals_redo_due`, and `feedback_weight_unworked_idx`.
  - The FAQ (10 languages), `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md` and
    `docs/UPGRADING.md` say how repeat trades count.
- The brandable app shell: `scripts/build-brand-slots.mjs` writes `build/spa-shell.html` from the
  fresh `index.html` (with `.gz`/`.br`), adds the link-preview picture (`og:image`,
  `twitter:image`, their alt text) after app.html's static preview tags with the build origin
  taken from the prerendered pages, and records its brand, theme and origin slots like any
  prerendered page. Both nginx configs: `location /` is `try_files $uri $uri.html @spa` (it had
  `$uri/index.html`, which answered `/`), and `@spa` tries `/spa-shell.html` before
  `/index.html`. `nginxVhostHeal` rewrites exactly those two lines as shipped in a bare-metal
  vhost with the app's `@spa`, and flags them in what nginx loaded. The in-page build-integrity
  check (`lib/net/releaseHashCheck.ts`, `lib/net/shellIntegrity.ts`), once `index.html` matches
  its signed hash, fetches `/spa-shell.html` and requires it to be the signed bytes but for what
  the build and branding write, where they write it: the brand attributes before the first
  `<html>` tag's `>`, the first theme-color meta's colour, the naming metas' content, the
  link-preview picture tags right after the first twitter:description meta (exactly as the build
  writes them), and one numeric custom-property `<style id="morphit-theme">` right before the
  first `</head>`. Those values hold no quote of either kind, no angle bracket and no entity but
  `&amp;`, and
  none sits inside a script or style of the signed page, so no parser — the page's, with
  scripting on, included — reads the copy differently but for them. A server without the copy
  (it answers with `index.html`, or 404) passes.
- Logo size: `MORPHIT_INSTANCE_LOGO_SIZE` (`INSTANCE_ENV.LOGO_SIZE`, 50–200, 100 is no setting),
  `--logo-size` on `branding apply` (and in `status`), written to `/brand/theme.css` as
  `html:root{--brand-logo-scale:…}`. `MorphitLogoBling` multiplies the header logo's height by it
  (not the footer's, not an explicit `wordmarkSrc`); the homepage hero's height classes carry the
  same factor.
- Tests: on real Postgres, `repeat-trades` (24: the weights on the profile, the receipt and the
  orderbook card; the 7-day window each way; old orders named late; the 72 hours; an unproven
  review in between; a late review back; both parties owning the permlink; old paid orders
  recycled through a fee-free order; the one-sided pile; Signals B and D; the flag redo, partners
  named late included, and only when due; the gate before and after the activation time, across
  it, and never stricter; two nodes, a BTC fee verified on one and not yet on the other; a node
  that ran an older version for a while; what a review from the activation time on recorded
  staying final; BLURT orders from before v2), `migration-v73-upgrade` (5: an upgraded node equals a
  fresh one review by review, the admitting order chosen as of each review and never a BTC-fee
  one, the naming times from the ops, and the latest-review rule until the start-up steps),
  `repeat-trades-guard` (7), `reputation-scale` (3: both states at 50,000 reviews);
  `consensusActivationTime`, the snapshot-manifest smoke (4 new), the review-back reminder smoke
  (2 new), `waiver-evidence-guard-wiring-smoke` (4 new: the repeat-trade guard and the start-up
  steps before any block), the feedback handler mocks. 50 mutations of the repeat-trade rules,
  all caught (conditions that could never change a result were removed instead).
  `shellIntegrity.test.ts` (60, every bypass the reviews found among them) and 17 mutations of
  the shell check, all caught; `branding-contract-smoke` C-10d brands app.html's shell copy with
  the real build and branding code and runs the browser check on it. `nginx-served-hardening-smoke` runs both shipped configs in a real nginx and checks `/`, the
  app's pages and `/index.html` with and without `spa-shell.html` (14 new); `branding.test.ts`
  (the shell copy, the logo size, `--logo-size`), `nginxVhostHeal.test.ts`,
  `branding-contract-smoke` C-10, `MorphitLogoBling.test.ts`; 15 mutations, all caught. Checked
  end to end: the build branded as Vigilante Trading with its own origin, served by the shipped
  frontend nginx config, answers `/` with "Vigilante Trading — No-KYC P2P Marketplace…" and its
  own preview picture while `/index.html` is unchanged; in a browser the bare address goes on
  to the homepage and a profile page loads, without errors, on a desktop and a phone; at 120 %
  the header logo is 38.4 px and the homepage logo 115.2 px (52.8 px on a phone), the footer
  40 px; an unbranded build keeps 32, 96 and 40.
- CI: the smoke pulses now start after the integration tests (`needs: integration` in `ci.yml`).
  The runner runs two jobs at a time, and beside a smoke pulse it ran the quorum read-ahead test
  nine times slower than a quiet machine, failing its wall-clock bound.
  `chat-block-quorum-prefetch.test.ts` also simulates 300 ms quorum reads instead of 100 ms, so
  the gap it measures (9 s one read after another against about 1.2 s eight at a time) outweighs
  the machine's own time; it still fails when the reads go one at a time.
- CI and installs: `scripts/fetch-matrix-bot-natives.mjs` tries a GitHub download again after a
  server error, a 429 or a dropped connection (after 5, 15, 30 and 60 s) instead of failing on
  the first: a 504 from GitHub failed CI. Any other answer is still final, and every download is
  still checked against its pinned SHA-256.
- Test fix: `certbot-monitor-renewal-due-smoke`'s certificate-age cases sat within a second of a
  whole day of age (Let's Encrypt's 90 days less a second), so the age read 83 or 84 days by
  whether the clock ticked mid-check, and it failed on a loaded machine. They are now an hour off
  the boundary, and still fail when the monitor's stall comparison is off by one.
- Performance: with each review's weight stored, the orderbook's rating aggregate over 300,000
  reviews takes about 90 ms (about 400 ms in v1.23.4); right after the upgrade, before the
  start-up walk, about 230 ms. That start-up work over 300,000 reviews takes about 20 s the
  first time and about 2 s at each later start; `reputation-scale` holds a page under its 600 ms
  bound at 50,000 reviews in both states.
