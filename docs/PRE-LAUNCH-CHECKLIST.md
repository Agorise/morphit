# PRE-LAUNCH-CHECKLIST.md

**Status:** living document.  Last refreshed: 2026-05-17 (Part 122 cp30).

This is the consolidated, ordered list of operator actions
required (or recommended) before flipping morphit.io from
pre-launch into a live public instance.  Items here are
either:

- **[blocking]** — launch cannot proceed until this is done
- **[recommended]** — launch can proceed but operator
  experience or user trust suffers without it
- **[optional]** — improvements that can ship post-launch

Every line traces back to a specific Part (audit campaign
turn) that introduced or refined the action.  If an item
is closed in a later Part, this file is updated **in the
same turn** as the closing change — never trailing.

Memory #5 makes this rule explicit: "All files kept current
in the same work unit as code changes — docs, ADRs, brag
list, FAQs, locale JSON, CI config, etc.  No trailing stale
files."  This checklist is included in that rule: any Part
that closes an item must update this file in the same turn.
Any Part that ADDS an operator action must also update this
file in the same turn.

---

## A. Account setup (one-time, before first broadcast)

- [ ] **[blocking]** Generate the `@morphit` Blurt account
      if it doesn't already exist.  Posting key stays on
      the operator's personal laptop, OFF the morphit.io
      production server.  This key signs the
      `morphit_release_v1` ops that pin the canonical
      treasury addresses on chain.  *(Origin: Part 106.)*

- [ ] **[blocking]** Generate the `@morphit-relay` Blurt
      account.  Active key is encrypted by the ops-cli init
      wizard (Section C below) into
      `apps/relay/keystore.json` (or `.wif`), read by the
      relay process for account creation, operator payouts,
      and all relay broadcasts.  *(Origin: ADR-0010 §3;
      keystore path corrected to match ops-cli init wizard
      output, Part 122 cp16.)*

- [ ] **[blocking]** Generate the canonical BTC treasury
      address.  Native segwit (`bc1q...`) recommended.
      Seed backed up offline; spending key never reaches
      the morphit.io production server.  *(Origin:
      Part 106.)*

- [ ] **[blocking]** Generate the canonical XMR treasury
      wallet.  Primary address (`4...`, 95 chars) is the
      only piece needed for production — **no private
      view key required** since Part 108++.  Seed backed
      up offline.  End-to-end sanity check: after the
      indexer is running with the address configured,
      have a trusted contact send a small test payment
      with a tx_proof and submit it through the real
      Morphit UI.  *(Origin: Part 106; view-key
      requirement removed in Part 108++; previous
      diagnostic script retired in Part 110.)*

- [ ] **[recommended]** Generate the `@morphit-fees`
      Blurt account if you want a distinct treasury
      account from `@morphit`.  Used as the `fee_recipient`
      in operator-config; receives BLURT-paid listing fees.
      *(Origin: Part 106; defaults to `@morphit-fees`.)*

