# Phase 3c — Order posting + enforcement — status

**Status:** implementation complete; Signal A detection and the
edit flow deferred with rationale; integration testing remains
a gap inherited from Phase 3b.

> **2026-05-07 forward note:** the "3-minute" replace-window
> values referenced throughout this document were updated to
> **15 minutes** in Part 70. The implementation files
> referenced below have been updated; the prose in this
> historical status doc still reads "3 minutes" because that
> was the value at the time the doc was written. See
> `docs/adr/0001-custom-json-replacement.md` Amendment
> 2026-05-07 for the threat-model re-analysis and updated
> call-site list.

> **2026-05-11 forward note (Part 120 audit):** the
> per-version schema files referenced in this doc
> (`apps/indexer/src/db/schema-v2.sql`, `schema-v3.sql`,
> etc.) were collapsed in May 2026 into a single
> `apps/indexer/src/db/schema.sql` with inline migration
> sections, plus a `MIGRATIONS` registry at
> `apps/indexer/src/db/migrations.ts`.  The original
> per-version files were moved to
> `apps/indexer/src/db/historical/` for archaeology.
> See `docs/ADDING-A-COIN.md` Step 5 for the current
> migration recipe.

## Scorecard

| Item | State |
|------|-------|
| ADR-0009 (fee model + enforcement architecture) | ✅ `docs/adr/0009-phase3c-order-posting.md` |
| Shared fee math (indexer + frontend) | ✅ `apps/indexer/src/indexer/fee.ts` + `apps/web/src/lib/orders/fee.ts` |
| Permlink generator + payload builder | ✅ `apps/web/src/lib/orders/payload.ts` |
| Order-op broadcaster with active-key signing | ✅ `apps/web/src/lib/blurt/ops/order.ts` + `sign.ts` extensions |
| Compose page (`/post`) | ✅ `apps/web/src/routes/post/+page.svelte` |
| Compose page i18n × 10 locales | ✅ 85 leaves × 10; top-level strings hand-translated, tail falls back to English |
| Schema migration v2 | ✅ `apps/indexer/src/db/schema-v2.sql` |
| `fee_transfers` pre-pass + population | ✅ `apps/indexer/src/indexer/dispatcher.ts` |
| Order handler fee verification | ✅ `apps/indexer/src/indexer/handlers/order.ts` |
| OrderReplace 3-minute window | ✅ `apps/indexer/src/indexer/handlers/orderReplace.ts` |
| Orderbook filter on `fee_status='verified'` | ✅ `apps/indexer/src/api/orderbook.ts` |
| `/v1/orders/:account` surfaces `fee_status` | ✅ `apps/indexer/src/api/orders.ts` |
| Self-trade Signal B (suspicious reciprocity) | ✅ `apps/indexer/src/indexer/signals.ts` |
| Signal B scheduled in poller (1h interval) | ✅ `apps/indexer/src/indexer/poller.ts` |
| Self-trade Signal A (related accounts) | ✅ `apps/indexer/src/indexer/signals.ts` + migration v3 |
| Signal A scheduled in poller | ✅ same hourly pass as Signal B |
| Fee math unit tests | ✅ `apps/indexer/test/indexer/fee.test.ts` |
| ADR-0009 parity tests (both sides) | ✅ parity tests in indexer + frontend |
| Fee-transfer parser tests | ✅ `apps/indexer/test/indexer/fee-transfer.test.ts` |
| Order-handler fee-verification tests | ✅ 9 new tests in `order.test.ts` |
| OrderReplace window tests | ✅ `apps/indexer/test/handlers/orderReplace.test.ts` |
| Signals detector tests (mock) | ✅ `apps/indexer/test/indexer/signals.test.ts` |
| Frontend fee-calculator tests | ✅ `apps/web/src/lib/orders/fee.test.ts` |
| "Post an order" CTA on orderbook | ✅ orderbook header |
| Env example documents fee vars | ✅ `ops/env/indexer.env.example` |
| Edit flow (`/post/edit/[permlink]`) | ✅ `apps/web/src/routes/post/edit/[permlink]/+page.svelte` |
| Integration tests (harness + migrations + key handlers) | ✅ `apps/indexer/test/integration/` |
| Integration tests — full block replay | ⏸ deferred to Phase 4 |
| Signal B SQL coverage via real DB | ⏸ deferred — mock tests cover SQL shape, not semantics |

