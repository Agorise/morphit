# ADR-0012 — Post-first-trade cross-post flow to Blurt

**Status:** Accepted (implemented in `apps/web/src/lib/syndication/publish.ts`)
**Date:** 2026-04-19 (proposed); 2026-05-06 (status updated)
**Deciders:** project maintainer
**Related:** ADR-0010 (key custody), ADR-0011 (dynamic fee model)

> Originally a stub with three UNDECIDED design questions.  All
> three resolved during Phase 5 implementation; the resolutions
> are recorded in the **Design questions resolved** section near
> the bottom of this document.  The Decision section below is
> the resolved shape now in code.

## Context

Phase 4c delivered the delayed welcome bonus: when a Morphit
user completes their first trade (evidenced by counterparty
`morphit_feedback_v1` submission), the relay sends them 10 BLURT
liquid + 10 BP as a welcome gift. The bonus is a concrete moment
of delight for the user.

Phase 5 wants to convert that moment into ecosystem reach. The
thesis: if Morphit's users post about their first completed trade
on Blurt, those posts become organic discovery vectors for new
users browsing blurt.blog, blurt.media, and the wider Blurt
social layer. This is content marketing via user-generated
authenticity rather than paid promotion.

The mechanism: right after the welcome bonus arrives, offer the
user a pre-filled "I traded on Morphit" blog post they can
review, edit, and publish to their own Blurt account. The user
owns the posting key that would sign the post; Morphit never
gets custody of content they didn't author.

### Constraints from Morphit principles

- **Consent-first.** Users must opt in per-post, explicitly. No
  auto-posting. No "quiet default to on."
- **Counterparty privacy.** The post must not reveal the
  counterparty's account name, the trade amount, the asset
  traded, or timing precise enough to identify the trade from
  on-chain data. A trade-completion post that says "I just
  bought $500 of BTC from @alice using Zelle" is unacceptable
  — that's doxxing the counterparty.
- **Non-custody stays non-custody.** The post is signed by the
  user's posting key (JIT-decrypted). Morphit never sees or
  persists the post content server-side.
- **Reversibility.** If a user regrets the post, they can
  delete it via any Blurt frontend. No Morphit-side lock-in.

### Technical state of play

- A feedback-submission UI does NOT exist in the Phase 4 frontend.
  The welcome bonus fires when the counterparty's feedback is
  indexed, but there's no UI for the original poster to submit
  THEIR feedback yet. Cross-post goes on the feedback-submit
  screen (the logical "trade complete" moment), so that UI is a
  hard prerequisite.
- The user's posting key is JIT-decrypted whenever they're
  composing an order or cancelling one. For cross-posting, we
  need a `custom_json`-like op (actually `comment` — the Blurt
  blog post op).
- The 10-locale i18n system (541 strings) needs ~5 new strings
  for the cross-post UI, plus the post-template body and title
  in each locale.

## Decision

**When:** On the feedback-submit confirmation screen, offer
(opt-in) to cross-post to Blurt. The offer shows once — if
declined, don't re-prompt.

**What:** A short Blurt comment op (i.e., a blog post) with:

- A title in the user's locale (10 localized versions; UNDECIDED
  whether fully fixed or fill-in-blank — see Open Questions).
- A body crediting Morphit, mentioning the platform link, and
  tagged `#morphit #p2p #privacy`. No counterparty info. No
  concrete amounts. No asset specificity unless the user
  explicitly toggles "include asset" (default off).
- Posted into `@{user}/morphit-first-trade-{random}` — the
  user's own account namespace.

**Key handling:** Require an explicit password re-entry before
signing the `comment` op, even if the posting key is already
unlocked in the session. This makes the permanence of the post
visible and deliberate. Rationale: unlike short-lived Morphit
ops (orders, cancellations), a blog post is public and
permanent — users should feel the weight of that choice.

**Resolved 1 — Post template:** Fixed template per locale.  No
in-line user editing; the post is fired in the same client turn
as the feedback broadcast (Post A) or order broadcast (Post B).
See "Design questions resolved" below.

**Resolved 2 — Community posting:** Both, by post type.  Post A
goes to the @morphit Blurt community (`parent_permlink =
"blurt-176570"`).  Post B goes to the user's personal feed with
parent_permlink "morphit" (the project tag).  See "Design
questions resolved" below.

**Resolved 3 — Schedule:** Immediate.  Fired in the same client
turn as the triggering action.  Replaced the originally-considered
deferred-syndication-queue model that was scaffolded but never
shipped.  See "Design questions resolved" below.

## Alternatives considered

- **Auto-post (opt-out).** Rejected outright on the consent-
  first principle. Any auto-posting under user accounts — even
  "silent" metadata ops — erodes the trust that Morphit never
  acts as the user.

- **Post from @morphit-relay on the user's behalf.** Rejected
  because it would require custodial authority over content
  posted under the user's name (even if semantically attributed
  to Morphit, the chain record would show @morphit-relay posting
  about users' trades, which is creepy and off-brand for a
  non-custodial protocol).

