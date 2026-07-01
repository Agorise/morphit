# ADR-0001: `custom_json` ops are protocol-immutable; "edits" are layer-2 replacements

**Status:** Accepted
**Date:** 2026-04-17
**Deciders:** project maintainer
**Supersedes:** implicit Phase-1-plan assumption that ops were editable

## Context

Morphit stores every order, feedback, profile update, and chat ciphertext
as a `custom_json` operation on the Blurt blockchain. Early plans assumed
these could be natively edited for a 15-minute window — a UX concession so
users could fix typos after posting.

A Blurt core developer confirmed authoritatively:

> There is no time limit to edit a post or a comment. It's not possible
> to edit a `custom_json` though. `custom_json` payloads are not validated
> at the protocol level. Only the operation structure is checked;
> payload semantics are entirely handled at layer 2.

This invalidates the "native edit" assumption entirely.

Additionally, the original 15-minute window is itself a latent attack
vector: a malicious seller could post favorable terms, wait for a buyer
to start negotiating, then silently worsen the terms while the window is
still open. A shorter window is both more honest about the edit semantics
and a stronger anti-abuse posture.

## Decision

Implement "edits" at **layer 2** by posting a new, signed
`morphit_order_replace_v1` `custom_json` op that references the original
order's `id`. Indexers treat the latest replacement (by signed timestamp,
from the same account) as canonical — but **only if posted within a 3-
minute window** of the original. Replacements posted outside the window
are ignored.

Both the original and the replacement remain on chain forever. History
is auditable.

## Alternatives considered

- **Stay with 15 minutes, re-implement as a layer-2 replacement.** Same
  immutability story, longer abuse window. Rejected — the 15-minute
  figure was a UX guess, not load-bearing. Three minutes handles the
  typo case and closes the bait-and-switch window.

- **No editing at all, cancel-and-repost only.** Cleaner semantically,
  but the UX of "I saw my typo one second after I hit post and now I
  have to pay the fee again" is punishing. Rejected — the 3-minute
  layer-2 window costs nothing because the original op would have to be
  cancelled on-chain either way.

- **Longer window (7 days), heavily UI-warned.** What the core dev was
  describing about Blurt `comment` ops. Rejected for Morphit orders
  specifically — orders move faster than posts; nobody is negotiating a
  trade seven days after it's posted.

## Consequences

### Positive

- Honest alignment with the protocol: we document how `custom_json`
  really works, not how we wished it worked.
- Every edit leaves a full on-chain audit trail.
- The 3-minute window is short enough to eliminate realistic
  bait-and-switch during negotiations.

### Negative

- Indexer must enforce the 3-minute window. A naive indexer that always
  honors replacements can be tricked by a malicious seller.
- Users unfamiliar with the model might be surprised that "edit" leaves
  a visible history. We document this prominently in the FAQ.

### Follow-up work

- Phase 3 indexer must validate replacement ops against (same author) ∧
  (original still `open`) ∧ (≤ 3 min elapsed). See Phase 1 review
  carry-forward item #12.
- `morphit_feedback_v1` gets no replacement op at all — feedback is
  permanent by design (see Phase 1 FAQ entry `feedback_immutable`).

## References

- Phase 1 review log entry 2026-04-17 (docs/REVIEW-PHASE1.md).
- Blurt core dev confirmation (off-channel, archived in project notes).

## Amendments

### 2026-05-07 (Part 70) — window extended from 3 → 15 minutes

The original 3-minute figure proved too short in practice during
the pre-launch Sally walkthrough audits. A user who notices a
typo on `/my/orders` more than 3 minutes after posting has no
recovery path except cancel-and-repost (paying another listing
fee). Sally walking away from the keyboard for 4 minutes —
realistic — is locked out and pays twice.

**The new figure: 15 minutes.** Same window the original
"Alternatives considered" section had rejected as too long.

**What changed in the threat model:** the bait-and-switch
attack ADR-0001 was hardening against assumed an attacker
sitting at the screen, watching for an interested buyer DM,
then editing terms in real-time before commitment. Two
mitigations make this attack significantly weaker than the
original analysis credited:

1. The trade-side commitment requires a separate Blurt
   broadcast (the buyer signing intent), and the receiver-
   side chat client renders the order-version hash inline
   so a switched listing is visually obvious at the moment
   of commitment. A buyer who's been talking to a seller
   about terms `A` and is then asked to commit to terms `B`
   sees the version mismatch.

2. Every replacement leaves a full on-chain audit trail
   (positive consequence #2 above). A switch-after-DM is
   forensically detectable after the fact, and the feedback
   system propagates the reputational cost. An attacker
   trading reputation for one bait-and-switch is making a
   short-term move with long-term cost — most realistic
   attackers are repeat actors.

The bait-and-switch attack was never fully blocked by any
window length; it was made manually inconvenient. Bumping
3 → 15 makes the attack 5x more comfortable for a manually-
patient attacker but doesn't remove the structural
mitigations above. The trade is a real but bounded reduction
in attack-cost asymmetry vs. a real and unbounded reduction
in punishing-the-honest-user. The honest case is the
overwhelming majority.

**Remaining UX guarantees:**
- Indexer still enforces the window (now 15 min) — clients
  cannot extend it.
- The window is still short enough that nobody has a real
  conversation started before it closes (anyone who's
  shown interest via DM has 15 min to commit, which is the
  tight bound for "interested buyer should make a decision
  while the seller is still reachable").
- Cancel is always allowed regardless of window — no
  hostage scenarios.

**Sites updated in this amendment:**
- `apps/indexer/src/indexer/handlers/orderReplace.ts`
  (`REPLACE_WINDOW_MS`)
- `apps/web/src/routes/post/+page.svelte`
  (`POST_EDIT_WINDOW_MS`)
- `apps/web/src/routes/post/edit/[permlink]/+page.svelte`
  (`windowExpiresAt`)
- `apps/web/src/routes/my/orders/+page.svelte`
  (`EDIT_WINDOW_MS`)
- `apps/web/src/routes/[x+40][account=account]/[permlink=permlink]/+page.svelte`
  (`Date.now() - createdMs < 15 * 60 * 1000`)
- All 10 i18n locales (FAQ entries, edit-window tooltips,
  expired-state copy)
- `apps/web/src/lib/blurt/ops/order.ts` doc comment
- ADR-0009 §"Replace-window enforcement" (cross-reference)
