# Phase F → F.5 audit — 2026-04-27

User asked for deep code + security audit of Phase F through F.5
before considering Phase G.  Methodology mirrored the chat audit
(C-1..C-62): line-by-line code-read of every file in the
F → F.5 surface, looking for cap-math errors, validation gaps,
privacy-contract violations, race conditions, off-by-one bugs,
type-contract mismatches, and key-handling exposure.

## Methodology

Six audit passes, each focused on one area:

1. Wire format & payload module (`apps/web/src/lib/chat/payload.ts`)
2. On-chain verifier (`apps/web/src/lib/chat/blurtVerify.ts`)
3. `broadcastTransfer` and active-key handling (`apps/web/src/lib/blurt/sign.ts`)
4. Global SSE listener (`apps/web/src/lib/trades/tradeEventListener.ts`)
5. Toast/notification rendering + tradeStatus store integration
6. Cross-cutting concerns (privacy, race conditions, i18n quality,
   forward-compat, accessibility)

NO code fixes during the audit.  Findings consolidated into this
doc; fixes implemented in priority order after sign-off.

## Severity counts

| Severity | Count |
|---|---|
| HIGH | 2 |
| MEDIUM | 6 |
| LOW–MEDIUM | 4 |
| LOW | 30 |
| VERY LOW | 3 |
| **Total** | **45 findings** |

(F-17 was considered and dropped — see notes below.)

## Findings — HIGH severity

### F-7 — Verifier multi-transfer first-match bug — HIGH

**Status:** [x] **fixed (2026-04-27)** — `verifyBlurtTransferAgainstTx`
now scans all transfers with `to === recipient`, returns verified
if any matches every field, and otherwise reports the closest-
match candidate's first failed field.  Helper
`compareTransferToExpect` factors the per-candidate comparison.
6 new smoke scenarios in `chat-blurt-verify-smoke.ts` cover decoy-
ahead, decoy-behind, neither-matches closest-field reporting, the
single-mismatch-tie case, sender-mismatch isolation, and the
legitimate-bundle case.  All 23 scenarios passing.

**Where:** `apps/web/src/lib/chat/blurtVerify.ts` lines 167-180.

**Description:** The verifier loops over `tx.operations` looking
for the FIRST transfer with `to === recipient`, breaks, then
checks all fields against expected.  If a transaction contains
multiple transfers to the same recipient, only the first is
checked.

A malicious buyer could craft a transaction with a tiny "decoy"
transfer to the seller AHEAD of the real payment in the same tx.
The seller's verifier picks up the decoy, sees amount mismatch
(or memo mismatch), and falsely flags the trade as mismatch — the
real payment is never inspected.  The seller might refuse to
release goods/services believing they weren't paid; on chain,
they were.

Symmetric edge: a buyer who legitimately bundles multiple
payments to the same seller in one tx (rare but valid) gets
flagged for whichever transfer happens to come first if the
seller-expected metadata only matches the second.

**Recommended fix:** Scan ALL `to === recipient` transfers in the
tx.  Return `verified` if ANY of them matches recipient + sender +
amount + memo.  Only return mismatch if no transfer matches all
fields (and report the closest-match field).  Only return
`wrong_op` if no transfer with `to === recipient` exists at all.

**Test additions needed:** smoke scenarios for:
- Decoy `to: alice` (small amount) before legit `to: alice` (big amount) — should verify
- Two `to: alice` transfers, neither matches → mismatch (which field surfaces)
- Two `to: alice` transfers, one matches memo, one doesn't — should verify

---

### F-40 — tradeStatus store poisoning by any chat partner — HIGH

**Status:** [x] **fixed (2026-04-27)** — implemented Option A
(lock-on-first-engage).

Changes:
- Added `engagedPeer?: string` field to `TradeState` —
  the peer the local user has affirmatively engaged with for
  this trade.
- `recordAddressSharedPure` and `recordFundsSentPure` now take
  a required `direction: 'outgoing' | 'incoming'` argument.