- [ ] **[blocking]** **Fund the `@morphit-relay` account
      with starter BLURT before launch.**  The relay
      pays for these BLURT-cost activities:
       - **Account creation via weekly ACT minting
         (OPERATIONS §2)** — the relay does NOT mint
         Account Creation Tokens at signup time.  The
         operator runs a weekly ceremony broadcasting
         `claim_account` ops, each of which burns the
         chain's `account_creation_fee` (currently
         **~100 BLURT per ACT**, witness-set).  At
         signup time the relay broadcasts the fee-free
         `create_claimed_account` consuming a pre-
         minted ACT.  Operator-side, the cost is "you
         need to fund the relay enough to mint enough
         ACTs to cover expected weekly signups."
       - **Welcome bonus** — 10 BLURT liquid + 10
         BLURT vested per user on first feedback.
         Paid at the moment the user earns it from
         the relay's running balance.
       - **Loyalty BP delegation** — small (1 BP →
         ~1 BLURT-equivalent) granted on first
         verified BLURT-paid fee.
       - **Low-balance auto-refill** — refills
         active users who run critically low on
         BLURT (default 1 BLURT per refill).
       - **Routine ops** — chat-identity registrations,
         feedback ops, signup-failure compensation;
         sub-BLURT each.

      Realistic sizing (ACT cost ~100 BLURT each,
      one ACT per expected signup, plus running
      bonuses/refills):

      | Expected signups | Suggested float |
      |---|---|
      | Quiet soft-launch (~5 testers) | **~700 BLURT** |
      | First-week ~50 users | **~6,000 BLURT** |
      | First-week ~100 users | **~12,000 BLURT** |

      The ACT minting cost dominates; ~100
      BLURT/signup is the load-bearing number.
      Top-ups any time without restart — the relay
      checks its own balance on every signup and
      emits `operator_balance_low` log lines when
      thin.  See OPERATIONS §0a + §1 + §2 for the
      full breakdown, the recurrent-transfer
      top-up mechanism, and the weekly ACT minting
      ceremony.

      **Don't get caught short**: an operator who
      funds 250 BLURT (the old sizing-table
      conservative figure, since corrected) cannot
      mint enough ACTs for even 3 signups, let alone
      a meaningful launch.

      *(Origin: Part 110; sizing figures corrected
      Part 112 after spotting the 1→100 BLURT
      error, ACT-vs-direct mechanism explanation
      corrected Part 112 follow-up after spotting
      that the relay uses `create_claimed_account`,
      not `account_create`.)*

- [ ] **[blocking]** **Fund the `@morphit` account with
      ~10 BLURT before launch.**  Small fixed cost;
      not signup-rate-dependent.  `@morphit` is the
      trust-anchor account that signs the chain-
      pinned `morphit_release_v1` op (canonical
      BTC/XMR treasury addresses) plus the periodic
      `morphit_warrant_canary_v1` ops (weekly
      automated, see OPERATIONS §36).  Each op
      consumes BLURT mana; the account needs enough
      headroom for the initial release op plus a
      year-or-two of weekly canary broadcasts.
      ~10 BLURT covers both with margin.

      *(Origin: Part 112 — gap noticed when listing
      the three Morphit accounts and only the relay
      had explicit funding guidance.)*

- [ ] **[blocking]** **Mint the first batch of ACTs
      before opening signups.**  The relay does NOT
      mint Account Creation Tokens at signup time —
      it consumes pre-minted ACTs (one per signup) via
      `create_claimed_account`.  If the relay's ACT
      pool is zero when the first user tries to sign
      up, the signup fails.  Run the weekly ceremony
      once before launch to seed the pool:

      ```
      cd ~/morphit/apps/relay
      npm run mint-acts -- 25
      ```

      This burns ~2,500 BLURT (25 × 100 BLURT) from
      `@morphit-relay`'s balance and adds 25 ACTs
      to the pool.  Size the batch to "slightly more
      than your expected first-week signups" — for a
      soft-launch with 5 testers, mint 10; for 50
      first-week signups, mint 60.

      Schedule subsequent batches via systemd timer
      (recommended: weekly).  See OPERATIONS §2 for
      the full ceremony procedure including
      verification + unattended setup.

      *(Origin: Part 112 follow-up — discovered when
      auditing whether OPERATIONS §0a accurately
      described the relay's payment flow.  Pre-this-
      item, the pre-launch checklist implicitly
      assumed the relay would mint ACTs on demand,
      which is NOT how ADR-0010 §4 designed it.)*

- [ ] **[recommended]** Confirm the `@morphit-fees`
      account exists on chain (whether you use the
      default or a custom name).  This account
      *receives* BLURT-paid listing fees and has
      **no signing key on any production box** — it
      is genuinely receive-only.  No upfront BLURT
      funding required, but the account itself must
      exist before any fee transfer tries to deliver
      to it.  *(Origin: Part 110.)*

- [ ] **[recommended]** Review the listing fee USD
      target and fallback BLURT/USD price.  The wizard
      asks for these during `morphit-ops init`; defaults
      are $0.25 USD listing fee and $0.002 fallback
      BLURT price.  Re-confirm both still match your
      operator intent before launch — BTC/XMR prices
      drift, so the BTC sat and XMR piconero amounts
      computed at wizard-run time may be stale by
      launch day.  Quick refresh:
      ```
      morphit-ops edit  →  Listing fee + fallback BLURT price
      ```
      The wizard re-fetches live Coingecko prices and
      recomputes amounts targeting your USD value.
      *(Origin: Part 110.)*

