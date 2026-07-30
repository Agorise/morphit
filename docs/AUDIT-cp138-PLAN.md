# cp138 — Pre-launch deep-deep audit (94-task plan)

Started: 2026-05-25. Triggered by Ken's "do a full deep deep on absolutely
everything" directive after cp137 closed.

Numbers in `[T-NN]` brackets are task IDs. Tasks marked **DONE** below
have been completed and findings logged in `FINDINGS.md`.

## Phase A — Hostile-chain-op review (17 tasks)
Per Ken's "what if every op was hostile" sweep. Re-walk each handler with
fresh eyes, looking for: missing input validation, unchecked actor
authority, replay/race, integer overflow, time-of-check-time-of-use,
schema-deviation bypasses, type confusion via JSON, prototype pollution.

- [T-01] `block.ts` handler — block-tip-tracking hostile review
- [T-02] `chat.ts` handler — `morphit_chat_v1` hostile review
- [T-03] `chatIdentity.ts` handler — `morphit_chat_identity_v1` hostile review
- [T-04] `chatRead.ts` handler — `morphit_chat_read_v1` hostile review
- [T-05] `featureBid.ts` handler — `morphit_featurebid_v1` hostile review
- [T-06] `feedback.ts` handler — `morphit_feedback_v1` hostile review
- [T-07] `feedbackResponse.ts` handler — `morphit_feedback_response_v1` hostile review
- [T-08] `operatorBlock.ts` handler — `morphit_operator_block_v1` hostile review
- [T-09] `operatorPaymentMethod.ts` handler — `morphit_operator_payment_method_v1` hostile review
- [T-10] `operatorRegister.ts` handler — `morphit_operator_register_v1` hostile review
- [T-11] `order.ts` handler — `morphit_order_v1` hostile review
- [T-12] `orderCancel.ts` handler — `morphit_order_cancel_v1` hostile review
- [T-13] `orderReplace.ts` handler — `morphit_order_replace_v1` hostile review
- [T-14] `profile.ts` handler — `morphit_profile_v1` hostile review
- [T-15] `release.ts` handler — `morphit_release_v1` hostile review
- [T-16] `strangerFee.ts` handler — `morphit_stranger_fee_v1` hostile review
- [T-17] Dispatcher — `dispatcher.ts` cross-op invariants (op-name spoofing, idempotency, ordering)

## Phase B — HTTP/API surface hostile review (8 tasks)
Each indexer + relay HTTP endpoint reviewed for: auth, rate limit, body
cap, content-type, CORS, CSRF (if cookie-based), open redirect, SSRF,
SQL injection, path traversal, ReDoS in regex params, leaks via error.

- [T-18] Indexer public `/v1/*` endpoints (orderbook, orders, profile, instance, etc.)
- [T-19] Relay HTTP — public endpoints (altcha, posting, blurt RPC proxy)
- [T-20] Relay HTTP — authenticated endpoints
- [T-21] Server-side rate-limit + body-cap + timeout consistency
- [T-22] Error message leakage — any 500 surfacing stack/secret/path/host?
- [T-23] Internal endpoints' auth (health, metrics)
- [T-24] CORS posture review
- [T-25] Open-redirect surface (any param that ends up in a `Location` header or `<a href>`)

## Phase C — Crypto & secrets review (12 tasks)
- [T-26] Argon2id parameters (memory, iterations, parallelism) vs OWASP recommended floor
- [T-27] PBKDF2 / scrypt usage anywhere — review params
- [T-28] AEAD nonce/IV uniqueness — any reuse risk?
- [T-29] MAC vs encrypt — constant-time compare everywhere?
- [T-30] Secret storage — any secret ever written to log/stderr/error?
- [T-31] Hardcoded secrets / placeholders in repo (beyond known `CHANGE_ME`)
- [T-32] Crypto primitive choices (SHA-1, MD5, etc — should be zero use except for non-security)
- [T-33] Key derivation paths (BIP-32, BIP-39) — validation, normalization
- [T-34] Random number sources — only `crypto.getRandomValues` / `crypto.randomBytes`?
- [T-35] Constant-time comparisons everywhere needed
- [T-36] Forward secrecy posture — keystore + chat
- [T-37] YubiKey HMAC-SHA1 challenge response — known-weak protocol, mitigations