- Outgoing payloads always apply.  Engagement is set on FIRST
  outgoing (sticky thereafter — UI bugs sending outgoing to a
  different peer don't flip engagement).
- Incoming payloads from a peer ≠ `engagedPeer` are dropped at
  the mutator layer.  Tentative entries (no engagement) still
  accept incoming updates.
- Verifier in `ChatMessage.svelte` now consults the store's
  `expectedMemo` ONLY when `engagedPeer === message.sender`.
  Falls back to the buyer's echoed memo otherwise — restoring
  Phase F.4 baseline behavior so a poisoned tentative entry
  cannot drive a false-mismatch.
- All call sites updated: chatService outgoing (sendMessage)
  and incoming (mergePollResponse) paths, and the global
  listener (always incoming).

7 new smoke scenarios in `trade-status-smoke.ts` cover:
outgoing locks, incoming-tentative succeeds, incoming-from-
non-engaged dropped, incoming-from-engaged applied, poison-
before-engagement-then-engage, engagement-stickiness against
different-peer outgoing, incoming funds_sent from non-engaged
dropped.

All 30 trade-status scenarios passing.  Frontend typecheck
0 errors.

**Where:** `apps/web/src/lib/trades/tradeStatusPure.ts` mutators.

**Description:** Any peer in the user's recent-peers list can
poison a tradeStatus entry for any public orderPermlink by
sending a chat message with a structured payload referencing it.
Mallory just needs to be a chat partner and to know an
orderPermlink — orderPermlinks are public Blurt posts, so Mallory
can scrape Alice's blog to find them.

The `expectedMemo` field in the store is preserved across
recordFundsSent calls (only `peer`/`method` overwrite).  If
Mallory pre-poisons the entry with a wrong `expectedMemo`,
the legitimate buyer Bob's funds-sent payload doesn't overwrite
the memo.  The verifier compares chain truth (Bob's correct memo)
against the poisoned `expectedMemo` → false mismatch:memo.

Result: the verifier becomes untrustworthy in the presence of
ANY malicious chat partner.  The "auto-correlation across pills"
feature (F.5 design promise) becomes a vulnerability when the
trust scope isn't pinned to the actual trade counterparty.

**Recommended fix:** tradeStatus entries should be scoped to a
specific peer.  Two options:

- **Option A (lock-on-first-engage):** Track per-permlink which
  peer the local user has actively engaged with (sent an outgoing
  structured payload to).  Once engaged, drop incoming payloads
  from any other peer that reference the same permlink.  Until
  engaged, accept payloads but tag them as "tentative" so the
  badge doesn't promote to a confirmed state.

- **Option B (key by permlink+peer):** Store keyed by
  `(orderPermlink, peer)` rather than just permlink.
  PaymentStatusBadge aggregates over peers (typically 1 entry per
  permlink, but architecture doesn't assume).

Option B is the more robust architectural answer.  Option A is
simpler to retrofit.  Recommend A as the immediate fix, B as a
longer-term refactor.

**Test additions needed:**
- Mallory sends address-shared with poison memo → Bob's
  funds-sent for same permlink → verifier should NOT consult
  Mallory's memo.
- Lock-on-engage: user sends outgoing → only that peer can
  update entry afterward.

---

## Findings — MEDIUM severity

### F-8 — BLURT amount precision asymmetry — MEDIUM

**Status:** [x] **fixed (2026-04-27)** — encoders now normalize
BLURT amounts to 3 decimals via Math.ceil round-up at encode
time.

Changes:
- `encodeAddressPayload` and `encodeFundsSentPayload` apply
  `(Math.ceil(parseFloat(amount) * 1000) / 1000).toFixed(3)`
  when method is `blurt`.  Round UP for symmetry with
  `formatBlurtAmount` (sellers slightly overpaid rather than
  slightly underpaid).
- BTC and XMR amounts unchanged — those chains have different
  decimal conventions (8, 12) and the wire format isn't trying
  to mirror chain rounding for them.
- Updated existing test (`decode: BLURT address payload
  round-trips`) which asserted the pre-fix behavior.
- 10 new F-8 scenarios in chat-payload-smoke covering: 4+
  decimal rounding, integer→.000 padding, 1-decimal padding,
  4-decimal round-up, 3-decimal unchanged, BTC verbatim, XMR
  verbatim, funds_sent symmetric, leading-zeros incidental fix,
  tiny-amount preservation.

Side benefit: F-4 (leading zeros) is incidentally fixed for
BLURT amounts.  "0001.500" → "1.500" via parseFloat + toFixed.
F-4 remains open for non-BLURT amounts.

Frontend typecheck 0 errors.  All 553 smoke scenarios stable.

**Where:** `payload.ts` `AMOUNT_RE` (12 decimals allowed) vs
chain rounding (3 decimals) vs verifier epsilon (0.0005).

**Description:** Address-pill amount accepts up to 12 decimals.
Buyer's chain transfer rounds UP to 3 decimals via
`formatBlurtAmount` (Math.ceil-based).  Verifier epsilon (0.0005)
is exactly half a chain-unit, which fails to absorb the
worst-case round-up.  Sellers typing amounts like `1700.4994` see
buyer pay rounded `1700.500` and the verifier flags
`mismatch:amount` (diff = 0.0006 > 0.0005).

**Recommended fix (preferred):** Round the seller's expected
amount UP to 3 decimals at encode time, matching what the buyer's
wallet will see.  Implement in `encodeAddressPayload` for BLURT
method.

**Alternative fixes:** loosen verifier epsilon to 0.001 OR
constrain modal input to 3 decimals via `step` attribute and
validation.

---

### F-11 — Single-RPC trust (verifier inherits C-35) — MEDIUM, residual

**Status:** [x] **documented (2026-04-27)** — added Phase F.5
addendum to `docs/SECURITY.md` covering single-RPC trust.

The addendum names the residual trust assumption explicitly,
lists existing mitigations (defense via observability, default
RPC operator transparency, settlement is on-chain not via
verifier), and points to multi-node quorum verification as a
post-launch enhancement.

The same addendum also documents the F-40 lock-on-engagement
semantics and the F-23 ambient decryption tradeoff so operators
and security-conscious users have all three Phase F.5 trust
boundaries in one place.

**Description:** Verifier trusts the single configured Blurt RPC
node.  Hostile node can fabricate "verified" results.  Same class
as chat audit C-35.

**Recommended fix:** Document the residual trust assumption in
`docs/SECURITY.md` so operators and security-conscious users know
the boundary.  Future architectural fix: multi-node quorum
verification — heavy, defer.

---

### F-14 — Buyer-side verification missing — MEDIUM, design

**Status:** [x] **fixed (2026-04-27)** — extended verification to
outgoing funds-sent pills with direction-aware copy.

Changes:
- `ChatMessage.svelte` gained an optional `peer` prop (the
  conversation counterparty).  Used to determine the chain
  recipient for outgoing self-verification.
- The verifier `$effect` no longer early-returns on
  `isOutgoing`.  For outgoing messages, the chain
  recipient/sender mapping flips: `recipient = peer` (seller),
  `sender = me` (buyer).  Self-verification proceeds when the
  `peer` prop is supplied; falls back to skipping when absent
  (back-compat for callers not yet aware).
- The render block dropped its `!isOutgoing` gate.  Each
  verifyResult branch now picks between two copy variants —
  peer-verification ("Verified" / "Wrong memo") for incoming,
  self-verification ("Sent as expected" / "Your wallet sent
  something different") for outgoing.
- 9 new i18n keys under `chat.funds_sent.self_verify_*`
  populated across all 10 locales (1469 keys total, 0 drift).
- ConversationView passes the `peer` prop through to
  ChatMessage.

The buyer's self-verifier catches wallet-typo bugs (wrong
recipient, wrong amount, wrong memo) at the moment they post
funds-sent — preventing the buyer from being unaware until the
seller's verifier eventually flags the mismatch hours later.

Frontend typecheck 0 errors.  All 543 smoke scenarios stable.

**Where:** `apps/web/src/lib/components/ChatMessage.svelte`
verifier `$effect`.

**Description:** Verifier runs only on the seller's incoming
funds-sent path (`isOutgoing` check).  Buyer never independently
verifies their own broadcast.

A buyer wallet typo (wrong recipient, wrong amount) → buyer
broadcasts → marks funds sent → buyer's UI shows nothing wrong.
Hours later the seller's verifier flags mismatch.  Funds are
already gone.

**Recommended fix:** Run the same verifier on the buyer's
outgoing funds-sent pill (when isOutgoing && method === 'blurt').
Render a self-verification badge.  Different copy for buyer
("✓ Sent to alice as expected" vs "⚠ Wallet sent to wrong
account") to keep mental model clear.

---

### F-21 — SSE listener connection ceiling — MEDIUM, real functional bug

**Status:** [x] **fixed (2026-04-27)** — listener stream count
capped at `MAX_LISTENER_STREAMS = 5`.

Changes:
- New constant `MAX_LISTENER_STREAMS = 5` in
  `tradeEventListener.ts` with a long rationale comment
  explaining the HTTP/1.1 6-connection-per-origin limit.
- `startTradeEventListener` and `refreshTradeEventListener`
  both `slice(0, MAX_LISTENER_STREAMS)` the recent-peers
  list before iterating.  Recent-peers is sorted newest-first,
  so the cap picks the user's most active conversations.
- `MAX_RECENT_PEERS = 20` in `recentPeers.ts` unchanged —
  the listener cap doesn't affect recent-peers storage which
  drives chat-list UX.
- New OPERATIONS.md section #24: HTTP/2 deployment requirement.
  Includes verification steps (DevTools + curl), nginx + Caddy
  config snippets, symptoms of HTTP/1.1 deployment, and
  rationale for not raising the cap higher.

Conversations rotate as new peers appear at the top of
recent-peers; older peers drop out of the listener's coverage
even if still in the recent-peers list.  When the user opens
a chat for a peer that's no longer in the listener's top 5,
the in-page chatService takes over (already does — chat-page
opens its own stream).

Frontend typecheck 0 errors.  All 553 smoke scenarios stable.

**Where:** `apps/web/src/lib/trades/tradeEventListener.ts`
`startTradeEventListener`.

**Description:** Listener opens up to 20 SSE streams (recent-peers
cap).  Browsers limit 6 concurrent connections per origin on
HTTP/1.1.  On HTTP/1.1 deployments most streams queue
indefinitely; cross-page trade-status feature silently fails for
most peers.

**Recommended fix (immediate):** Cap listener at 5 most-recent
peers.  Document HTTP/2 as deployment requirement in
`docs/OPERATIONS.md`.

**Recommended fix (architectural):** Indexer-side single global
stream `/v1/chat/<me>/all/stream` that delivers events for any
peer of `me`.  Eliminates fan-out entirely.  Larger refactor;
defer to post-launch.

---

### F-41 — Verifier not cross-page — MEDIUM, design gap

**Status:** [x] **fixed (2026-04-27)** — extracted the verifier
trigger into a centralized module and wired it from every entry
point.

Changes:
- New module `apps/web/src/lib/trades/tradeVerify.ts` with
  `triggerBlurtVerification(args)`.  Reads the F-40 engagement
  gate (engagedPeer === sender → use stored memo; else fall
  back to echoed memo), runs the verifier, writes the result to
  the store via `recordVerification`.
- Listener (`tradeEventListener.ts`) calls the trigger after
  `recordFundsSent` for every incoming BLURT funds-sent
  payload.  Verification now fires regardless of which page
  the user is on.
- chatService merge layer also calls the trigger after
  `recordFundsSent`.  Idempotent with the listener via the
  cache + first-wins semantics.
- `ChatMessage.svelte`'s `$effect` refactored: when the
  funds-sent payload has an `orderPermlink`, delegate to
  `triggerBlurtVerification` (single source of truth).  When
  there's no permlink, fall back to the legacy direct-verify
  path with component-local result state (rare — pre-Phase-F.5
  payloads or hand-crafted ones).

The cross-page promise of Phase F.5 is now fully realized:
state propagates AND state computation (verification) fires
regardless of user navigation.  PaymentStatusBadge auto-flips
from "Payment pending" to "✓ Paid" within seconds of the
funds-sent landing — no chat-page visit required.

Frontend typecheck 0 errors.  All 543 smoke scenarios stable
(118 in F-relevant runners: 65 chat-payload + 23 chat-blurt-
verify + 30 trade-status, plus the rest).

**Where:** Verifier `$effect` in `ChatMessage.svelte`.

**Description:** The on-chain BLURT verifier runs only when
ChatMessage is mounted (component-scoped `$effect`).  If a user
never visits the chat page after a funds-sent payload arrives,
the verifier never runs and the badge stays at blue
"Payment pending" indefinitely.

The cross-page promise of Phase F.5 (badge updates without
visiting chat) is incomplete: state PROPAGATES cross-page but
state COMPUTATION (the verifier) is gated behind chat-page mount.

**Recommended fix:** Move the verifier trigger to the listener
(or chatService merge) so verification fires immediately on
funds-sent arrival regardless of which page the user is on.
ChatMessage retains its own trigger as a fallback for the case
where the listener isn't running (e.g., the chat page is open but
the listener was stopped during lock-unlock cycle).

---

### F-45 — Translation quality for fa/zh-CN/zh-HK/ru/pl — MEDIUM, i18n

**Status:** [ ] open

**Description:** Phase F.5 added 9 trade_status keys + 1
toast.view_action key × 10 locales.  Translations for fa, zh-CN,
zh-HK, ru, pl were generated mechanically.  Some are awkward
(ru "Адрес отправлен" = "Address sent" not "shared").

**Recommended fix:** Native-speaker review for the 5 affected
locales before user launch.  Scope: just the new
`trade_status.*` namespace + `toast.view_action`.  Other locales
(en, es, fr, de, it) reviewed during F.5 development; OK.

---

## Findings — LOW–MEDIUM severity

### F-18 — Active key alive during broadcast network roundtrip — LOW–MEDIUM

**Status:** [x] **fixed (2026-04-27)** — split each broadcast operation into three phases:

1. **prepare** (async, no key) — `prepareUnsignedTransfer`, `prepareUnsignedOrderWithFee` fetch ref-block info and assemble the unsigned Transaction.
2. **sign** (pure sync, ~10ms) — `signTransferWithKey`, `signOrderWithFeeWithKey` take the unsigned Transaction + raw active scalar and return a SignedTransaction.  Caller invokes from inside a `runWithActiveKey` / `useActiveKey` closure so the active key is wiped immediately after.
3. **broadcast** (async, network only) — `broadcastSignedTransaction` takes a pre-signed transaction and broadcasts.  No keys in scope.

The legacy `broadcastTransfer` and `broadcastOrderWithFee` functions, which held the active key alive for the full network roundtrip (200-2000ms), have been removed.

Higher-level operations (`broadcastNewOrder`, `broadcastStrangerFee`, `broadcastFeatureBid`) now take a `signCallback: (tx) => SignedTransaction` parameter instead of `activePriv: Uint8Array`.  Callers wrap `runWithActiveKey` / `useActiveKey` around the construction of the callback so the active key only lives during the synchronous sign.

Migrated call sites:
- `PayBlurtModal.svelte` (chat pay-now flow → broadcastSignedTransaction direct)
- `routes/post/+page.svelte` (BLURT-fee order broadcast)
- `StrangerFeeModal.svelte` (stranger-fee payment)
- `FeatureBidForm.svelte` (featured-slot bid)

dblurt's `Client.signTransaction` is non-mutating: returns a deep-copy with appended signature.  `SignedTransaction` holds only signature strings, no key references — safe to carry past the wipe.

Active-key heap-resident window reduced from ~200-2000ms (network roundtrip) to ~10ms (signing only).  Frontend typecheck 0 errors; 614/614 smokes stable across 3 runs.

**Where:** `broadcastTransfer`, `broadcastOrderWithFee`,
`broadcastCustomJson` in `sign.ts`.

**Description:** Active-key scalar remains in heap for the
duration of `broadcast_transaction_synchronous`'s network
roundtrip (~200-2000ms).  Could be reduced to signing-only window
(~10ms) by restructuring: sign inside `useActiveKey`, broadcast
outside.

dblurt's `signTransaction` is non-mutating (returns deep-copy
with signature appended); the SignedTransaction holds only
signature strings, no key references.  Restructure is safe.

**Recommended fix:** Refactor the broadcast-with-active-key
pattern: sign inside `useActiveKey` callback, return the signed
tx, broadcast outside.  Apply to all three broadcast helpers.
Pattern-wide change.

---

### F-23 — Ambient decryption privacy posture — LOW–MEDIUM

**Status:** [x] **fixed (2026-04-27)** — added a separate opt-out toggle distinct from `tradeNotificationsEnabled` (which only gates OS-level notifications).  New module `lib/notifications/crossPageTradeEvents.ts` exposes `crossPageTradeEventsEnabled` (Readable), `enableCrossPageTradeEvents`, `disableCrossPageTradeEvents`.  Layout `$effect` for the listener now gated on the store: when off, listener fully torn down (no streams open, no ambient decryption).  Default ON since cross-page UX value is high; privacy-conscious users opt out via Settings.  3 new i18n keys under `settings.privacy.*` × 10 locales (1478 total, 0 drift).  New section card in NotificationSettings.svelte renders the toggle.

**Where:** Listener decrypts every chat message across all recent
peers.

**Description:** Listener decrypts every incoming chat message
just to check for structured payloads.  Plaintext briefly
resident in memory for messages the user never reads from the
chat page.  Implicit privacy tradeoff that's undocumented.

**Recommended fix:** Document explicitly in design docs.  Offer
opt-out toggle (Settings) for users who want to disable cross-
page trade events in exchange for less ambient decryption.  Pair
with the `tradeNotificationsEnabled` setting that already exists.

---

### F-30 — handleAppend writes survive lock — LOW–MEDIUM

**Status:** [x] **fixed (2026-04-27)** — added post-decrypt
re-check in `handleAppend`.

After the `await tryDecrypt(rec)` async gap, the function now
checks `me !== null` AND `streams.has(peer)` before any store
write.  If explicit lock fired during the ~1ms decrypt window
(clearing `me` and the trade-status store) OR the stream was
otherwise closed, the function aborts cleanly.

Without this guard, a post-lock recordFundsSent could leak a
fresh trade-status entry that the explicit-lock contract
promised to wipe — privacy class violation.

Frontend typecheck 0 errors.  All 553 smoke scenarios stable.

**Where:** `tradeEventListener.ts` `handleAppend`.

**Description:** `handleAppend` can complete a write to
tradeStatus store AFTER `stopTradeEventListener` has fired and
even after `clearAllTradeStates` has run during a lock.  A single
trade-state entry can survive the lock when it shouldn't.
Privacy class violation (recentPeers/readState are wiped; this
entry leaks).

**Recommended fix:** At the top of `handleAppend`, after the
seenIds check, also verify `streams.has(peer)` AND `me !== null`.
If stream was closed during decrypt, abort before writing.

---

### F-43 — Navigate-away during pay-now loses receipt — LOW–MEDIUM

**Status:** [x] **fixed (2026-04-27)** — both fallback paths in
`handlePaidBlurt` now record to the trade-status store and
surface the txid in the toast.

Changes in `ConversationView.svelte`:
- Added `recordFundsSent` import.
- Refactored `handlePaidBlurt`: ALWAYS records the funds-sent
  in the trade-status store (when `orderPermlink` is present)
  before attempting the chat broadcast.  The store mutator is
  idempotent — when the broadcast succeeds, chatService's merge
  won't overwrite (incoming would be dropped by F-40 lock if
  it ever arrived from elsewhere; outgoing path already wrote).
- Both fallback toasts (controller-null and sendMessage-failed)
  now use the new key `chat.pay_blurt.success_toast_no_chat_with_txid`
  with `{txid}` placeholder.  User sees the full txid in the
  toast for copy-paste convenience.
- Removed the old `success_toast_no_chat` references (still in
  the i18n bundles for backward-compat, but no callers).

i18n: 1 new key × 10 locales (1470 total, 0 drift).

The on-chain transfer is settled, the trade-status store now
reflects the buyer-side intent, and the user has the txid in
the toast for manual recovery if they need to post the receipt
later.  Combined with F-19 (txid in fallback toast — same
finding, same fix) the navigate-away gap is closed.

Frontend typecheck 0 errors.  All 553 smoke scenarios stable.

**Where:** `ConversationView.svelte` `handlePaidBlurt`.

**Description:** If user navigates away (browser back, etc.)
between Pay-now broadcast and the auto-funds-sent post,
`controller` is null when handlePaidBlurt resolves → the funds-
sent payload never broadcasts.  Combined with F-19 (no txid in
fallback toast), manual recovery requires the user to find the
txid in their wallet.

**Recommended fix:** Surface the txid prominently in the
fallback toast for copy-paste convenience.  At minimum: change
the toast message from generic "couldn't post receipt" to "BLURT
sent (txid: abc...). Mark funds sent manually if you'd like."

Future polish: detect navigation-during-pay and either block
(browser will warn) or queue the funds-sent broadcast on a
session-level service that survives navigation.

---

## Findings — LOW severity

### F-1 — `note` field charset filter missing — LOW

**Status:** [x] **fixed (2026-04-27)** — `noteHasForbiddenChars` filter added next to existing constants in `payload.ts`.  Encoder throws on bidi overrides (U+202A-E, U+2066-9), C0 controls, DEL.  Decoder returns null → plaintext fallback.  Both encoders + both decoders updated.  6 new scenarios cover RLO rejection, newline rejection, legitimate Unicode (Cyrillic+emoji), forbidden chars in wire → plaintext, DEL on funds_sent, ZWJ allowed.  ZWJ deliberately preserved — legitimate in many scripts.

**Where:** `payload.ts` encoder + decoder.

**Description:** `note` field has length-only check (≤100), no
charset restriction.  Allows newlines, control chars, RTL
override marks, ZWJ, combining marks.  Svelte auto-escape
prevents XSS but visual spoofing within the text remains.

**Recommended fix:** Filter on encode (reject) and decode (return
null for plaintext fallback): control chars (≤0x20 except space,
plus 0x7F), bidi controls (U+202A-202E, U+2066-2069), unassigned
codepoints.

---

### F-2 — Decoder for v:1 + unknown kind falls to plaintext — LOW

**Status:** [x] **fixed (2026-04-27)** — added `unknown_kind` discriminant to `DecodeResult`.  Decoder returns `{ kind: 'unknown_kind', name }` when `o.v === 1` and `o.kind` starts with `morphit_` but isn't recognized.  ChatMessage.svelte renders unknown_kind same as unknown_version (italic "this message uses a newer protocol — please update").  Old test that asserted plaintext-fallback updated.  4 new scenarios.

**Where:** `payload.ts` `decodePayload` line 393.

**Description:** Decoder returns `plaintext` for v:1 messages
with unknown `kind`, rather than `unknown_version` or
`unknown_kind`.  Future protocol additions of new kinds at v:1
(e.g. `morphit_dispute`) won't surface "old client, please
update."

**Recommended fix:** Add a new `unknown_kind` discriminant.  When
`o.v === 1 && typeof o.kind === 'string' && o.kind.startsWith('morphit_')`,
return `{ kind: 'unknown_kind', name: o.kind }`.  ChatMessage
renders unknown_kind similarly to unknown_version.

---

### F-3 — `memo` field on non-BLURT methods accepted — LOW

**Status:** [x] **fixed (2026-04-27)** — encoder rejects `memo` on non-BLURT methods (throws).  Decoder treats memo on non-BLURT as shape failure (returns null, falls to plaintext).  Both encoders + both decoders updated.  4 new scenarios: BTC + memo encoder rejects, XMR + memo encoder rejects, BTC + memo decoder plaintext, BLURT memo positive case.

**Where:** `payload.ts` encoder + decoder.

**Description:** Encoder + decoder accept `memo` on btc/xmr
methods even though memo is BLURT-only by design.  Cross-method
state pollution theoretically possible.

**Recommended fix:** Encoder rejects `memo` set on non-BLURT
methods.  Decoder treats memo on non-BLURT as shape failure
(returns null for plaintext fallback).

---

### F-4 — Leading zeros in amount strings — VERY LOW

**Status:** [partial] BLURT amounts incidentally normalized via
F-8 (Math.ceil + toFixed strips leading zeros).  BTC/XMR amount
leading-zeros remain — defer to launch prep, low priority.

**Where:** `payload.ts` `AMOUNT_RE`.

**Description:** AMOUNT_RE permits `"0001.000"`.  Wire output
passes verbatim.  Wallet UIs may render the literal string ugly.

**Recommended fix:** Canonicalize on encode (parseFloat then
format).

---

### F-5 — Decoder uses `'amount' in o` (prototype-chain) — VERY LOW

**Status:** [x] **fixed (2026-04-27)** — replaced `'X' in o` with `Object.hasOwn(o, 'X')` across all 8 sites in `payload.ts` (4 in optionalFieldsAddress, 4 in optionalFieldsFundsSent).  Defense-in-depth: prototype-chain phantoms can't produce false-positive field detection.  1 new smoke scenario asserts a JSON-decoded payload doesn't see `note` from prototype.

**Where:** `payload.ts` `optionalFieldsAddress` /
`optionalFieldsFundsSent`.

**Description:** `'amount' in o` traverses prototype chain.
Defense-in-depth: prefer `Object.hasOwn(o, 'amount')`.

**Recommended fix:** Replace `in` with `Object.hasOwn`.

---

### F-6 — Encoder emits empty-string optional fields — VERY LOW

**Status:** [x] **fixed (2026-04-27)** — encoders now skip empty-string optionals (`note: ''`, `memo: ''`, `amount: ''`, `orderPermlink: ''`).  Saves ~11 chars per omitted field of plaintext budget in encrypted payloads.  Validation regexes (MEMO_RE, AMOUNT_RE, ORDER_PERMLINK_RE) also skip on empty so callers can pass `''` interchangeably with `undefined`.  4 new smoke scenarios cover note, memo, funds_sent, and non-empty positive case.

**Where:** `payload.ts` encoders.

**Description:** Encoder emits `note: ""` etc. rather than
skipping.  Wastes ~11 chars of plaintext budget.

**Recommended fix:** Coerce `''` → undefined / not-emit on
encode.

---

### F-9 — Empty-memo case treats any chain memo as mismatch — LOW

**Status:** [x] **fixed (2026-04-27)** — `compareTransferToExpect` skips memo comparison when `expect.memo === ''`.  Asymmetric: when seller pinned a memo and buyer omitted, still mismatch.  2 new scenarios.

**Where:** `blurtVerify.ts` line 209.

**Description:** When seller's `expect.memo === ''` (no memo
requested), the verifier flags any non-empty chain memo as
mismatch.  But buyer adding their own accounting memo shouldn't
fail verification when the seller didn't ask for one.