- [ ] **[blocking]** Set `MORPHIT_INSTANCE_OPERATOR_TAG`
      to your instance's operator tag.  Canonical
      morphit.io uses `morphit`.  Community operators
      pick their own (e.g. `example-community`).  The
      wizard captures this at init time (step 16) and
      writes it to `morphit.config.env`.

      **Without this set correctly, your relay queues
      nothing — every chain op looks like it belongs
      to a different operator, and the conservative
      default ("if I don't know who I am, I pay for
      nothing") engages.**

      This is the gate that makes Morphit's federation
      cost-attribution work: your relay pays only for
      ops carrying your operator tag.  Other operators
      see those ops and skip the payout queue insert,
      so no double-pay across the federation.
      *(Origin: Part 111.)*

- [ ] **[blocking — community operators only]**
      Register your operator tag on chain via
      `morphit_operator_register_v1`.  First-come-
      first-served on the tag value; once claimed, no
      other operator can use it.  Without on-chain
      registration, your 90% operator-payout share
      cannot be attributed even if everything else
      is set up correctly.

      Canonical morphit.io is already registered with
      tag `morphit`; this step applies only to
      community operators standing up new instances.
      Use the wizard step 16 to pick + commit your
      tag; broadcast the registration op separately
      after the wizard completes.  Document for your
      operator-directory listing.  *(Origin: Part 111.)*

## B. First-time chain broadcasts

- [ ] **[blocking]** Broadcast the first
      `morphit_release_v1` op with the `treasury` block
      containing:
       - `btc.address` and `btc.satoshis`
       - `xmr.address` and `xmr.piconero`

      The builder script
      `apps/indexer/scripts/release-build-payload.ts`
      enforces "no viewkey field" defense-in-depth.  The
      op is signed by `@morphit`'s posting key from the
      operator's personal off-server machine.  *(Origin:
      Part 106 + Part 107 + Part 108++.)*

- [ ] **[recommended]** Verify federation propagation by
      polling each peer's `/v1/release.treasury`.  Confirm
      every response shows the same canonical address+amount
      AND that none of them surface a `viewkey` field.
      *(Origin: Part 107 + Part 108++.)*

- [ ] **[blocking]** Broadcast an operator registration
      op (`morphit_operator_register_v1`) for any
      operator_tag this instance will use.  Tags are
      first-come-first-served; pick before community
      operators do.  *(Origin: ADR-0011 operator-earnings
      pipeline.)*

## C. Operator-config files (on the morphit.io production box)

- [ ] **[blocking]** Run the setup wizard:
      `npx morphit-ops init`.  As of Part 122 cp22+ the wizard
      covers ~18 prompts including the fee-verifier
      explorer URLs (BTC + XMR) and chat-link explorer
      URLs (BTC + XMR + BCH + LTC + DASH + DOGE + ZEC; USDT, USDC, DAI have per-network explorers configured separately) with live health-checks,
      plus the trade-only asset policy step.  (Exact
      count drifts as we add operator-config surface;
      see `apps/ops-cli/src/init/steps.ts` for the
      authoritative list — `TOTAL_STEPS` constant.)  Writes:
       - `morphit.config.env` (allowlisted user-tunables)
       - `morphit.env` (critical infrastructure)
       - `apps/relay/keystore.json` or `.wif` (posting key)
       - Optional backup of `morphit.env`

      All four files set to mode 0600.  *(Origin: ops-cli
      init wizard, extended in Part 109; step-count
      audit Part 119.)*

- [ ] **[blocking]** Verify both env files load cleanly
      by starting the indexer briefly and watching for
      Zod config-validation errors:
      `cd apps/indexer && timeout 5 npm run start || true`.
      Repeat for the relay:
      `cd apps/relay && timeout 5 npm run start || true`.
      Both apps' `loadConfig()` run synchronously via Zod
      schemas before any side effects — any misconfiguration
      shows up as a `ZodError` in the first ~100 ms of stderr.
      No `--dry-run` flag exists on either; a 5-second
      `timeout` is the simplest grandma-friendly way to
      exercise validation without staying connected to
      chain.  *(Origin: ops-cli init, post-Part-106 hardening;
      Part 119 audit corrected the nonexistent `--dry-run`
      flag reference; Part 122 cp16 walkthrough extended
      validation to the relay env after the cp16 VAPID
      walkthrough showed how easily a relay-env gap can
      hide.)*

