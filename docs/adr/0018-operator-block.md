# ADR-0018: Operator-instance blocks and the honest-and-narrow notification

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** Agorise team (Claude collaborating)
**Supersedes:** —
**Related:**
- ADR-0013 (operator incentives) — defines the operator role and the
  per-instance moderation surface this ADR adds an op type to.
- ADR-0008 (Phase 3b indexer architecture) — handler / dispatcher
  contract this ADR's handler conforms to.
- ADR-0010 (key custody) — defines the trust-anchor pubkey model;
  this ADR's operator-account gate uses the same configured
  `officialAccountName`.

## Context

Morphit's per-user moderation today is two-tiered:

- **Per-user, per-browser**: `hiddenAccounts` (localStorage). "I don't
  want to see X here." Local. Reversible.
- **Per-user, chain-broadcast**: `blockedAccounts` (`morphit_block_v1`
  op signed by the user). "X has blocked me from messaging them;
  symmetrically I hide them too." On-chain audit trail.

Both are user-driven. Neither lets the **operator** of an instance
filter unwanted content from the orderbook view they serve.

The operator role exists (ADR-0013) and is responsible for the
operator-register op, the listing-fee account, the Featured-bid
revenue stream, and other instance-level concerns. Curation of the
orderbook surface they expose is in scope for the role but had no
ship-ready mechanism. The user asked for one.

The user also explicitly framed the UX requirement: "we don't want
to lose existing users and we certainly don't want to scare away new,
potential users if they think they might get censored. it has to be
very clear to everyone why someone got blocked." Operator-instance
blocks must therefore be transparent, scoped, reversible, and clearly
explained to the affected user — without becoming a punishment vector.

## Decision

### Mechanism: chain op, not indexer-DB-only

Operator broadcasts `morphit_operator_block_v1`, a `custom_json` op
signed by the operator's posting key. Indexer records it in the
`operator_blocks` table. Block / unblock semantics mirror the existing
user-level `morphit_block_v1` handler.

Rejected alternative: `ops-cli` writes directly to the indexer DB
without a chain op. That would make moderation actions invisible to
chain replay and to sibling-instance audit; opaque-to-the-user is
exactly the property we're avoiding. **All operator moderation goes
through the chain.**

### Op shape

```ts
{
  v: 1,
  blocked: <account>,          // valid Blurt account name
  action: "block" | "unblock",
  reason: <string, ≤500 chars>,
  ts: <unix seconds>           // operator-supplied; not authoritative
}
```

- `v: 1` for forward-compat. `unsupported_version` rejection.
- `blocked` validated against the standard Blurt account-name regex.
- `action` constrained; anything else rejected with `action_invalid`.
- `reason` length-capped at 500 UTF-16 code units. Sanitized (see
  below). Empty string is permitted (operator declines to give one)
  but the ops-cli command refuses to broadcast a block without a
  reason — silent operator blocks erode trust, and the CLI is the
  primary tool for issuing them.
- `ts` is informational only. Authoritative timestamps come from the
  chain block; an operator can't backdate by lying in the payload.

### Operator-account gate

The handler refuses any `morphit_operator_block_v1` not signed by
`ctx.config.officialAccountName` (default `'morphit'`, configurable
per-deployment for sibling instances).

```ts
if (ctx.signer !== ctx.config.officialAccountName) {
  return { ok: false, reason: 'not_operator' };
}
```

Rationale: the op is INSTANCE-LEVEL moderation. A user broadcasting
a "morphit_operator_block_v1 alice" doesn't make sense — they aren't
the operator. The handler accepts only the configured operator's
signatures, dropping the rest as `not_operator`. Each indexer
configures its own operator name; sibling instances accept their own
operator's ops, not each other's.

### Reason sanitization

Operator-supplied reasons are stripped of dangerous codepoints
**before storage**. The forbidden set mirrors the existing display-
name stripper at `apps/web/src/lib/crypto/profile.ts`:

- Bidi override / formatting: U+202A–U+202E, U+2066–U+2069
- Zero-width chars: U+200B–U+200D, U+FEFF
- Invisible math/language: U+2060–U+2064
- C0 control chars except LF (0x0A) and TAB (0x09)
- All C1 control chars (0x7F–0x9F)