**Recommended fix:** When `expect.memo === ''`, accept any chain
memo as verified.  The case where seller requested a memo and
buyer omitted remains a mismatch (different direction).

---

### F-10 — `not_found` regex over-matches — LOW

**Status:** [x] **fixed (2026-04-27)** — extracted `classifyRpcError` pure helper.  Tighter heuristic: requires BOTH a chain-object word (transaction/trx/hash) AND an absence word (not found / find / exist / unknown / missing / no such).  Generic network errors like "host not found" no longer misclassified as not_found.  12 new scenarios cover real Blurt-RPC error patterns + DNS/network exclusions.

**Where:** `blurtVerify.ts` line 134.

**Description:** Regex `/not\s*found|unknown.*trans|missing.*trans/i`
catches generic "not found" phrasings (network errors, missing
nodes) and misclassifies as `not_found` (tx-not-on-chain).
Misleading UX.

**Recommended fix:** Tighten to specific patterns observed in
actual Blurt node responses.  Or simplify: collapse not_found and
rpc_error into a single "could not verify" UX since the user-
visible distinction is small.

---

### F-12 — Dynamic import type cast shadows TS — LOW

**Status:** [x] **fixed (2026-04-27)** — dynamic import now uses `typeof import('$blurt/client')` to derive the type from the real module.  Hand-written cast removed.  Future signature drift in `getBlurtClient` would now produce a typecheck error rather than silent runtime mismatch.