- **Off-chain announcement via Morphit-side database.** We
  could maintain a "recent trades" page on the Morphit website
  that's populated server-side based on feedback events.
  Rejected because it doesn't use Blurt's network effect — the
  whole point is to push content INTO the Blurt social layer,
  not to host it ourselves.

- **Share button that opens a pre-filled compose window on
  blurt.blog.** A lower-effort version: instead of signing
  directly in Morphit, we redirect the user to a blurt.blog
  compose URL with the title/body pre-filled. Rejected because:
  (a) it breaks for users without a blurt.blog session
  (they'd have to log in again), and (b) it creates a UX seam
  right at the emotional-high moment after a successful trade.

## Consequences

### Positive

- Organic discovery: every cross-posted first trade is a Morphit
  mention on the Blurt social layer. If 30% of first-time users
  opt in, and Morphit gains 1000 first-time users in a year,
  that's 300 organic posts.
- Reinforces the non-custodial narrative: Morphit gives you
  something to share about your experience, signed under your
  own key, that you fully own.
- Closes the "what happened after the trade" loop: users
  currently complete their first trade and then don't interact
  with the site again until their next trade. The cross-post
  gives them a closing action that feels rewarding.

### Negative

- Exposes a new vector for misinformation: if Morphit's
  template copy overclaims (e.g., "I made $1000 trading
  crypto!"), we're embedding it in user voices. Copy needs
  to be carefully neutral.
- 10-locale translation work for the template — adds to
  i18n maintenance burden.
- Prerequisite feedback-submit UI work (medium-sized frontend
  feature) must ship before this can land.
- Cross-posts from newly-minted accounts with low BP might get
  filtered as spam on Blurt frontends. We can't control Blurt's
  spam filters; some percentage of posts won't land.

### Follow-up work

- Feedback-submit UI in the frontend (prerequisite).
- ADR-0013 must resolve whether a dedicated Morphit community
  exists before we can target posts there.
- 10-locale translation pass for the template.
- Analytics: track opt-in rate. If under 10%, the feature
  isn't earning its implementation cost.

## Design questions resolved (2026-05-06)

### Q1 — Post template: fully fixed
**Decision:** Fixed template per locale, generated programmatically
from `apps/web/src/lib/syndication/publish.ts`.  Hardcoded image
URLs (`IMAGE_FIRST_TRADE`, `IMAGE_ORDER_POST`) point at images
pre-uploaded to Blurt's image host.  No in-line user editing; the
post is fired in the same client turn as the triggering action.

**Why:** Removes a UX friction point (no "review before post"
modal that users habitually dismiss without reading), removes the
attack surface of user-controlled HTML/markdown landing under
the @morphit-community feed, and keeps the "post Morphit talks
about itself in a uniform way" branding consistent across operators.

**User control:** The opt-out is per-feature (Settings → "Auto-
announce my first trade") rather than per-post.  Per-order
syndication (Post B) is already opt-in via a checkbox on `/post`.

### Q2 — Community vs personal: both, by post type
**Decision:**
- **Post A (first-trade announcement)** → @morphit Blurt community
  (`parent_permlink = "blurt-176570"`).  This is the discovery
  channel where Blurt users browsing the @morphit feed see new
  Morphit users' first-trade celebrations.
- **Post B (per-order syndication)** → user's personal blog with
  parent_permlink `"morphit"` (the project tag).  This is the
  user's own marketing of their open trade, posted to their own
  followers, discoverable by anyone browsing the `morphit` tag.

**Why:** Post A is project-branded promotion; the community feed
makes that explicit and gives the @morphit community account a
reason to exist as a content hub.  Post B is user-driven; their
personal blog is the right venue for their own order.

### Q3 — Schedule: immediate
**Decision:** Both posts fire in the same client turn as the
triggering action (feedback broadcast for Post A, order broadcast
for Post B).  No deferred-syndication-queue, no indexer state, no
"pending" banner.

**Why:** The originally-proposed 30-60s scheduled delay was
scaffolded as a deferred-queue with cancel UI, but in practice
nobody used the cancel and the indexer-state added attack surface
for syndication-queue tampering.  Replacing it with immediate
firing eliminated ~200 lines of scaffolding code (publish.ts §
"Replaces the old deferred-syndication-queue model").  Idempotency
via deterministic permlink — a retry of the same trigger lands
on the same Blurt post (edit, not duplicate).

## References

- `apps/web/src/lib/syndication/publish.ts` — implementation
- `apps/web/src/lib/utils/syndicationPrefs.ts` — opt-out store
- PHASE-5-BACKLOG.md item 1
- ADR-0010 — key custody (constrains posting-key handling)
- ADR-0011 — dynamic fee model (defines the welcome bonus
  that this feature emotionally follows from)