Why **strip** rather than **reject**: a reason copy-pasted from a
PDF or word-processor doc may incidentally contain zero-widths; we
shouldn't fail the moderation op over a paste accident. Stripping
silently transforms the reason to its safe form. Banner re-strips
on render as a belt-and-braces measure.

Audit finding #10 / #15 in
`docs/audit/2026-04-28-followup-items-1-thru-6.md` documents the
threat model.

### Notification design: "honest-and-narrow"

When a blocked user visits the operator's instance, a banner appears
at the top of every page (mounted in `+layout.svelte`):

> ## You've been blocked on this Morphit instance
>
> @morphit, the operator of this instance, blocked your account on
> 2026-04-28. This is a curation choice by THIS instance — your
> funds, identity, and chain history are unaffected, and other
> Morphit instances are not.
>
> **Reason:** Repeated reports of off-platform payment scams during
> October 2026.
>
> [What does this mean? (show details)]
>
> [Message @morphit]

Expandable detail surfaces the four "what this does NOT do"
guarantees and the one "what this DOES do":

- Does NOT touch your BLURT, BTC, XMR, or any other funds.
- Does NOT follow you to other Morphit instances.
- Does NOT block you at the chain level.
- IS reversible by the operator at any time.
- DOES hide your trade listings from this instance's orderbook view.

Tone is matter-of-fact, not apologetic, not accusatory.

The banner is **private to the affected user** — other viewers of the
same page do not see a "blocked" badge, and account profile pages do
not surface block status to non-blocked viewers. The block is public
on chain (anyone scraping `/v1/operator-blocks/by-operator/morphit`
sees the list), but the surface in the user-facing UI doesn't
spotlight it.

### Cross-instance behavior

Each instance's indexer applies only ITS operator's blocks:

- User blocked on instance A → blocked when visiting A. Banner
  appears.