- [ ] **[blocking]** Run the static smoke suite and
      confirm it returns clean.  From the repo root:
      `bash scripts/run-smokes.sh`.  Expected output:
      `Total: 3,327+ scenarios passed, 0 runners failed`
      (the "0 runners failed" is the load-bearing assertion —
      the scenario count is a moving lower bound that ticks up
      as smokes are added each release; baseline-source-of-truth
      is the cp27 floor of 3,327, with cp30 USDC, cp31 DAI, cp32
      icon-coverage + payment-method-i18n-parity, cp33 DOGE, cp39 ZEC, and
      cp34 narrow-union-parity adding scenarios on top.  The
      exact current total is whatever `run-smokes.sh` prints
      against the repo state you're running; what you're verifying
      is that the count is ≥ 3,327 AND that zero runners failed).

      If you see several runners fail with
      `ERR_MODULE_NOT_FOUND` errors all referencing a
      `@morphit/*` package, you skipped the
      `npm install` step (or did it from inside one of
      the workspace sub-directories instead of the
      repo root).  Workspace symlinks live under
      `node_modules/@morphit/*` and are only created
      by an install run from the root.  Fix:
      `cd ~/morphit && npm install --no-audit --no-fund`,
      then re-run the smoke suite.  This is NOT a code
      regression — pure environment setup.  *(Origin:
      Part 121 audit found this drift while extending
      smoke coverage to the asset-registry expansion.)*

- [ ] **[recommended]** If you want priority-#2 maximum
      independence, self-host a `monero-block-explorer`
      + `monerod` Docker stack and point
      `MORPHIT_INDEXER_XMR_EXPLORER_URLS` at localhost.
      ~50 GB disk, ~3-7 days initial monerod sync.  See
      `docs/OPERATIONS.md §40.4`.  Operator confirmed
      OFF the table for the initial launch (cost), but
      remains a documented option for later.  *(Origin:
      Part 108++.)*

- [ ] **[blocking]** Decide your trade-only-asset operator
      stance.  The canonical morphit.io ships USDT, USDC, DAI,
      BCH, LTC, DASH, DOGE, and ZEC enabled by default; alternative
      instances may want to disable one or more instance-wide
      on philosophical (centralization, fork preference),
      regulatory, or audience-specialization grounds.

      **The wizard handles this for you.**  `morphit-ops init`
      step 13 "Trade-only asset policy" (Part 122 cp22) walks
      through every shipped trade-only asset and asks
      per-ticker whether to enable it.  Default for each is YES.
      Pick "n" at the prompt to disable that asset; the wizard
      emits the correct `MORPHIT_INDEXER_DISABLED_ASSETS=` line
      into `morphit.config.env` for you.  Re-run the wizard
      later to change your mind without touching the env file
      by hand.

      Equivalent post-deploy env-edit per-asset options:
      1. Accept everything (default — no config change).
      2. Refuse USDT — set
         `MORPHIT_INDEXER_DISABLED_ASSETS="USDT"`.
      3. Refuse USDC — set
         `MORPHIT_INDEXER_DISABLED_ASSETS="USDC"`.
      4. Refuse DAI — set
         `MORPHIT_INDEXER_DISABLED_ASSETS="DAI"`.
      5. Refuse BCH — set
         `MORPHIT_INDEXER_DISABLED_ASSETS="BCH"`.
      6. Refuse LTC — set
         `MORPHIT_INDEXER_DISABLED_ASSETS="LTC"`.
      7. Refuse DASH — set
         `MORPHIT_INDEXER_DISABLED_ASSETS="DASH"`.
      8. Refuse DOGE — set
         `MORPHIT_INDEXER_DISABLED_ASSETS="DOGE"`.
      9. Refuse multiple —
         `MORPHIT_INDEXER_DISABLED_ASSETS="USDT,USDC,DAI,BCH,LTC,DASH,DOGE,ZEC"`.

      Federation note: disabling an asset means your own
      users cannot POST orders for it; you'll still see
      those orders from peer instances in read-only
      orderbook feeds (chain history is shared).

      Whichever stance you take, document it publicly so
      users know what your instance offers.  Memory #25
      (default-on + operator override for new assets),
      ADR-0023 (USDT), ADR-0024 (BCH), ADR-0025 (LTC),
      ADR-0027 (DASH), ADR-0028 (USDC), ADR-0029 (DAI),
      ADR-0030 (DOGE), ADR-0031 (ZEC), and Part 122 cp22 (wizard step) explain
      the design.  *(Origin: Part 121 cp3 USDT integration,
      Part 122 cp21 BCH integration, Part 122 cp22 wizard
      step, Part 122 cp24 LTC integration, Part 122 cp27 DASH
      integration, Part 122 cp30 USDC integration, Part 122
      cp31 DAI integration, Part 122 cp33 DOGE integration, Part 122 cp39 ZEC integration.)*

