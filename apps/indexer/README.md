# `morphit-indexer`

The Morphit chain indexer — a read-only service that watches the
Blurt chain for `morphit_*` ops, materialises them into a queryable
Postgres schema, and exposes the result over HTTP.

## What it does

- **Polls** the chain every `blockIntervalMs` (default 3s), catches
  up block by block, never reads a block more recent than
  `last_irreversible_block_num`
- **Dispatches** each `custom_json` op with a registered morphit id
  to a typed handler, validates payload, writes derived state
- **Records** every op in an append-only event log (`ops` table)
  with status and reason slug
- **Serves** queries over `/v1/health`, `/v1/orderbook`,
  `/v1/orders/:account`, `/v1/profiles/:account`,
  `/v1/accounts/:account/feedback`, `/v1/release`, `/v1/chat/:a/:b`,
  `/v1/instances`, `/v1/instances/stream` (SSE),
  `/v1/orderbook/stream` (SSE),
  `/v1/chat/:a/:b/stream` (SSE)

It does NOT:

- Broadcast transactions to the chain (that's the frontend's job,
  via the relay for account creation or the user's own key for
  trades)
- Hold any authentication state — every endpoint is public-read
- Make cryptographic re-verification of signatures — consensus
  already did that before the block hit `last_irreversible_block_num`

See `docs/PHASE-3b-DESIGN.md` and `docs/adr/0008-phase3b-indexer-architecture.md`
for the design rationale.

## Running locally

### Prerequisites

- Node 24+ (see `engines` in `package.json`)
- Postgres 15+
- Network access to at least one Blurt RPC endpoint

### One-time setup

Install dependencies from the repo root:

```bash
cd /path/to/morphit
npm install
```

Create a Postgres role and database:

```bash
createuser morphit_indexer --pwprompt
createdb morphit_indexer --owner=morphit_indexer
```

Copy the env example and fill in your values:

```bash
cp ops/env/indexer.env.example apps/indexer/.env
# Edit apps/indexer/.env — at minimum, DATABASE_URL must point at
# your local Postgres.
```

Apply migrations:

```bash
cd apps/indexer
npm run migrate
```

### Run the indexer

```bash
cd apps/indexer
npm run dev      # watches src/, restarts on change
# or
npm run start    # one-shot, no watch
```

Healthcheck:

```bash
curl http://127.0.0.1:8080/v1/health
```

## Configuration

All config comes from the process environment. See
`ops/env/indexer.env.example` for the full list with comments. Key
variables:

- `MORPHIT_INDEXER_DATABASE_URL` — Postgres connection string
- `MORPHIT_INDEXER_BLURT_RPC_ENDPOINTS` — comma-separated list
- `MORPHIT_INDEXER_CHAIN_ID` — 64-hex mainnet chain id, pinned at
  DB init; the poller refuses to start if the DB's recorded chain
  id differs
- `MORPHIT_INDEXER_START_BLOCK` — first block to process (only
  honoured on a fresh DB; subsequent starts resume from
  `indexer_state.last_applied_block`)
- `MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY` — trust anchor for the
  `morphit_release_v1` handler; must match the frontend's
  `MORPHIT_OFFICIAL_POSTING_PUBKEY`
- `MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME` — the Blurt account that
  goes with the pinned pubkey (default `morphit`)

## Schema

The database schema is defined in `src/db/schema.sql` and managed
via `src/db/migrations.ts`. Two kinds of tables:

- **Event log** — `ops`, append-only, one row per observed op
  (applied or rejected). Partial unique on
  `(block_num, trx_in_block, op_in_trx)` prevents double-write on
  retry.
- **Materialised state** — `profiles`, `orders`, `feedback`,
  `feedback_responses`, `releases`, `chat_messages`. Derived from
  the event log; can be dropped and rebuilt via
  `npm run migrate:rebuild` (placeholder in v1).

Plus `indexer_state` (single-row table tracking
`last_applied_block` and the chain id) and `schema_migrations`
(tracking applied migration versions).

## Running tests

### Unit tests (default)

```bash
cd apps/indexer
npm test
```

Unit tests are pure — no DB, no network. Handlers are tested
against a mock `pg.PoolClient` that records queries. Signature
extraction, cursor codecs, account-name validation, fee math,
and transfer parsers have dedicated test files.

### Integration tests (optional)

```bash
# Start a Postgres locally, then:
TEST_DATABASE_URL=postgres://morphit_test:password@127.0.0.1:5432/morphit_test \
    npm run test:integration
```