## What ships

End-to-end flow that now works:

1. User opens `/post`, progressively answers side/asset, amounts/fiat,
   payment methods/region/terms, picks expiry.
2. Frontend fetches the user's recent order count + fresh BLURT price,
   computes the Sybil-tier fee quote in both USD and BLURT.
3. User reviews and enters their session password.
4. Frontend JIT-unlocks the active key via `useActiveKey()`, builds a
   2-op transaction (custom_json + transfer), signs with both posting
   and active keys, broadcasts. The scalar is wiped on return.
5. Indexer observes the block. Pre-pass walks every transaction for
   transfers to `@morphit-fees`, writes all observed transfers to
   `fee_transfers` (audit trail).
6. Dispatch loop processes the custom_json. Handler scans `siblingOps`
   for the matching transfer, counts the signer's live+recent orders
   to compute the expected tier, compares observed amount to expected
   (±1% tolerance), sets `fee_status` accordingly.
7. Orders with `fee_status='verified'` appear in `/v1/orderbook`.
   Orders with `missing`/`underpaid` are visible only via
   `/v1/orders/:account` so the owner can see what happened.
8. For 3 minutes after posting, a `morphit_order_replace_v1` op
   updates the listing. After 3 minutes (measured by block time),
   the indexer drops replaces with `replace_window_expired`.
9. Once per hour, the poller runs Signal B detection: queries the
   last 7 days of feedback for mutually reciprocating ≥3×5-star
   pairs with no third-party reviews, inserts into
   `suspicious_reciprocity`.

## Deferred with rationale

### Full block-replay integration tests

The integration harness shipped this phase covers the SQL paths
most likely to harbor silent bugs: migrations, the order
handler's fee-verification query, and both signal detectors'
CTEs. What's still absent is end-to-end block replay — feeding
a synthetic BlockHeader through the entire poller → dispatcher
→ handler → HTTP endpoint pipeline and asserting the observable
state.

Why not this phase: a good block-replay harness needs realistic
block fixtures (either recorded from testnet or handcrafted),
which is its own small body of work. The SQL-level integration
tests close the highest-risk gap; the block-replay gap is lower-
risk because the fixture-shape assertions are mostly covered by
unit tests already.

Phase 4 scope.

### Important note on integration-test validation

The integration harness and the three test files that use it
were written and structurally reviewed in the same development
environment that did not have a Postgres instance available.
The harness's `TEST_DATABASE_URL` gating is deliberately
designed to skip cleanly when Postgres is absent, so the CI-
or-local run of `npm run test:integration` against a real
Postgres is the true first trial of these tests.

Expected concerns on first run:
- Migration SQL executes through a single `client.query(sql)`
  call; Postgres `pg` driver supports multi-statement SQL in
  simple-query mode, but the DDL in `schema.sql` contains
  semicolons and `$` sigils that could interact with the
  parser. If this surfaces, switch migration execution to
  statement-by-statement parsing.
- `TIMESTAMPTZ` columns receive JS `Date` objects via
  parameterized queries; `pg` serialises these as ISO strings,
  which Postgres accepts. If timezone handling surprises, the
  tests would show it through off-by-one-hour assertions on
  `first_activity_at` gap computations.
- Schema-search-path handling in `db.query` uses a per-query
  `SET search_path` round trip. This adds ~1ms per query; on a
  local Postgres this is negligible, but an operator running
  the tests against a high-latency remote Postgres may want to
  batch.

None of these are blocking issues for shipping; they are
enumerated here so the first CI failure (if any) lands with
context.

## How to exercise end-to-end locally

From the repo root:

```bash
# 1. Postgres + migrations
sudo -u postgres psql -f ops/postgres/init.sql
# (edit the password first)
cp ops/env/indexer.env.example apps/indexer/.env
# edit apps/indexer/.env to point at your DB
cd apps/indexer && npm run migrate

# 2. Run the indexer against a real Blurt testnet or recent block
cd apps/indexer && npm run dev

# 3. In another terminal, the frontend
cd apps/web && npm run dev

# 4. Open http://localhost:5173 — register an account, then
#    navigate to /post and walk through the compose flow.
```

For the fee path to actually verify, the chain you point at must
have a `@morphit-fees` account (or whatever you set
`MORPHIT_INDEXER_FEE_RECIPIENT` to) that can receive transfers.
On Blurt testnet, create it before testing.

## Testing

```bash
cd apps/indexer && npm test
cd apps/web && npm test
```

Total new tests this phase: 47 cases across 7 new test files.
Coverage areas:
- Fee math (indexer + frontend) with ADR-0009 parity assertion
- Sibling-op detection (wrong sender, wrong permlink, wrong recipient)
- Sybil tier escalation (tier 4 user paying tier 1 amount → underpaid)
- 3-minute replace window at exact boundary, under, over
- Transfer parsers (malformed amounts, bad memos)
- Signal B detector SQL shape

## Files delivered in Phase 3c

**Frontend:**
- `apps/web/src/lib/orders/fee.ts` — fee math
- `apps/web/src/lib/orders/payload.ts` — permlink + payload builder
- `apps/web/src/lib/blurt/ops/order.ts` — broadcastNewOrder + broadcastOrderReplace
- `apps/web/src/lib/blurt/sign.ts` — extended with `broadcastOrderWithFee` (2-op atomic signing)
- `apps/web/src/routes/post/+page.svelte` — the compose page
- `apps/web/src/lib/orders/fee.test.ts`

**Indexer:**
- `apps/indexer/src/indexer/fee.ts` — mirror of frontend fee math
- `apps/indexer/src/indexer/fee-transfer.ts` — transfer parsers
- `apps/indexer/src/indexer/signals.ts` — Signal B detector
- `apps/indexer/src/indexer/dispatcher.ts` — siblingOps + fee-transfer pre-pass
- `apps/indexer/src/indexer/handler-contract.ts` — siblingOps field
- `apps/indexer/src/indexer/handlers/order.ts` — fee verification
- `apps/indexer/src/indexer/handlers/orderReplace.ts` — 3-min window
- `apps/indexer/src/indexer/poller.ts` — scheduled signal detection
- `apps/indexer/src/db/schema-v2.sql` — migration v2
- `apps/indexer/src/db/migrations.ts` — v2 registered
- `apps/indexer/src/config/index.ts` — fee config
- `apps/indexer/src/api/orderbook.ts` — fee_status filter
- `apps/indexer/src/api/orders.ts` — fee_status surfaced
- `apps/indexer/test/indexer/fee.test.ts`
- `apps/indexer/test/indexer/fee-schedule-parity.test.ts`
- `apps/indexer/test/indexer/fee-transfer.test.ts`
- `apps/indexer/test/indexer/signals.test.ts`
- `apps/indexer/test/handlers/order.test.ts` (extended)
- `apps/indexer/test/handlers/orderReplace.test.ts`

**Docs + ops:**
- `docs/adr/0009-phase3c-order-posting.md`
- `docs/PHASE-3c-STATUS.md` (this file)
- `ops/env/indexer.env.example` — fee vars documented

**Shared:**
- `packages/indexer-client/src/index.ts` — `status` + `fee_status` on `OrderRecord`

**i18n:**
- +85 post_order leaves × 10 locales = 850 strings
- +1 orderbook.post_cta × 10 locales = 10 strings
- All 10 locales at 427 leaves, parity verified

## Phase 3 cumulative stats

Across 3a + 3b + 3c:
- Approximately 200 source files in the repo
- Approximately 8,000 LoC TypeScript/Svelte (counting tests)
- 4,270 i18n strings across 10 locales (427 × 10)
- 9 ADRs (0001-0009)
- 3 status docs + 2 design docs
- 1 functional P2P orderbook, end-to-end
