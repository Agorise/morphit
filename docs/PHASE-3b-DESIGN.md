# Phase 3b — Indexer · Design

**Status:** Historical design doc (pre-implementation, dated ~Phase 3b). Authoritative behavior is now in the indexer code (`apps/indexer/src/`) and the public API surface in `docs/API.md`. Several payload field names and shapes shifted between this design and the shipped implementation — for example, `price_model` ships as `{ kind: 'spread' | 'fixed', percent | price }` rather than the `{ type: 'spot_plus', percent }` shown in this doc. This file is kept for historical context. Do not cite it for current behavior.

## Goals

The indexer makes the Morphit orderbook actually work. Without it,
the frontend has nothing to read: Blurt stores ops but doesn't expose
arbitrary op-history queries efficiently, and no user can see orders
or feedback without them being collated first.

Concretely, 3b ships:

1. A Node.js/TypeScript service at `apps/indexer/` that polls the
   Blurt chain, parses `morphit_*` ops, verifies signatures, and
   maintains queryable state in Postgres
2. A read-only HTTP API at `indexer.morphit.io` (or wherever the
   operator deploys it)
3. A shared TypeScript types package at `packages/indexer-client/`
   that both the indexer and the frontend import, so response
   shapes can't drift
4. Updates to the frontend that replace its current placeholder /
   mock orderbook reads with real indexer queries
5. Ops + deployment docs mirroring the Phase-3a relay README

See ADR-0008 for the architectural decisions behind this plan.

## Non-goals (explicitly out of Phase 3b)

- **Real-time push**. Clients poll. Upgrade path to SSE or
  WebSocket is noted but not built.
- **Cross-chain indexing**. Morphit is chain-native to Blurt; the
  indexer is too.
- **Redis or other caching layer**. Postgres + `Cache-Control:
  max-age=3` is the caching strategy.
- **Authentication on the API**. The data is public on chain;
  the indexer is a public mirror.
- **Historical analytics / dashboards**. Separate tooling, later
  phase.
- **Full-text search beyond ILIKE**. `tsvector` infrastructure is
  provisioned but not exposed in 3b endpoints.

## Repo layout added in 3b

```
morphit/
  apps/
    indexer/         (Phase 3b, NEW — Node.js/TypeScript service)
      src/
        main.ts              entrypoint
        config/index.ts      env parsing + validation
        db/
          pool.ts            pg connection pool
          migrations.ts      migration runner
          schema.sql         initial DDL (v1)
        blurt/
          client.ts          multi-endpoint dblurt wrapper
          verify.ts          signature verification helpers
        indexer/
          poller.ts          block polling loop
          dispatcher.ts      routes ops to handlers
          handlers/
            profile.ts
            order.ts
            orderReplace.ts
            orderCancel.ts
            feedback.ts
            feedbackResponse.ts
            chat.ts
            release.ts
        api/
          health.ts
          orderbook.ts
          orders.ts
          profiles.ts
          feedback.ts
          release.ts
          chat.ts
          middleware/
            cors.ts
            ratelimit.ts
            security.ts
            contentType.ts
            etag.ts
      test/
        ...
      package.json
      tsconfig.json
      README.md
  packages/
    indexer-client/  (NEW — shared types)
      src/
        index.ts             type-only exports
        endpoints.ts         URL builders
      package.json
      tsconfig.json
  ops/
    systemd/
      morphit-indexer.service
    nginx/
      indexer.conf
    postgres/
      init.sql
    env/
      indexer.env.example
```

## Database schema (v1)

Human-readable SQL with a Postgres-15 syntax baseline.

