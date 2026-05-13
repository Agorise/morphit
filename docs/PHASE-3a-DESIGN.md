# Phase 3a — Posting relay + account creation · Design

**Status:** Draft for review, pre-implementation
**Date:** 2026-04-18
**Depends on:** Plan v1.3, ADR-0002 (live keys policy), ADR-0005
(Phase 3 subphase split)

> **2026-05-11 forward note (Part 120 audit):** This is the
> ORIGINAL Phase 3a design as it stood on 2026-04-18.  The
> shipped relay differs in two important ways and this doc
> is preserved for historical context only — do NOT cite it
> for current behavior:
>
> 1. **Account-creation mechanism.**  This doc describes
>    `account_create` (inline-pay: creator broadcasts the
>    creation transaction with a `fee` field paid in liquid
>    BLURT).  The shipped relay uses
>    `create_claimed_account` consuming pre-minted ACTs
>    (Account Creation Tokens) per **ADR-0010 §4** — the
>    weekly ACT minting ceremony is automated via
>    `morphit-relay-mint-acts.timer` (see AUTOMATION-AUDIT.md
>    §1.1).  The H8 ACT-model-drift fix in the 2026-05
>    audit closed the last inline-pay path.
> 2. **Repo layout.**  The "morphit/apps/relay/cmd/…/internal/…"
>    Go-style layout shown in §"Repo layout added in 3a"
>    below was the original sketch.  The shipped layout is
>    flatter: `apps/relay/src/{main.ts,api/,blurt/,config/,
>    middleware/,policy/}` with no `cmd/` or `internal/`
>    directories.  See ARCHITECTURE.md for the current
>    topology.
>
> Authoritative current behavior is in the code at
> `apps/relay/src/api/create.ts` + `apps/relay/src/blurt/client.ts`
> and the operator-facing recipes in OPERATIONS.md +
> RUN-A-MORPHIT-NODE.md.

## Goals

Ship a first-time-user onboarding flow that:

1. Lets a user pick and register a Blurt account name without ever
   running a third-party signup.
2. Never lets the user's owner / active / posting / memo private keys
   leave their browser.
3. Uses a small Node.js service on morphit.io's VPS (the `morphit-relay`
   account) to pay the Blurt RC cost of the `account_create`
   operation. The relay holds only its own active key, never the
   user's.
4. On success, stores the confirmed Blurt account name locally so
   the Phase-2 display-name-broadcast path can now actually
   broadcast (previously a `BroadcastError { code: 'no_account' }`).
5. Enables the first on-chain read of a `morphit_profile_v1` op
   (i.e. if the user had a name saved from a prior session, fetch
   it back from the chain on fresh device).

## Non-goals (explicitly out of Phase 3a)

- Indexer. No chain-streaming database yet; the relay does not index.
- Orderbook. No order posting, no order reading, no order storage.
- Chat, feedback, reputation, payment-watcher, tor/lokinet/i2p
  hosting. All later phases.
- WhaleVault / Gravity signing path. Design the relay to accept
  externally-signed transaction blobs so this lands cleanly in
  Phase 4, but no code.

## Repo layout added in 3a

```
morphit/
  apps/
    web/              (Phase 1-2, SvelteKit frontend)
    relay/            (Phase 3a, NEW — Node.js/TypeScript service)
      cmd/
        morphit-relay/
          src/main.ts
      internal/
        api/          HTTP handlers
        blurt/        RPC client wrapper
        config/       env-driven config + validation
        policy/       rate limits, name-allowlist rules
        queue/        pending-op queue + retry
      package.json
      package-lock.json
      tsconfig.json
      Makefile
      README.md
    (apps/indexer/    comes in Phase 3b)
  ops/                NEW — deployment + systemd units
    systemd/
      morphit-relay.service
    nginx/
      relay.conf
    env/
      relay.env.example
```

## Relay HTTP API

One origin: `https://relay.morphit.io`. Served only over HTTPS.
CSP on the frontend `connect-src` adds this exact host.

### POST /v1/account/availability

**Purpose:** cheap existence check so the UI can disable the
"register" button for names that are already taken.