## Phase D — Database & persistence review (10 tasks)
- [T-38] DB schema dead-field sweep (columns never written or never read)
- [T-39] DB schema migration linearization (no gaps, no reorders since launch — we're pre-launch so should be fine)
- [T-40] Index coverage on hot queries (orderbook, profile, conversations)
- [T-41] FK integrity (referential, cascade-delete posture)
- [T-42] Race conditions in upsert/transaction paths
- [T-43] SQL injection — every dynamic query reviewed
- [T-44] LIKE-pattern injection (user controls a LIKE pattern?)
- [T-45] Connection pool exhaustion under load
- [T-46] Long-running query timeouts
- [T-47] Locks held across I/O

## Phase E — Frontend security review (10 tasks)
- [T-48] XSS — chat message rendering, address pills, link-pills, code blocks
- [T-49] CSP — adequate `default-src`, `script-src`, `style-src`, `connect-src`, `frame-ancestors`
- [T-50] SRI — external CDN scripts (any?)
- [T-51] PostMessage handlers — origin checks
- [T-52] Local/Session storage — any secret stored?
- [T-53] IndexedDB — any secret stored unencrypted?
- [T-54] Service worker — caching of authenticated content?
- [T-55] Tor/I2P metadata leak surfaces (assets loaded from external CDNs)
- [T-56] Auto-submit forms / click-jacking — frame-ancestors set?
- [T-57] localStorage cleared on logout?

## Phase F — Static code-quality sweep (10 tasks)
- [T-58] Dead code / unused exports
- [T-59] Orphan files (files unreferenced by anything)
- [T-60] TODO / FIXME / XXX backlog count and triage
- [T-61] Inconsistent error handling (some throws, some returns null)
- [T-62] Missing `Promise.allSettled` where appropriate
- [T-63] Unbounded `await` in loops (rate-limit risk)
- [T-64] `setTimeout` / `setInterval` without cleanup (memory leak risk)
- [T-65] Closures holding large objects in scope
- [T-66] `JSON.parse` of untrusted input without try/catch
- [T-67] Any non-strict equality (`==` vs `===`)

## Phase G — Regex accuracy (5 tasks)
- [T-68] Every regex in the codebase reviewed for ReDoS
- [T-69] Every regex reviewed for anchoring (`^` / `$` to prevent partial-match bypass)
- [T-70] Every regex reviewed for Unicode handling
- [T-71] Address-validation regexes vs canonical specs
- [T-72] TXID-validation regexes vs canonical specs

## Phase H — Smokes + tests audit (7 tasks)
- [T-73] Smoke drift — any smoke asserting an outdated invariant?
- [T-74] Smoke staleness — any smoke that hasn't fired in N audits?
- [T-75] Test coverage gaps — areas of code with low/no test
- [T-76] Vitest skipped tests — why? Are they real or stale?
- [T-77] Smoke tamper-test rotation — do all critical smokes have a tamper-test in the smoke comment?
- [T-78] Property-based testing surface — could fast-check find more?
- [T-79] Mutation testing — would a mutant survive?

## Phase I — Documentation accuracy (8 tasks)
- [T-80] README.md accuracy (top-level)
- [T-81] OPERATIONS.md accuracy (every step works as documented)
- [T-82] RUN-A-MORPHIT-NODE.md accuracy (every step works as documented)
- [T-83] FAQ accuracy (every Q has an accurate A vs current code)
- [T-84] ADR accuracy (every Decision still reflects current code)
- [T-85] Broken intra-doc references (link targets exist)
- [T-86] SECURITY.md accuracy + disclosure process
- [T-87] PRIVACY.md / METADATA-LEAK-CATALOG.md accuracy

## Phase J — Wiring & i18n drift (5 tasks)
- [T-88] Locale-key orphans (keys defined but never referenced)
- [T-89] Code-referenced i18n keys missing from locale files
- [T-90] Locale parity (already done; re-verify)
- [T-91] Component wiring (any component imported but never rendered)
- [T-92] Route wiring (any route registered but unreachable, or vice versa)

## Phase K — Failover/fallback completeness (2 tasks)
- [T-93] Every external dependency (RPC, indexer, relay, image-gen) has a fallback path
- [T-94] Every user-facing error has an actionable next step (never "wtf is going on?")

---

## Working notes

- Sandbox-only constraints: no DAST, no fuzzing of live targets, no real
  YubiKey hardware. All findings via source-code review + static analysis.
- Each finding goes into `FINDINGS.md` with severity + fix-status.
- All fixes ship in cp138.
