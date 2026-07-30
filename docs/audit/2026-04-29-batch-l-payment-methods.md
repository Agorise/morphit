# Audit — Batch L: canonical payment-methods registry + instance additions

**Date:** 2026-04-29
**Scope:** Code introduced for ADR-0021. Builds on Batch I/J/K
audit methodology.

| Surface | Files |
|---|---|
| Canonical registry | `apps/web/src/lib/payments/registry.ts` |
| Search helper | `apps/web/src/lib/payments/search.ts` |
| Legacy resolver | `apps/web/src/lib/payments/match.ts` |
| Display helper | `apps/web/src/lib/payments/display.ts` |
| Picker component | `apps/web/src/lib/components/PaymentMethodsPicker.svelte` |
| Instance-additions store | `apps/web/src/lib/stores/instanceAdditions.ts` |
| Op id constants | `apps/web/src/lib/net/config.ts` (operatorPaymentMethod), `apps/indexer/src/indexer/dispatcher.ts` |
| Indexer handler | `apps/indexer/src/indexer/handlers/operatorPaymentMethod.ts` |
| Indexer API | `apps/indexer/src/api/instancePaymentMethods.ts` |
| Schema migration | `apps/indexer/src/db/schema-v24.sql` |
| ops-cli | `apps/ops-cli/src/commands/paymentMethod.ts` |
| Wired sites | post page, edit page, orderbook page, profile page, order-detail page |

## Methodology

Same lens as prior audits — STRIDE per surface, hostile-input
sweep on every parser/consumer, "experienced black hat hacker"
mindset, federation-safety review.

Severity: HIGH / MEDIUM / LOW / INFO / NOTED.

---

## Findings

### L-1 (NOTED) — Operator-account spoofing gate

Handler enforces `ctx.signer === ctx.config.officialAccountName`.
Same trust gate as `operator_block_v1`. Confirmed.

### L-2 (NOTED, CRITICAL) — Reserved-key shadowing

If an operator could broadcast `key='paypal'` and the indexer
accepted it, that operator's picker would silently shadow the
canonical entry — federation breaks because cross-instance
order filtering by `paypal` would now match different things.

Defense: `RESERVED_CANONICAL_KEYS` set in the handler; rejects
with `key_reserved`, no DB write. **Smoke covers this** with
explicit `paypal`, `zelle`, `cash` cases. Confirmed safe.

### L-3 (NOTED) — Cross-spelling shadowing

Operator could add `key='pay_pal'` (underscore) which doesn't
collide with any canonical key. The picker renders BOTH the
canonical `paypal` (display name "PayPal") and the instance
`@instance:pay_pal` (operator-supplied display name). The
"(this instance only)" badge visually distinguishes them.

This is **by design** — operators have legitimate reasons to
add region-specific methods that look similar (e.g. "PayPal
Pakistan" might warrant a separate entry due to different
account-verification rules). The badge protects users from
confusion. Accepted.

### L-4 (NOTED) — XSS via name/description rendering

The picker renders names and descriptions via Svelte's default
text interpolation (`{entry.name}`, `{descFor(entry.key)}`),
which HTML-escapes. Display chip uses `{nameFor(key)}`. Order-
detail and profile pages use `displayNamesForMethods(...).join(', ')`
which also goes through Svelte interpolation. Confirmed safe.

### L-5 (NOTED) — Operator-supplied content is operator's responsibility

A malicious operator can write a 300-char description that's
misinformation or social-engineering text. This is by design:
the operator runs the instance, sets its policies, and is
accountable to their users. Same as the operator-block reason
field's posture. Confirmed acceptable.

### L-6 (NOTED) — URL field is stored but not currently linked

`entry.url` is in the schema and the picker stores it for
future use, but no current code creates an `<a href={url}>`.
The indexer validates `https://` prefix only, so a future code
change that DOES link the URL would still need to defend
against javascript: schemes (which the prefix check already
prevents). Confirmed safe; flagged for awareness if anyone
adds URL-as-link rendering later.

### L-7 (NOTED) — Picker render race vs instance-additions fetch

The instance-additions store starts empty and resolves async.
For a fast-clicking user, the picker might briefly show no
instance options before the fetch resolves. Svelte re-renders
on store update, so the eventual state is correct. Confirmed
acceptable — instance additions are an extension, not a
dependency.

### L-8 (NOTED) — Legacy resolver doesn't shadow instance keys

`resolveLegacy("@instance:paypal")` → first checks
`findPaymentMethod("@instance:paypal")` (returns null, not in
canonical set), then folded-name lookup (also no match), then
returns original text unchanged. Display helper recognizes the
prefix and routes to `instanceLookup`, falling back to
stripping the prefix if the key isn't known on this instance.
No exploit path. Confirmed safe.

### L-9 (NOTED) — User can't type arbitrary picker keys