```sql
-- Tracking which block we've processed.
CREATE TABLE indexer_state (
    id INT PRIMARY KEY CHECK (id = 1),           -- singleton row
    last_applied_block BIGINT NOT NULL,
    last_applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    chain_id TEXT NOT NULL
);

-- Schema version tracking.
CREATE TABLE schema_migrations (
    version INT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description TEXT NOT NULL
);

-- The event log: every morphit op we've ever seen.
CREATE TABLE ops (
    block_num BIGINT NOT NULL,
    trx_in_block INT NOT NULL,
    op_in_trx INT NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    trx_id TEXT NOT NULL,
    signer TEXT NOT NULL,
    op_id TEXT NOT NULL,                         -- morphit_profile_v1 etc
    payload JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
    reject_reason TEXT,
    PRIMARY KEY (block_num, trx_in_block, op_in_trx)
);
CREATE INDEX ops_signer_idx ON ops (signer, block_num DESC);
CREATE INDEX ops_op_id_idx ON ops (op_id, block_num DESC);

-- Profiles: latest profile per account.
CREATE TABLE profiles (
    account TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    json_metadata JSONB NOT NULL,
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

-- Orders. Permlink is the user-supplied unique id within an account.
CREATE TABLE orders (
    account TEXT NOT NULL,
    permlink TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    asset TEXT NOT NULL,                         -- 'BTC' | 'XMR' | 'BLURT'
    fiat_currency TEXT NOT NULL,                 -- 'USD' | 'EUR' | ...
    amount_min NUMERIC,
    amount_max NUMERIC,
    price_model JSONB NOT NULL,                  -- opaque to indexer
    location_region TEXT,                        -- freeform; UI filters
    payment_methods TEXT[] NOT NULL,
    terms TEXT,
    status TEXT NOT NULL CHECK (status IN ('live', 'cancelled', 'expired')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    PRIMARY KEY (account, permlink)
);
CREATE INDEX orders_live_idx ON orders (status, asset, side, updated_at DESC)
    WHERE status = 'live';

-- Feedback from one trader to another.
CREATE TABLE feedback (
    id BIGSERIAL PRIMARY KEY,
    reviewer TEXT NOT NULL,                      -- account leaving the review
    subject TEXT NOT NULL,                       -- account being reviewed
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    order_permlink TEXT,                         -- optional: the specific order traded
    created_at TIMESTAMPTZ NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE,          -- on-chain provenance
    UNIQUE (reviewer, subject, order_permlink)   -- one review per order per reviewer
);
CREATE INDEX feedback_subject_idx ON feedback (subject, created_at DESC);

-- Responses to feedback (optional — the subject can add context).
CREATE TABLE feedback_responses (
    id BIGSERIAL PRIMARY KEY,
    feedback_id BIGINT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    responder TEXT NOT NULL,                     -- must match feedback.subject
    comment TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE
);

-- Release-discovery ops (only the latest valid one is used by clients).
CREATE TABLE releases (
    id BIGSERIAL PRIMARY KEY,
    version TEXT NOT NULL,                       -- semver
    hash_manifest JSONB NOT NULL,
    endpoints JSONB NOT NULL,
    signature TEXT NOT NULL,
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE,
    signer TEXT NOT NULL,
    valid BOOLEAN NOT NULL,                      -- signature + pinned-key match
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX releases_valid_idx ON releases (valid, created_at DESC)
    WHERE valid = true;

-- Chat ciphertext pairs. The indexer stores the opaque ciphertext;
-- only the two participants can decrypt with their X25519 chat-
-- identity keys (derived from posting key; see ADR-0015).
CREATE TABLE chat_messages (
    id BIGSERIAL PRIMARY KEY,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    ciphertext TEXT NOT NULL,                    -- base64 opaque
    header JSONB NOT NULL,                       -- ECIES envelope (ephemeral_pub, nonce, client_tag)
    created_at TIMESTAMPTZ NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE
);
CREATE INDEX chat_pair_idx ON chat_messages (
    LEAST(sender, recipient), GREATEST(sender, recipient), created_at DESC
);
```

## Op handler contracts

Each handler lives in `src/indexer/handlers/<op_id>.ts` and exports
a default function of the shape:

```typescript
interface OpContext {
    blockNum: number;
    trxInBlock: number;
    opInTrx: number;
    blockTime: Date;
    trxId: string;
    signer: string;                              // pulled from trx signatures
    payload: unknown;                            // from the custom_json
}

type HandlerResult =
    | { ok: true }
    | { ok: false; reason: string };

type Handler = (ctx: OpContext, tx: PgTransaction) => Promise<HandlerResult>;
```

Handler contract:

- Handler receives a Postgres transaction already open. It either
  commits state changes or returns `{ ok: false, reason }`.
- If handler throws, the outer dispatcher logs + marks the op
  `rejected` with reason=`'handler_threw'`. Does NOT crash the
  indexer.
