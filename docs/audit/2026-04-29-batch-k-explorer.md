# Audit — Batch K: block explorer + APR + cross-chain links + activity

**Date:** 2026-04-29
**Scope:** Code introduced for ADR-0020. Builds on the methodology
used in the Batch I audit, the post-Batch-I follow-up audit, and
the Batch J audit.

| Surface | Files |
|---|---|
| APR helper | `apps/web/src/lib/blurt/apr.ts` |
| External-explorer URLs | `apps/web/src/lib/explorer/urls.ts` |
| Search-input parser | `apps/web/src/lib/explorer/search.ts` |
| Op-decoration helper | `apps/web/src/lib/explorer/decorate.ts` |
| Listings histogram | `apps/web/src/lib/explorer/listingsHistogram.ts` |
| BlurtClient extensions | `apps/web/src/lib/blurt/client.ts` (getBlock, getTransaction) |
| Activity API | `apps/indexer/src/api/activity.ts` |
| Indexer client wrapper | `apps/web/src/lib/indexer/client.ts` (getActivityVolume) |
| Param matchers | `apps/web/src/params/{blocknum,trxid}.ts` |
| Explorer pages | `apps/web/src/routes/explorer/{,/account/[name],/block/[num],/tx/[id],/activity}/+page.svelte` |
| Wired surfaces | Footer (+layout.svelte), `/my/orders`, `ChatMessage.svelte` funds_sent pill |
| MyBalanceCard | APR display |

## Methodology

Same as prior audits:

- STRIDE per surface.
- Hostile-input sweep on every parser / consumer.
- Chain-direct re-pass: assume RPC nodes are attacker-controlled.
- Cross-tab race-condition review.
- "Experienced black hat hacker" lens.

Severity: HIGH / MEDIUM / LOW / INFO / NOTED.

---

## Findings — applied during this audit

### K-1 (LOW, account/block/tx pages) — non-string timestamp would throw or render garbage

**Surface:** `/explorer/account/[name]/+page.svelte` formats each
op's timestamp with `op.timestamp.endsWith('Z') ? op.timestamp :
\`${op.timestamp}Z\``. `/explorer/block/[num]/+page.svelte` and
`/explorer/tx/[id]/+page.svelte` render `{block.timestamp}Z` and
`{tx.expiration}Z` as plain interpolations.

**Issue:** The chain RPC might return a non-string timestamp
(e.g. `null`, a numeric epoch from a non-conformant proxy). On
the account page, `.endsWith()` would throw and break the entire
ops list rendering. On the block/tx pages, the interpolation
would render `nullZ` or `[object Object]Z` — visually broken
but not exploitable.

**Fix:**

- Account page: when materializing each `OpRow`, coerce
  `hop.timestamp` to a string at the source: `typeof
  hop.timestamp === 'string' ? hop.timestamp : ''`. Empty
  string passes the `.endsWith()` check harmlessly.
- Block + tx pages: render with type-guard:
  `{typeof block.timestamp === 'string' ? \`${block.timestamp}Z\`
  : '—'}` and same for `tx.expiration`.

**Severity post-fix:** N/A — closed.

---

## Findings — accepted as-is

### K-2 (NOTED, /explorer/tx) — XSS via raw-JSON display

Reviewed. `<pre>{JSON.stringify(op[1], null, 2)}</pre>` uses
Svelte's default text interpolation, which HTML-escapes. Even if
`op[1]` contained `{"x": "<script>"}`, the rendered output
literal-escapes the angle brackets. Confirmed safe.

### K-3 (NOTED, /explorer/account) — RPC trust

The account page reads `acct.balance`, `acct.vesting_shares`,
etc. from the RPC response. A malicious RPC could substitute
another account's data. The page enforces the same audit-fix S-1
guard as `MyBalanceCard`: `if (acct.name !== account) throw
new Error(...)`. If a hostile RPC plays back a different
account's name, we refuse to render. Confirmed safe.

### K-4 (NOTED, polling) — cleanup correct

Both `/explorer/account/[name]` and `/explorer/activity` clear
their `setInterval` handles in `onDestroy`, set the local timer
ref to `null` after clear. Visibility-aware guard
(`document.hidden`) skips the poll body when the tab is in the
background. Confirmed clean.

### K-5 (NOTED, search dispatch) — no injection path

`parseSearchInput()` returns a discriminated union with strict
classification. URL builders return `null` on malformed input.
The submit handler explicitly null-checks before `goto()`.
Hostile pasted text → `'unknown'` → friendly error message.
Confirmed safe.

### K-6 (NOTED, activity SQL) — parameter binding

The volume query uses `WHERE f.created_at > NOW() - $1::interval`
with the window value passed as a positional parameter. Postgres
parameter binding handles all escaping; no string interpolation
of user input into SQL. Confirmed safe.

### K-7 (NOTED, getTransaction) — graceful null on tx-index-less nodes