The picker is multi-select over a fixed list (canonical +
instance additions). No free-text input means no way to type
keys that match nothing or that probe for collisions.
Confirmed safe.

### L-10 (NOTED) — Compromised-indexer trust posture

A compromised indexer could lie about additions. Mitigation:
the frontend independently knows the canonical list (ships
with the code); a malicious indexer can't shadow canonical
entries because their keys never go through the instance-
lookup branch. The visual badge distinguishes additions from
canonical entries. Confirmed: same trust posture as the rest
of the app, no regression.

### L-11 (NOTED, CRITICAL) — Reserved-keys parity drift

If a future canonical entry is added to the frontend registry
but not the indexer's `RESERVED_CANONICAL_KEYS`, an operator
could accidentally or maliciously shadow it.

**Defense: `reserved-keys-parity-smoke` reads both sources and
asserts they match exactly.** Drift fails CI immediately.
Confirmed.

### L-12 (INFO) — Sanitization is silent strip

`U+202E` (RIGHT-TO-LEFT OVERRIDE) and other dangerous
codepoints are stripped silently before storage. The ops-cli
surfaces the strip count to the operator; the indexer does not
echo the strip. Operators broadcasting via raw chain ops would
see the chain-stored value (sanitized) differ from what they
posted. Acceptable — same posture as operator-block reasons.

### L-13 (NOTED) — Direct-broadcast bypass of CLI

An operator with their posting key can post the chain op
directly. The indexer applies all the same validation (key
shape, length, sanitization, reserved-keys, https URL) so the
CLI is operator-friendliness, not a security boundary.
Confirmed.

### L-14 (NOTED) — DoS by infinite additions

No per-operator cap on additions. An attacker who has the
operator's posting key has already broken the operator account;
trashing the picker UI is the smallest concern at that point.
Out of scope.

### L-15 (NOTED) — Legacy-orders migration is transparent

Pre-Batch-L orders carry free-text strings like `"PayPal"`. The
orderbook filter on the indexer side is case-insensitive substring
match, so a filter for `paypal` (canonical key) matches both new
orders posting the canonical key AND legacy orders posting the
display name. Confirmed transparent migration.

---

## Cross-surface findings

### CS-L-1 (NOTED) — Federation safety preserved

Plan A (canonical-only-with-instance-additions): the canonical
list is global; instance additions are local with namespaced
keys. A buyer on instance B viewing a seller's order from
instance A sees:

  - Canonical methods (PayPal, Wise) → match by display name
    via `displayNamesForMethods` (canonical lookup hits).
  - Instance-A additions (@instance:foo) → display falls back
    to stripping the prefix (`foo`) since instance B's lookup
    has no such key. Slightly degraded but informative.

This is the documented federation behavior. Confirmed.

### CS-L-2 (NOTED) — Three-place duplication of canonical keys

Canonical keys are listed in:

1. `apps/web/src/lib/payments/registry.ts` (frontend, full
   entries with name/url/category).
2. `apps/indexer/src/indexer/handlers/operatorPaymentMethod.ts`
   (indexer's RESERVED_CANONICAL_KEYS, just the keys).
3. `apps/ops-cli/src/commands/paymentMethod.ts` (CLI's
   RESERVED_CANONICAL_KEYS, just the keys).

Drift between 1 and 2 is caught by reserved-keys-parity-smoke.
Drift between 1 and 3 is NOT currently caught. The CLI's check
is informational (the indexer rejects regardless), so drift
would result in a worse-but-not-broken UX (CLI permits a
broadcast that the indexer rejects).

**Recommendation accepted as-is**: not adding a third smoke
because (a) the CLI's set is a courtesy check, (b) the indexer
is the actual security boundary, and (c) anyone updating the
frontend registry would naturally update the CLI as well —
but if they didn't, the failure mode is "operator gets a clear
error from the indexer," not security loss.

---

## Smoke regression posture

- 1049 total scenarios passing (was 1020 pre-Batch-L; +1 reserved-
  keys-parity + 28 operator-payment-method-handler scenarios).
- Typecheck clean.
- i18n drift = 0 across 1861 keys × 10 locales.

---

## Outstanding (not in this audit's scope)

- **Batch I H2** — WebHID transport hardware probe (independent).
- **External pre-launch security audit** by a security firm.
- **Phase G mobile PWA polish** — gated on this campaign closing.
- **Future: tx-by-id explorer fetch from non-tx-index nodes**.
- **Future: payment_methods endpoint observability** (rate-limit
  tier, latency).

---

## Sign-off

This audit reviewed 15 surface findings + 2 cross-surface
findings. **Zero open issues.** The two CRITICAL items (L-2
reserved-key shadowing and L-11 reserved-keys parity drift) are
both protected by smokes that fail CI on regression.

Batch L considered shippable.