**Where:** `blurtVerify.ts` lines 117-121.

**Description:** Hardcoded type cast on `await import('$blurt/client')`.
If client signature changes, code calls wrong shape silently.

**Recommended fix:** `import type { ... }` for type info,
dynamic import for value.

---

### F-13 — Verifier doesn't validate `expect.amountBlurt` — LOW

**Status:** [x] **fixed (2026-04-27)** — `verifyBlurtTransferAgainstTx` returns mismatch:amount when `expect.amountBlurt` is NaN/Infinity/0/negative.  4 new scenarios.

**Where:** `blurtVerify.ts` `verifyBlurtTransferAgainstTx`.

**Description:** Function trusts caller's `amountBlurt`.  If
upstream bug passes NaN/Infinity, `Math.abs(actualAmount - NaN) =
NaN`, `NaN > 0.0005` is false → verifier falsely returns
verified.

**Recommended fix:** Add `if (!Number.isFinite(expect.amountBlurt) || expect.amountBlurt <= 0) return { kind: 'mismatch', field: 'amount' };`
at function entry.

---

### F-15 — broadcastTransfer no account-name validation — LOW

**Status:** [x] **fixed (2026-04-27)** — `BROADCAST_ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/` checked at function entry for both `from` and `to`.

**Where:** `sign.ts` `broadcastTransfer` lines 264-265.

