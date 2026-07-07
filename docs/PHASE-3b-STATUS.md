# Phase 3b — Indexer — status

**Status:** implementation complete; integration testing deferred.

> **2026-05-11 forward note (Part 120 audit):** the dev
> recipe in §"How to run it end-to-end in dev" below
> shows the indexer on port 8080.  That was the Phase 3b
> default; the indexer has since moved to **port 8081**
> (current default in `apps/indexer/src/config/index.ts`
> `MORPHIT_INDEXER_LISTEN_PORT: ... .default(8081)`)
> because the Phase 3a relay claims 8080.  Operators
> following current OPERATIONS.md + RUN-A-MORPHIT-NODE.md
> use 8081 for the indexer.  This file is a historical
> snapshot; do not cite the port from it.

## Scorecard

| Item | State |
|------|-------|
| ADR-0008 (architecture) | ✅ landed |
| Design doc (`PHASE-3b-DESIGN.md`) | ✅ landed |
| Postgres schema (9 tables, 12 indexes) | ✅ `src/db/schema.sql` |
| Migration runner (numbered, idempotent, CLI) | ✅ `src/db/migrations.ts` |
| BlurtClient (read-only, endpoint rotation) | ✅ `src/blurt/client.ts` |
| Signature / signer extraction | ✅ `src/blurt/verify.ts` |
| Handler contract | ✅ `src/indexer/handler-contract.ts` |
| Dispatcher (per-op savepoints, event log) | ✅ `src/indexer/dispatcher.ts` |
| Poller (chain-id pin, crash-safe resume) | ✅ `src/indexer/poller.ts` |
| 8/8 handlers | ✅ `src/indexer/handlers/` |
| HTTP middleware (body-cap, security, cors, rate-limit) | ✅ `src/api/middleware/` |
| 7/7 endpoints | ✅ `src/api/` |
| Entry point + graceful shutdown | ✅ `src/main.ts` |
| Shared types package | ✅ `packages/indexer-client/` |
| Frontend indexer client | ✅ `apps/web/src/lib/indexer/client.ts` |
| Orderbook page wired to real indexer | ✅ `apps/web/src/routes/orderbook/+page.svelte` |
| i18n (orderbook UI × 10 locales) | ✅ +39 leaves each; parity at 339 |
| Unit tests (verify, shared, 4 handlers) | ✅ `apps/indexer/test/` |
| README | ✅ `apps/indexer/README.md` |
| systemd unit | ✅ `ops/systemd/morphit-indexer.service` |
| nginx config | ✅ `ops/nginx/indexer.conf` |
| Postgres init script | ✅ `ops/postgres/init.sql` |
| env example | ✅ `ops/env/indexer.env.example` |
| Integration tests (poller vs. real Postgres) | ⏸ deferred |
| Dispatcher test (block-level replay) | ⏸ deferred |
| E2E with live chain fixture | ⏸ deferred |

## What the indexer can do (end-to-end)

1. Boot against a fresh Postgres, apply migrations, initialise
   `indexer_state` with `chain_id` and `last_applied_block =
   startBlock - 1`
2. Poll the chain every 3s for head + last-irreversible
3. Fetch each irreversible block we haven't applied yet
4. For every `custom_json` op with a morphit id:
   - Extract the signer via `required_posting_auths`
   - Parse the payload JSON
   - Look up the handler, invoke it inside a savepoint
   - Write the result (applied or rejected) to the event log
5. Bump `last_applied_block` in the same transaction
6. Expose the derived state over HTTP at 7 endpoints, with proper
   middleware chain (security → cors → body-cap → rate-limit)
7. Respond to SIGTERM by finishing the current block and draining
   HTTP connections before exiting

## What it explicitly does not do (yet)

- **No cryptographic signature re-verification.** We trust the
  consensus verdict that landed the block in
  `last_irreversible_block_num`. This is documented in
  `verify.ts`.