**Request:**
```json
{"name":"sally"}
```

**Response:** 200
```json
{
  "name":"sally",
  "available":false,
  "reason":"already_registered"
}
```

`reason` ∈ `"already_registered"`, `"reserved"`, `"invalid_format"`,
`"too_short"`, `"too_long"`, `"leading_trailing_dash"`, `"bad_chars"`.
If `available: true` then `reason` is omitted.

**Rate limit:** 60/min per IP (rate limits are per-IP memory; no
logging of IPs per Plan v1.3 privacy promise).

### POST /v1/account/create

**Purpose:** accept an unsigned `account_create` op body from a
user's browser and broadcast it to Blurt, signed with the relay's
own active key. The relay pays the chain's account-creation fee
in BLURT (currently 100 BLURT per account; set by witness
consensus and read dynamically by the relay from
`condenser_api.get_chain_properties` at each signup) from its
own liquid BLURT balance.

**Request:**
```json
{
  "op": {
    "new_account_name": "sally",
    "owner":    { "weight_threshold": 1, "account_auths": [], "key_auths": [["BLT...",  1]] },
    "active":   { "weight_threshold": 1, "account_auths": [], "key_auths": [["BLT...",  1]] },
    "posting":  { "weight_threshold": 1, "account_auths": [], "key_auths": [["BLT...",  1]] },
    "memo_key": "BLT...",
    "json_metadata": ""
  }
}
```

The client POSTs only the op's *body* — the four sets of
authorities for the new account and the chosen name. The relay:
  1. Validates the op body.
  2. Checks its own BLURT balance against the current
     `account_creation_fee` median from witness consensus.
  3. Wraps the body in a Blurt transaction with correct
     `ref_block_num`, `ref_block_prefix`, and `expiration`.
  4. Adds its own `creator: "morphit-relay"` field and the
     required `fee` field (read from
     `condenser_api.get_chain_properties.account_creation_fee`
     at broadcast time — currently `"100.000 BLURT"`).
  5. Signs the whole transaction with its own active key
     (read from `MORPHIT_RELAY_ACTIVE_KEY_FILE` at startup).
  6. Broadcasts via
     `condenser_api.broadcast_transaction_synchronous`.

Why this shape — not "user signs, relay forwards"?

Account creation on Blurt is signed by the **creator** (the
account paying the fee), not the new account. The creator
authorizes "I am paying 100 BLURT to register `sally` with these
pubkeys." The new account has no active key on-chain yet so it
couldn't sign anything. The relay's active key is the signing
identity here; the user's role is only to choose the name and
contribute the pubkeys that will govern their new account.

This is security-positive for users: their owner private key
never touches any signing flow during account creation. Zero
opportunity for an XSS / extension bug to exfiltrate it at this
moment.

**Validation before signing + broadcast:**
- `op.new_account_name` passes the same allowlist as the
  availability endpoint.
- The four pubkey fields are each structurally valid BLT
  keys (parseable; no duplicates across roles, each `key_auths`
  has exactly one entry).
- `weight_threshold: 1` and each `key_auths[0][1]: 1`
  (single-key authorities; multi-sig setups via relay are not
  supported in 3a).
- `json_metadata` is empty or a short string; reject >1 KiB to
  prevent using account creation as a chain-storage abuse
  vector.
- The account name is not already registered (final chain
  check, belt-and-braces — availability endpoint already did
  this but another user could have grabbed the name between
  availability check and create submission).
- The relay has at least `account_creation_fee * 2` BLURT
  liquid balance (if not, return 503 `relay_out_of_funds` so
  the client can offer to retry later and the operator gets a
  clear signal to top up).
- Dedupe within the last minute by the 4-pubkey fingerprint
  (hash of all four pubkeys concatenated) — an accidental
  double-submit from a flaky client network does not try to
  register the same account twice.

**Response:** 200
```json
{
  "status":"broadcast",
  "block_num":12345678,
  "trx_id":"abc..."
}
```

Or 4xx with a machine-readable error:
```json
{
  "status":"rejected",
  "code":"already_registered",
  "message":"sally is already taken"
}
```