- [ ] **[blocking]** Decide BCH chat-link explorer URL.
      Default `https://blockchair.com/bitcoin-cash/transaction/{txid}`
      is fine for most operators.  Override via
      `MORPHIT_FRONTEND_BCH_CHAT_LINK_URL` if you prefer a
      different explorer or run your own.  See
      `docs/OPERATIONS.md` §"BCH chat-link explorer URL
      override" for the alternatives surveyed at cp21
      addition time.  *(Origin: Part 122 cp21 BCH integration.)*

- [ ] **[blocking]** Decide LTC chat-link explorer URL.
      Default `https://litecoinspace.org/tx/{txid}` is fine for
      most operators.  Override via `MORPHIT_FRONTEND_LTC_CHAT_LINK_URL`
      if you prefer a different explorer or run your own.  See
      `docs/OPERATIONS.md` §"LTC chat-link explorer URL
      override" for the alternatives surveyed at cp24
      addition time.  *(Origin: Part 122 cp24 LTC integration.)*

- [ ] **[blocking]** Decide DASH chat-link explorer URL.
      Default `https://insight.dash.org/insight/tx/{txid}`
      (official Dash project Insight, community-led,
      open-source) is fine for most operators.  Override via
      `MORPHIT_FRONTEND_DASH_CHAT_LINK_URL` if you prefer a
      different explorer or run your own.  See
      `docs/OPERATIONS.md` §"DASH chat-link explorer URL
      override" for the 9 alternatives surveyed at cp27
      addition time.  *(Origin: Part 122 cp27 DASH integration.)*

- [ ] **[blocking]** Decide DOGE chat-link explorer URL.
      Default `https://blockchair.com/dogecoin/transaction/{txid}`
      is fine for most operators.  Override via
      `MORPHIT_FRONTEND_DOGE_CHAT_LINK_URL` if you prefer a
      different explorer or run your own (e.g.
      `https://dogechain.info/tx/{txid}`, or a self-hosted
      Iquidus instance).  *(Origin: Part 122 cp33 DOGE integration;
      ADR-0030.)*

- [ ] **[blocking]** Decide ZEC chat-link explorer URL.
      Override `MORPHIT_FRONTEND_ZEC_CHAT_LINK_URL` if you prefer a
      different default from the bundled `mainnet.zcashexplorer.app`.
      Operator's 7-explorer survey at cp39 (mainnet.zcashexplorer.app,
      blockchair.com/zcash, zcashinfo.com, 3xpl.com/zcash,
      blockexplorer.one/zcash/mainnet, zcash.tokenview.io,
      cipherscan.app) is documented in ADR-0031.  *(Origin: Part 122
      cp39 ZEC integration; ADR-0031.)*