**Description:** Truthy-only check on `from`/`to`.  Defense-in-
depth gap; current callers validate but future callers may not.

**Recommended fix:** Apply BLURT_ACCOUNT_RE at function entry.

---

### F-16 — broadcastTransfer no amount validation — LOW

**Status:** [x] **fixed (2026-04-27)** — `BROADCAST_AMOUNT_RE` (matches `<digits>.<3-digits> BLURT`) checked at function entry.  Caller sees a clear error message instead of a confusing chain-rejection downstream.

**Where:** `sign.ts` `broadcastTransfer`.

**Description:** Amount string passed through with no validation.

**Recommended fix:** Regex `/^\d+\.\d{3}\s+BLURT$/` at entry.

---

(F-17 dropped — see notes.)

### F-19 — txid lost in fallback toast — LOW

**Status:** [x] **fixed (2026-04-27)** — closed by F-43.  Both
fallback paths in `handlePaidBlurt` now embed the full txid in
the toast message via the
`chat.pay_blurt.success_toast_no_chat_with_txid` i18n key.

---

### F-20 — `ref_block_prefix` uint32 conversion bug-shape — LOW, latent, pre-existing

**Status:** [x] **fixed (2026-04-27)** — outer parens around the OR-combine ensure `>>> 0` applies to the FINAL value, not just the last shift.  Operator precedence trap closed.

