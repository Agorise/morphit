# ADR-0008: Phase 3b indexer architecture

**Status:** Accepted
**Date:** 2026-04-18
**Supersedes:** none
**Depends on:** ADR-0001 (custom_json replacement ops), ADR-0005
(Phase 3 subphase split), ADR-0007 (keygen curve + dblurt package)

## Context

Phase 3a shipped the ability to create accounts and broadcast ops.
Phase 3b needs to make those ops *readable* — specifically, the
orderbook, profiles, feedback, and release-discovery UIs need to
query current state derived from on-chain ops. The Blurt chain
itself is not a good source for that query surface: `get_account`
returns account data, not arbitrary op history; reading full block
history for every frontend page load would be prohibitively slow
and hammer public RPC nodes.

The indexer is the bridge: it follows the chain's op stream, picks
out Morphit-relevant ops, and exposes queryable state over HTTP.

## Decision

### Ingest: pull, not push

The indexer polls `condenser_api.get_block` and
`condenser_api.get_dynamic_global_properties` on a ~3-second
cadence (Blurt's block interval), using the existing relay-style
multi-endpoint rotator pattern.

**Why pull over push:**

- Blurt's HTTP-JSON-RPC is the only transport dblurt supports
  post-0.7; WebSocket subscriptions aren't available
- Pull-based indexing is crash-safe: the indexer records the last
  successfully-indexed block and resumes from there on restart
- Polling latency is bounded and predictable (~3 seconds per
  block), good enough for an orderbook that isn't latency-
  sensitive the way an order-matching engine would be
- We can rate-limit ourselves trivially (don't make more than one
  `get_block` call per block interval)

### Storage: Postgres

PostgreSQL 15+ is the indexer's backing store.

**Schema strategy — hybrid event log + materialized views:**

- **Event log table** (`ops`): every morphit op we've ever seen,
  append-only, primary-keyed on `(block_num, trx_in_block,
  op_in_trx)`. Never updated, never deleted. Audit surface.
- **Materialized state tables** (`orders`, `profiles`,
  `feedback`, `releases`, `chat_messages`): current derived
  state. Written by op-handler functions as new ops arrive.
- Materialized tables can be fully rebuilt by replaying the event
  log in order. This is the DR / schema-migration strategy.

**Why not SQLite:**

- Postgres's concurrency story is better (the indexer writes while
  the HTTP layer reads)
- Horizontal scale paths exist (read replicas, partitioning)
- `tsvector` full-text indexing is ~free; we'll want it for
  profile display names and search

**Why not a graph or document DB:**

- Query patterns are simple: "list orders filtered by asset + side
  + location + freshness", "get profile by account name", "tally
  feedback for account X". Relational works.
- No joins we can't express in standard SQL

### State model: replace-in-place for logical updates

Consistent with ADR-0001, morphit ops are protocol-immutable on
chain. The indexer compresses this to the user-facing view:

- `morphit_order_v1` creates a row in `orders` with `status =
  'live'`
- `morphit_order_replace_v1` looks up the target by permlink,
  updates the row, preserves the original `created_at` and bumps
  `updated_at`. The event log keeps both the original and the
  replacement; the `orders` table shows only the latest state.
- `morphit_order_cancel_v1` flips `status = 'cancelled'`, keeps
  the row for audit (no hard delete)
- `morphit_feedback_response_v1` attaches to the original
  feedback row as a nested response (separate table joined on
  `feedback_id`), not replacing the original feedback

### Reorg handling: trail the irreversible block

The indexer maintains two block pointers:

- `head_block`: the highest block we've received from the chain
- `indexed_block`: the highest block we've applied to materialized
  state

We only apply ops from blocks where `block_num <=
last_irreversible_block_num` (provided in every dynamic global
properties response). This means the indexer trails head by ~15-
21 blocks (45-63 seconds), which is the price of never needing to
roll back. DPoS irreversibility is effectively permanent; no reorg
recovery logic needed.

### Reconciliation + catch-up

On startup, the indexer:

1. Reads its last-applied block from the database
2. Polls current `last_irreversible_block_num` from the chain
3. Fetches every block in between, applying morphit ops it finds
4. Only after the catch-up is complete does it begin serving HTTP
   queries

This means a fresh deploy has a lengthy initial sync before the
HTTP API goes live. Acceptable for a project still in launch.

### HTTP API surface — REST + JSON

Endpoints the frontend needs:

- `GET /v1/health` — uptime, chain head, indexed head, lag in
  blocks
- `GET /v1/orderbook` — filter by asset, side, location region,
  freshness; paginate; returns live orders only
- `GET /v1/orders/:account` — orders for a specific account
- `GET /v1/profiles/:account` — latest profile for an account
- `GET /v1/accounts/:account/feedback` — feedback records + summary
  stats (count, weighted avg)
- `GET /v1/release` — latest verified `morphit_release_v1` op
- `GET /v1/chat/:account_a/:account_b` — chat messages between
  two accounts, newest first, paginated

No POST endpoints — all writes go to the chain via Phase 3a's
relay or via broadcast from the user's browser. The indexer is
strictly read-only from the frontend's perspective.

