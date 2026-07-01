# cp164 themed deep-deeps

Two cross-cutting deep-deeps that cut across workspaces by *threat*
rather than by directory.  Different angle from the cp146-lens
per-workspace audits, intended to surface threads workspace-scoped
passes miss.

---

## Deep-deep #1 — every place a Monero private view key could leak

**Threat:** the operator's treasury wallet view key, if published
anywhere (on chain, in HTTP responses, in logs, in test fixtures),
would let any observer trace every payment to that wallet forever —
both for the operator's privacy and for every fee-paying user.
Memory rule: view keys stay env-only on the operator's box.

### Phases walked

1. **Surface inventory** — every file touching `viewkey` / `view_key` /
   `viewKey` / `secret_view` / `secretViewKey` across `apps/`,
   `packages/`, `docs/`, `ops/`, `scripts/`.  ~45 files, mostly
   documentation explaining the privacy invariant.
2. **Env-var sourcing** — confirmed `MORPHIT_INDEXER_XMR_FEE_VIEWKEY`
   is **fully deprecated**.  Part 109 (well before this session)
   replaced view-key-based decryption with per-payment `tx_proof`
   verification.  `apps/indexer/src/config/index.ts:908` documents:
   *"the env var that existed during the Part 107/108 transition has
   been removed entirely.  No code path reads it.  No verification
   flow uses it."*  Architecturally, the indexer **no longer holds
   a view key at all** — the biggest potential leak vector doesn't
   exist by construction.
3. **Proof-verifier input shape** — `moneroProofVerifier.ts` strictly
   validates `tx_proof`: must start with `OutProofV1` or `OutProofV2`,
   max 4096 chars, base62-ish charset.  A 64-char hex view key would
   be rejected by the prefix check alone.
4. **Explorer query construction** — the indexer calls explorer
   `/api/outputs?txprove=1` passing the *proof string*, not a view
   key.  Proof reveals only "this txid paid this address this
   amount", not the full wallet history.
5. **Log/HTTP echo of proof** — zero log/error/HTTP paths echo the
   proof string back.  Even though the proof is user-supplied
   (selective-transparency material, lower sensitivity than a view
   key), the indexer doesn't log it.
6. **Frontend UI surface** — zero view-key fields, prompts, labels,
   or local-storage entries anywhere in `apps/web/src/`.  Only
   public addresses are accepted in AddressShareModal and friends.
7. **privateKeyDetector** — `apps/web/src/lib/security/privateKeyDetector.ts`
   **explicitly catches Monero private view keys** (64-char lowercase
   hex pattern).  If a user accidentally pastes a view key into chat,
   feedback, or any text input wired to the detector, they're stopped
   before sending.  Defense in depth on the user side.
8. **Order/release payload validation** — `releaseValidate.ts:55-62`:
   *"the XMR private view key is no longer chain-pinned.  Validation
   reasons related to the viewkey (treasury_xmr_viewkey_missing,
   treasury_xmr_viewkey_not_hex64) were removed because the validator
   no longer accepts a `viewkey` field — any `viewkey` value present
   in the input is silently ignored (forward-compat for any historical
   release op that included one before Part 107)."*  Validator strips
   any view key from incoming release payloads.
9. **Indexer release-handler** — `apps/indexer/src/indexer/handlers/release.ts:28-36`:
   the same silent-ignore behaviour at handler level.  Belt and
   suspenders: validator rejects + handler refuses to persist to the
   `treasury` JSONB column.
10. **Indexer poller + main.ts** — zero console.log/warn/error
    references near view-key surfaces.
11. **Chat payload** — the chat envelope is end-to-end encrypted;
    even if a key somehow appeared in the plaintext, it'd be encrypted
    to the peer.  But more strongly: no chat-payload field accepts a
    view-key shape.
12. **Test fixtures** — one 64-char hex in `apps/indexer/test/testutils/context.ts:52`
    (a `chainId`, the public Blurt mainnet chain identifier — verified
    public, not secret).  METADATA-LEAK-CATALOG.md explicitly lists
    "XMR private view-key NEVER leaves the operator's box" as a
    defended property.

### Verdict

Clean across all 12 phases.  **The architecture eliminates the threat
by design** — Part 109 removed the indexer's view-key dependency
entirely.  Legacy paths have explicit silent-ignore defenses (validator
+ handler).  Frontend has no view-key UI.  privateKeyDetector catches
user-pasted view keys.  Zero leak vectors found.

No code changes needed.

---

## Deep-deep #2 — every error/log path that could leak internal hostnames/IPs

**Threat:** an HTTP error response, log line, or debug field that
includes an internal hostname, IP, port, or database connection
string could reveal the operator's infrastructure topology to a
public attacker — useful reconnaissance for chained attacks
(direct connect bypassing nginx, internal-network pivot, etc.).

### Phases walked

1. **Error-throw sites** — zero `throw new Error(...)` interpolating
   URLs/hosts in production code paths across `apps/relay/src/` and
   `apps/indexer/src/`.
2. **HTTP error-response patterns** — zero handlers do
   `c.json({error: err.message})` or equivalent.  All errors go
   through curated paths.
