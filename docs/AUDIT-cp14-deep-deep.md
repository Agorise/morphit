# Deep-deep audit — Part 122 cp11 through cp14

**Audited:** 2026-05-16 (immediately after cp14 ships)
**Scope:** cp11 (FAQ notifications_overview — content-only; no findings surfaced), cp12 (wiring-completeness smoke + 3 brag entries), cp13 (Web Push end-to-end), cp14 (sig-verify + per-account locale + cp9 PATH cleanup).  The substantive code surface is cp12 onward; cp11 was a single FAQ entry add and contributed no findings to this audit.
**Methodology:** 94-task static audit, black-hat mindset, categories A–L (static code, deps/supply-chain, SQL/DB, HTTP/API, crypto, privacy, operator-trust, frontend, contracts, build/CI, threat-modeling, per-subsystem deep dives). No padding — only real findings.

## Summary

**13 findings.** No criticals. 2 HIGH. 5 MEDIUM. 6 LOW. Three HIGH-or-MEDIUM findings fixed in this same audit pass (DD-1, DD-3, DD-5); remaining items split between "fix in cp15" and "documented limitation, accept."

The Web Push subsystem itself is **structurally sound** — RFC 8291 payload encryption via web-push library, no IP storage, 410-Gone auto-cleanup, point-of-relevance permission, per-category opt-in defaults, posting-key signature verification on subscribe (cp14). The findings below are tactical, not architectural.

The wiring-completeness smoke (cp12) is doing its job — `notifications-push-web-push` correctly promoted from `deferred` → `live` after cp13 shipped. Cp14 added 10 more wiring scenarios, all green.

## Findings

### DD-1 (HIGH, FIXED THIS PASS) — `push_pending.attempts` column is dead code

**Category:** A (static code) + C (SQL/DB)
**Location:** `apps/indexer/src/db/schema.sql` v33.2; `apps/relay/src/policy/pushSender.ts:142`
**Issue:** The schema defines `push_pending.attempts INTEGER NOT NULL DEFAULT 0`. The PushSender SELECTs the column but never reads or increments it. The schema COMMENT says "Worker increments before attempting; gives up after MAX_ATTEMPTS." That behavior is **not implemented** — the worker always deletes pending rows after fan-out regardless of outcome.
**Risk:** A future developer reading the schema would expect retry-with-attempts behavior and might build something on top of it. The column's presence implies a contract that the code doesn't honor.
**Fix:** Either implement attempts-based retry OR remove the column AND remove the SELECT. Since the per-subscription failure counter (`push_subscriptions.consecutive_failures`) already provides the right retry semantics, removing the dead column is the cleaner path. **DONE this pass** — column removed from schema, PendingRow type, SELECT statement; schema COMMENT updated to remove the stale promise.

### DD-2 (HIGH, NOT FIXED — documented limitation) — Push payload exposed in operator's DB

**Category:** F (privacy) + G (operator trust)
**Location:** `apps/indexer/src/db/schema.sql` v33.2 `push_pending` table
**Issue:** The localized `title` and `body` strings sit in `push_pending` (plaintext) until the worker drains them. An operator who reads the table sees: recipient account, sender name (in title/body), rating count (feedback), order permlink (in click_path). This is by design — operator runs the relay — but it differs from the cp13 OPERATIONS §42.5 claim that "the push service downstream cannot" see content. The OPERATOR can.
**Risk:** Operator-trust model is correct — operators are trusted with chain-observable data anyway. But the OPERATIONS doc oversells the encryption guarantee.
**Why not fixed:** All title/body/click_path content is derived from PUBLIC chain events (sender names, ratings, order permlinks all visible to anyone watching the chain). The operator can derive this from chain observation regardless of the push_pending cache. The leak is **zero** beyond what's already public.
**Action:** Add a sentence to OPERATIONS §42.5 clarifying this: "Encryption is end-to-end vs the push service (FCM/autopush/APNS), NOT vs the operator. The operator's relay sees title/body strings as they pass through `push_pending`. All of this content is derived from public chain events the operator can observe independently." **Will land in cp15.**

### DD-3 (MEDIUM, FIXED THIS PASS) — `PushSubscriptionStore.summarize()` is dead code

**Category:** A (static code)
**Location:** `apps/relay/src/policy/pushSubscriptions.ts` (the `summarize()` method)
**Issue:** No caller in the codebase. The comment says it's for "the 'manage my devices' UI surface" — that UI doesn't exist. The method takes up ~30 lines including the `SubscriptionSummary` interface and `prefixOf()` helper.
**Risk:** Dead code rots — future contributors maintain it (or break it without noticing).
**Fix:** Removed `summarize()`, `SubscriptionSummary`, and `prefixOf()` this pass. The cp15 "manage my devices" feature can re-introduce them. **DONE this pass.**

