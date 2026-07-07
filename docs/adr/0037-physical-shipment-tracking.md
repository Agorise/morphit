# ADR-0037 — Physical-shipment tracking & mailing-address share (cp120–cp121)

**Status:** Accepted (shipped 2026-05; pre-launch hardening campaign)

**Context part:** Part 122 cp120–cp122, follow-on to ADR-0021 (payment-method registry).

## Context

Pre-launch, Morphit supported two-party trades over BTC, XMR, BLURT, and a
catalogue of trade-only assets (USDT/USDC/DAI/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/
SOL/ETH/XRP). Chat carried two structured payloads — `morphit_addr` (carried inside `morphit_chat_v1`) for
sharing crypto receiving addresses and `morphit_funds_sent` (carried inside `morphit_chat_v1`) for txid
receipts — to let either party hand off cryptographic-grade trade evidence
without re-typing.

A first-principles workflow gap remained: **trades involving physical
shipments had no structured chat evidence**. Two cases surfaced in user
feedback:

1. **Cash by mail.** The buyer mails physical paper currency to the seller
   in exchange for crypto. Until the cash arrives, the seller has no
   verifiable signal that the buyer mailed anything. The buyer says "I sent
   it"; the seller waits.

2. **Physical goods for crypto.** Existing `barter_goods` payment method
   covered face-to-face trades (a used bicycle, home-grown garlic, etc.),
   but not the case where one party ships a physical good (e.g. a Barbie
   doll for Monero) and the other pays with crypto. The shipping party
   needs to prove the shipment.

The existing single `cash` payment method (category `in_person`) conflated
two operationally distinct flows (face-to-face vs. asynchronous mail), and
no chat payload existed to share a physical mailing address or a carrier
tracking number.

## Decision

Three coordinated changes, shipped together as cp120 (foundation) + cp121
(UI) + cp122 (docs).

### 1. Split `cash` into two payment methods, add `by_mail` category

- Remove the single `cash` (in_person) entry from the payment-method
  registry.
- Add `cash_in_person` (category `in_person`) and `cash_by_mail` (category
  `by_mail`).
- Add a fourth payment category `by_mail` to `PaymentCategory` for
  asynchronous mail-based payments. Currently holds one method
  (`cash_by_mail`); future additions like postal money orders fit here.
- `PAYMENT_CATEGORIES_ORDERED` keeps UX-display order:
  `crypto → in_person → by_mail → online` (same-machine → same-room →
  same-country → anywhere).

Rationale: the in-person/by-mail split reflects a fundamentally different
operational reality (face-to-face vs. third-party-carrier hand-off with
days of latency), and downstream UX (in-chat triggers for the mailing-
address-share and shipment-tracking modals) only makes sense for the
by-mail subset.

Pre-launch posture: zero instances live, no chain history to preserve;
the rename is clean. Indexer's `RESERVED_CANONICAL_KEYS` is updated
in lockstep with the frontend registry (enforced by
`reserved-keys-parity-smoke`).

### 2. Two new chat payloads (E2EE chat-only, never on-chain)

> **Versioning note:** chat-payload `kind` values are bare
> (`morphit_addr`, `morphit_mailing_address`, `morphit_shipment`,
> ...) without a `_v1` suffix.  Per ADR-0015, versioning lives at
> the OUTER envelope (`morphit_chat_v1`); the inner `kind` is a
> discriminator within that envelope and evolves by adding new
> fields or new kinds, not by bumping a per-kind version.  An
> earlier draft of this ADR (and PHASE-5 docs) wrote
> `morphit_addr_v1` etc., which never matched the code; cp131
> LOW-007 corrected this.

- **`morphit_mailing_address`** — share a physical mailing address.
  Fields: `country` (ISO 3166-1 alpha-2), `street`, optional `street2`,
  `city`, optional `state`, `postal_code`, optional `recipient_name`,
  optional `note`, optional `order_permlink`. Length-bounded to defeat
  DoS-shaped messages (`MAILING_ADDRESS_LIMITS`). Country code
  validated against `/^[A-Z]{2}$/` (any ISO alpha-2; not enum-locked
  because country lists evolve).