- [ ] **[recommended, non-blocking]** **VAPID keypair for
      Web Push notifications** (Part 122 cp13).  Without
      this, push notifications are disabled instance-wide
      and users on your instance see "Not supported on this
      device" in Settings → Notifications.  In-tab ambient
      channels (title-bar badge, favicon dot, OS native
      notifications when the tab is open, audio cue,
      vibration) keep working without VAPID.

      One-time setup:
      ```
      bash scripts/generate-vapid-keys.sh
      ```
      Append the three printed lines to
      `/etc/morphit/relay.env` (replace the placeholder
      mailto: address with a real one — push services
      contact you there if something goes wrong).
      Restart the relay.

      The relay will boot-log either
      `push_enabled` (success) or
      `push_disabled_no_vapid_keys` (missing).  The
      worker's drain interval is tunable via
      `MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS` (default
      30000).  Subscribe-endpoint authentication
      requires a valid posting-key signature by default
      (Part 122 cp14, `MORPHIT_RELAY_PUSH_REQUIRE_SIGNED=true`).
      Full operator reference at
      `docs/OPERATIONS.md` §42 and
      `docs/RUN-A-MORPHIT-NODE.md` Web Push subsection.
      *(Origin: Part 122 cp13–cp14.)*

## D. Infrastructure

- [ ] **[blocking]** Postgres reachable from the morphit
      processes.  Database URL configured in both
      indexer and relay envs.  Initial schema applied
      via the indexer's auto-migrate on first boot
      (currently at v33 as of Part 122 cp13; adds
      `push_subscriptions` + `push_pending` tables for
      Web Push.  cp14 adds the `locale` column on
      push_subscriptions; cp15 audit drops the dead
      `attempts` column from push_pending and adds a
      composite index on push_subscriptions(account,
      created_at DESC) for the locale-lookup hot path;
      cp18 adds `extension_count` + `last_extended_at`
      columns on featured_slot_bids for the anti-snipe
      soft-close auction rule, plus an ix_featured_bids_expires
      index for the "expiring within snipe window" check).
      *(Origin: ADR-0001 schema management; version
      refreshed Part 121 audit.)*

- [ ] **[recommended]** Enable the daily DB backup
      scheduled by the wizard (off by default; opt-in
      during setup).  Retention configurable; default
      14 days.  *(Origin: ops-cli init.)*

- [ ] **[recommended]** Reverse proxy in front of the
      indexer + frontend with HTTPS termination.  Caddy
      or nginx; the wizard doesn't auto-configure this,
      it's deployment-flavor-specific.  *(Origin: ops
      runbook.)*

- [ ] **[optional]** Tor hidden service, Lokinet, I2P
      .b32 address for privacy-network access.  All
      three are operator-configurable in the wizard.
      *(Origin: Part D.5 federation directory + alt-
      network reachability.)*

## E. Frontend deployment

- [ ] **[blocking]** Build the frontend bundle:
      `cd apps/web && npm run build`.  Output goes to
      `apps/web/build/`.

- [ ] **[blocking]** Hash the bundle and include the
      hash manifest in the next `morphit_release_v1`
      op so federated frontends can verify integrity.
      Generate the manifest from the built bundle:
      ```
      cd apps/web && node scripts/build-manifest.mjs
      ```
      This walks `apps/web/build/` and emits a sorted
      SHA-256-per-file manifest (deterministic
      fingerprint of the bundle bytes).  Pass the output
      path to `apps/indexer/scripts/release-build-payload.ts`
      via `--hash-manifest <path>` when building the
      next release op.  *(Origin: ADR-0007 chain-pinned
      hash manifest; build-manifest script reference
      added Part 122 cp19 pre-launch dry-run.)*