Some Blurt RPC nodes lack the `account_history` plugin's
`get_transaction` method (it requires a non-default tx-index
plugin). The frontend's `BlurtClient.getTransaction` wraps the
call in `try/catch` and returns `null` on RPC error rather than
propagating. `/explorer/tx/[id]` surfaces this as the
`not_found` UI state with a fallback link to
`blocks.blurtwallet.com`. Confirmed correct fallback.

### K-8 (INFO, APR computation) — overflow safety

`computeBlurtVestingApr` does multiply-then-divide on
chain-supplied numbers. Worst-case realistic inputs stay within
float64's safe range. A hostile RPC returning bizarre numbers
wouldn't cause a security issue, just a display oddity (a NaN
formatted as "—" by `formatApr`). Confirmed bounded.

### K-9 (NOTED, decorateOp hostile op body) — defensive against null

`decorateOp(opName, opBody)` casts `opBody` to
`Record<string, unknown> | null` and explicitly checks `body &&
typeof body === 'object'` before reading `body.id`. Smoke
covers the null-body case. Confirmed defensive.

### K-10 (NOTED, external-explorer URL injection) — strict regex

`externalExplorerUrl` validates txids with `/^[0-9a-fA-F]{64}$/`
for both BTC and XMR; account names with the standard Blurt
regex; block numbers as positive-integer only. Anything failing
validation returns `null` and the caller hides the link.
Confirmed no injection vector.

### K-11 (NOTED, block render) — defensive iteration

`{#each tx.operations ?? [] as op}` uses the `?? []` fallback so
a missing operations field doesn't crash. Inside, `op[0]` and
`op[1]` are passed to `decorateOp` which handles all malformed
shapes by returning `native_unknown`. Confirmed defensive.

### K-12 (NOTED, multi-tab) — independent state

If the user opens two tabs of the same explorer account page,
each maintains its own `ops` array, `oldestSeqLoaded` cursor,
and `pollTimer`. No shared global state to race on. Confirmed
independent.

### K-13 (NOTED, long-running tab memory) — bounded by user behavior

A tab left open with the account page polling and the user
clicking "Load more" repeatedly will grow the `ops` array
unboundedly. In practice, the user closes the tab; growth is
bounded by their patience. The fix would be a circular buffer
capped at, say, 1000 ops with a "view earlier on fallback"
affordance — overkill for the v1. Documented as acceptable for
early launch.

### K-14 (NOTED, listings histogram limit) — undercounts beyond 100

The activity page fetches `getOrderbook({ limit: 100 })`. If
there are more than 100 active listings of one (asset, side),
the histogram undercounts. Documented in the activity page
component comment. Acceptable for early launch — orderbooks of
that size aren't the current scale.

---

## Cross-surface findings

### CS-K-1 (NOTED) — Lazy-loading respects no-login posture

The `/explorer` route is its own SvelteKit chunk; users who don't
visit `/explorer` never download its code. Confirmed by route
structure (separate `+page.svelte` per node). The chunk also has
no sign-in dependencies — it doesn't touch `keystore` or
`isUnlocked` stores. Public, anonymous, lazy. ✓

### CS-K-2 (NOTED) — Polling cadences vary by surface, by design

| Surface | Cadence | Why |
|---|---|---|
| /explorer/account/[name] | 5s | Op stream feels real-time |
| /explorer/activity | 30s | Coarse stats; faster doesn't help |
| /explorer/block/[num] | none | Blocks are immutable |
| /explorer/tx/[id] | none | Txs are immutable |

Each is visibility-aware. No coordinated multi-surface poller is
needed — Morphit's pattern is one timer per page. Confirmed
appropriate.

### CS-K-3 (NOTED) — APR computation respects "no third-party endpoints"

The APR helper computes from chain DGP (already fetched by
`MyBalanceCard.refresh()` for BP/MANA). No new chain calls, no
external services. Inflation curve constants baked in (Blurt
chain config). Confirmed self-contained.

---

## Smoke regression posture

- 980 total scenarios passing (was 907 pre-Batch-K; +13 APR + 21
  explorer URLs + 20 explorer search + 19 explorer activity).
- Typecheck clean, no new errors beyond the pre-existing baseline.
- i18n drift = 0 across 1810 keys × 10 locales.

---

## Outstanding (not in this audit's scope)

- **Batch I H2** — WebHID transport hardware probe (independent).
- **External pre-launch audit** by a security firm.
- **Phase G mobile PWA polish** — gated on this campaign closing.
- **Future: tx-by-id fetching from any RPC node** — currently
  requires a node with the tx-index plugin. Could improve by
  walking blocks ourselves; deferred.
- **Future: depth-style price-vs-market histogram** — requires a
  market-price feed (currently unavailable in Morphit's
  ecosystem); deferred.

---

## Sign-off

This audit closes 1 finding (1 LOW). 13 findings reviewed and
accepted as-is (10 NOTED-safe, 1 INFO, 2 NOTED-bounded-by-design).
No findings remain open on Batch K surfaces.

Batch K considered shippable.