- Handlers may read other tables but must not perform chain calls
  (all chain state is already on the OpContext or in the event log).

## HTTP API responses

All responses:
- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: max-age=3, public` (matches poll cadence)
- `ETag` based on `indexed_block_num + resource version`
- `Vary: Accept-Encoding`

### GET /v1/health

```jsonc
{
    "status": "ok",
    "version": "0.1.0-phase3b",
    "uptime_sec": 12345,
    "chain_head_block": 80123456,
    "indexed_block": 80123441,
    "lag_blocks": 15,
    "stale": false
}
```

`stale: true` if lag_blocks exceeds 30.

### GET /v1/orderbook?asset=BTC&side=sell&region=...&cursor=...&limit=50

```jsonc
{
    "items": [
        {
            "account": "alice",
            "permlink": "order-20260418-01",
            "side": "sell",
            "asset": "BTC",
            "fiat_currency": "USD",
            "amount_min": 100,
            "amount_max": 500,
            "price_model": { "type": "spot_plus", "percent": 2.5 },
            "location_region": "North America / US / CA",
            "payment_methods": ["zelle", "wire", "cash_mail"],
            "terms": "...",
            "created_at": "2026-04-18T12:34:56Z",
            "updated_at": "2026-04-18T12:34:56Z",
            "expires_at": "2026-04-25T12:34:56Z"
        }
    ],
    "next_cursor": "eyJibG9ja19udW0iOjgwMTIzNDAwLCJ0cnhfaW5fYmxvY2siOjN9",
    "indexed_block": 80123441
}
```

### GET /v1/profiles/:account

```jsonc
{
    "account": "alice",
    "display_name": "Alice",
    "json_metadata": {
        "bio": "..."
    },
    "source_block_num": 80120000,
    "updated_at": "2026-04-18T11:00:00Z"
}
```

Returns `404` if no profile op exists for that account.

### GET /v1/accounts/:account/feedback

```jsonc
{
    "summary": {
        "count": 42,
        "weighted_rating": 4.7,
        "by_rating": { "1": 0, "2": 1, "3": 2, "4": 8, "5": 31 }
    },
    "items": [
        {
            "id": 12345,
            "reviewer": "bob",
            "rating": 5,
            "comment": "Smooth trade, fast release.",
            "order_permlink": "order-20260417-03",
            "created_at": "2026-04-17T18:00:00Z",
            "responses": [
                {
                    "responder": "alice",
                    "comment": "Thanks!",
                    "created_at": "2026-04-17T19:00:00Z"
                }
            ]
        }
    ],
    "next_cursor": null
}
```

### GET /v1/release

```jsonc
{
    "version": "0.4.0",
    "hash_manifest": { ... },
    "endpoints": { ... },
    "signer": "morphit",
    "source_trx_id": "abc...",
    "source_block_num": 80100000,
    "created_at": "2026-04-18T00:00:00Z"
}
```

Only valid releases (signature matches pinned
`MORPHIT_OFFICIAL_POSTING_PUBKEY`) are returned. No valid release →
`404`.

### GET /v1/chat/:a/:b?cursor=...&limit=50

Returns ciphertext messages between two accounts, regardless of
direction. Only the participants can decrypt. `(a, b)` are
canonicalised alphabetically so `/v1/chat/alice/bob` and
`/v1/chat/bob/alice` return the same conversation.

## Poller loop

Pseudo-code for the main indexer loop:

```typescript
while (running) {
    try {
        const { head_block_number, last_irreversible_block_num } =
            await blurt.getDynamicGlobalProperties();
        const from = await db.getLastAppliedBlock();
        const to = last_irreversible_block_num;
        if (to <= from) {
            await sleep(BLOCK_INTERVAL_MS);
            continue;
        }
        // Catch up in small batches so we can shutdown gracefully.
        for (let n = from + 1; n <= to; n++) {
            const block = await blurt.getBlock(n);
            await applyBlock(n, block);
            await db.setLastAppliedBlock(n);
        }
    } catch (err) {
        log(`poll error: ${err.message}`);
        await sleep(ERROR_BACKOFF_MS);
    }
}
```

`applyBlock` iterates transactions, filters for `custom_json` ops
with `id` matching one of `OP_IDS`, validates signer + shape, and
dispatches to the matching handler inside a single Postgres
transaction (all handlers for one block commit atomically; if any
throws, the block retries on next iteration).

## Frontend wire-up

Phase 3b also replaces the frontend's placeholder orderbook reads
with real queries. Changes to `apps/web/`:

- New module `$lib/indexer/client.ts`: typed wrappers for each API
  endpoint. Uses `@morphit/indexer-client` type-only imports for
  request + response shapes.
- New env constant `PUBLIC_MORPHIT_INDEXER_ORIGIN` defaulted to
  `https://indexer.morphit.io`
