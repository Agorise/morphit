# Audit — follow-up items 1, 3, 4, 5, 6

**Date:** 2026-04-28
**Scope:** Items shipped in the post-Batch-I follow-up campaign. Item 2
(release-trust-anchor frontend wiring) was investigated but deferred to
Batch J; not in this audit's surface. Item 7 IS this document.

| Item | Description | Surfaces audited |
|---|---|---|
| 1 | ELI5 comments on `useActiveKey` / `useOwnerKey` / `runWithActiveKey` | Comment-only; no behavior change |
| 3 | Operator-blocked-user notification ("honest-and-narrow") | Chain op handler, DB schema, two API endpoints, ops-cli command, frontend banner, orderbook filter |
| 4 | Order expiry re-list flow | `relistOrder()` helper, post-page prefill consumer expansion |
| 5 | Profile balance/MANA private div | `balanceMath` helpers, `MyBalanceCard` component, RPC fetch path |
| 6 | P&L CSV export | Categorizer, CSV builder (RFC 4180 + injection mitigation), 365-day history fetch |

---

## Methodology

Per the user's standing instruction ("think like an experienced black hat
hacker"), each surface was reviewed for:

- **STRIDE per surface**: spoofing, tampering, repudiation, information
  disclosure, denial of service, elevation of privilege.
- **Hostile input sweep on each handler / parser / consumer.**
- **Chain-direct re-pass**: assume the chain RPC and indexer DB rows are
  attacker-controlled; verify the frontend can't be coerced into unsafe
  behavior.
- **Cross-tab / multi-tab race conditions** (continuation of Batch I's
  M6 line of inquiry).
- **Side-channel review** for any surface that touches sensitive material
  (MANA / balance card displays public chain data only — no side
  channels relevant; reason/memo display reviewed for bidi-spoofing).

Severity codes:

- **HIGH** — exploitable in a realistic attack scenario; user harm
  plausible.
- **MEDIUM** — exploitable in a contrived scenario, or non-exploitable
  but enables further attack chaining.
- **LOW** — defense-in-depth gap; no realistic exploit alone.
- **INFO** — informational; not a vulnerability.
- **NOTED** — reviewed and confirmed safe / acceptable.

---

## Findings — applied this audit

### #1 (LOW, item 5) — `errorMsg` rendered without length cap

**Surface:** `MyBalanceCard.svelte`'s catch handler stores the RPC error
message verbatim and renders it in the UI.

**Issue:** A malicious or buggy RPC node returning a multi-kilobyte
error message could break the card's layout and the surrounding
profile page. Not exploitable for code execution (Svelte's text
interpolation is HTML-safe), but a denial-of-render concern.

**Fix:** Cap raw message at 200 chars before display, append `…` when
truncated. Applied to both `refresh()` (balance fetch) and `exportPnl()`
(P&L export) catch blocks.

**Severity post-fix:** N/A — closed.

---

### #7 (MEDIUM, item 6) — `op.op` destructure not type-checked

**Surface:** `apps/web/src/lib/pnl/categorize.ts`'s `categorizeOp()`
destructures `op.op` as `[opName, body]`.

**Issue:** The `HistoryOp` type declares `op` as `readonly [string,
Record<string, unknown>]` — but the data comes from a possibly-hostile
RPC. A malformed `op.op` (null, non-array, length 0) would crash the
destructure. Caller wraps in try/catch, so the user sees a generic
error rather than a stack trace, but the export silently aborts on
even one malformed entry — losing legitimate rows that came AFTER the
bad one in the page.

**Fix:** Early guards at top of `categorizeOp`:

```ts
if (!Array.isArray(op.op) || op.op.length < 2) return null;
const [opName, body] = op.op;
if (typeof opName !== 'string') return null;
if (typeof body !== 'object' || body === null) return null;
```

**Smoke:** Added 3 scenarios to `pnl-smoke.ts` covering null `op.op`,
empty-array `op.op`, and non-object `body`. All pass.

**Severity post-fix:** N/A — closed.

---

### #8 (LOW, item 4) — `terms` length not capped before sessionStorage write

**Surface:** `apps/web/src/routes/my/orders/+page.svelte`'s
`relistOrder()` writes the order's terms field directly into
sessionStorage.

**Issue:** A malicious indexer could return an oversized `terms`
string (multi-megabyte). Stuffing into sessionStorage hits the
origin's quota (5–10 MB browser-dependent), potentially breaking
other session-state writes (draft restore, prefills, etc.). The
post-page form already caps on submit, but the prefill path bypasses
that.

**Fix:** Cap `terms` at 5000 chars when building the prefill payload
(`(o.terms ?? '').slice(0, 5000)`). The post-page form already enforces
this same cap on submit; no UX regression.

**Severity post-fix:** N/A — closed.

---

### #10 (HIGH, item 3) — operator reason not validated for control / bidi codepoints