Error codes: `already_registered`, `malformed_operation`,
`name_not_allowed`, `invalid_pubkey`, `rate_limited`,
`relay_out_of_funds` (temporary — retry later),
`broadcast_failed` (with inner error from Blurt surfaced).

**Rate limit:** 5/hour per IP. Real users only register once;
this bucket primarily protects the relay's BLURT balance from
drain attacks.

### GET /v1/health

**Purpose:** liveness + readiness for monitoring. Returns the
relay's current BLURT liquid balance + an estimate of how many
more account creations it can fund, node it's currently using,
and uptime. Used by the frontend to decide whether to show a
"registration is temporarily unavailable" banner.

**Response:** 200
```json
{
  "status":"ok",
  "version":"0.3.0-phase3a",
  "blurt_balance":"423.000 BLURT",
  "account_creation_fee":"100.000 BLURT",
  "creations_remaining":4,
  "uptime_sec":12345
}
```

`creations_remaining = floor(blurt_balance / account_creation_fee)`.
At a balance below 10 creations, the frontend warns the user
that registration might be delayed.  Below 3, the relay
rejects new create requests with `relay_out_of_funds` so a
remaining handful of BLURT isn't spent on a single burst that
might include a name-squatter.

### What the relay DOES NOT expose

- No catch-all broadcast endpoint. Future ops (orders, feedback)
  will have their own dedicated endpoints with op-specific
  validation. A general-purpose "sign this for me" endpoint is
  a footgun.
- No account-key-rotation endpoint. That path stays in the user's
  browser with `useOwnerKey()` + direct-to-chain broadcast.
- No key-escrow, no key-recovery, no email-binding, no social-login.

## Client-side — account-registration UI

New route: `/onboarding/register-name`.

Reached after a user completes the existing `/onboarding` keygen
+ seed-confirmation flow and the seed is backed up. Skipped if the
user already has a Blurt account name in local storage (returning
user path).

Layout (sketch):

1. Headline: "Pick your Blurt handle."
2. Single input, rules displayed inline (3-16 chars, lowercase,
   digits, dashes, no leading/trailing dash, no consecutive dashes).
3. Debounced availability check (400ms after typing stops) against
   `/v1/account/availability`.
4. Submit button: disabled until availability is green.
5. On submit:
   - Prompt for owner-key password (one time). Password unlocks
     the keystore, `useOwnerKey()` hands the owner key to a
     callback.
   - Callback builds the `account_create_with_delegation` op,
     signs with the user's owner key + generated posting/memo/active
     pubkeys (keys already exist in `FullIdentity`; we broadcast
     the pubkeys and retain the privkeys locally).
   - Owner key is zeroed the instant the callback returns.
   - Signed transaction is POSTed to the relay.
   - On 200: local storage gets the account name, session flips
     to "registered", user is redirected to `/orderbook`.
6. Error states: show the relay's error code translated via
   i18n. Retry is always offered for recoverable errors.

i18n keys added (translated across all 10 locales):
- `register.title`
- `register.intro`
- `register.name_label`
- `register.name_placeholder`
- `register.name_rules`
- `register.check_availability`
- `register.available`
- `register.unavailable_{reason}` (×7 reason codes)
- `register.password_prompt`
- `register.submit`
- `register.submitting`
- `register.success`
- `register.error_{code}` (×7 error codes)
- `register.rc_low_warning`

That's ~30 new keys × 10 locales = 300 new string deliveries.

## Release-discovery op

In 3a, the `morphit` account publishes its first
`morphit_release_v1` custom_json op. Schema:

```json
{
  "v": 1,
  "release": "0.3.0-phase3a",
  "hashes": {
    "index.html": "sha256-..."
  },
  "endpoints": {
    "relay": ["https://relay.morphit.io"],
    "indexer": []
  },
  "ts": 1713456789
}
```

Clients can optionally verify this op is signed by the expected
posting pubkey (pinned in `$net/config.ts`) to detect
impersonation. Phase 3a hard-pins the expected key; Phase 5
adds PGP-signed release manifests as a second factor.

**Need from you:** the `morphit` account's posting public key
(safe to share publicly). I'll embed it as
`MORPHIT_OFFICIAL_POSTING_PUBKEY` in `$net/config.ts`.