- **No multi-sig account support.** Handlers receive a single
  signer via `required_posting_auths`; accounts with composite
  auths that don't resolve to a single posting key are excluded
  from the release handler's trust check (returned as
  `valid=false`). If Morphit v2 needs multi-sig handlers, this
  is a schema + dispatcher change, not a handler change.
- **No chat retention policy.** `chat_messages` grows forever.
  A maintenance job to prune ciphertext older than N days is
  a Phase 5 concern.
- **No materialised-state rebuild logic.** The
  `rebuildMaterialized` hook exists but is empty in v1. If a
  future migration requires replaying the event log to rebuild
  a derived table, that code goes there.
- **No integration tests against a real Postgres or fixture
  chain replay.** Unit tests cover handlers, signer extraction,
  and cursor codecs; poller-to-poller block replay is a gap.

## How to run it end-to-end in dev

From the repo root (assumes Postgres 15+ running locally):

```bash
# 1. Prepare role + database
sudo -u postgres psql -f ops/postgres/init.sql
# (edit ops/postgres/init.sql first to change the password, or
# use an existing role)

# 2. Install workspace deps
npm install

# 3. Copy env example and fill in DATABASE_URL
cp ops/env/indexer.env.example apps/indexer/.env
# edit apps/indexer/.env

# 4. Apply migrations
cd apps/indexer
npm run migrate

# 5. Run the indexer
npm run dev

# 6. In another terminal, hit the health endpoint
curl http://127.0.0.1:8080/v1/health
```

The frontend's orderbook page expects the indexer at
`https://indexer.morphit.io` by default; override
`MORPHIT_INDEXER_ORIGIN` in `apps/web/src/lib/net/config.ts`
for local testing or edit before running `npm run dev` in
`apps/web/`.

## Testing

```bash
cd apps/indexer
npm test
```

Ten test files, four handlers covered, plus the verify helpers
and the shared API helpers. Tests are pure unit — no DB, no
chain, no network. See `README.md` for the integration-test gap.

## Files delivered in Phase 3b

- `apps/indexer/` — 32 source files (1 SQL, 27 TS) + 7 test files
  (~2,700 LoC application; ~700 LoC tests; ~280 LoC SQL)
- `packages/indexer-client/` — 2 files (package.json + types)
- `apps/web/src/lib/indexer/client.ts` — 1 file (~230 LoC)
- `apps/web/src/lib/net/config.ts` — +16 LoC (`MORPHIT_INDEXER_ORIGIN`)
- `apps/web/src/routes/orderbook/+page.svelte` — replaced
  placeholder with ~390 LoC real implementation
- `apps/web/src/lib/i18n/locales/*.json` — +39 leaves × 10
  locales (390 strings)
- `docs/adr/0008-phase3b-indexer-architecture.md` — ADR
- `docs/PHASE-3b-DESIGN.md` — design doc
- `docs/PHASE-3b-STATUS.md` — this doc
- `ops/systemd/morphit-indexer.service` — unit file
- `ops/nginx/indexer.conf` — nginx config
- `ops/postgres/init.sql` — DB init
- `ops/env/indexer.env.example` — env example
- `package.json` (root) — workspaces declaration

## Handoff notes

- The codebase is strict-TypeScript and ESM-only. `tsx` is the
  runtime; there is no build step.
- Every handler returns a stable reason slug on rejection. If
  you're adding a new rejection path, use snake_case and document
  it in the handler comment. Slugs are contract — changing an
  existing one is a breaking change for anyone grepping the event
  log.
- The frontend's `Result<T>` error codes are the indexer's
  `ErrorCode` union plus two frontend-local values
  (`network_error`, `timeout`). Keep these in sync: if the
  indexer adds a new error code, declare it in
  `packages/indexer-client/src/index.ts` before the frontend can
  handle it type-safely.
- The release handler is the only one that reads from the chain
  mid-processing. All others are pure DB writes. If you're adding
  a handler that needs chain context, prefer denormalising into
  the payload instead — chain reads inside the poller loop slow
  catch-up.