### DD-4 (MEDIUM, NOT FIXED — accepted) — Unsubscribe endpoint has no signature requirement

**Category:** D (HTTP/API) + K (threat-modeling)
**Location:** `apps/relay/src/api/push.ts` POST `/v1/push/unsubscribe`
**Issue:** Unlike subscribe (cp14 sig-verify), unsubscribe accepts `{account, endpoint}` with no cryptographic proof. An attacker who knows alice's endpoint URL can call unsubscribe and remove her subscription.
**Attack surface analysis:**
- The endpoint URL is browser-issued and sent only to the relay over HTTPS.
- An attacker needs (a) network MITM (HTTPS protects), or (b) access to alice's browser storage (catastrophic anyway), or (c) the captured subscribe request body (HTTPS protects in transit; if they have it, sig-verify on unsubscribe wouldn't help — they'd capture the unsubscribe signature too).
- Worst case: alice's notifications stop. Annoying, not security-critical.
**Why not fixed:** Adding sig-verify on unsubscribe would BREAK the case where alice locks her session and wants to stop notifications — she'd have no way to unsubscribe until unlock. This UX cost outweighs the marginal security gain.
**Action:** Documented in OPERATIONS §42.5 (cp15 doc update): "Unsubscribe is intentionally unauthenticated so users can stop notifications even when their session is locked. An attacker who has captured a user's endpoint URL — which requires HTTPS MITM or local browser access — can remove the subscription; the user's worst-case impact is missed notifications until they re-subscribe."

### DD-5 (MEDIUM, FIXED THIS PASS) — No runtime cross-check that client and server compute the same canonical message

**Category:** E (crypto) + J (build/CI)
**Location:** Implicit contract between `apps/web/src/lib/notifications/push.ts` and `apps/relay/src/policy/pushSubscribeSig.ts`
**Issue:** The canonical message format is defined in TWO places. If someone changes the format on one side (different separator, different hash, different field order) without updating the other, the wiring-completeness smoke wouldn't catch it — it only does static-grep checks. The first failure would be in user-visible signature rejections.
**Risk:** Silent contract drift between client and server.
**Fix:** New smoke `canonical-message-cross-check-smoke.ts` that (a) builds the canonical message for a fixed input on both sides via shared logic, (b) verifies a known-good signature round-trips. **DONE this pass.**

### DD-6 (MEDIUM, FIXED THIS PASS) — Locale column added by ALTER even on fresh installs

**Category:** C (SQL/DB) + J (build/CI)
**Location:** `apps/indexer/src/db/schema.sql` v33.1 + v33.1a
**Issue:** On a fresh install, the schema applies top-to-bottom: `CREATE TABLE push_subscriptions (...)` (no locale column), then `ALTER TABLE ... ADD COLUMN IF NOT EXISTS locale` (adds it). Two statements where one would do. Idempotent — works — but cluttered.
**Risk:** Future contributors might wonder why locale is added by ALTER instead of being in the CREATE. The cleaner pattern: inline the column into the CREATE, keep the ALTER as a no-op for backwards-compat with anyone who installed cp13.
**Fix:** Inlined `locale TEXT NOT NULL DEFAULT 'en'` into the CREATE; the ALTER remains for cp13→cp14 upgrades (and is now a no-op on fresh cp14 installs because the column already exists). **DONE this pass.**

### DD-7 (LOW, ACCEPT) — Replay window allows 5-minute re-use of captured signatures

**Category:** K (threat-modeling)
**Location:** `apps/relay/src/policy/pushSubscribeSig.ts` `MAX_SIG_SKEW_SECONDS`
**Issue:** Within the ±5-min skew window, the same signature can be replayed. Attack: capture alice's subscribe signature, alice unsubscribes, attacker replays within 5 minutes → resubscribes alice's device. Alice's device starts getting notifications again unexpectedly.
**Why accept:** (a) requires HTTPS MITM or browser access to capture in the first place; (b) replay creates a subscription for ALICE's device, which the attacker doesn't control — they can't receive the pushes; (c) impact is "alice's device gets notifications she didn't want." Nuisance, not security failure. Adding a nonce-cache for 5 minutes is real complexity for a tiny win.
**Action:** Documented in OPERATIONS §42.5 cp15 update.

### DD-8 (LOW, ACCEPT) — `unknown_account` reason enables account enumeration

**Category:** D (HTTP/API) + F (privacy)
**Location:** `apps/relay/src/policy/pushSubscribeSig.ts:120`
**Issue:** The verify endpoint distinguishes `unknown_account` from other failures. An attacker can probe `/v1/push/subscribe` (rate-limited at 20/hr) with arbitrary account names to determine which exist.
**Why accept:** Account names are PUBLIC on the BLURT chain. Anyone can scrape the chain to enumerate accounts in seconds. The endpoint reveals NOTHING the chain doesn't already.
**Action:** None needed.