## Security review for 3a

- Owner key touches JavaScript heap for <100ms (build + sign op).
  Zeroed in the `useOwnerKey()` `finally` block.
- Relay holds only `morphit-relay`'s active key. Operator keeps
  `morphit-relay`'s owner key offline.
- No user IP is logged by the relay in any path.
- Rate limits use in-memory sliding windows. No IP-keyed
  persistence.
- Relay's Blurt node is the same endpoint rotator the frontend
  uses; community failover applies.
- CORS on the relay allows only `https://morphit.io` +
  `https://*.onion` + `https://*.loki` + `https://*.i2p` origins.
- All endpoints return no body on idle connections (no banners
  broadcasting software versions) except `/v1/health`.
- CSP additions on the frontend: `connect-src` now explicitly
  allows `https://relay.morphit.io`. Tightened from the Phase 2
  `https:` wildcard once the registry of community relays
  publishes (Phase 3b).

## Phase 3a test plan

Relay-side unit tests for:
- Availability check: accepts valid names, rejects every illegal
  pattern in the allowlist spec.
- Account-create validation: rejects malformed ops, accepts
  well-formed ones (mocked RPC).
- Rate limits: 5/hour bucket enforces, resets after window.

Relay-side integration test against a testnet Blurt node:
- End-to-end: generate keys, sign op, post to relay, observe
  account existing on testnet.

Frontend-side Vitest:
- Availability debounce: typing fast only fires one check.
- Success path: relay 200 → local storage updated → redirect.
- Failure paths: each error code maps to its i18n key.

Phase-2 carry-forwards P2-10 / P2-11 / P2-12 land in this
subphase's test suite.

## Rollout

1. Relay deployed to staging subdomain (`relay-staging.morphit.io`),
   pointed at Blurt mainnet (Blurt has no testnet that mirrors
   mainnet's RC model closely enough to be worth staging there).
2. Registration UI deployed to `staging.morphit.io`, configured
   to hit the staging relay.
3. Maintainer registers 2-3 test accounts, confirms they exist,
   confirms RC drain is within expectations.
4. Production cutover: relay moves to `relay.morphit.io`,
   frontend CSP updates, release-discovery op broadcast.
5. Tarball handed off to user for git commit.

## Open questions

- **Relay operator account key rotation.** The relay's active
  key is what's at risk if the VPS is compromised. Plan is to
  rotate it quarterly via `useActiveKey()` from a cold device.
  Documenting the procedure is part of 3a's README.
- **Relay RC budget.** Blurt account creations cost varying RC;
  at current chain state one create is ~0.5% of a mid-vested
  account's daily RC. We'll size `morphit-relay`'s vesting based
  on observed Phase 2 registration interest — for 3a launch, 500
  BLURT vested should cover tens of registrations per day with
  headroom. Maintainer tops up as needed.
- **Abuse response.** A determined attacker can burn through the
  5/hour IP bucket from a VPN pool. If we see this happen, the
  mitigation is to require a small proof-of-work stamp on the
  create request. Designed but not implemented in 3a.

## Design-doc changelog

- **2026-04-18 — stack pivoted from Go to Node.js/TypeScript**. The
  original design specified a Go relay. Mid-implementation we
  discovered no actively-maintained Go library for Blurt exists; the
  only option would have been writing the signing + serialization
  layer by hand. The Node.js ecosystem has `@beblurt/dblurt` —
  Promise-based, TypeScript-native, documents every op we need, and
  happens to be what the frontend uses too. ADR-0006 captures the
  security posture under the new stack (it transfers directly —
  nothing in the threat model was Go-specific). Architecture,
  endpoints, error taxonomy, and deployment posture are unchanged.
- **2026-04-18 — keygen curve corrected and dblurt package name
  fixed**. Phase 2 shipped Ed25519 keygen (wrong curve for Blurt) and
  a typo'd package name. Neither could ever have worked against a
  real chain. ADR-0007 records the fix. The Phase 3a registration
  flow is the first place in the codebase where this ever mattered,
  which is how it went undetected in Phase 2.