### Authentication

None. Every HTTP endpoint is public. Morphit's whole design
premise is that on-chain data is public; the indexer mirrors that
publicness. See ADR-0006 for why CSRF/auth concerns don't apply.

### Op validation at ingest time

The indexer re-verifies every op's signature against the Blurt
chain's public-key records before applying to materialized state.
This is strict — an op can fail:

- Structural validation (wrong shape, missing required field)
- Signature validation (signer's posting key doesn't match the
  account's recorded posting key)
- Authorization (e.g. a `morphit_order_replace_v1` targeting an
  order not owned by the signer)

Ops failing any of these land in the event log tagged as
`rejected` (so we know they existed) but never update materialized
state. The frontend never sees them.

### Pagination + freshness

- All list endpoints return `{ items, next_cursor }` cursor-based
  pagination, not offset-based. Cursors are opaque base64-encoded
  `(block_num, trx_in_block, op_in_trx)` tuples
- `ETag` + `Cache-Control: max-age=3` on responses. A 3-second
  cache window matches the indexer's poll cadence — clients get
  fresh data exactly as fast as the chain produces it

### What's NOT in 3b

- Price feed integration (ADR-0004 is the UI-side fallback; 3b
  doesn't compute or serve prices)
- Full-text search of order bodies (basic `ILIKE` queries are
  fine for launch; `tsvector` is wired but exposed as a 4+
  phase)
- ~~WebSocket / SSE push to the frontend (polling is fine; upgrade
  path is clean if we want it later)~~ **Shipped in Phase E**:
  SSE endpoints `/v1/orderbook/stream`, `/v1/chat/stream`,
  `/v1/instances/stream` are now live. Frontend consumers buffer
  events and flush per-rAF (see `apps/web/src/lib/orderbook/
  stream.ts` and `apps/web/src/lib/chat/stream.ts`). Each stream
  has a 500-event buffer cap (Audit 2026-05 findings 2-11 and
  NEW-10-2).
- Historical reporting / analytics endpoints
- Search-by-region geolocation (strings in, strings out; no geo
  math)

## Alternatives considered

### Chain-of-state — no event log, only derived state

Smaller storage footprint, simpler schema. **Rejected:**
rebuilding after a schema change would require re-reading the
Blurt chain from launch block, hitting public RPC nodes hard and
taking hours.

### TimescaleDB instead of plain Postgres

TimescaleDB's hypertables are good for time-series-heavy workloads.
**Rejected:** Morphit's queries aren't time-series-shaped. The
orderbook queries "live orders matching filters" — a set
operation, not a range scan. Plain Postgres is enough.

### Redis for hot materialized state

Performance argument: hot-path reads (orderbook, profile) happen
often; Redis could serve them in <1ms.  **Rejected for 3b:** adds
a second stateful component to operate. Postgres with proper
indexes + `max-age=3` Cache-Control handles the traffic volume
Morphit will see in its first year. Revisit in Phase 5 if metrics
justify it.

### Writing the indexer in Go instead of Node.js/TypeScript

Go is the traditional choice for a streaming indexer — high
throughput, low memory, easy static binary. **Rejected:** same
reason as Phase 3a — no actively-maintained Go library for Blurt
means we'd re-implement the signature-verification logic.
`@beblurt/dblurt` gives us the full verify path in TypeScript, and
Node 22 is fast enough for our op-rate ceiling (we won't exceed
a few hundred morphit ops per hour in the foreseeable future).

## Consequences

### Positive

- Single language (TypeScript) across relay + indexer + frontend,
  with shared libraries (`@beblurt/dblurt` provides the same
  signing + verification primitives all three need)
- Hybrid log + materialized strategy is standard and well-understood
- Trailing irreversibility makes reorg handling a non-issue
- REST + JSON is the broadest-compatibility API shape

### Negative

- Database migrations need care. Adding a column to `orders` is
  easy; changing the primary key triggers a rebuild from the
  event log. Migration system design is a separate sub-decision
  (next section).
- No websocket push means a 3-second worst-case staleness for UI
  updates. Acceptable given the orderbook's human-scale decision
  speed.

### Migration strategy (follow-up)

Database schema changes fall into three classes:

1. **Additive, non-breaking** (new column with default, new index):
   applied in-place with standard `ALTER TABLE`. No downtime.
2. **Materialized-view rebuild**: new handler logic, different
   derivation from event log. Rebuild the affected table from the
   event log, then switch over atomically in a transaction.
3. **Event log schema change**: rare. Requires a re-read from
   chain. Documented as an operator task in the indexer README.

Each type gets a separate migration script, versioned sequentially.
Using a bare-minimum migration tool (single numbered `.sql` files
+ a `schema_migrations` table tracking applied versions) rather
than a framework — simplicity wins when there are few migrations
and no ORM involved.

## References

- `docs/PHASE-3a-DESIGN.md` — the design doc this ADR extends
- `docs/PHASE-3a-STATUS.md` — what shipped in 3a
- ADR-0001: custom_json immutability
- ADR-0005: Phase 3 subphase split
- `apps/web/src/lib/net/config.ts` — OP_IDS the indexer must
  recognize
