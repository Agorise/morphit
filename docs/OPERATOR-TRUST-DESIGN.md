# Operator trust tooling — design discussion

**Status:** Design ratified.  Items 1 + 2 ✅ SHIPPED.  Item 3
(orderbook comparison view), Items 4 + 5 (advisory op +
governance process) remain open.

- **Item 1** — `verify.json` generated at build time by
  `scripts/build-verify-json.mjs` (repo root), served as a
  static asset.  Captures version + git commit + build
  timestamp + operator tag + hash manifest.
- **Item 2** — `/about-this-instance` route at
  `apps/web/src/routes/[lang]/about-this-instance/+page.svelte`
  visualizes the verify.json for users.  Does not yet
  cross-check against the on-chain release-op
  (intentionally — the cross-check is followup work, this
  page just makes the claim legible).
- **Item 3** — orderbook comparison view: not shipped.
- **Item 4** — `morphit_operator_advisory_v1` op: not
  shipped, blocked on the OP-TRUST Q1-Q5 governance
  discussion.
- **Item 5** — community advisory governance: blocked on
  Q5 maintainer/Agorise decision.

**Date:** 2026-04-21 (design); shipped iteratively.
**Interacts with:** ADR-0013 (operator incentives), ADR-0011
(dynamic fee model, operator payout path).

---

## Why this document exists

The revisit list carried "operator-shutdown tooling" for a
while. After writing a first draft, the framing itself
turned out to be wrong. We can't shut down operators. The
architecture is specifically designed so that nobody can.
This document replaces that framing with an honest one:
**operator trust tooling**. We're not stopping anyone. We're
helping users see which operators deserve their trust.

Morphit's architecture is intentionally federated: anyone
can stand up an instance (SvelteKit frontend + indexer +
relay) and serve users. The indexer reads the Blurt chain as
its source of truth; the frontend renders from the
indexer's API; the relay broadcasts ops on users' behalf.
Users choose which operator's frontend they visit.

This design is censorship-resistant by construction. It's
also **permanent**: once the software exists and the chain
exists, operators exist, and nothing we do can change that.
If an operator acts in bad faith, we cannot technically or
legally remove them. We can only inform the users.

---

## What "stopping" a bad operator actually looks like

It's worth being explicit, because the intuition from
centralized services is wrong.

**What we cannot do:**

1. **We cannot make their server stop.** We have no
   administrative access. They pay for their own
   hosting.
2. **We cannot block users from reaching them.** There is
   no central DNS, gateway, or CDN that we operate.
3. **We cannot stop them from reading the Blurt chain.**
   It's a public blockchain.
4. **We cannot stop them from collecting operator fees.**
   Once ADR-0013 ships, every operator earns a fee share
   via the same protocol rules. If users post orders
   through their frontend, those fees flow to them
   regardless of our opinion of them.
5. **We cannot legally compel them.** They're anonymous.
   No KYC, no jurisdiction, no company, no address.

**What we can do:**

1. **Warn users** via channels we control: `morphit.io`'s
   homepage, Matrix, the `@morphit` Blurt account, the
   signed `morphit_release_v1` op on the chain.
2. **Publish verification tools** so users can check an
   instance themselves — e.g., the signed bundle hash
   from the release-op lets any user detect an instance
   serving a tampered build.
3. **Compete.** Build a better instance than the bad
   actor's. Users who care about quality pick the better
   instance.

The honest consequence: **a better-looking operator with
better uptime and better UX should earn more than
morphit.io**. That's correct. That's the market working.
The way we protect morphit.io's relevance is by making it
actually better, not by suppressing competitors.

This framing matters because every "shutdown" tool we
could imagine either (a) doesn't actually shut anything
down, or (b) creates a central point of control that a
government could pressure. We build (a)-type tools.
We refuse to build (b)-type tools.

---

## Threat model — three tiers of bad operator

"Bad operator" covers three categorically different
behaviors and the appropriate response is different for
each. Muddling them leads to either tyranny (treating the
selfish operator as if they were lying) or uselessness
(treating the lying operator as if they were selfish).

### Tier 1 — Selfish operator

**Behavior:** Runs a technically correct node but doesn't
participate in the ecosystem as intended. Examples:

- Strips the `operator_tag` field from orders they
  broadcast, so fee shares flow to `@morphit-fees`
  rather than to the operator who actually served the
  user (ADR-0013 interaction).
- Claims operator status without paying the registration
  fee.
- Promises 99% uptime and delivers 50%.

**User impact:** Low. Users see correct data; the only
damage is to operator economics. The user doesn't know
or care.

**Appropriate response:** Economic, not policing. The
market handles Tier 1 without any tooling from us.

### Tier 2 — Censoring operator

**Behavior:** Silently filters what users see. The
operator doesn't fabricate anything — they just omit.
Examples:

- Hides orders from accounts they don't like.
- Hides orders in a particular fiat currency.
- Hides the cheapest listings to steer traffic toward
  their own.

**User impact:** Medium. The user gets **some** of the
truth but not all of it.

**Appropriate response:** Verifiability. Make the
omission detectable so a user (or a watchdog) can compare
one operator's view to another's and see the discrepancy.
This is not enforcement — censoring operators keep running
— but their filtering becomes visible.

### Tier 3 — Lying operator

**Behavior:** Actively fabricates data. The operator's
frontend returns orders that don't exist on-chain, or
mis-prices orders that do exist, or ships a phishing fork
of the UI that exfiltrates seed phrases.

**User impact:** High. Users lose funds, lose keys, or
trade based on false data.

**Appropriate response:** Truth-amplification. Warn users
away via every channel we control, and publish tools
users can run to verify an instance themselves. The
operator keeps running — to an increasingly empty
parking lot as users check the warnings.

---

## Design primitives we already have

Before adding anything, catalog what's there:

### Release-op trust anchor (ADR-0008, shipped)

The `morphit_release_v1` op is signed by `@morphit` with
the pinned posting pubkey. Its payload includes:

- `version` (semver)
- `hash_manifest` (asset hashes of the frontend bundle)
- `endpoints` (RPC endpoint rotation set)
- `signature` (optional additional signature)

The `hash_manifest` is the key primitive. Every legitimate
frontend instance should serve a bundle whose hash matches
what `@morphit`'s latest release-op published. A user
visiting a tampered fork can check the hash and see a
mismatch — in theory. Today this requires a tool that
doesn't exist yet (see item 1 below).

**Gap we need to close:** a user-facing "is this instance
legitimate" check that uses the release-op hash_manifest.

### `releases.invalid_reason` audit trail (shipped this session, Finding J fix)

Rejected release ops are now recorded with a specific
`invalid_reason`. If `@morphit`'s posting key is ever
compromised, the audit trail distinguishes:

- `signer_not_official_account` (phishing / impersonation;
  no real key compromise)
- `signer_no_single_posting_key` (unusual chain auth
  setup; not necessarily malicious)
- `pubkey_mismatch` (pinned value differs from what's
  on-chain — signal to rotate keys immediately)

A key-compromise event would require a config update to
all operators: bump the pinned `officialPostingPubkey` to
a newly-rotated value. Currently there's no chain op that
signals "the @morphit posting key has been rotated" —
operators would coordinate out-of-band (Matrix, email).

**Gap we need to close:** a key-rotation signaling op or
a documented out-of-band procedure.

### Operator registration (ADR-0013, ✅ shipped 2026-05-02)

ADR-0013 was Accepted-and-implemented in early May.  We now
have:

- a list of registered operators on-chain
- a registration fee they've paid
- a unique operator tag claimed by each

Registration is voluntary — an operator can run an
instance without registering. Registration is how they
get their fee share, not how they get permission to
operate.

**Gap closed:** ADR-0013 accepted-and-implemented 2026-05-02
(registration, tag claim, payout pipeline all in place).

---

## Proposed tooling (minimum viable)

### Short-term, no new chain ops (shippable now)

**1. Instance-verification endpoint (frontend).**

Every frontend instance exposes `/verify.json`:

- the current release-op version string
- the hash of the frontend bundle this instance is serving
- the git commit hash of the frontend build
- the operator's claimed tag (null for unregistered
  instances)

A user or a watchdog fetches this and compares to the
release-op value on chain. Mismatches are visible without
trusting the instance's own claim about itself.

**Scope:** ~50 lines of static-build-time generation plus
one JSON endpoint. No chain changes.

**2. "About this instance" page.**

A `/about-this-instance` route on every frontend that
visually presents the `verify.json` data to the user:

> "You're on: `morphit.agorise.world`. This instance
> claims to be running Morphit v2.3.1. The release-op
> on chain says v2.3.1 hash is `abc123…`; this instance
> serves `abc123…` ✅"

When the hash matches, the check is green. When it
doesn't, the check is red and the page shows what the
expected hash is and links to `morphit.io` and
`morphit.agorise.world` as known-good alternatives.

**Scope:** ~200 lines of Svelte + i18n. No chain changes.

**3. Comparison view.**

The orderbook page gains a "compare with another
instance" toggle. User enters a second instance URL; the
page fetches both orderbooks and highlights anything one
has that the other doesn't.

**Scope:** ~400 lines of Svelte + a shared-schema
expectation that both instances serve the standard
`/v1/orderbook` API. No chain changes.

### Medium-term (needs ADR-0013 first)

**4. Signed operator advisory op.**

`morphit_operator_advisory_v1` signed by `@morphit`
(release-op trust anchor: signer must be official
account, posting pubkey must match pinned value). Payload:

```json
{
  "operator_tag": "<tag or null for origin-based>",
  "origin": "<hostname or null for tag-based>",
  "advisory": "warn" | "do-not-use",
  "reason": "short human-readable string",
  "evidence_url": "optional link to proof"
}
```

Frontend instances read the latest advisory list and, if
the current origin or claimed tag is on it, show a
warning banner:

> "⚠️ This instance is on a community advisory list.
> Reason: `<reason>`. Consider visiting morphit.io or
> morphit.agorise.world instead."

**This is not a shutdown.** The instance keeps running.
The warning is informational. A lying operator could
even serve a frontend that hides the advisory banner —
but users can detect this via item 1's on-chain hash
check.

**Scope after ADR-0013:** ~100 lines of indexer handler,
a new `operator_advisories` table, the release-op schema
addition, ~50 lines of frontend check.

### Long-term (needs governance process)

**5. Community advisory maintenance.**

Someone has to decide what goes on the advisory list.
This is a governance question, not a technical one. The
very high bar for inclusion: demonstrated Tier 3
behavior (fabrication, phishing), not disagreement with
project direction. Requires a documented process with
evidence requirements and an appeal path.

The advisory list should NOT be a tool for suppressing
Tier 1 freeloaders or Tier 2 censors. Tier 1 is handled
by the market; Tier 2 is handled by item 3's
comparison view.

---

## What we explicitly don't want

**Anti-patterns to avoid:**

1. **Pre-emptive blocking of unregistered operators.** A
   new operator should be able to stand up an instance
   without asking permission. Requiring prior approval
   destroys the federated property.

2. **Central domain-level filtering.** Morphit doesn't
   run DNS for operator instances. Any "shutdown" via
   DNS requires us to run DNS, which is centralization
   we don't want.

3. **Irreversible operator advisories.** Every advisory
   must be reversible by a follow-up op from
   `@morphit` — otherwise a compromised key could
   permanently destroy legitimate operators.

4. **Trust-on-first-use of arbitrary instance JSON.**
   The `verify.json` endpoint MUST cross-check against
   on-chain release-op data; relying on the instance's
   own claim about itself defeats the point.

5. **Any tool framed as "shutdown."** We don't have
   that power. Framing tools as if we did creates
   expectations users will feel betrayed by when the
   bad operator keeps running.

---

## Operator anonymity — design invariant

Operators are anonymous by default. This is a feature:

- **Registration requires only a Blurt account.** No
  name, no email, no address. The operator picks a tag
  and pays the registration fee. Done.
- **The `contact_url` field on operator profiles is
  optional.** An operator can populate it with a Matrix
  handle, a Nostr pubkey, an onion address, or nothing.
  They choose what to expose.
- **Nothing in the public UI identifies operators
  geographically or personally.** Operators are
  pseudonymous. The `/operators` page shows the tag,
  registration date, on-chain stats, and the
  operator's own chosen contact link (if any). No
  country flags, no city names, no real names.
- **This invariant also applies to morphit.io itself.**
  The instance is identified as "operated by Agorise,"
  which is a project-level pseudonym. No individual
  person is named anywhere user-visible.

If a jurisdiction ever pressures a known person behind
an operator, that person hasn't been made known by us.
Operator anonymity is protection against legal coercion.

---

## Open questions (need maintainer / governance decisions)

**OP-TRUST Q1:** What evidence threshold justifies a
`morphit_operator_advisory_v1` op? Who reviews the
evidence? Is there an appeal path?

**OP-TRUST Q2:** Does the release-op gain an
`advisories` field now, or do we wait for the first
concrete incident to force the design?

**OP-TRUST Q3:** If `@morphit`'s posting key is
compromised, what's the recovery path? A hardcoded
secondary pubkey in `officialPostingPubkey` config
that operators can roll to? A published recovery
procedure that assumes out-of-band communication?

**OP-TRUST Q4:** Should the short-term tooling (items
1, 2, 3) ship even if ADR-0013 is still pending? I'd
argue **yes** — they're independent of the operator-
incentive design and help Tier 2/3 detection
regardless.

**OP-TRUST Q5:** Who maintains the advisory list?
Project maintainer? Agorise? A multi-signature
committee? Once this is more than one person, it's a
governance structure that needs its own
consideration.

---

## Recommended next step

Before writing an ADR: **build items 1 and 2**. Both
are independent of every open question above, both
help Tier 2/3 detection immediately, and both create
concrete artifacts that users and operators can
reference when OP-TRUST Q1-Q5 get discussed.

Item 3 is independent but bigger UI work — probably a
second pass after items 1 and 2 land and we see how
users engage with them.

Items 4 and 5 need ADR-level decisions first. Item 5
specifically needs a governance process that doesn't
exist yet, and that's the bigger blocker.