- **`morphit_shipment`** — share carrier + tracking number. Fields:
  `carrier` (canonical key from carrier registry OR the special
  `'other'`), `tracking` (5-50 chars alphanumeric+space+dash+slash),
  optional `custom_carrier_name` + `custom_tracking_url` (used only
  when `carrier === 'other'`), optional `note`, optional `order_permlink`.

Both payloads:

- Stay in **E2E-encrypted chat ONLY**. Never written to indexer.
  Never stored in chain ops. Never federation-readable. The chat
  envelope is opaque to server infrastructure.
- Round-trip through `encodePayload()` / `decodePayload()` with full
  field-shape validation; the decoder falls through to plaintext on
  malformed input (same defense pattern as existing payloads).
- `custom_tracking_url` is scheme-locked to `https://` via
  `isValidCustomTrackingUrl()`, which (a) requires the literal
  `https://` prefix, (b) round-trips through `new URL()` to confirm
  well-formedness, (c) rejects any other scheme. This blocks
  `javascript:`, `data:`, `file:`, etc. URL-injection attacks via the
  chat-pill clickable-tracking-link affordance.

Rationale for two distinct payloads (vs. extending `morphit_funds_sent`
with an optional `tracking` field): `morphit_funds_sent` is crypto-
specific (carries a chain txid + asset method); a physical shipment
carries fundamentally different metadata (carrier name, paper-currency
context). Two payloads mirror the existing `addr` vs. `funds_sent`
split — one event = one payload type.

### 3. Bundled top-20 carrier registry with tracking URL templates

`apps/web/src/lib/shipping/carriers.ts` exposes:

- Top 20 worldwide carriers by global parcel volume + Morphit locale
  relevance: USPS, UPS, FedEx, DHL Express (en/global); China Post EMS,
  SF Express, Hongkong Post (zh-CN/zh-HK); Japan Post; Royal Mail (UK);
  La Poste (FR); Deutsche Post (DE); Poste Italiane (IT); Correos
  (ES); Poczta Polska (PL); Pochta Rossii (RU); Iran Post (FA);
  Australia Post; Canada Post; India Post; Aramex (Middle East/global).
- An `'other'` free-text fallback (caller supplies `customCarrierName`
  + `customTrackingUrl`).
- Per-carrier `trackingUrlTemplate` (best-effort https:// URL with a
  literal `{tracking}` placeholder). `buildTrackingUrl()` URL-encodes
  the tracking number at substitution time, so spaces / slashes /
  special chars in tracking numbers don't break the URL.
- `getCarrier(key)` lookup; `CARRIER_KEYS` set for O(1) validation.

Structural invariants (every key matches `/^[a-z0-9_]{2,32}$/`,
canonical entries are alphabetical, `'other'` is last, every canonical
entry has an https template with `{tracking}`, every Morphit locale
has at least one region-relevant carrier) are enforced by
`carrier-registry-invariants-smoke`.

Carriers that change their tracking URL structure can be updated
in-place; the bundled list is best-effort and operators / users can
override via the `'other'` free-text path.

## Privacy posture

Highest-sensitivity user data this entire feature touches. Design
choices in order of importance (per Morphit's standing priority #1):

1. **Both payloads never leave E2E chat.** No indexer write, no chain
   op, no relay-readable form. The federation cannot see the address
   or tracking number.

2. **Recipient's tracking-link click is the only external touchpoint.**
   When the recipient clicks "Track package" on a shipment pill, their
   browser visits the carrier's tracking page. The tracking number
   then becomes visible to the carrier (which already knew it) and to
   any network observer in the recipient's path (which gains
   carrier-visit + tracking number, but not the address payload).
   Users who want fully air-gapped lookup can copy the tracking number
   from the pill (`📋 Copy` button) and look it up via Tor or a
   different browser.

3. **Mailing-address recipient is the destination — already knows.**
   Sharing a mailing address with a counterparty who needs it to ship
   something is intrinsically a disclosure. The modal's privacy aside
   names four facts before the user shares: (a) E2EE chat only, (b)
   irreversible once sent, (c) consider a P.O. box / mail-drop /
   virtual mailbox instead of a home address, (d) consider clearing
   chat history after the trade completes.