Integration tests exercise real SQL against a real Postgres so
we catch bugs that mocks can't see: CTE behavior, JSONB ops,
INTERVAL arithmetic, CHECK constraints. Each test suite creates
its own schema, applies migrations, then tears everything down
in afterAll. Suites run sequentially (a shared Postgres with a
small connection cap can't take parallel schema churn).

Without `TEST_DATABASE_URL` set, the integration suite skips
cleanly and `npm test` still works on a developer machine that
has no Postgres.

Integration coverage as of Phase 3c:

- Migrations v1 → v3 apply cleanly; table/column shapes; CHECK
  constraints enforce their invariants
- Order handler fee verification against real tables (Sybil
  counting, 24h predicate, missing-transfer path)
- Signal A detector (creator join, proximity window, evidence
  JSONB, idempotence)
- Signal B detector (mutual-reviewer predicate, single-subject
  filter, rating threshold, 7-day window)

Full block-replay integration tests (poller → real chain
fixture → DB assertions) are still a gap; that's a Phase 4
concern.

## Operational notes

- **Restart is always safe.** `indexer_state.last_applied_block`
  advances only after a block's transaction commits, so a restart
  mid-block re-processes that block cleanly.
- **Chain-id mismatch is fatal.** If an operator accidentally
  points the indexer at testnet with a mainnet DB, the poller
  refuses to boot. Reset the DB to switch chains.
- **RPC endpoint failures** cool the failing endpoint for 2s →
  10s → 60s → 5min on repeated failure. Round-robin continues
  against the remaining healthy endpoints.
- **Per-op savepoints** isolate handler failures: one bad op
  cannot poison a block's other ops. The rejected op is still
  recorded in the event log with a stable reason slug.

## Health and monitoring

`GET /v1/health` returns:

```json
{
  "status": "ok",
  "version": "1.0.0-beta.46",
  "uptime_sec": 12345,
  "chain_head_block": 80123456,
  "indexed_block": 80123441,
  "lag_blocks": 15,
  "stale": false
}
```

`stale` flips to `true` and `status` to `degraded` when
`lag_blocks > MORPHIT_INDEXER_STALE_LAG_THRESHOLD`. Alerting on
`degraded` for more than a few minutes is the right signal.

## Streaming endpoints (SSE)

Three endpoints serve Server-Sent Events for real-time
front-end updates:

- `/v1/instances/stream` — federation directory, real-time
  diffs (Phase D.5+). Poll-based internally, 5s diff
  interval; subscribers see registrations and probe-status
  changes as they happen. Typical end-to-end latency from
  on-chain registration to subscriber notification: ~25-40s
  (block time + chain replay + 15s probe scheduler tick +
  HTTP probe time). Worst-case ~80s.

- `/v1/orderbook/stream` — order events (Phase E). Push-based
  via in-process `orderbookEventBus`; every order/replace/
  cancel/feeAttest handler emits, the SSE handler dispatches
  to subscribers matching the filter. Latency: blocks land
  on disk (BLURT confirmation ~3s) + indexer block-tick
  (≤3s) + emit propagation (instant, in-process). Median
  ~3-6s from order broadcast to subscriber notification.
  Filter parameters mirror REST `/v1/orderbook` exactly.

- `/v1/chat/:a/:b/stream` — chat message events (Phase E.5).
  Push-based via in-process `chatEventBus`; the chat handler
  emits after a successful INSERT, the SSE handler routes by
  canonical conversation pair (LEAST/GREATEST(a,b)) so each
  connection only receives events for its specific pair.
  Same latency profile as orderbook (~3-6s median). Frontend
  uses this endpoint as the primary chat delivery path; the
  REST `/v1/chat/:a/:b` endpoint is now used only as a
  defense-in-depth fallback when SSE is unavailable.

All three endpoints use:

- `text/event-stream` content type, no compression
- `:keepalive` comment lines every 25s to defeat
  proxy idle-killers
- `Cache-Control: no-store, no-transform`
- `X-Accel-Buffering: no` to disable nginx response
  buffering (which would defeat the stream)

**Reverse proxy notes.** SSE connections are long-lived.
Configure your nginx (or other proxy) with:

```nginx
location ~ ^/v1/(instances/stream|orderbook/stream|chat/[^/]+/[^/]+/stream)$ {
    proxy_pass http://indexer;
    proxy_http_version 1.1;
    proxy_buffering off;        # let chunks through immediately
    proxy_read_timeout 1h;      # don't kill idle SSE
    proxy_send_timeout 1h;
}
```

Per-IP open-connection caps belong here too (`limit_conn`)
rather than in the indexer middleware. The indexer
deliberately mounts SSE endpoints OUTSIDE its rate-limit
middleware so a few REST requests can't starve a user's SSE
connection budget.

## File layout

```
src/
  api/
    middleware/   body-cap, cors, ratelimit, security
    chat.ts       /v1/chat/:a/:b
    chatStream.ts             /v1/chat/:a/:b/stream (SSE)
    chatStreamHelpers.ts      pure helpers for tests
    feedback.ts   /v1/accounts/:account/feedback
    health.ts     /v1/health
    instance.ts   /v1/instance (this operator's branding)
    instances.ts  /v1/instances (federation directory)
    instancesStream.ts        /v1/instances/stream (SSE)
    instancesStreamHelpers.ts pure helpers for tests
    orderbook.ts  /v1/orderbook
    orderbookStream.ts        /v1/orderbook/stream (SSE)
    orderbookStreamHelpers.ts pure helpers for tests
    orders.ts     /v1/orders/:account
    profiles.ts   /v1/profiles/:account
    release.ts    /v1/release
    shared.ts     cursor codec, account validator, error body
  blurt/
    client.ts     read-only BlurtClient with endpoint rotation
    verify.ts     signer extraction + payload parsing
  config/
    index.ts      zod-validated env loader
  db/
    migrations.ts numbered migration runner + CLI
    pool.ts       pg pool + transaction helper
    schema.sql    initial schema
  indexer/
    dispatcher.ts    block walk, per-op savepoint, handler invocation
    federationProbe.ts   per-block probe scheduler (Phase D.5)
    federationSeed.ts    boot-time seeding for known reference instances
    handler-contract.ts  OpContext, HandlerResult, Handler types
    orderbookEventBus.ts in-process pub/sub for orderbook mutations
    chatEventBus.ts      in-process pub/sub for chat messages
    poller.ts        main loop; chain-id pinning; crash-safe resume
    handlers/
      chat.ts, feedback.ts, feedbackResponse.ts, order.ts,
      orderCancel.ts, orderReplace.ts, profile.ts, release.ts,
      operatorRegister.ts, feeAttest.ts, ...
  main.ts       entry point: boot → poller + http → signal handlers
test/
  api/shared.test.ts
  blurt/verify.test.ts
  handlers/feedback.test.ts, order.test.ts, profile.test.ts, release.test.ts
  testutils/context.ts, mockClient.ts
```