- Same user visits instance B → B's indexer hasn't seen instance A's
  operator-block op (or has seen it but rejects it under the
  operator-account gate, since instance A's operator isn't instance
  B's `officialAccountName`). No banner. Full functionality.
- Federation directory remains intact; user can sign in on any
  instance and operate there unaffected.

This is the architectural property that makes Morphit's "operator
blocks" tractable from a censorship-resistance standpoint: a single
operator's choice doesn't lock anyone out of the protocol.

### Orderbook filter

A new `operatorBlockedAccounts` store fetches `/v1/operator-blocks/
by-operator/<this-instance's-operator>` once per session. The
orderbook view's `visibleItems` derived value unions this set with
the existing `hiddenAccounts` and `blockedAccounts` sets, filtering
all three out. The transparency toggle (`showHiddenTemporarily`)
reveals all three uniformly.

### ops-cli command

```
morphit-ops operator-block <account> --reason "<text>"
morphit-ops operator-block <account> --unblock
```

- `MORPHIT_OPERATOR_POSTING_KEY_FILE` (preferred) or
  `MORPHIT_RELAY_POSTING_KEY_FILE` (fallback) for the signing key.
  Encrypted-envelope keys prompt for passphrase the same way the
  relay's key file does.
- Refuses to block without a reason; warns and strips dangerous
  codepoints before broadcast (paste-from-malicious-doc detection).
- Confirms the action (`Operator/Action/Target/Reason` summary)
  before signing. Yes/no prompt.
- After successful broadcast, prints the trx_id and explains what
  the blocked user will see when they next visit.

### Idempotency

Mirrors the user-level `morphit_block_v1` handler's state-machine:

- block on no-prior-row → INSERT new row, since_* anchored to this op.
- block on `state='blocked'` row → UPDATE reason only, do NOT move
  `since_*` (preserves audit anchor of when the original block
  started). Operator can amend the stated reason without resetting
  the audit trail.
- block on `state='unblocked'` row → UPDATE state='blocked', MOVE
  since_* to this op (a NEW relationship after a previous
  unblock).
- unblock on `state='blocked'` row → UPDATE state='unblocked',
  KEEP since_* (audit trail of when the original block started
  stays valid).
- unblock on `state='unblocked'` row → idempotent no-op.
- unblock on no-prior-row → REJECT with `no_prior_block` (no state
  to change; client should refetch before retrying).

## Consequences

### Positive

- Operator gets a sanctioned moderation tool with full chain audit
  trail.
- Blocked user gets a clear, friendly explainer instead of silent
  filtering. Trust-establishing rather than trust-destroying.
- Cross-instance escape hatch is preserved — censorship-resistant
  protocol property holds.
- Reversibility is built in (`unblock` action with audit trail
  preserved).
- The reason field gives the operator a way to communicate WHY,
  which the project's "everything visible" ethos requires.
- Bidi/zero-width sanitization defangs the trust-undermining attack
  vectors a malicious operator could otherwise embed in a reason.

### Negative

- An operator with a compromised posting key could spam blocks. RC
  rate-limits the chain side; the indexer accepts whatever the chain
  delivers. Mitigation: operators secure their posting key the same
  way they secure their other keys.
- A 500-char reason cap is opinionated. Operators with longer
  policies must summarize and link out (the reason can include a
  URL).
- The "honest-and-narrow" framing requires translation into all 10
  locales with care; bad translation (especially in RTL languages)
  could undermine the design intent. Reviewed in i18n round.

### Trade-offs explicitly considered

We considered four alternative designs (per the user's ELI5 picker
exercise):

1. **Public transparency** — every block listed publicly with
   reasons. Pros: maximum transparency. Cons: blocked users get
   publicly humiliated; chills legitimate edge cases. **Rejected.**
2. **Auto-redirect to alternate instances** — banner suggests
   sibling instances. Pros: makes censorship-resistance tangible.
   Cons: requires working instance directory; encourages instance-
   shopping. **Rejected for now;** could layer on later.
3. **Appeal-only, no reason given** — minimal explanation, just
   "talk to operator." Cons: feels arbitrary, censorship-y.
   **Rejected.**
4. **Time-boxed with auto-restore** — every block expires. Cons:
   chronic offenders wait it out; chain storage complexity.
   **Rejected.**

The user chose **(1) honest-and-narrow** with explicit fallback to
its core properties: clear notification, private, undoable, with
link to operator.

## Implementation

- Op-id registered: `OP_IDS.operatorBlock = 'morphit_operator_block_v1'`
  in both `apps/web/src/lib/net/config.ts` and
  `apps/indexer/src/indexer/dispatcher.ts`.
- Indexer handler: `apps/indexer/src/indexer/handlers/operatorBlock.ts`.
- DB schema: migration #23, `operator_blocks` table, two indexes.
- Indexer API: `apps/indexer/src/api/operatorBlocks.ts` exposes
  `/v1/operator-blocks/by-blocked/:account` (single-row lookup) and
  `/v1/operator-blocks/by-operator/:operator` (audit listing).
- ops-cli command: `apps/ops-cli/src/commands/operatorBlock.ts`.
- Frontend banner: `apps/web/src/lib/components/OperatorBlockBanner.svelte`
  mounted in `+layout.svelte` so it appears on every page.
- Frontend store: `apps/web/src/lib/stores/operatorBlocks.ts`.
- Frontend client wrappers: `getOperatorBlockByBlocked`,
  `getOperatorBlocksByOperator` in `lib/indexer/client.ts`.
- Smokes: 22 scenarios in `operator-block-handler-smoke.ts` covering
  the operator gate, payload validation, all state-machine
  transitions, unicode + sanitization (3 added in audit pass),
  custom `officialAccountName` config support, sibling-instance
  signature rejection.
- i18n: 14 banner keys × 10 locales = 140 strings, drift = 0.
- Audit doc: `docs/audit/2026-04-28-followup-items-1-thru-6.md`.

## Open questions / future work

- A future "transparency page" could surface
  `/v1/operator-blocks/by-operator` as a public list ("blocks issued
  by this instance's operator"). Not in this batch — design will
  need to balance the operator's accountability against the blocked
  users' dignity. Filed in REVISIT-LIST.md §F.27 area.
- Banner currently lacks a "talk to operator" fallback when the
  operator hasn't published a chat-identity op. Logged as audit
  finding #16 (INFO).
- The 500-char reason cap is a guess. If operators consistently
  hit it, we'll widen.
