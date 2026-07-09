# Batch-profile endpoint — design

**Status:** ✅ SHIPPED.  Both sessions complete:
session 1 (indexer-side `GET /v1/profiles?accounts=...`)
landed at `apps/indexer/src/api/profiles.ts`; session 2
(frontend integration via `getProfilesBatch()`) at
`apps/web/src/lib/indexer/profileCache.ts:186`.  Wired into
orderbook, feedback list, profile cross-reference panes.
This file is preserved as the design rationale; the
endpoint is documented under "Public endpoints" in
`docs/API.md`.

**Scope:** add a batch `GET /v1/profiles?accounts=...` endpoint so
pages that render many usernames at once (orderbook rows, feedback
lists, profile cross-reference panes) can fetch their matching
profiles in one round-trip instead of N single `/v1/profiles/:account`
calls.

## Motivation

Users can set custom avatars (SVG or raster, uploaded via settings).
The avatar is stored in `profiles.json_metadata`. Today, only the
profile page (`/@{account}`) reads this — so avatars are invisible
on orderbook rows, feedback lists, and comment bylines, which all
fall back to the heart identicon.

A naive fix (one `/v1/profiles/:account` call per visible account)
is an N+1 query pattern. An orderbook page with 50 rows would make
51 HTTP requests. Unacceptable.

## Design decisions

### Endpoint shape: `GET /v1/profiles?accounts=alice,bob,carol`

- **Method:** GET, not POST. GET is cacheable at both browser and
  CDN layers. Profile data changes rarely (most users update once
  per year or never); cache-friendliness is the whole point.
- **Query string, comma-separated:** fits the largest realistic
  request (100 accounts × ~16 chars = 1600 chars) well under the
  4 KB practical URL limit. Comma is not valid in Blurt account
  names so unambiguous as a separator.
- **Max batch size: 100.** Caps the worst-case query cost and
  prevents a hostile caller from constructing a request that
  would materialize thousands of rows. An orderbook page is
  ~50 accounts; feedback list is ~20. 100 is comfortably above
  both with margin.

### Response shape: object keyed by account

```json
{
  "profiles": {
    "alice": { "account": "alice", "display_name": "...", ... },
    "bob": { "account": "bob", "display_name": "...", ... }
  }
}
```

Rationale: callers can do `response.profiles[account]` directly
without a find-by-key scan on a list. Matches the pattern the
frontend already uses for caches (`Map<account, Profile>`).

### Unknown / missing accounts

**Silently dropped from the response.** If the caller requests
`?accounts=alice,bob,nonexistent`, the response contains `alice`
and `bob` under `profiles`, and `nonexistent` is simply absent.

Rationale:
- Batches should degrade gracefully. A 404 for the whole batch
  because one account is unknown is hostile.
- The frontend already has to handle "no profile for this account"
  (legitimate case: user has a Blurt account but never set a
  display name). Same code path handles "account doesn't exist."
- An explicit "missing" list in the response would be symmetrical
  but adds noise for the 99% case where everything is found.

### Caching

- **`Cache-Control: public, max-age=90, stale-while-revalidate=60`** —
  but ONLY when the batch is COMPLETE (every requested account
  resolved to a profile row).
- **`Cache-Control: no-store` when the batch is PARTIAL** (at least one
  requested account is absent from the response). #2 — an absent
  account is only *provisionally* authoritative: the usual cause is
  indexer lag, in the 1–2 block window after the account broadcast
  its profile op or signed up. Caching that negative result pinned it
  in the **browser's HTTP cache**, which replays it on every load of
  the same URL — so the fresh profile stayed invisible for up to 150s
  and, crucially, **survived a page refresh** (a reload clears the
  client's in-memory cache but not the browser's disk cache). The
  symptom was a display name falling back to `@account` and an avatar
  falling back to the identicon, with refreshing changing nothing.
  Positive results are still cached for the full 90s; only negatives
  are excluded. Mirrors the client's soft-null policy (cp428) and the
  dynamic-data service-worker exclusion (cp324).
- 90 seconds = 90 blocks on Blurt (3s block time). A user who
  updates their avatar waits ~90 seconds for it to propagate via
  the cache to other visitors' orderbook views. That's acceptable
  because the orderbook-row avatar is a nice-to-have, not a
  correctness surface. (The updating user themselves sees it
  immediately: the client re-fetches their own profile with
  `cache: 'reload'` after a confirmed broadcast, bypassing both the
  in-memory and browser HTTP caches.)
- `stale-while-revalidate=60` lets the CDN serve slightly stale
  responses while refetching, keeping p99 latency low.
- Browser cache also honors this; repeated orderbook navigations
  within 90s don't re-request.

### Rate limiting

Uses the existing `ratelimit` middleware (Finding B). Each batch
request costs 1 token regardless of batch size — the max-size cap
(100) already bounds the worst-case abuse. No separate bucket
needed.

### Authentication

None. Profiles are fully public on-chain data. No reason to gate
the endpoint; doing so would break CDN caching.

## Rejected designs

### B. Push avatars inline with `/v1/orderbook`

Rejected in §G during the decision-landing discussion. Reasons
preserved here for durability:

1. Tight-couples orderbook and profile caches. Orderbook changes
   every block (3s); profiles change once a year. Forcing them
   into one response means either the orderbook gets cached too
   aggressively (stale prices) or the profiles too briefly
   (constant refetch of static data).
2. Bloats every orderbook response. 50 rows × 3 KB per raster
   avatar = 150 KB extra per response. CDN bandwidth cost +
   worse p50 latency for every caller, including ones that
   don't care about avatars.
3. Orderbook responses become unique per (user-set)-avatar-state,
   killing the CDN hit rate.

### C. Don't batch — N+1 calls

Rejected because it scales linearly with orderbook size. A user
scrolling an active orderbook with 200 rows would trigger 200 HTTP
requests. Unacceptable.

## Implementation plan

### Session 1 (this session — indexer)

1. Extend `apps/indexer/src/api/profiles.ts` — new handler for
   `GET /` (batch) alongside the existing `GET /:account`.
2. Extend `packages/indexer-client/src/index.ts` with
   `BatchProfilesResponse` type.
3. Add integration tests covering: happy path, empty batch,
   single-item batch, over-limit rejection, mix of known +
   unknown accounts, malformed account name rejection.

### Session 2 (next session — frontend)

1. `getProfilesBatch(accounts[]): Promise<Map<string, Profile>>` in
   `apps/web/src/lib/indexer/client.ts`.
2. Wire into orderbook page: fetch orderbook first, then batch the
   distinct accounts, swap identicons for custom avatars.
3. Same wiring in feedback list, profile cross-reference pane.
4. Client-side in-memory cache with 90s TTL to match server
   `Cache-Control`.

## Open questions parked for session 2

- Do we want client-side deduplication across the 3 consumer
  surfaces? An orderbook view that then navigates to a profile
  would ideally reuse the batch-fetch result. Design in session 2.
- Is it worth a local storage cache to survive page reloads?
  Probably not — 90s TTL plus the in-memory cache handles the
  common "refresh after a minute of inactivity" case.