**Where:** `sign.ts` `getRefBlockInfo`.

**Description:** `(D << 24) >>> 0` — the `>>> 0` only applies to
the last shift; surrounding `|` operations re-convert to int32.
Result can be negative.  May not currently misbehave (Graphene's
int parsing tolerant) but is correctness-fragile.

Pre-existing from Phase B, surfaced in audit.

**Recommended fix:** Wrap whole expression: `((A | (B << 8) | (C << 16) | (D << 24)) >>> 0)`.

---

### F-22 — `seenIds` set per stream unbounded — LOW

**Status:** [x] **fixed (2026-04-27)** — `MAX_SEEN_IDS = 100`
constant + `addSeenId()` helper.  When cap hit, evicts the
oldest entry (Sets preserve insertion order in JS; iterator's
first value is oldest).  Memory bounded at ~4KB total across
5 streams × 100 IDs × 8 bytes.

100 chosen because the snapshot is 50 IDs and live arrivals
append; 2× headroom prevents reconnect-replay from colliding
with the cap.

**Where:** `tradeEventListener.ts`.

**Description:** seenIds Set per stream grows unbounded.  ~800KB
per stream at 10K entries.  Snapshot is 50 IDs; only need to
retain that many for dedup.

**Recommended fix:** Cap seenIds to 100 most-recent IDs.  Use a
small ring or evict-oldest pattern.

---

### F-24 — Lock-during-decrypt race — VERY LOW

**Status:** [x] **accepted (2026-04-27)** — risk is vanishingly low (~1ms decrypt window with active session-lock).  Worst case is a single garbage decrypt that returns null silently.  No symptom observed in practice.  Documented for completeness; will revisit if a real-world report surfaces.

**Where:** `tryDecrypt` reads `liveIdentity` at function entry.

**Description:** Live identity keys can be zeroed by lockSession
mid-flight.  Worst case: garbage decrypt → silent miss.

**Recommended fix:** Note for completeness only.  Risk vanishingly
low; no action needed unless a real symptom appears.

---

### F-25 — tryDecrypt swallows non-DecryptError silently — LOW

**Status:** [x] **fixed (2026-04-27)** — non-`DecryptError`
exceptions in `tryDecrypt` now log a `console.warn` with the
error class name (PII-safe; no rec contents).  Listener stays
best-effort: returns null after warning so caller continues.

**Where:** `tryDecrypt` catch block.

**Description:** All non-DecryptError exceptions swallowed.
Listener bugs surface as silent inaction.

**Recommended fix:** `console.warn` for unexpected errors with
PII-safe message.  Don't surface to user (best-effort design
intentional).

---

### F-26 — Listener doesn't validate `rec.sender` regex — LOW

**Status:** [x] **fixed (2026-04-27)** — `handleAppend` now calls
`isValidBlurtAccount(rec.sender)` near the top and bails on
mismatch.  Defense-in-depth — indexer-side validation already
catches malformed names, but a slipped-through value would
corrupt store keys and deep-links.

**Where:** `handleAppend`.

**Description:** Trusts indexer-supplied sender field without
re-validating account regex.  SvelteKit route matcher catches
malformed names at deep-link resolution but defense-in-depth
gap.

**Recommended fix:** `if (!ACCOUNT_NAME_RE.test(rec.sender)) return;`
near top of handleAppend.

---

### F-27 — Toast/notification text hard-coded English — LOW, i18n debt