- [ ] **[recommended]** Verify your frontend renders
      correctly for ALL 10 locales (en, es, fr, de, it,
      pl, ru, fa, zh-CN, zh-HK) before going live.
      Specifically check the post-order screen at
      `/post` which has the most complex
      locale-dependent UI (per-wallet proof generation
      instructions for XMR, etc.).  *(Origin: Memory
      #4 — 10-locale invariant.)*

## F. Marketing / outreach (pre-launch but soft-blocking)

- [ ] **[recommended]** Launch blog post drafted using
      `MORPHIT-BRAG-LIST.md` as the source-of-truth set
      of claims.  Every claim must be either verifiable
      in code or honestly disclosed as backlog.  *(Origin:
      Memory #15.)*

- [ ] **[recommended]** Matrix channel
      `#agorise:matrix.org` actively monitored, and the
      `@agorise:matrix.org` MXID actively monitored for
      DM security disclosures.  *(Origin: Memory facts.)*

- [ ] **[optional]** Beta-tester intake form actively
      used.  Form is shipped (Memory: "beta-tester
      intake form" completed earlier) — track responses
      and reach out.  Verify form is live + collecting
      submissions correctly.  *(Origin: pre-launch
      hardening campaign.)*

## G. Things explicitly NOT required to launch

These are tracked as REVISIT-LIST follow-ups but do not
block initial launch:

- Self-hosted BTC explorer (Esplora) on the morphit.io
  box.  Public Esplora explorers (blockstream.info,
  mempool.space) are sufficient for the multi-explorer
  cross-check defaults.  *(Operator decision Part 109:
  off the table for now; revisit post-launch.)*

- Self-hosted XMR explorer on the morphit.io box.  The
  5 verified-compatible public explorers in the default
  config provide adequate cross-check.  *(Operator
  decision Part 109: off the table for now; revisit
  post-launch.)*

- Per-user explorer preference (Settings page +
  localStorage) for the chat-link feature.  Part 109
  shipped the per-OPERATOR override; per-user is a
  natural extension but not required to launch.

- Auto-defaulted quorum threshold based on URL count.
  Part 109 ships default 1 (back-compat).  A future
  part may bump to `Math.max(1, ceil(N/2))`.

## H. Day-0 monitoring checklist (the first 24 hours after launch)

> **The full day-zero runbook lives in
> `docs/LAUNCH-DAY.md`.**  The checklist below is the
> condensed pre-flight; the full doc covers T-minus 24h
> rehearsals, T-zero procedures, what to watch hour-by-hour,
> rollback, and end-of-day-zero retrospective.
>
> **For days 1–7 after launch, see
> `docs/POST-LAUNCH-WEEK-ONE.md`.**  Covers monitoring
> cadence, paging thresholds, common week-one situations,
> and when to dial down to sustainable operations.

- [ ] Check `/v1/health` returns 200 every minute.
- [ ] Check `/v1/release` returns the canonical
      treasury block as broadcast.
- [ ] Check `journalctl -u morphit-indexer` for any
      ERROR-level lines.
- [ ] Check Postgres `morphit_indexer_processed_block`
      progresses (each Blurt block advances the
      indexer's pointer; if stuck, RPC issue).
- [ ] Check the first user signup completes end-to-end
      (registration → relay broadcast → on-chain account
      created → orderbook visible).
- [ ] Check the first BTC and XMR fee verifications
      complete.  XMR fee verifications now require a
      user-supplied per-payment proof (Part 108++) —
      verify the post-order form rendered correctly with
      the proof textarea and per-wallet instructions for
      the first XMR-paying user.  Inspect status via:
      `psql -c "SELECT permlink, fee_method, fee_status FROM orders WHERE fee_status IS NOT NULL ORDER BY created_at DESC LIMIT 10;"`.
      Healthy: rows transition from `pending` → `verified`
      within a few minutes of the fee transfer being mined.
- [ ] Watch the **relay balance** trend.  If
      auto-refills are firing on day-zero traffic, the
      relay account drain rate is real; top up
      pre-emptively if you're approaching the
      low-balance threshold.
- [ ] **[if push enabled]** Watch the `push_pending`
      queue size.  Quick check:
      `psql -c 'SELECT COUNT(*) FROM push_pending;'`.
      Healthy: drains to ≤ batch_size (default 50)
      within poll_interval (default 30s).  Growing
      unboundedly = worker is wedged (VAPID misconfig,
      web-push library auth failure, or DB lock).
      Cross-reference with the relay's
      `push_sender_tick` log lines.  *(Origin: Part 122
      cp16 walkthrough — DD-10 single-relay invariant
      makes queue growth a clean failure signal.)*

---

## Update history

| Part | Date | Change to this file |
|---|---|---|
| 122 cp20 | 2026-05-17 | Section C smoke baseline bumped from 3,173 → 3,187 to match the new `version-consistency-smoke` (14 scenarios) shipped this turn.  The smoke catches drift between the root `package.json` version, the 9 sub-package versions, the runtime `VERSION`/`INDEXER_VERSION` constants in relay+indexer `/v1/health`, and the example responses in `docs/API.md` + `apps/indexer/README.md` — pre-cp20 those touchpoints had four different version strings, none of them the release tag.  All 14 unified to `1.0.0-beta.1` and the smoke is wired into `scripts/run-smokes.sh`. |
| 109 | 2026-05-10 | Initial consolidated checklist. Items A-H gathered from Parts 106 + 107 + 108++ + 109 operator-action lists in REVISIT-LIST, OPERATIONS.md §40, RUN-A-MORPHIT-NODE.md, and TARBALL.md.  Section G "explicitly NOT required" reflects operator decision in Part 109 to defer self-hosted explorers. |
| 109 | 2026-05-10 | Section G updated mid-Part-109 after the quorum gate and viewkey-env removal landed.  Removed the two now-closed items (viewkey removal, quorum) and added two new deferred items (per-user explorer preference, auto-defaulted quorum threshold) per Memory #5 same-turn update rule. |
| 110 | 2026-05-10 | Section A gained two new items: relay-account funding (`[blocking]`) and fees-account-exists-on-chain (`[recommended]`).  Operator-reported gap: previous revisions assumed operators knew the relay needed BLURT upfront; explicit checkbox reduces failed first-day launches.  Section A also updated to retire the `verify-xmr-viewkey.ts` reference (script retired Part 110).  Section H expanded with reference to `LAUNCH-DAY.md` (new) and `POST-LAUNCH-WEEK-ONE.md` (new) for day-zero and week-one runbooks. |
| 110 | 2026-05-10 | Section A gained a `[recommended]` "Review listing fee + fallback BLURT price" item.  The wizard prompts for these during init, but BTC/XMR prices drift between wizard-run and launch day so a pre-launch re-confirmation is worth doing — `morphit-ops edit → Listing fee + fallback BLURT price` re-fetches live Coingecko prices and recomputes amounts. |
| 111 | 2026-05-10 | Section A gained two new items for the federation-cost-attribution model: `[blocking]` set `MORPHIT_INSTANCE_OPERATOR_TAG` (canonical morphit.io uses `morphit`; community operators pick their own) and `[blocking — community operators only]` register the tag on chain via `morphit_operator_register_v1`.  Without these, the relay queues NO payouts because it can't prove which ops are "ours." |
| 122 cp19 | 2026-05-17 | Pre-launch dry-run walkthrough surfaced 4 doc gaps: (1) Section A mint-acts invocation used bare `tsx scripts/mint-acts.ts 25` which fails on operator boxes without global tsx; corrected to `npm run mint-acts -- 25` (matching npm script added to `apps/relay/package.json`); (2) Section C smoke baseline bumped from 3,154 → 3,173 to match cp18; (3) Section E added build-manifest script invocation (`node scripts/build-manifest.mjs`) so operators know HOW to produce the hash manifest, not just that they need to; (4) Section H fee-verification check now includes the `psql SELECT permlink, fee_method, fee_status` query so operators can inspect status without spelunking. |
| 122 cp16 | 2026-05-16 | Sally-operator walkthrough surfaced 4 doc gaps: (1) Section A keystore path was stale (`/etc/morphit/keys/relay-active.key` → corrected to `apps/relay/keystore.{wif,json}` matching ops-cli init); (2) Section C env-load verification now covers relay too, not just indexer; (3) Section C smoke-count baseline bumped from 2,900+ → 3,100+ (cp16 baseline 3,154); (4) Section H Day-0 monitoring gains push_pending queue-health check when push is enabled.  Section C VAPID setup step + Section D schema-v33 reference + audit-cp15 refinements landed earlier in cp16. |
| 119 | 2026-05-11 | Section C wizard step-count corrected (14 → ~17 with disclaimer pointing at `apps/ops-cli/src/init/steps.ts` as the source-of-truth list).  Section C also corrected the nonexistent `--dry-run` flag — the indexer has no such flag; use a 5-second `timeout npm run start` to exercise Zod env validation instead.  Section D schema version updated v29 → v31 to reflect Part 113's Signal C addition. |
