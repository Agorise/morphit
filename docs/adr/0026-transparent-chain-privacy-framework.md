# ADR-0026 — Transparent-chain privacy framework

**Status:** Accepted (Part 122 cp26)
**Date:** 2026-05-17
**Deciders:** project maintainer
**Supersedes:** none
**Superseded by:** none
**Related:** ADR-0023 (USDT multi-network), ADR-0024 (BCH
trade-only), ADR-0025 (LTC trade-only). All three established
the asset-registry pattern this ADR extends.

## Context

After cp24 shipped Litecoin, Ken raised a strategic question:
since BLURT, BTC, BCH, and LTC transactions are not private at
all, can we make them more private — and can that pattern apply
to future coins? Ken explicitly excluded two directions: (a)
wallet recommendations (even reputable wallets have been
compromised; the liability isn't worth the small UX win), and
(b) Lightning Network for BTC (Morphit will not support LN).

We can't make transparent chains private at the protocol level
— that's structural. But we can:

1. **Nudge better practices in the UX** (fresh addresses per
   trade, amount randomization, reuse warnings)
2. **Surface opt-in privacy tech** that the chain or its
   ecosystem supports (MWEB, CashFusion, CoinJoin, PayJoin)
3. **Educate users** with registry-driven per-asset privacy
   guides

The cp23-DD-class lesson applies here too: whatever framework
we build must be registry-driven, so future asset additions
(Dash, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP, etc.) get privacy infrastructure automatically
rather than per-asset bolt-ons.

## Decision

Extend the canonical `AssetEntry` interface with a
`privacyFeatures` struct, then build four user-facing surfaces
that pull from it:

### 1. `AssetEntry.privacyFeatures` struct

Three fields:

- `freshAddressAdvice`: one of `'subaddress'` (XMR), `'hd-derived'`
  (BTC/BCH/LTC/USDT), or `'account-reuse'` (BLURT). Drives the
  shared i18n key explaining how to get a fresh receive address
  on this chain.

- `optInPrivacyTech`: `null` for assets without opt-in privacy
  technology (XMR has it built in; BLURT and USDT don't have
  any), or an array of protocol-standard identifiers from a
  fixed enum: `'mweb'`, `'cashfusion'`, `'coinjoin'`, `'payjoin'`,
  `'privatesend'` (cp27 extension; see ADR-0027).
  These are **protocol names, not wallet names** — naming a
  protocol like CashFusion is an information item, not a wallet
  endorsement.

- `privacyGuideKey`: lowercase i18n key prefix for the per-asset
  privacy guide page. Pages live at `/[lang]/privacy/{key}` and
  pull copy from `privacy.guides.{key}.*`.

Per-asset values:

| Asset | freshAddressAdvice | optInPrivacyTech       | privacyGuideKey |
|-------|--------------------|------------------------|-----------------|
| XMR   | subaddress         | null                   | xmr             |
| BTC   | hd-derived         | [coinjoin, payjoin]    | btc             |
| BLURT | account-reuse      | null                   | blurt           |
| USDT  | hd-derived         | null                   | usdt            |
| BCH   | hd-derived         | [cashfusion]           | bch             |
| LTC   | hd-derived         | [mweb]                 | ltc             |
| DASH  | hd-derived         | [privatesend]          | dash            |

> **Note (Part 122 cp27):** DASH row + `'privatesend'` enum value
> added in ADR-0027 (Dash trade-only addition) as a registry-driven
> extension of this framework.  No other framework changes needed —
> DASH lit up automatically.

### 2. Generalized amount-jitter across transparent chains

cp3 shipped `jitterMoneroAmount` for XMR. cp26 generalizes to
`jitterUtxoAmount` (BTC/BCH/LTC, 8-decimal precision, 0-999 sat
jitter) and `jitterBlurtAmount` (3-decimal, 0-99 milliblurt
jitter). A dispatcher `jitterAmountForAsset(method, amount)`
routes to the right helper. USDT is pass-through (no-op) — its
privacy issue is centralization, which jitter doesn't address.

The AddressShareModal toggle (previously XMR-only) now surfaces
for every transparent asset. Default ON. Toggling OFF surfaces
an amber warning explaining the privacy cost.

### 3. Address-reuse detection

A new `lib/privacy/addressHistory.ts` helper tracks addresses
the user has shared from this device. **localStorage-only** —
never transmitted to any Morphit server. Server-side address
tracking would be a privacy regression.

When the user pastes/types an address into the share modal that
matches a prior share, an amber warning chip surfaces with the
date and (if available) the previous order permlink.

Bounded at 200 entries (rolling buffer); fail-open on any
storage error.

### 4. PayJoin (BIP-78) optional endpoint

The address-share modal grows an optional advanced field for
BTC: PayJoin endpoint URL. When the seller supplies one, the
generated `bitcoin:` URI gains a `pj=<endpoint>` parameter and
the wire payload carries `payjoin_endpoint`. PayJoin-capable
buyer wallets switch to the BIP-78 PSBT exchange; wallets
without support ignore the parameter and fall back to a normal
payment. Zero footgun.

Morphit's role is URI relay only. The seller's wallet (or self-
hosted BTCPayServer / equivalent) supplies the endpoint; we
don't host it.

ChatMessage renders a green "🔐 PayJoin available" badge when
the payload carries an endpoint.

### 5. Per-asset privacy guide pages

`/[lang]/privacy` (index) lists all tradable assets with one-line
summaries (registry-driven — the page reads `ASSETS.filter(canBeTraded)`,
so additions like DASH (cp27) light up automatically).
`/[lang]/privacy/{asset}` (detail) renders an
asset-specific guide pulling copy from registry + shared i18n:

- Intro (per-asset, from `privacy.guides.{key}.intro`)
- Fresh-address advice (shared per advice type)
- Opt-in privacy techs (shared per tech, only renders when
  present)
- Universal common practices (shared)
- "What to avoid" list (shared)
- Asset-specific caveats (per-asset, optional —
  `privacy.guides.{key}.caveats`)
- "We don't recommend wallets" footer (shared)

Registry-driven. Adding Dash to Morphit later: populate the
`privacyFeatures` field, write `privacy.guides.dash.{intro, one_line, caveats?, meta_description}`
strings, done.

## Cp26 inline-fix: pre-existing latent bug

While auditing the encoder/decoder paths for PayJoin, we
discovered the `network` field on `AddressPayload` and
`FundsSentPayload` was declared in the interface but **silently
dropped** by `encodeAddressPayload` / `encodeFundsSentPayload`.
The decoder never read it either.

This is a cp3-era latent bug that has been undetected through
cp21, cp23, cp24, cp25. Symptom: USDT cross-network display in
ChatMessage shows `p.network` as `undefined`, breaking the
per-network header badge and the per-network explorer-link
selection.

Fixed inline because the wire-shape pattern was the same as the
PayJoin work. New smoke `payjoin-uri-wire-shape-smoke` covers
both: the cp26 PayJoin additions and the cp3-bug-fix roundtrips.

## Consequences

### Positive

- **Privacy framework is registry-driven.** Future asset
  additions get the privacy guide + jitter + reuse warning for
  free by populating one struct field.
- **No wallet recommendations.** Ken's call avoids liability;
  protocol-standard names are descriptive, not endorsements.
- **Address-reuse detection is purely client-side.** Server-side
  history would have been a privacy regression; localStorage-only
  is the right shape.
- **PayJoin support without hosting the endpoint.** Morphit
  stays a coordination layer; sellers bring their own PayJoin
  infrastructure.
- **Latent cp3 USDT network-field bug fixed** as a side effect
  of the PayJoin wire-shape work.

### Trade-offs accepted

- **Native translations only in en/es/fr/de.** Other 6 locales
  (it/pl/ru/fa/zh-CN/zh-HK) ship cp26's new keys as English-
  fallback to maintain locale parity at the file-shape level.
  REVISIT entry filed for a translation pass; users in those
  locales see English privacy-guide copy until then. Trade-off:
  ship the privacy framework now versus block on translations.
- **Address-history per-device.** A user who uses Morphit on
  laptop and phone won't see reuse warnings across devices.
  Acceptable: server-side history is worse.
- **PayJoin requires both sides to opt-in.** Most BTC wallets
  don't support BIP-78. The feature is a "real win for a small
  subset, no harm to the rest" addition.
- **No wallet recommendations means users have to find their
  own.** Trade-off accepted: Morphit not in the wallet-
  recommendation business is the right posture.

### Future revisits

- Native translations for 6 locales (it/pl/ru/fa/zh-CN/zh-HK)
- Possible Tornado-Cash-style integration explainer for USDT
  on supported host chains (with appropriate ecosystem
  warnings)
- If Lightning ever becomes in-scope, expand the framework with
  a `lightning` asset_network value (out of scope per Ken's
  current decision)
- The `privacyFeatures` struct could grow a `walletRequirements`
  field if a future asset has unusual wallet requirements (e.g.
  "this asset requires a wallet that supports stealth-address
  output detection"). Not needed today.

## Subsequent additions (CP35 status update — 2026-05-19)

The per-asset table in §2 was current at cp26 ship and listed
the six trade assets supported then (XMR, BTC, BLURT, USDT, BCH,
LTC).  Subsequent checkpoints added
more assets that plug into this framework without changing the
framework itself; for reader convenience the current full table
is:

| Asset | freshAddressAdvice | optInPrivacyTech       | privacyGuideKey |
|-------|--------------------|------------------------|-----------------|
| XMR   | subaddress         | null                   | xmr             |
| BTC   | hd-derived         | [coinjoin, payjoin]    | btc             |
| BLURT | account-reuse      | null                   | blurt           |
| USDT  | hd-derived         | null                   | usdt            |
| BCH   | hd-derived         | [cashfusion]           | bch             |
| LTC   | hd-derived         | [mweb]                 | ltc             |
| DASH  | hd-derived         | [privatesend]          | dash            |
| USDC  | hd-derived         | null                   | usdc            |
| DAI   | hd-derived         | null                   | dai             |
| DOGE  | hd-derived         | null                   | doge            |

Added after this ADR's ship date:
- **DASH** (Part 122 cp27) — opt-in PrivateSend mixing via
  masternodes; otherwise transparent at base layer.
- **USDC** (Part 122 cp30) — second stablecoin; `usdc_centralized`
  privacy-warning class (Circle has freeze power).
- **DAI** (Part 122 cp31) — third stablecoin; distinct
  `dai_partly_centralized` class (MakerDAO has no freeze, but
  Peg Stability Module USDC backing transitively affects).
- **DOGE** (Part 122 cp33) — fair-launched, merge-mined with
  LTC, no native privacy upgrade.

**Canonical reference** remains `packages/asset-registry/src/index.ts`.
This footnote is a convenience snapshot; the registry is
authoritative.  No changes to the framework decision itself —
all additions used the framework as designed.