**Status:** [x] **fixed (2026-04-27)** — listener now uses
`get(_)` from svelte-i18n with 5 new keys under
`chat.trade_event.*`:

- `address_shared_title` — browser-notification title
- `address_shared_body` — toast + notification body, placeholders
  `{peer}`, `{method}`, `{orderPermlink}`
- `funds_sent_title` — browser-notification title with `{peer}`
- `funds_sent_body_with_amount` — when payload includes amount
- `funds_sent_body` — when payload omits amount

5 keys × 10 locales = 50 translations.  i18n parity stable at
1475 keys, 0 drift.

**Where:** `tradeEventListener.ts` toast body + browser
notification title/body strings.

**Description:** Strings like "alice paid X BLURT for trade Y"
are hard-coded English.  Other locales see English toasts.

**Recommended fix:** Add i18n keys for toast bodies (separate
namespace from `trade_status` badges) and browser-notification
text.  Propagate translations across all 10 locales.

---

### F-28 — Toast body length wrapping — LOW

**Status:** [x] **fixed (2026-04-27)** — listener truncates orderPermlink at 22 chars (19 + ellipsis) for the visible toast/notification body.  Deep-link URL still uses the full permlink so navigation works for any length.  Toasts stay readable in narrow viewports.

**Description:** Toast body for long order permlinks (256 chars
max) wraps to 5+ lines.  Visual clutter.

**Recommended fix:** Truncate orderPermlink in visible toast
("...trade-abc123" with ellipsis); full permlink in deep-link
target.  Or use simpler body text without permlink.

---

### F-29 — `refreshTradeEventListener` never called — LOW

**Status:** [x] **fixed (2026-04-27)** — `recordRecentPeer` dispatches `CustomEvent('morphit:recent-peers-changed')` after writing.  Layout subscribes inside the listener `$effect` and calls `refreshTradeEventListener` on event.  Cleanup removes listener on lock.  Decoupled approach — recentPeers doesn't import the listener; communication via window event.

**Where:** `tradeEventListener.ts` exported but no caller.

**Description:** New chats started mid-session not picked up by
listener until next lock/unlock cycle.

**Recommended fix:** Make recentPeers a reactive Svelte store
and subscribe to its changes from layout, calling
`refreshTradeEventListener` on update.

---

### F-31 — Browser notification tag coalescing — LOW

**Status:** [x] **fixed (2026-04-27)** — `maybeBrowserNotify` takes an `orderPermlink` argument and uses `tag: morphit-trade-<permlink>`.  Different trades produce separate notifications.  Same-trade updates (address-shared → funds-sent) still coalesce, which is desirable.

**Where:** `maybeBrowserNotify` `tag: 'morphit-trade'`.

**Description:** All trade notifications share a fixed tag.
Multiple events coalesce — only most recent visible.

**Recommended fix:** `tag: 'morphit-trade-${orderPermlink}'` so
different trades get separate notifications, but updates to the
same trade collapse.

---

### F-32 — No smoke coverage for listener — LOW, test debt

**Status:** [x] **fixed (2026-04-27)** — extracted post-decode routing logic into a pure `planListenerDispatch` function in `lib/trades/listenerDispatch.ts`.  Takes a decoded payload + context (sender, me, currentPathname) and returns a `ListenerDispatchPlan` describing three orthogonal effects: store mutation, BLURT verification trigger, notification intent.  `handleAppend` is now a thin wrapper: decrypt → plan → apply.  New smoke runner `listener-dispatch-smoke` covers 24 scenarios: empty-plan paths (plaintext, unknown_version, unknown_kind, missing permlink), store effect shape (address vs funds_sent), verify effect (BLURT funds_sent only with valid amount), notify effect (i18n keys, toast kind, tag), F-38 same-page suppression (exact path, sub-route, lookalike defense), F-28 truncation, F-31 tag scoping, deep-link encoding, method uppercasing, empty-pathname handling.  Registered in run-smokes.sh between trade-status and profile-handler.

**Description:** tradeEventListener has no smoke tests.  Pure
routing/dedup logic is testable.

**Recommended fix:** Extract pure dispatch (taking decoded
payload + state, returning store mutation + toast intent) into
a separate module.  Smoke-test:
- handleAppend dedup (same id twice → second no-ops)
- non-structured plaintext → no toast
- structured payload but no orderPermlink → no toast
- lock-race → drops cleanly

---

### F-33 — Toast href no scheme validation — LOW

**Status:** [x] **fixed (2026-04-27)** — `showToast` now
validates `options.href` at the entry point.  Allowed schemes:
paths starting with `/` (in-app navigation), explicit `https://`
URLs.  Anything else (javascript:, data:, vbscript:, etc.) is
silently dropped with a `console.warn`.  Toast still renders
without the href; the message text remains visible.

Defensive boundary at the API entry so callers passing arbitrary
strings (e.g. derived from chat content in a future feature)
can't introduce XSS via toast.

**Where:** `ToastRegion.svelte` binds `href={toast.href}`
without sanitization.

**Description:** If a future caller passes
`href: 'javascript:alert(1)'`, click would execute.  Currently
all callers construct safe URLs but the toast surface doesn't
enforce.

**Recommended fix:** `showToast` validates `options.href`
starts with `/` or `https://`.  Reject (or throw in dev)
otherwise.

---

### F-34 — "View →" announced as part of link text — LOW, accessibility

**Status:** [x] **fixed (2026-04-27)** — moved arrow into a separate span with `aria-hidden="true"` and CSS-driven content via `::after`.  Screen readers now announce only the action label ("View"), not the decorative arrow.

**Where:** `ToastRegion.svelte` clickable variant.

**Description:** "View →" inside `<a>` is read by screen readers
as part of the link text.

**Recommended fix:** `aria-hidden="true"` on the View span.
Optionally clearer aria-label on the link.

---

### F-35 — Toast auto-dismiss too short for keyboard users — LOW, accessibility

**Status:** [x] **fixed (2026-04-27)** — `showToast` extends timeout by 6s when `safeHref` is set.  Default 4s for info/success becomes 10s when the toast has an action link.  Keyboard users have time to Tab to the link before auto-dismiss.  Explicit `options.timeout` still overrides.

**Description:** 4s timeout (info/success) may not give keyboard
users time to Tab-reach the link.

**Recommended fix:** Pause-on-focus (cancel dismiss timer when
toast or its action gains focus).  Or extend timeout to 10s when
href is set.

---

### F-36 — RTL arrow direction hardcoded LTR — LOW, RTL