- Orderbook page (`/orderbook`) reads from `/v1/orderbook` with
  active filters
- Profile page reads from `/v1/profiles/:account`
- Feedback on profile reads from `/v1/accounts/:account/feedback`
- Release-discovery startup check reads from `/v1/release` and
  verifies the pinned key

## Security review for 3b

ADR-0006 covers the general security posture. Specific to the
indexer:

- **SQL injection**: every query uses parameterized prepared
  statements via `pg` Node driver. No string concatenation into SQL.
  `ILIKE` queries validate input is plain text (letters, digits,
  limited punctuation) before binding.
- **Disk exhaustion**: the event log grows without bound. At 500
  morphit ops/day and ~1 KiB each, that's 180 MB/year — easily
  accommodated. Log rotation isn't needed within the lifetime we
  plan for 3b. Phase 5 can add partition-by-year if data volume
  warrants it.
- **Malicious op payloads**: handlers validate every field. JSONB
  storage means Postgres parses at insert time — no eval, no code
  execution, no template rendering.
- **Rate limits on API**: per-IP token bucket at 120/min for list
  endpoints, 600/min for single-resource lookups. Implemented in
  memory — if the operator runs multiple indexer instances behind
  a load balancer, they should front it with a shared rate limiter.
- **Read-only API**: no POST, no state mutation from external
  traffic. The indexer's write path is exclusively the chain
  poller.

## Phase 3b test plan

Indexer unit tests:

- Signature verification of a known-good custom_json against a test
  account's public key
- Handler branching: each `morphit_*` op type has a test that feeds
  a well-formed payload and asserts the resulting state in the
  materialized table
- Rejection cases: malformed JSON, mismatched signer, duplicate
  permlink, orphan `feedback_response` (target feedback doesn't
  exist), unknown op_id

Indexer integration tests:

- Spin up a Postgres test database via Docker in CI
- Replay a fixture block stream (captured from a staging Blurt
  testnet or synthesised), confirm materialized tables reach the
  expected state
- Restart mid-replay, confirm resume from last-applied-block works

Frontend integration:

- `/orderbook` page shows real orders when pointed at a live
  indexer
- Filter combinations (asset, side, region) narrow results as
  expected
- Empty-state rendering when no results match

## Rollout

1. Spin up a Postgres instance on the VPS. Apply `schema.sql`.
2. Deploy indexer, point `PUBLIC_MORPHIT_INDEXER_ORIGIN` env at
   staging subdomain, leave it syncing from launch-block for a
   day to validate stable operation.
3. Operator manually inspects `/v1/health`, confirms lag is small
   and stable.
4. Promote indexer to `indexer.morphit.io`, update frontend's
   build-time env, cut over.
5. Close P2-12 test-coverage item (end-to-end chain round-trip
   now possible via indexer).

## Open questions

- **Op backfill during outages**: if the indexer is down for an
  hour, it catches up automatically on restart. If it's down for
  a week, the catch-up takes ~1 second per irreversible block
  (public RPC rate limits). Operator manual intervention needed
  only if downtime exceeds days.
- **Public RPC consumption**: the indexer makes one `get_block`
  call per block (every 3s) plus `get_dynamic_global_properties`.
  Well within polite consumption of public nodes. No rate-limit
  pushback expected at current Morphit volumes.
- **Chain ID pinning**: the indexer records the chain ID it
  started from. Startup check: refuse to boot if the chain ID at
  the configured RPC endpoints differs from the recorded one. This
  defends against someone pointing us at a testnet by accident and
  corrupting the production database.