**Surface:** Indexer handler for `morphit_operator_block_v1` accepts any
string ≤500 chars as the operator's `reason`. Stored verbatim. Banner
displays verbatim (with HTML-escape via Svelte interpolation).

**Issue:** A malicious operator (or a compromised operator key) could
embed:

- **Bidi override codepoints (U+202A–U+202E, U+2066–U+2069)**:
  flips display order. Operator writes "spam attack" but it renders
  as "kcatta maps" — could be used to make a benign-looking reason
  appear hostile, or vice versa. More importantly in the banner
  context, could escape the reason-block and visually re-order the
  surrounding "What this does NOT do" list, undermining the
  honest-and-narrow design intent.
- **Zero-width chars (U+200B–U+200D, U+FEFF)**: invisible content
  used to fingerprint copies of a reason or to make two
  visually-identical reasons differ byte-wise (could be used to
  evade automated content moderation if/when we add it).
- **Null bytes (U+0000) and other C0/C1 control chars**: most
  display as nothing, but some downstream tooling (CSV log streams,
  audit exports) might truncate or interpret unexpectedly.

**Severity rationale:** HIGH because the attacker is the operator
themselves — exactly the role the user is told to trust in the
banner. A trust-undermining attack on a trust-establishing UI is
material, even if no funds move.

**Fix (defense-in-depth):**

1. **Indexer handler** strips dangerous codepoints before storage.
   `FORBIDDEN_REASON_CODEPOINTS` set mirrors the existing display-name
   stripper (apps/web/src/lib/crypto/profile.ts). Strips: bidi (9
   codepoints), zero-width (4), invisible math (5), C0 control chars
   except LF/TAB, all C1 control chars. Newline and tab preserved
   because legitimate multi-line reasons exist.
2. **Banner component** mirrors the same set and re-strips on render.
   Belt-and-braces: catches data already in the DB from before this
   fix, AND a sibling-instance indexer that hasn't applied the fix
   yet.
3. **ops-cli command** strips the reason BEFORE broadcast, surfacing
   a warning to the operator if anything was stripped (paste-from-
   malicious-doc accident detection).

**Smokes:**
- "sanitizes bidi-override codepoints from reason" — U+202E in
  reason → `'spam\u202Eattack'` becomes `'spamattack'` in DB row.
- "sanitizes zero-width-joiner / null bytes from reason" — U+200B
  and \x00\x01 stripped.
- "preserves newline + tab in reason (legitimate multi-line)" —
  control chars whitelist verified.

**Severity post-fix:** N/A — closed at server side. The banner-side
strip is layer 2 defense, also in place.

---

### #13 (LOW, item 3) — `/by-blocked` query missing ORDER BY

**Surface:** `GET /v1/operator-blocks/by-blocked/:account` SQL with
`LIMIT 1` and no `ORDER BY`.

**Issue:** Schema-level uniqueness (PK + handler operator gate) makes
multiple matching rows impossible in normal operation. A corrupted DB
or operational mistake could result in multiple rows; the LIMIT 1
returns Postgres' arbitrary choice. Cosmetic / determinism issue; no
exploit.

**Fix:** Added `ORDER BY updated_at DESC` so behavior is deterministic
under any database state. Most-recent-action wins, matching the audit
trail intent.

**Severity post-fix:** N/A — closed.

---

### #15 (HIGH, item 3) — banner reason rendering — duplicated by #10