3. **`errorBody()` helper** (`apps/indexer/src/api/shared.ts:62`) —
   constrained `code` to a typed union (`not_found | bad_request |
   rate_limited | internal | service_starting`); all callers pass
   hand-curated message strings ("invalid account name", "self-chat
   not allowed", etc.).  No URL/host interpolation.
4. **`errorBody('internal', ...)`** — the `internal` code is defined
   in the type but **never used in any handler** in the indexer's
   API.  No path emits an `internal` error with a possibly-leaky
   message.
5. **Relay catch-all 500** (`apps/relay/src/main.ts:347-350`):
   `app.onError((err, c) => { httpLog.error('unhandled', {}, err);
   return c.json({status:'error', code:'internal'}, 500); })`.
   **By construction, returns only a fixed code** — no message, no
   URL, no stack trace.  Logs go to httpLog locally.
6. **Relay 404 catch-all** — `app.notFound((c) => c.json({status:'not_found'}, 404))`.
   Tight, no URL echo.
7. **Logger sink behaviour** — `apps/relay/src/log/index.ts:142,153`
   and `apps/indexer/src/log/index.ts:146,177` both write only to
   `process.stdout` / `process.stderr`.  Zero `fetch`, `axios`,
   `net.connect`, or `createWriteStream` for remote shipping.  **Logs
   stay on the operator's machine by sink construction.**  Even if an
   `err.message` contains an internal host, it never leaves the
   operator's box via Morphit itself.
8. **Response headers** — all manually-set headers in
   `apps/relay/src/middleware/security.ts` and `apps/indexer/src/api/middleware/security.ts`
   are constants (`X-Content-Type-Options`, `Referrer-Policy`,
   `X-Frame-Options`, `Permissions-Policy`).  No host/IP
   interpolation.
9. **CORS** (`apps/relay/src/middleware/cors.ts`) — exact-match
   origin allowlist; echoes only the matched origin (a value the
   request already supplied), never an internal value.  Preflight
   handled cleanly with 204.
10. **Redirects** — zero `c.redirect(...)` / `reply.redirect(...)`
    in the API layer.  No Location-header leak surface.
11. **Debug/admin/metrics endpoints** — **none exist**.  No
    `/admin`, no `/_debug`, no Prometheus `/metrics`.  Nothing to
    leak.
12. **Database/upstream-error bubbling** — sampled SSE-stream
    catches (`chatStream:272`, `instancesStream:115/152/194`,
    `orderbookStream:389/436/482`) and relay-push catch
    (`push.ts:256`).  Pattern is uniform: `log.warn/error(...,
    err)` locally, then either close the stream silently or return
    `{status:'internal'}` with no message.  No err.message leaks
    over the wire.

### One finding — `/v1/health?verbose=1` diagnostic exposure

`apps/indexer/src/api/health.ts:135` conditionally adds a
`diagnostics` block to `/v1/health` containing:

- `last_error: status.lastError` — the **raw error message** from the
  poller's most recent failure (`apps/indexer/src/indexer/poller.ts:527`:
  `lastError: err instanceof Error ? err.message : String(err)`).
  This *can* include internal hostnames, ports, IPs, Postgres
  connection strings, or RPC URLs depending on what failed.
- `explorers[].url` — configured Monero explorer URLs.
- `operator_balances` — per-account below-threshold state.

**However, this block is double-gated:**

1. Server-side: `config.verboseHealth` (env var
   `MORPHIT_INDEXER_VERBOSE_HEALTH`, default `false`).
2. Request-side: `?verbose=1` query param.

Both must be set.  Default deployments expose **none** of this.
The current file's own comment notes that a previous audit fix
introduced exactly this gating: *"Pre-fix, any caller passing
?verbose=1 got the full diagnostics block… Post-fix, verbose mode
is operator-opt-in only."*

This is not a leak; it's an operator-controlled diagnostic.  But
an operator who flips verbose ON should understand the privacy
tradeoff they're accepting — and the previous env-example doc
just said "leave off in production unless actively debugging,"
without spelling out what *specifically* the operator would expose.

### Change shipped

Strengthened the env-example documentation
(`ops/env/indexer.env.example`) to make the verbose-health privacy
tradeoff explicit.  Operators who turn it on now see exactly what
they're exposing (raw error text, explorer URLs, below-threshold
balance state) and a suggested mitigation (IP-allowlist
`/v1/health?verbose=1` behind nginx for the admin workstation).

### Verdict

Clean across all 12 phases.  No false-positive findings.  One
already-defended diagnostic surface with documentation improved so
operators make informed choices.

---

## Combined summary

- **View-key leak:** zero vectors found.  Architecture defends by
  construction (Part 109 removed the dependency); defense in depth
  covers legacy paths (validator + handler strip viewkey fields);
  user-facing detector catches accidental paste.
- **Internal-host/IP leak:** zero default-on leak surfaces.  Logger
  sinks are local-only.  All public HTTP errors are curated codes
  without err.message interpolation.  One double-gated diagnostic
  endpoint where the operator can consciously expose more — doc
  strengthened to make the tradeoff explicit.

The two themed angles confirmed what the per-workspace audits had
indicated, but as separate cross-cutting threads.  No new
HIGH/CRITICAL findings; one INFO-level doc clarification shipped.