**Status:** [x] **fixed (2026-04-27)** — `.toast-arrow:dir(rtl)::after { content: "←" }` flips the arrow for RTL locales (Persian).  CSS-driven so no per-locale i18n duplication.  Modern browsers support `:dir()`; older browsers gracefully degrade to LTR arrow.

**Description:** "→" in "View →" hardcoded LTR.  Persian users
see wrong direction.

**Recommended fix:** Use logical arrow via i18n-localized
character, or CSS pseudo-content with `dir`-aware content.

---

### F-37 — Toast no pause-on-hover — LOW, UX, not F.5-specific

**Status:** [x] **fixed (post-F.5, task #6, 2026-04-28)** —
toast store now exposes `pauseToast` / `resumeToast`.
ToastRegion calls them on `pointerenter` / `pointerleave` and
on `focusin` / `focusout` (so keyboard users tabbing into the
toast also pause it).  Remaining-time math floors at 1s so a
hover-and-leave with <1s left doesn't dismiss instantly.

---

### F-38 — Toast fires on active-chat page — LOW, UX

**Status:** [x] **fixed (2026-04-27)** — listener checks `window.location.pathname` against `/chat/<rec.sender>` after the store-write block; bails before the toast/notify section if matched.  Store update still happens for /my/orders + other surfaces.

**Description:** Listener fires toast even when user is on
matching `/chat/<peer>` page.  Double-notification (inline pill +
toast).

**Recommended fix:** Check `window.location.pathname` against
`/chat/<rec.sender>` and skip toast in that case.  Store update
still happens.

---

### F-39 — `tradeState(permlink)` per-call derived store — LOW, perf-correctness

**Status:** [x] **fixed (2026-04-27)** — removed the `tradeState(permlink)` helper.  PaymentStatusBadge and ChatMessage now read directly from `$tradeStates.get(permlink)` inside `$derived` blocks.  No more per-instance derived-store allocation; one subscription on the underlying map drives all consumers.  `derived` import dropped from `tradeStatus.ts`.

**Description:** Each call creates a new derived store.  N orders
on /my/orders → N deriveds subscribe to `_states`.  Wasteful at
scale.

**Recommended fix:** Remove `tradeState()` helper.  Consumers do
`$tradeStates.get(permlink)` directly.  PaymentStatusBadge
updated accordingly.

---

### F-42 — `phaseForVerify` unknown VerifyResult kind not tested — LOW, test debt

**Status:** [x] **fixed (2026-04-27)** — added forward-compat scenario in `trade-status-smoke` asserting that an unknown future VerifyResult kind falls through to `paid_unverifiable`.  31 scenarios passing.

**Description:** Future VerifyResult kind would fall through to
`paid_unverifiable` default, but no test asserts.

**Recommended fix:** Add scenario in trade-status-smoke.

---

### F-44 — `verifyCache` not cleared on lock — LOW, privacy

**Status:** [x] **fixed (2026-04-27)** — `runExplicitLockExtras`
now calls `_clearVerifyCache()` alongside `clearAllTradeStates()`.

The verifier's module-level cache held
`(txid, recipient, sender, amount, memo) → result` tuples for
every BLURT verification done this session.  Inspectable via
debugger / JS console after lock.  Same privacy class as
`recentPeers`, `readState`, `pubPins`, and `tradeStates` — all
of which are wiped by explicit lock.

Frontend typecheck 0 errors.  All 553 smoke scenarios stable.

**Where:** `blurtVerify.ts` module-level Map.

**Description:** Cache holds {txid, recipient, sender, amount,
memo} → result for the session.  Reveals trade activity by
inspection.  Same privacy class as recentPeers / readState.

**Recommended fix:** Add `_clearVerifyCache()` call to
`runExplicitLockExtras`.

---

### F-46 — PaymentStatusBadge `role="alert"` persistent — LOW, accessibility

**Status:** [x] **fixed (2026-04-27)** — dropped `role="alert"` from `paid_mismatch` and `disputed` badges, dropped `role="status"` from `paid_verified`.  Persistent state badges no longer trigger redundant screen-reader announcements on every render.  Screen readers announce naturally when focus passes through the badge.

**Where:** `PaymentStatusBadge.svelte`.

**Description:** Uses `role="alert"` on persistent state badges
(mismatch, disputed).  Causes redundant screen-reader
announcements on every render.

**Recommended fix:** Drop `role="alert"` from badges (they're
persistent state, not transient alerts).  Keep `role="status"`
on verified.  If transition announcement is desired, add a
separate aria-live region keyed off store transitions.

---

## Note on F-17 (skipped)

Initially considered: enforce `MEMO_RE` on `broadcastTransfer`'s
memo parameter to prevent off-spec memo content.  Dropped because
this would constrain legitimate non-Morphit uses of the function
— a future caller might want to transfer with a free-form memo
("Birthday gift!") which isn't memo-shaped.  The chain itself
caps memo length; that's the right boundary.

## Recap: structural lesson

Phase F.4/F.5 traded audit-rigor for shipping speed.  The HIGH
and MEDIUM findings are predominantly "what if the world isn't
friendly" questions that were deprioritized:

- F-7: "What if there are MULTIPLE transfers in the tx?"
- F-40: "What if a third party sends payloads claiming this
  orderPermlink?"
- F-8: "What if amounts have precision the chain can't represent?"
- F-41: "What if the user never opens the chat?"
- F-21: "What if the browser limits 6 connections?"
- F-14: "What if a buyer typos their wallet address?"

For pre-launch, every new feature gets an explicit threat-modeling
exercise: not just "does it work in the happy path" but
systematically "what's the worst a malicious actor / unfortunate
edge case can do."

## Fix order

Recommended sequence:

1. **F-7** verifier multi-transfer (HIGH)
2. **F-40** store poisoning (HIGH)
3. **F-41** verifier not cross-page (MEDIUM, design gap)
4. **F-14** buyer-side verification (MEDIUM, design)
5. **F-8** amount precision (MEDIUM)
6. **F-21** SSE connection ceiling (MEDIUM)
7. **F-45** translation review (MEDIUM, requires native speakers)
8. **F-11** document single-RPC trust (MEDIUM, doc-only)
9. LOW–MEDIUM batch (F-18, F-23, F-30, F-43)
10. LOW selection (privacy/security: F-44, F-26, F-33, F-25, F-1, F-2, F-3, F-9, F-10, F-13)
11. LOW remainder (UX/perf/test debt)

Items marked `[ ] backlog` are deferred to post-launch.