The banner-side mitigation discussed above. Marked closed by the
indexer-side fix (#10) plus the banner-side belt-and-braces strip. No
separate fix needed.

---

## Findings — accepted as-is (not patched)

### #2 (INFO, item 5) — `parseAssetAmount` no value-bound

A malicious RPC returning `"5000000000000 BLURT"` would display 5
trillion BLURT. Visually misleading, not exploitable. The chain
itself enforces sane balance limits at consensus. Real-world
mitigation is the user noticing "that's way too much, the chain
doesn't have that much BLURT in circulation." Accepted; no fix
applied.

### #3 (NOTED, item 5) — onDestroy + in-flight refresh

Reviewed. Svelte 5 runes-based components: $state writes after
destruction are no-ops; the `setInterval` is cleared in `onDestroy`.
No leak, no race that affects security. Confirmed safe.

### #4 (MEDIUM, item 5) — top-up sessionStorage prefill writable by any same-origin script

A successful XSS could write to `morphit.post.prefill` and force the
user toward composing an order with attacker-chosen amounts. The user
still has to confirm the order, sign it (password / YubiKey prompt),
and pay the listing fee — all of which surface the trade details for
review. The prefill consumer validates types defensively (rejects
non-string fields, clamps `expiresDays`).

The "real" fix would be HMAC-signing the prefill payload with a
session key. Cost-benefit: an attacker with XSS already has
substantial leverage; this surface adds marginal additional risk.
**Accepted as defense-in-depth gap; not patched.** Documented in the
component for future work if XSS-amplification ever becomes a
concern.

### #5 (NOTED, item 6) — bogus `op.timestamp` and pagination termination

Reviewed. The 5-page (50_000 ops) cap bounds worst-case behavior
even when timestamp parsing always returns NaN. The catch in
`exportPnl` surfaces any thrown error as the generic "couldn't build
report" message. Confirmed safe.

### #6 (INFO, item 6) — featured-bid memo regex matches user-mislabeled tips

Categorization issue. A user who sends a tip to `@morphit` labeled
`featured-bid: foo` would have it categorized as "Featured bid (paid)"
in their P&L. This is a self-mislabel by the user, not an external
attack vector. Operators of a less-strict instance might also have
their non-bid memos catch on this prefix; documented behavior.
Accepted as-is.

### #11 (NOTED, item 3) — reason length in UTF-16 code units

Reviewed. The 500-char cap is in `string.length` units (UTF-16 code
units), so 500 ASCII fit, ~250 emoji fit, fewer surrogate pairs fit.
The smoke explicitly tests this boundary. Consistent with the
project's other char-count caps. Accepted as the design's intent.

### #12 (NOTED, item 3) — no handler-level rate limit on operator-block ops

Chain-level RC (resource credits) rate-limits the operator's posting
key globally. If the key were compromised, the attacker spamming
block ops would burn through RC and stop. An indexer-level rate
limit would be redundant. Confirmed safe.

### #14 (NOTED, item 3) — `/by-operator` 5MB worst-case body

10_000 rows × 500-char reason ≈ 5 MB. Acceptable response size for
an admin-style endpoint. Morphit explicitly does not use Cloudflare,
so no CDN-cache-poisoning concern. Confirmed safe.

### #16 (INFO, item 3) — banner contact-operator link doesn't probe chat-identity availability

UX issue, not security. If the operator hasn't published a chat
identity, the link goes to a chat page that shows an error. Future
enhancement: probe chat-identity availability and fall back to a
"contact operator at <url>" affordance from the operator-register
record if chat isn't available. Filed in REVISIT-LIST.md §F.27 for
Phase G+.

---

## Cross-surface findings (not in initial pass)

### CS-1 (NOTED) — operator-block + user-block + hidden-accounts overlap

Three independent sets filter the orderbook view:

- `hiddenAccounts` (per-user, per-browser, localStorage) — "I don't
  want to see X here."
- `blockedAccounts` (per-user, chain-broadcast) — "X has blocked me
  from messaging them; symmetrically I hide them too."
- `operatorBlockedAccounts` (per-instance, chain-broadcast by
  operator) — "this instance hides X."

Reviewed for interaction:
- All three are unioned in `visibleItems` derived value. ✓
- The transparency toggle (`showHiddenTemporarily`) reveals all
  three uniformly. ✓
- Per-row rendering doesn't expose which set caused the hide
  (good — protects the operator from "you're being filtered by
  the operator specifically" inference attacks based on which
  badge appears). ✓

Confirmed safe.

### CS-2 (NOTED) — sessionStorage prefill key shared between item 5 (top-up) and item 4 (re-list)

Both items write to `morphit.post.prefill`. Last-writer-wins. Both
clear after read on the post page. If a user clicks "Top up BLURT"
on their profile, then immediately navigates to /my/orders and
clicks "Re-list" without going through the post page, the re-list
overwrites the top-up prefill — the user sees their re-listed order's
fields, not BLURT-buy. **Acceptable behavior** — the user's most-
recent intent wins.

If the user clicks both in opposite order, same result. The "stale
prefill from previous tab" case is handled by the one-shot
read-and-clear. Confirmed safe.

---

## Smoke regression posture

- 860 total scenarios passing (was 854 pre-audit + 6 new for #7 and #10).
- Typecheck clean, no new errors beyond the pre-existing baseline.
- i18n drift = 0 across 1689 keys × 10 locales.

---

## Outstanding (not in this audit's scope)

- **Batch I H2** — WebHID transport unverified against real
  hardware. Probe page is built and waiting for the user to run it
  with a YubiKey. Independent of this follow-up batch.
- **Item 2** — release-trust-anchor frontend wiring deferred to
  Batch J. Schema and pinned pubkey exist; signature-verify code
  does not.
- **External pre-launch audit** by a security firm experienced in
  browser-based crypto. Recommended before production launch.
- **Phase G mobile PWA polish** — gated on this campaign closing.
  Ready to start.

---

## Sign-off

This audit closes 5 findings (1 LOW, 1 MEDIUM, 2 HIGH, 1 LOW). 11
findings reviewed and accepted as-is (4 NOTED-safe, 4 INFO,
1 MEDIUM-defense-in-depth-doc, 2 NOTED). No findings remain open
on items 1, 3, 4, 5, 6 surfaces.

Items 1, 3, 4, 5, 6 considered shippable.
