# ADR-0021: Canonical payment-methods registry with instance additions

**Status:** Accepted
**Date:** 2026-04-29
**Deciders:** Agorise team (Claude collaborating)
**Supersedes:** —
**Related:**
- ADR-0018 (operator blocks) — same operator-signed-broadcast
  pattern this ADR's instance-additions mechanism reuses.
- ADR-0008 (Phase 3b indexer architecture) — defines the chain-
  op handler contract and event-log write conventions.

## Context

Pre-Batch-L, payment methods on Morphit orders were free-text
strings. The user types whatever they want — "PayPal," "paypal,"
"Pay-Pal," "PaiPal" all become distinct values in the orderbook
filter. This is bad UX (filter doesn't match what users mean) and
bad UX-for-builders (we can't show tooltips, descriptions, or
categorical organization for an open-ended string set).

The user requested a curated, searchable, alphabetized, multi-
select picker organized by category. Plus the ability for
operators to add region-specific methods that aren't shipped in
the canonical list (e.g. PromptPay for a Thailand-focused
instance, or PIX-locale-specific variants).

The design tension: **who owns the canonical list?** Three
options were considered:

- (A) Code-only canonical list, instance additions allowed but
  not removals.
- (B) Operators have full control of their instance's list —
  add, remove, edit canonical entries.
- (C) Code-only canonical list, no instance additions at all.

User picked (A). This ADR documents the implementation.

The user also requested the registry include the top P2P-capable
payment providers in Mexico, USA, and Canada (the largest
expected initial user base). After auditing the inherited list,
merchant-acquirer-only entries (Stripe, Adyen, Braintree, etc.)
were dropped; Zelle (USA), Interac e-Transfer (Canada), SPEI
(Mexico), and Oxxo Pay (Mexico) were added.

## Decision

### Canonical list, code-defined

`apps/web/src/lib/payments/registry.ts` ships a const array of
40 entries across three categories:

- **Crypto** (3): Bitcoin, BLURT, Monero.
- **In Person** (3): Barter (goods), Cash, Precious metals.
- **Online** (34): Airwallex, Alipay, Amazon Pay, Apple Pay,
  Bancontact, Bitso, Bizum, BLIK, Cash App, GCash, Google Pay,
  iDEAL, Interac e-Transfer, Klarna, M-PESA, Mercado Pago, Mir,
  MTN MoMo, Oxxo Pay, Payoneer, PayPal, Paytm, PayU, Pix,
  Przelewy24, Revolut, ShebaPay, Sofort, SPEI, Square, UnionPay,
  Venmo, WeChat Pay, Wise, Zelle.

Categories alphabetized (`Crypto`, `In Person`, `Online`) per
user preference. Within each category, entries alphabetized by
display name (default JS sort, which puts e.g. `m-pesa` before
`mercado pago` because `-` < space in codepoint order).

Each entry has:

- `key`: machine-readable id, `[a-z][a-z0-9_]+`, ≤32 chars.
  **Stable forever** once shipped — orders on chain reference it.
- `name`: display name (typically a brand name; not translated).
- `url`: optional canonical website (https only).
- `category`: `crypto` | `in_person` | `online`.
- `assetExclusion`: for crypto entries, the asset that should
  hide this method when picking ("buy BTC with BTC" makes no
  sense). Undefined for non-crypto.

**Removing an entry is forbidden once shipped.** If a method
becomes irrelevant, mark it deprecated in a future revision but
keep the key. Old orders still resolve to a name.

### Crypto category with asset exclusion

Each Morphit asset (BTC, BLURT, XMR) appears as a payment-method
option (you can pay XMR for someone's BTC). The `assetExclusion`
field hides the matching crypto entry when the order's traded
asset matches — e.g. if you're trading BTC, "Bitcoin (BTC)" is
hidden from the payment-method picker. The picker's
`excludeForAsset` prop carries the order's asset; the search
helper applies the filter before scoring.

### Search semantics

- Whitespace-trimmed, case-folded, diacritic-stripped.
- Empty query → all entries.
- Whitespace-split into terms; ALL terms must match (AND).
- Match is substring (no fuzzy). On a 40-entry curated list,
  fuzzy matching adds more surprise than help.
- Name match scores 3× description match.
- Sort: score desc, name asc on tie.

The description is supplied via a callback so the search module
stays pure (no svelte-i18n import). Components pass
`(key) => $_(\`payment_method.${key}.description\`)`.

### Picker UX

`PaymentMethodsPicker.svelte` replaces the pre-Batch-L free-text
input on the post and edit pages. Layout:

1. Selected chips (with × to remove).
2. Description-of-last-selected (inline tooltip).
3. Search box.
4. Picker body — categorical view (collapsible sections) when
   no search query, flat ranked list when searching.
5. Optional "Instance additions" section at the bottom.

Max 12 selected (mirrors the pre-Batch-L cap).

### Migration: legacy free-text orders

Pre-Batch-L orders carry strings like `"PayPal"`. The matcher
module `apps/web/src/lib/payments/match.ts` provides:

- `resolveLegacy("PayPal")` → `"paypal"` (folded-name lookup).
- `resolveLegacyMany([...])` deduplicates after canonicalization.

Display sites use `displayNamesForMethods()` which routes:

1. `@instance:foo` keys → instanceLookup callback.
2. Canonical keys → registry lookup.
3. Legacy text → `resolveLegacy` then registry lookup; falls
   through to verbatim display if no match.

The orderbook filter is case-insensitive substring match on the
indexer side, so a filter for `paypal` matches both
new-canonical-key orders AND legacy "PayPal"-string orders.
Migration is transparent.

### Instance additions: operator-broadcast chain ops

A new chain op `morphit_payment_method_addition_v1`:

```json
{
  "v": 1,
  "action": "add" | "remove",
  "key": "promptpay",
  "name": "PromptPay",
  "description": "Thai instant retail payments…",
  "category": "online",
  "url": "https://www.bot.or.th/...",
  "ts": 1730000000
}
```

Signed by the configured operator account's posting key.
Indexer handler enforces:

- Signer === `officialAccountName` (gate).
- Version === 1.
- Action ∈ {add, remove}.
- Key matches `/^[a-z][a-z0-9_]+$/`, length 3–24.
- Key NOT in `RESERVED_CANONICAL_KEYS` (the critical
  federation-safety check).
- Name 1–64 chars, post-sanitization non-empty.
- Description ≤300 chars.
- Category ∈ {crypto, in_person, online}.
- URL null or `https://` prefix, ≤200 chars.

Sanitization strips bidi-override and zero-width codepoints
(same set as `operator_block` reasons). Strip rather than
reject — operators paste from elsewhere occasionally.

Storage: `instance_payment_methods` table, keyed
`(operator, key)`. State flips between 'active' and 'removed'
but the row persists for audit trail.

Public read endpoint: `GET /v1/instance/payment-methods` returns
active additions with the `@instance:` prefix already applied.
Frontend store fetches lazily on first subscribe; cached for
the session.

### Federation safety: namespaced keys

When stored on chain in an order's `payment_methods` array,
instance additions use `@instance:promptpay` (the
`INSTANCE_KEY_PREFIX` reserved). Cross-instance filtering still
works:

- Buyer on instance A filters orderbook by `paypal` → matches
  canonical entries on any instance.
- Buyer on instance A views a seller's order from instance B
  that uses `@instance:promptpay` → if instance A has the same
  addition, displays "PromptPay"; otherwise displays
  "promptpay" (prefix stripped). Slightly degraded but
  informative.

Operators **cannot** remove canonical entries — federation
breaks if they could (a buyer on instance A filtering by `paypal`
wouldn't match orders from instances where PayPal was removed).
Plan (B) was rejected for this reason.

### Reserved-keys parity smoke

Critical security mechanism: the indexer's
`RESERVED_CANONICAL_KEYS` set must match the frontend's
canonical-key list exactly. Drift means an operator could
silently shadow a canonical entry.

`apps/indexer/scripts/reserved-keys-parity-smoke.ts` reads both
sources at smoke-runtime and asserts they match. Any drift
fails CI immediately.

### ops-cli surface

`morphit-ops payment-method add <key> --name <n> --description <d> --category <c> [--url <u>]`
`morphit-ops payment-method remove <key>`
`morphit-ops payment-method list`

Mirrors the operator-block command pattern: signs and broadcasts
a chain op via the operator's posting key. Includes client-side
reserved-keys check (informational; indexer rejects regardless).
List subcommand reads from local DB.

## Consequences

### Positive

- **Curated UX** with descriptions, tooltips, categorical
  navigation. Users discover methods they didn't know to type.
- **Cross-instance filterability** — orderbook filter for
  `paypal` matches reliably regardless of which instance posted
  the order.
- **Migration transparency** — legacy free-text orders still
  filter correctly via the case-insensitive substring filter on
  the indexer side, while displaying via the canonical lookup
  on the frontend.
- **Federation safety** — operators can extend but not break
  the canonical list. The namespaced key prefix is the security
  boundary.
- **Operator autonomy preserved** — region-specific methods can
  be added without a project release.

### Negative

- **Three-place duplication** of canonical keys (frontend
  registry, indexer reserved-keys set, CLI reserved-keys set).
  The first two have a parity smoke; the third is informational.
  Drift between 1 and 3 results in CLI-permits-then-indexer-
  rejects UX, not security loss.
- **Code-defined canonical list means project releases gate
  additions.** A market that needs a new canonical method has
  to file an issue and wait for a release. Mitigation: instance
  additions cover the urgent case.
- **Removing canonical entries forbidden.** A method that
  becomes deprecated stays in the registry forever. Not a
  practical issue today but worth documenting.
- **No URL-as-link rendering yet** — `entry.url` is stored but
  not currently shown as a clickable link anywhere. Future code
  that adds linking would need the existing `https://` validation
  (already in place); audit flagged for awareness.

### Trade-offs explicitly considered

- **Plan A vs B vs C.** User picked A (canonical-only-with-
  additions). B fails federation; C fails operator autonomy.
- **Drop merchant-acquirers (Stripe et al.) vs keep.** Dropped
  per concern #3 — they aren't P2P-capable from a regular
  user's perspective and would mislead.
- **Top-three-markets coverage.** Audited the inherited list
  against USA, Canada, Mexico (largest expected initial user
  base) and added Zelle, Interac e-Transfer, SPEI, Oxxo Pay.
- **Crypto category.** Added per user request — "buy BTC with
  XMR" is a real Morphit use case. `assetExclusion` prevents the
  nonsensical "buy X with X" combos.
- **In Person category restructured.** User clarified "Edibles"
  meant general barter for goods (orange trees, raw garlic, used
  bicycle), not the cannabis-edibles interpretation. Single
  "Barter (goods)" entry with the order's free-form `terms`
  field carrying specifics. "Precious metals (gold/silver)"
  combines what the user listed as four separate entries
  (gold/silver coins/bars) since the trade pattern is identical.
- **Fuzzy search vs strict substring.** Strict on a 40-entry
  curated list. Fuzzy creates more surprise than help.

## Implementation

- `apps/web/src/lib/payments/registry.ts` — canonical list with
  shape invariants.
- `apps/web/src/lib/payments/search.ts` — pure search/filter.
- `apps/web/src/lib/payments/match.ts` — legacy resolver.
- `apps/web/src/lib/payments/display.ts` — keys → display
  names, routing canonical/instance/legacy.
- `apps/web/src/lib/components/PaymentMethodsPicker.svelte` —
  multi-select picker UI.
- `apps/web/src/lib/stores/instanceAdditions.ts` — frontend
  store for instance additions.
- `apps/web/src/lib/net/config.ts` — added `operatorPaymentMethod`
  op id.
- `apps/web/src/lib/indexer/client.ts` — added
  `getInstancePaymentMethods` wrapper.
- `apps/indexer/src/db/schema-v24.sql` — schema migration.
- `apps/indexer/src/indexer/handlers/operatorPaymentMethod.ts` —
  handler.
- `apps/indexer/src/indexer/dispatcher.ts` — wired.
- `apps/indexer/src/api/instancePaymentMethods.ts` — public
  read endpoint.
- `apps/indexer/src/main.ts` — endpoint mounted.
- `apps/ops-cli/src/commands/paymentMethod.ts` — operator CLI.
- `apps/ops-cli/src/main.ts` — wired into dispatcher.
- Wired display sites: `routes/post`, `routes/post/edit`,
  `routes/orderbook`, `routes/[account]`, `routes/[account]/[permlink]`.
- Smokes:
  - `payments-smoke.ts` — 40 scenarios (registry shape, search,
    legacy resolver).
  - `reserved-keys-parity-smoke.ts` — 1 scenario, the critical
    federation-safety check.
  - `operator-payment-method-handler-smoke.ts` — 28 scenarios
    (gate, payload validation, key validation, reserved keys,
    field-shape, sanitization, state transitions).
- i18n: 51 new keys × 10 locales = 510 strings (40 method
  descriptions + 7 picker UI keys + 4 category labels).
- Audit: `docs/audit/2026-04-29-batch-l-payment-methods.md`.

## Open questions / future work

- **Per-operator addition cap.** No limit currently. Could
  add a soft cap (say 50 additions per operator) if abuse
  becomes a concern.
- **URL rendering as link in the picker.** Stored but not yet
  surfaced. Could add an "info" icon next to each entry that
  opens the canonical URL in a new tab.
- **Description-search weight tuning.** Currently 3× weight
  for name vs description. May need adjustment based on
  real-world search analytics (which we won't have until
  launch).
- **Crypto-asset filter for non-Morphit-supported pay-with
  crypto.** A user might want to pay with USDT (a stablecoin
  Morphit doesn't trade as an asset). Could add USDT/USDC/etc.
  as crypto entries with no `assetExclusion`. Deferred — wait
  for user demand.
- **Canonical list expansion via formal proposal process.**
  Each new canonical entry should require: P2P verification,
  documented website, region/market relevance. Currently
  ad-hoc; could formalize.