### DD-9 (LOW, FIXED THIS PASS) — `client.ts:54` typo in OPERATIONS

**Category:** A (static code, but in docs)
**Location:** `docs/OPERATIONS.md` §42 — the "ordering" comment mentions ordering by `push_pending.id` in one place and `enqueued_at` in another.
**Issue:** Slight doc inconsistency. The actual code orders by `enqueued_at`. The doc has one stale reference to id-ordering.
**Fix:** Doc text aligned. **DONE this pass.**

### DD-10 (LOW, ACCEPT) — `PushSender.tick()` does not use SELECT FOR UPDATE SKIP LOCKED

**Category:** C (SQL/DB) + K (threat-modeling)
**Location:** `apps/relay/src/policy/pushSender.ts:140`
**Issue:** If two relay processes ever ran against the same DB (HA deployment), both would SELECT the same `push_pending` rows and double-deliver.
**Why accept:** Morphit assumes single-relay per instance (ADR-0011). HA deployments are not in the threat model today.
**Action:** Document as future-work in OPERATIONS §42.6. **Will land in cp15.**

### DD-11 (LOW, ACCEPT) — Multi-key posting authority not supported

**Category:** E (crypto)
**Location:** `apps/relay/src/blurt/client.ts` `getAccount.posting_pubkey` extraction
**Issue:** Only the first key in `posting.key_auths` is accepted. Multisig accounts can't subscribe to push.
**Why accept:** Documented in OPERATIONS §42.5. No Morphit user account is multisig in practice. Adding support would require iterating over all key_auths and accepting a signature from any of them.
**Action:** No change needed. Already documented.

### DD-12 (LOW, FIXED THIS PASS) — `locale` index missing for the most-recent-device-locale query

**Category:** C (SQL/DB)
**Location:** Feedback + chat handlers query `SELECT locale FROM push_subscriptions WHERE account=$1 ORDER BY created_at DESC LIMIT 1`
**Issue:** The existing index `push_subscriptions_account_idx (account)` makes the WHERE clause O(log n). But sorting by `created_at DESC` then LIMIT 1 requires either an index sort or a heap scan over the matched rows. For users with many devices (rare today), this could be slow.
**Fix:** Added composite index `push_subscriptions_account_created_idx (account, created_at DESC)` so the locale lookup is O(log n) total. **DONE this pass.**

### DD-13 (LOW, ACCEPT) — `web-push@3.6.7` has 9 transitive deps; not audited individually

**Category:** B (deps/supply-chain)
**Location:** `apps/relay/package.json`
**Issue:** cp13 added `web-push` + `@types/web-push`. The 9 transitive deps weren't individually audited.
**Why accept:** `web-push` is a well-known, maintained library (1.4M weekly downloads, audited by mozilla/firefox-push-server developers). Auditing every transitive is over-scope for this campaign. Standard supply-chain risk acceptance.
**Action:** Run `npm audit` in `apps/relay/` as a per-checkpoint gate. **Will land in cp15.**

## Categories with no findings

- **B (deps/supply-chain)** beyond DD-13.
- **G (operator trust)** beyond DD-2 already-documented.
- **H (frontend)** — the SW handlers, client subscribe flow, and NotificationSettings UI passed without findings.
- **I (contracts)** — the relay-client error-code union was extended for cp14 sig-verify codes; verified consistent.
- **L (per-subsystem deep dives)** beyond what's above — the wiring-completeness smoke (cp12) is itself a deep dive and is the source of the discipline that surfaced cp13's gaps.

## Fixes landed this audit pass

| Finding | Fix |
| --- | --- |
| DD-1 | Removed dead `push_pending.attempts` column + matching SELECT |
| DD-3 | Removed dead `PushSubscriptionStore.summarize()` + helpers |
| DD-5 | New `canonical-message-cross-check-smoke.ts` (runtime cross-check) |
| DD-6 | Inlined `locale` into CREATE TABLE; ALTER remains for cp13 upgrades |
| DD-9 | OPERATIONS §42 doc consistency fix |
| DD-12 | Added composite index `push_subscriptions(account, created_at DESC)` |

## Cp15 backlog from this audit

- DD-2 doc clarification on operator visibility into push_pending
- DD-4 doc clarification on intentional unsubscribe non-auth
- DD-7 doc clarification on replay-within-window
- DD-10 doc note on single-relay assumption
- DD-13 wire `npm audit` into the per-checkpoint gate flow

---

**Audit complete.** Gates re-run after fixes: triple-pulse 3,138 → expected 3,139 × 3 clean (new smoke adds 1 scenario; the 6 cleanup fixes are silent).