4. **Shipment safety aside is contextual.** Always shown: insurance,
   plain envelope, return-address tradeoff (anonymity vs. recovery),
   tracking-optional. **Collapsible "If you're mailing CASH" expander
   ** with cash-specific tips: tinfoil-wrap (defeats envelope-fishers
   holding envelopes up to bright light to see contents — well-known
   P2P-cash wisdom), UPS/FedEx prohibit cash shipments in their
   terms (opened packages can be confiscated with no recourse — use
   a postal service), international/customs warning (don't lie on
   declarations; high-value cash will be seized).

5. **Tracking-number spoofing is a known soft attack** — a malicious
   buyer could paste any random tracking number. Mitigation is
   user-education (the seller should sanity-check that the destination
   ZIP on the carrier-lookup matches their actual ZIP) — covered in
   the FAQ entry shipped with this ADR. Code-level mitigation would
   require integrating with each carrier's tracking API; the operator
   trust + decentralization story doesn't justify that complexity.

## Wire-format example

Mailing address (`morphit_mailing_address`):

```json
{
  "v": 1,
  "kind": "morphit_mailing_address",
  "country": "DE",
  "street": "Hauptstraße 42",
  "street2": "Hinterhof Aufgang 3",
  "city": "Berlin",
  "state": "Berlin",
  "postal_code": "10115",
  "recipient_name": "Max Mustermann",
  "note": "Klingel 12 — bitte zweimal klingeln",
  "order_permlink": "order-abc-123"
}
```

Shipment (`morphit_shipment`, USPS):

```json
{
  "v": 1,
  "kind": "morphit_shipment",
  "carrier": "usps",
  "tracking": "9400 1234 5678 9012 3456 78"
}
```

Shipment, custom carrier:

```json
{
  "v": 1,
  "kind": "morphit_shipment",
  "carrier": "other",
  "tracking": "XYZ-123-456",
  "custom_carrier_name": "Acme Couriers",
  "custom_tracking_url": "https://acme.example/track?id=XYZ-123-456"
}
```

## Consequences

**Positive:**

- Cash-by-mail and physical-goods-for-crypto trades now have structured
  chat evidence — the same UX class as crypto address-share and
  funds-sent pills.
- Generic by design: the same shipment pill works for cash, Barbie
  dolls, sourdough starters, any other physical good.
- Pre-launch clean rename — no migration debt for `cash` → split.
- Privacy aside surfaces real risks before users share PII; safety
  aside encodes user-tested operational wisdom (tinfoil-wrap,
  UPS/FedEx prohibition).

**Negative / accepted tradeoffs:**

- Bundled carrier tracking URLs are best-effort. Carriers occasionally
  restructure their URL parameter scheme; the recipient gets a clear
  "couldn't load tracking" outcome rather than silent failure
  (browser opens a broken page, user falls back to copy-and-lookup).
- Operators cannot extend the carrier list per-instance. We
  intentionally don't expose carriers as on-chain operator-configurable
  registry entries (the federation-wide consistency rationale for
  payment methods doesn't apply to carriers — recipients in different
  jurisdictions might want different sets). The `'other'` free-text
  fallback covers every gap.
- The mailing-address modal bundles only 15 common ISO countries in
  the dropdown (per Morphit's 10 locales' primary jurisdictions); the
  "Other (type ISO code)" path accepts any 2-letter ISO alpha-2 code.
  Grandma test passes: most users see their country in the dropdown
  directly.

**Operational hygiene:**

- Carrier tracking URLs need periodic refresh. Marked in code with
  a doc comment explaining the best-effort posture and pointing
  to this ADR.
- Translation polish for cp121 strings (~590 new strings) flagged
  in REVISIT-LIST translation-quality block for native-speaker review.

## Related

- ADR-0021 (payment-method registry) — baseline shape this ADR extends.
- `carrier-registry-invariants-smoke` (cp120) — 13 structural
  scenarios over the carrier registry.
- `shipping-payload-roundtrip-smoke` (cp120) — 17 scenarios over
  the two new payload types, including S-8 javascript: URL rejection.
- `apps/web/src/lib/components/MailingAddressModal.svelte` (cp121).
- `apps/web/src/lib/components/ShipmentModal.svelte` (cp121).
- ChatMessage pill rendering — cp121.
- `docs/faq/cash-by-mail-trading.md` (cp122 companion FAQ).
