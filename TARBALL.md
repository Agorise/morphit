# TARBALL — Morphit pre-launch hardening, Part 121 (in progress, checkpoint 3)

**Snapshot date:** 2026-05-13

**Tarball:** `morphit-audit-2026-05-121-cp3-delta.tar.gz`

**Previous tarball:** `morphit-audit-2026-05-121-cp2-delta.tar.gz`.  This cp3 ships **USDT (Tether) end-to-end** as Morphit's first multi-network and first trade-only asset.

## Part 121 cp3 — what's shipped

### Pretext

Ken's directive after cp2 sealed: *"let's add Tether (USDT). do not let people pay fees with it. i will never own usdt and do not want any from anyone/anywhere. it's not private at all and is very centralised, but i am choosing to add it because active traders choose to hold/use it for holding value temporarily."*

Pre-execution design Q&A turn detailed how USDT would appear in Morphit, then asked 5 edge-case design questions.  Ken's answers (committed before code landed):

1. **9a — wrong-network address in chat:** same posture as BTC/XMR (reject inline)
2. **9b — order-row hint:** "you need USDT on Tron for this trade" chip
3. **9c — operator opt-in posture:** default=ON instance-wide with operator-config override (same for all future coin additions).  **Memory #25 committed.**
4. **9d — bridged vs native:** native only
5. **9e — depeg risk:** live "1 USDT = $X.XX live" subline on every USDT row

### Memory edit #25

> Every new tradable asset ships default=ON instance-wide, with operator-config override to disable.  Pattern: `MORPHIT_INDEXER_DISABLED_ASSETS` env var.  Per-asset opt-out is OPERATOR-level not user-level.  Applies to USDT and all future coin additions.

### Code changes shipped

**Foundation:**
- Canonical asset registry: USDT entry with `canPayListingFee: false`, 4 supported networks, `defaultNetwork: null`, `privacyWarningKey: 'usdt_centralized'`
- NEW `apps/web/src/lib/assets/networks.ts` — per-network metadata module (regexes + bundled explorers: etherscan.io, tronscan.org, solscan.io, bscscan.com per Ken's list; Omni Layer excluded per Tether's own deprecation)
- Frontend asset registry mirrors canonical with `canBeUsedForListingFee: false`

**Chat payload:**
- `ChatAssetTicker` extended to include `'usdt'`
- `AddressPayload`/`FundsSentPayload` gained optional `network` field
- `isValidAddress`/`isValidTxid` dispatchers extended for USDT

**Indexer:**
- New `MORPHIT_INDEXER_DISABLED_ASSETS` env var + `Config.disabledAssets` field
- Order handler instance-wide disable gate (`asset_disabled_on_instance`)
- `validate()` asset_network gates: `asset_network_required_for_usdt` / `asset_network_unknown` / `asset_network_not_permitted_for_asset`
- All 4 INSERT INTO orders sites rewritten with `asset_network` column
- Schema v32 migration: `orders.asset_network TEXT` + partial index, idempotent

**Indexer-client + API:**
- `OrderRecord.asset_network?: string | null` type
- Orderbook SELECT + rowToWire include asset_network

**Order payload builder:**
- `OrderFormInput.assetNetwork` + `OrderPayload.asset_network` fields

**Instance store:**
- `chat_link_urls.usdt` sub-map for per-network operator-overridable explorer templates

**Explorer URLs:**
- `usdtExplorerUrl(network, txid)` — reads instance override, falls back to bundled default, SPL preserves case

**Price feed:**
- USDT added to fallback ($1.00 static) + Coingecko ('tether' ID for live peg state)

**3 new Svelte components:**
- `PrivacyWarningChip.svelte` (full + compact variants, dismissible per-session)
- `UsdtNetworkPicker.svelte` (required radio, cross-network warning above)
- `UsdtPriceSubline.svelte` (live + stale fallback)

**3 form integrations:**
- `/post +page.svelte` (chip + picker, step1Done gated)
- `AddressShareModal.svelte` (USDT tab, per-network validation, picker, payload threads network)
- `FundsSentModal.svelte` (USDT tab, `initialUsdtNetwork` prop with networkPinned read-only mode)

**ChatMessage rendering:**
- `explorerLinkForTxid` takes optional network
- Address pill: bold-network prefix chip + amber per-message warning (stays on chat record forever)
- Funds-sent pill: same prefix

**Orderbook row:**
- USDT network chip with title-tooltip hint (9b)
- `<UsdtPriceSubline compact />` (9e)

**SVG assets:**
- `/icons/icon-usdt.svg` (Tether teal) + 4 sub-network chip icons at `/icons/networks/`

**i18n:**
- 28 keys × 10 locales = 280 native translations
- 3 FAQ entries (`what_is_usdt`, `why_usdt_warning`, `which_usdt_network`) wired into FAQ_KEYS + FAQ_RELATED + locales (q+a pairs)
- Allow-list extended for "Tether"/"Ethereum"/"Tron"/"Solana"/"BNB Smart Chain"/"USDT" proper-noun loanwords with reason codes

### 2 new sentinel smokes

- `usdt-trade-only-smoke` (11/11 green) — pins canonical + frontend registry invariants
- `usdt-network-picker-required-smoke` (9/9 green) — sentinel-greps /post + AddressShareModal + FundsSentModal for usdtNetwork-gated canSubmit
- Both registered in `scripts/run-smokes.sh`

### 5 new persona-walkthrough scenarios (P121-USDT-1..5)

### Docs shipped same turn (Memory #24 discipline)

- NEW `docs/adr/0023-usdt-multi-network.md` — full architectural ADR, all 9 design decisions
- `docs/ADDING-A-COIN.md` Category B example updated to match shipped reality
- `docs/OPERATIONS.md` new "Trade-only asset configuration" tail section
- `docs/RUN-A-MORPHIT-NODE.md` new "USDT and your operator stance" tail section
- `docs/PRE-LAUNCH-CHECKLIST.md` new [blocking] checklist item + schema v31→v32

### Marketing

- `MORPHIT-BRAG-LIST.md` 252 → 254 entries; footer count + date refreshed

### Verification

- **Triple-pulse `bash scripts/run-smokes.sh`: 2,405 scenarios green × 3, zero failures.**  Baseline 2,377 → 2,405 (+28).
- Locale parity 10/10 green at 2,478 keys × 10
- Translation-completeness: 0 unexpected byte-identical
- Fee-method-enum-frozen 7/7: USDT did NOT leak into fee_method enum (Memory #23 preserved)
- First-buy-waiver-payment-agnostic 6/6
- Web TS / svelte-check clean; indexer / relay / asset-registry TS clean

---

## Part 121 cp2 — what shipped previously

Ken asked whether the "one-time `npm install`" setup note I'd given verbally in cp1 was actually present in the operator/launch docs.  Grep confirmed it was — `RUN-A-MORPHIT-NODE.md` §736, `OPERATIONS.md` §7015-7038, `PRE-LAUNCH-CHECKLIST.md` §307-324 all carry the workspace-symlinks explanation with current numbers ("13 affected runners," "2,370+ scenarios").  Ken's correction was a process one: "please stop forgetting to update the .md files as we go along."

**Memory edit #24 committed 2026-05-13:** "Before EVERY tarball, grep operator/launch docs for setup/troubleshooting/operator implications of the turn's work; never assume coverage; if saying verbally 'one-time setup note' or 'environmental thing,' that's the SYMPTOM the doc update was missed — fix BEFORE tarball, not after Ken asks."

The self-audit triggered by that memory rule surfaced **one real gap that should have shipped in cp1**: ADR-0011 (the fee-model ADR) did not yet carry the Part 121 enum-freeze forward-note.

### cp2 changes

1. **`docs/RUN-A-MORPHIT-NODE.md` line 736** — extended `npm install` explanation: workspace symlinks, ERR_MODULE_NOT_FOUND symptom, framing as pure environment setup.

2. **`docs/OPERATIONS.md` §Tests + smoke** — appended a "Smoke-suite troubleshooting" block enumerating the 13 affected runners and the fix (`cd ~/morphit && npm install --no-audit --no-fund`), framed as pure environment setup not a code regression.

3. **`docs/PRE-LAUNCH-CHECKLIST.md` §C** — added a new `[blocking]` checkbox: "Run the static smoke suite and confirm it returns clean.  From the repo root: `bash scripts/run-smokes.sh`.  Expected output: `Total: 2370+ scenarios passed, 0 runners failed`."  Includes the ERR_MODULE_NOT_FOUND symptom + fix inline so an operator hitting it during pre-launch finds the answer without leaving the checklist.

4. **`apps/web/scripts/persona-walkthrough-smoke.ts`** — four new P121-DOC sentinel scenarios pinning the doc claims against future drift:
   - P121-DOC-1: RUN-A-NODE mentions workspace symlinks + ERR_MODULE_NOT_FOUND + @morphit/asset-registry
   - P121-DOC-2: OPERATIONS.md has the Smoke-suite troubleshooting block with the fix command
   - P121-DOC-3: PRE-LAUNCH-CHECKLIST §C has the smoke-suite verification step
   - **P121-DOC-4 (added in catch-up after memory #24):** ADR-0011 carries the Part 121 fee_method enum-freeze forward-note pointing at memory #23 and both sentinel-grep smokes.
   
   Header comment updated with the Part 121 additions block.

5. **`docs/adr/0011-dynamic-fee-model.md` (added in catch-up after memory #24)** — 2026-05-13 forward-note at the head of the ADR explaining that the `fee_method` field type union throughout this ADR is now a wire-format-frozen invariant per memory #23; points at the two sentinel-grep smokes that guard it (`fee-method-enum-frozen-smoke.ts`, `first-buy-waiver-payment-agnostic-smoke.ts`) and the user-facing rationale sections in FEES-AND-REWARDS §"What is FROZEN" and ADDING-A-COIN §"2026-05-13 architectural update."  Pattern lesson: when shipping a code-level invariant, the ADR that established the original wire format MUST gain a forward-note pointing at the freeze.  Self-audit triggered by memory #24 found this gap — exactly the failure mode #24 was committed to prevent.

Pattern lesson distilled: the cp1 `CHANGES-cp1.md` "Setup note for you (one-time)" was talking to Ken, but the operators who set up nodes will hit the same symptom and need to find the answer in the docs they're already reading — not in a tarball CHANGES file from a Part they weren't following.  Memory #14 says operator-facing claims belong in operator docs in the same work unit as the code.  cp2 closes that gap.

## Verification

- Triple-pulse `bash scripts/run-smokes.sh`: **2,374 scenarios green × 3, zero failures** (up from 2,370 in cp1; +4 P121-DOC scenarios).
- Persona-walkthrough-smoke: 37/37 (was 33/33).
- ADR-0011 line count grew from 1,561 → 1,582 (+21 forward-note lines).
- AUDIT-2026-05.md grew ~40 lines (Part 121 entry + cp1 catch-up section).
- REVISIT-LIST.md Part 121 maintained-line extended with the cp1 catch-up narrative.
- All other smokes unchanged.

## Combined cp1 + cp2 state

Everything from cp1 (asset-registry expansion, rename, two new sentinel smokes, locale shape, docs) PLUS three operator-doc edits + three smoke sentinels pinning them.



## Part 121 cp1 — what's shipped

Pretext: Ken's two forward-looking architecture questions after Part 120 closure — "Will it be easy to add new languages (7 more, total 17)?" + "Will it be easy to add more coins like USDT?" — plus the new architectural constraint that **listing fees can ONLY be paid in BLURT, XMR, or BTC** (memory edit #23).

### Investigation findings

- **Languages: already easy.**  `apps/web/src/lib/i18n/index.ts` carries `SUPPORTED_LOCALES` (10 today) AND `PLANNED_LOCALES` (the exact 7 Ken referenced: hi, ar, bn, pt, id, ja, vi).  Graduating is a one-line move + dropping a JSON.  No structural work needed.
- **Coins: mostly ready, three real gaps.**  Asset registries at both `packages/asset-registry/src/index.ts` and `apps/web/src/lib/assets/registry.ts` already had the right discriminators.  The indexer's `fee_method` enum is correctly hardcoded as wire-format-frozen `'blurt' | 'waived_first_buy' | 'btc' | 'xmr'`.  Three gaps closed:
  1. `apps/web/src/lib/explorer/urls.ts` hardcoded BTC/XMR branches → registry-driven dispatch
  2. No `network` sub-field for multi-network coins (USDT on ERC-20/TRC-20/SPL) → added
  3. No `privacyWarning` field for transparent/centrally-controllable assets → added

### Ken's design decisions (confirmed before code landed)

1. Multi-network coins: option B — single USDT entry with `supportedNetworks: ['erc20', 'trc20', 'sol']` and `defaultNetwork: null` to force explicit user choice every trade.
2. Privacy-warning chip: yes, added as `privacyWarningKey: string | null`.
3. First-buy waiver applies regardless of payment-method (waiver covers listing fee, not trade settlement).
4. Commit "listing fees BLURT/XMR/BTC only" rule to memory — done as memory edit #23.

### Code changes shipped this cp1

1. **`packages/asset-registry/src/index.ts`** — `AssetEntry` gains 3 new required fields: `supportedNetworks`, `defaultNetwork`, `privacyWarningKey`.  All 3 existing entries (XMR, BTC, BLURT) backfilled with `['mainnet']` / `'mainnet'` / `null`.

2. **`packages/asset-registry/scripts/asset-registry-smoke.ts`** — 5 new invariants including the hard rule `canPayListingFee: true → ticker ∈ {BLURT, BTC, XMR}` enforcing memory #23 at the registry level.

3. **`apps/web/src/lib/assets/registry.ts`** — frontend extension mirrors all 3 new fields.

4. **`apps/web/src/lib/chat/payload.ts`** — `PaymentMethod` type renamed to `ChatAssetTicker` with JSDoc explaining the lowercase-wire-format distinction.  Old name was misleading (sounded like fiat payment rail; was actually the asset/coin ticker for chat-side address-share payloads).

5. **6 importing files renamed** to match: `components/ChatMessage.svelte`, `components/AddressShareModal.svelte`, `components/FundsSentModal.svelte`, `trades/tradeStatusPure.ts`, `trades/tradeStatus.ts`, `trades/listenerDispatch.ts`.

6. **`apps/web/src/lib/explorer/urls.ts`** — refactored to registry-driven `EXPLORER_REGISTRY` map dispatch.  Adding a future trade-only asset's explorer link is now a single-entry addition, not a hardcoded branch.

7. **`apps/web/src/routes/post/+page.svelte`** — line 667 hardcoded triple-asset check replaced with `isAssetTicker(p.asset)` from the canonical registry; import added at line 53.

8. **NEW smoke `fee-method-enum-frozen-smoke.ts`** — 7 sentinel scenarios pinning the indexer's `fee_method` enum at the frozen 4-member set; checks against expansion tickers (usdt, ltc, doge, arrr, eth, sol, bch, xlm, dash).

9. **NEW smoke `first-buy-waiver-payment-agnostic-smoke.ts`** — 6 sentinel scenarios brace-balanced-extracting the waiver branch from `order.ts`, validating the gate checks (side, asset) and asserting the gate portion (pre-INSERT) does NOT reference `payment_methods` or any fiat payment rail.  **Bonus catch during development:** first draft flagged the INSERT statement's `payment_methods` column — false positive.  Refined to scope the check to the gate portion only.

10. **`scripts/run-smokes.sh`** — both new smokes registered.

11. **All 10 locale JSON files** — added `assets.privacy_warnings` object (empty for now; shape ready for when USDT lands).  Locale parity 10/10 green at 2,459 keys × 10.

### Doc changes

- **`docs/ADDING-A-COIN.md`** — appended Part 121 architectural section explaining Category A (full-citizen coin, requires deep operator trust) vs Category B (trade-only coin, common case for new additions), with worked USDT multi-network example.
- **`docs/FEES-AND-REWARDS.md`** — appended "What is FROZEN" section with the fee-surface invariant table and pointers to the two new sentinel-grep smokes.
- **`docs/AUDIT-2026-05.md`** — Part 121 entry appended.
- **`docs/REVISIT-LIST.md`** — Part 121 maintained-line added at top.

### Verification

- Triple-pulse `bash scripts/run-smokes.sh`: **2,370 scenarios green × 3, zero failures** (baseline grew 2,322 → 2,370 from +13 new smoke scenarios + ~35 new asset-registry invariants).
- Web TypeScript: 0 errors (`npx tsc --noEmit`).
- Web Svelte: 0 errors, 0 warnings (`npm run check`).
- Indexer TypeScript: 0 errors.
- Relay TypeScript: 0 errors.
- Asset-registry package TypeScript: 0 errors.
- Locale parity: 10/10 green, 2,459 keys × 10.

### Environmental note

Fresh clones with no `node_modules` see 13 smokes fail with `ERR_MODULE_NOT_FOUND` on `@morphit/asset-registry` imports.  This is NOT a code regression — it's that workspace symlinks under `node_modules/@morphit/asset-registry → packages/asset-registry` only exist after `npm install` at the workspace root.  Running `npm install --no-audit --no-fund` once fixes all 13 (verified in sandbox).  Tarball doesn't ship `node_modules` per project convention.

### What's deliberately NOT in this cp1

- **USDT itself is NOT added.**  The structural work shipped this cp1 alone with smoke coverage.  Adding USDT becomes a single-file follow-up (one entry in `packages/asset-registry/src/index.ts` + a logo SVG + translations of its specific privacy-warning text + frontend payment-method-registry plumbing for USDT-as-payment).
- **FAQ copy rewrites** (the many "BTC, XMR, or BLURT" mentions in `apps/web/src/lib/i18n/locales/en.json`).  Those rewrites happen the turn USDT actually lands, not in advance, so we don't accidentally promise something we haven't shipped.
- **Payment-method-registry expansion** for USDT-as-payment-rail — separate ADR-0021 follow-up if needed.



**Part 120 — what's done in checkpoint 11 (everything from cp10 plus):**

42. **FAQ orphan-entry fix.**  Caught a real production-bound bug: `apps/web/src/lib/utils/faqIndex.ts` `FAQ_KEYS` array had 102 entries, but `apps/web/src/lib/i18n/locales/en.json` had 104 entries — two orphans (`public_api`, `qr_login`) translated in all 10 locales but not rendering because `FAQ_KEYS` didn't list them.  Both are flagship-feature FAQs (public-API for aggregators/explorers/etc, QR-login via phone) that translators had localized but the surface didn't expose.  Added both keys to `FAQ_KEYS` (lines 127-128) and added `FAQ_RELATED` cross-nav entries: `public_api → ['run_your_own', 'how_to_run_node', 'rss_feeds', 'block_explorer']` and `qr_login → ['lost_keys', 'backup_practices', 'lock_vs_signout', 'how_morphit_protects_me']`.  FAQ now at 104 keys = 104 entries, zero orphans, zero missing.

43. **Brag-list stale-numbers sweep.**  Three counts had drifted:
    - Line 71: "1,960 self-checking smoke scenarios" → "2,320+" (actual smoke total via prior brag list claim 2,322; rounded down + plural for resilience to future drift).
    - Line 188: "21 ADRs" → "22 ADRs" (actual count of `docs/adr/*.md` is 22; added ADR-0022 to the examples list).
    - Line 189: "42 design and operations documents" → "46 design and operations documents" (actual count of `docs/*.md` is 46).
    - Verification footer: "2,322 self-checks across 107 runners" → "2,320+ self-checks across 100+ runners" (rounded down for the same drift-resilience reason).

44. **Brag-list §18 slim — items 203-272 → 203-252.**  Per the user's instruction "stick to the selling points, slim them WAY down, if some give away too much take them out completely."  Reduced 70 items averaging 200-800 words each to 50 items averaging 1-3 sentences each.  File size dropped 227 KB → 63 KB (72% reduction).  What was removed:
    - Internal Part numbers (`Part 119`, `Part 70`, etc.) — these are project-internal artifacts that mean nothing to a blog reader.
    - Memory-fact references (`Memory #11`, `Memory #14`) — internal disciplines.
    - Smoke-coverage counts and scenario numbers — attacker-relevant detail about what is and isn't tested.
    - Exact env-var names (`MORPHIT_RELAY_HIGHVALUE_SHORT_NAME_THRESHOLD`, etc.) — attacker-relevant defense-tuning knobs.
    - Exact defense-detector thresholds and parameter names — attacker recipe for evasion.
    - File-line citations (`apps/relay/src/...:line`) — attack surface mapping.
    - Internal lineage references (Findings F-7, H1, M1, B-2, So-3, D-11, etc.) — meaningless to outsiders.
    
    What was kept: the *selling point* of each entry, in voice a stranger would find compelling.  E.g. "Operator playbook for squatter defense — five attacker patterns to recognize, weekly periodic-audit procedure, active-attack incident response, and a 'diamond-hardened' preset" stayed; the exact env vars, the structured-log event names, and the §38.X subsection map all went.  Items that were ENTIRELY internal (e.g. detailed audit-of-an-audit narratives) were dropped; items that were both selling-point AND attack-surface-revealing were rewritten to keep just the selling point.
    
    Footer summary updated: "272 specific selling points" → "252 specific selling points"; intro updated: "200+ specific things" → "250+ specific things"; date updated to 2026-05-12.

45. **Fee-flow SVG regenerated — dark mode, Morphit brand colors, accurate fee splits.**  Old SVG: light-mode `#fafafa` background, amber/blue/purple palette, AND it stated "100% of fees" went to the operator-fees-recipient account which contradicts the actual code (per `apps/indexer/src/indexer/operatorEarnings.ts:154` and FEES-AND-REWARDS.md: BLURT-paid listing fees split 90/10 operator/treasury; BTC/XMR-paid listing fees go 100% to treasury).  New SVG at `apps/web/static/brand/morphit-fee-flow.svg`:
    - **Dark navy `#0B1220` background** (the morphit.io dark-mode surface from `tailwind.config.js`).
    - **Morphit emerald `#00DA69` for "Money in"** (welcome bonus, loyalty milestones, staking) — visually obvious which boxes represent money the user *receives*.
    - **Red `#DC2626` for "Money out"** (listing fee, cold-message, featured-slot) — visually obvious which represent money the user *pays*.
    - **Neutral `#8A96A8` for "Where fees land"** (operator + treasury) — middle column, money in transit.
    - **Soft purple `#A78BFA` for peer-to-peer** (the actual trade settlement that never touches Morphit) — preserved the original purple framing.
    - **Title bumped to 34pt + tagline + sub-tagline** for blog readability at full-page width.
    - **Accurate facts** verified against code: 60 BLURT base listing fee (≈ $0.12); 4th/5th/6th/7th+ Sybil tier multipliers labeled `1× · 2× · 4× · 8×`; 5 BLURT cold-message fee (≈ $0.01); 50 BLURT/hour featured slot, 6h minimum (= 300 BLURT floor); ~100 BLURT signup cost (paid by operator's relay via pre-minted ACTs, NOT by the user — explicitly framed as "operator's cost, not a fee"); 90% BLURT-listing-fee → operator's own account, 10% → @morphit-fees treasury; 100% BTC/XMR listing fees → treasury; 20 BLURT welcome bonus = 10 liquid + 10 BP; loyalty milestones 10/50/200/1000 BLURT-in-fees → 10/50/200/1000 BP (total 1,260 BP); ~7% APR staking from chain inflation.
    - **ELI5 voice** with proper grammar: "Buyer", "Seller", "First-time messager", "When paid in BLURT", "When paid in BTC or XMR", "Direct peer-to-peer settlement", "No escrow. No custody. No middleman.", "Morphit cannot see this."
    - **Rendered to PNG at 2400px wide** via `rsvg-convert` and placed at `/mnt/user-data/outputs/morphit-fee-flow.png` (487 KB) for the user's blog upload convenience.

Smokes green: persona-walkthrough 29/29, forgejo-not-gitea 3/3.

Total Part 120 fix-groups so far: **45 fix-groups across 41 docs/components** (29 doc fixes + 1 doc-deletion + 10 doc verified-clean + 1 FAQ wiring + 1 brag-list slim + 1 brag-list stale-numbers + 1 SVG regen + 1 historical-disclaimer cluster).

**Part 120 — what's done in checkpoint 12 (everything from cp11 plus the four closure pieces):**

46. **22 ADRs line-by-line audit.**  All ADRs in `docs/adr/` audited.  Three needed Part 120 forward-notes:
    - **ADR-0005** (Phase 3 subphase split) — added supplement to the existing 2026-05-07 forward-note explaining the "Go service" / "Go relay" / "Go indexer" framing in the original plan describes the pre-implementation design; the shipped reality is Node.js/TypeScript services with `tsx` as the runtime.  Rationale lives in ADR-0008's "Writing the indexer in Go instead of Node.js/TypeScript" section (no actively-maintained Go library for Blurt signature verification means we'd re-implement; `@beblurt/dblurt` gives us the full verify path in TS).  Preserved Go framing intact for historical accuracy.
    - **ADR-0008** (Phase 3b indexer architecture) — fixed inline drift at line 221: "Node 24 is fast enough" → "Node 22 is fast enough", matching the `package.json` `engines.node` declaration of `>=22.0.0` (lowered in Part 86's deps audit when CI was confirmed to run Node 22).
    - **ADR-0009** (Phase 3c order posting) — added Part 120 forward-note at the header explaining the "3 minutes" replace-window references throughout describe the originally-specified value; updated to 15 minutes in Part 70 per ADR-0001's 2026-05-07 Amendment.  Preserved the 3-minute references inline for historical accuracy; ADR-0001 is authoritative for the current window.
    
    Other ADRs verified self-maintaining or no drift to surface: ADR-0001 already has its 2026-05-07 Amendment for the 15-minute window; ADR-0010 correctly says use `create_claimed_account` not `account_create`; ADR-0011 maintains its own detailed Part-by-Part change log; ADR-0003 already corrected 8→10 languages; ADR-0007 cross-references ADR-0002 for the secp256k1 correction; ADR-0014 cleanly documents its supersession by ADR-0015 for the cipher/key-exchange component; ADR-0022 self-consistent.  No ADR-0016 cross-refs anywhere (that slot was the planned QR-pair ADR that landed as ADR-0022).

47. **AUDIT-2026-05.md Part 120 entry shipped.**  Appended a comprehensive Part 120 narrative covering: doc sweep summary (40 docs, 1 deleted, 29 fixed, 10 clean, 1 with own disclaimer); ADR sweep summary (3 with forward-notes, rest self-maintaining); top-5 consequential single-doc catches (BETA-INCIDENT-RUNBOOK port + env-var ghosts; ARCHITECTURE Go-vs-Node drift + fictional services; SECURITY §1a account-creation mechanism; PLAN.md drift forward-note; FAQ orphan-entry fix); brag list slim summary; FAQ orphan fix details; fee-flow SVG regeneration details; standing pattern lessons distilled this Part; verification status; full tarball trail.  AUDIT-2026-05.md grew from 16,704 lines to 16,795 (+91 lines).

48. **REVISIT-LIST.md Part 120 maintained-line added.**  New "Last maintained: 2026-05-12 (Part 120: ...)" entry at the top covering the full Part 120 scope.  Previous Part 119 + follow-up entry preserved as "Previous maintained:" per the standing convention so future sessions reading the doc see the lineage.

49. **Persona-walkthrough-smoke extended with 4 P120-FAQ scenarios.**  `apps/web/scripts/persona-walkthrough-smoke.ts` grew from 29 → 33 scenarios.  The new scenarios sentinel-pin the FAQ orphan catch:
    - **P120-FAQ-1:** `public_api` listed in `FAQ_KEYS` array in `apps/web/src/lib/utils/faqIndex.ts`
    - **P120-FAQ-2:** `qr_login` listed in `FAQ_KEYS` array
    - **P120-FAQ-3:** `public_api` FAQ entry present in `en.json`
    - **P120-FAQ-4:** `qr_login` FAQ entry present in `en.json`
    
    If a future refactor removes either key from `FAQ_KEYS`, OR if a translator deletes the locale entries without removing the keys, the smoke fails loudly in CI.  Smoke header comment updated with Part 120 additions block.  Triple-pulse result: 33 passed, 0 failed across all three pulses — fully stable.

**Total Part 120 fix-groups closed: 49 fix-groups across 47 docs/components.**

**Part 120 verification summary:**
- Persona-walkthrough-smoke: 33/33 green (was 29/29; +4 P120-FAQ scenarios)
- Forgejo-not-gitea smoke: 3/3 green
- FAQ parity: 104 keys = 104 entries, zero orphans, zero missing
- Brag list zero internal-detail leaks (grep verified)
- Fee-flow SVG well-formed and renders cleanly to PNG
- AUDIT-2026-05.md grew by 91 lines with the Part 120 entry
- REVISIT-LIST.md has Part 120 maintained-line at top

**Part 120 is CLOSED.**  Twelve incremental delta tarballs delivered (cp1 through cp11 full snapshots, cp12 first true delta).  Ready for next task.

**For the fresh session reading this:** every fix in this checkpoint is verifiable; smokes green; locale parity 2,458 × 10 unchanged; persona-walkthrough smoke 29/29 unchanged.

---

## Headline

**Three persona walk-throughs end-to-end + a follow-up
line-by-line audit of the four primary operator-facing docs
that caught twelve additional doc-vs-code drift bugs +
docs/API.md expansion + a sentinel-grep smoke that pins all
19 fixes against future regression.  Locale parity 2,458 ×
10.  Zero stale docs trailing live code.**

Ken's instructions across this Part:

1. **Initial:** walk Bob (existing Blurt user, multi-login
   soup-to-nuts), Sally (never owned crypto, full flow),
   and Sally-as-operator (sets up her own node from any
   .md she picks, every CLI/screen/button, launch through
   post-launch week one) end-to-end as three distinct
   personas; fix where necessary; finish `docs/API.md`.

2. **Follow-up:** "please read the operations md file and
   the RUN-A-MORPHIT-NODE.md file, every single line.  I
   think there might be some things in those files that
   is not perfectly accurate.  check over every cli
   command too, and even check the md syntax itself.
   oh yeah, check the prelaunch and week 1 files too
   please.  same scrutiny."

3. **Discretion call from Ken:** "numbers 1 and 2 might
   be a good idea.  use your discretion on those though,
   I don't want to break anything or drag this project
   out any longer."  I shipped the persona-walkthrough
   smoke (low-risk sentinel-grep, ~150 ms runtime,
   immediate value) and deferred B-3 chat encrypted-
   placeholder localization to Part 120 (architectural
   refactor, three-option fix plan filed in REVISIT §A).

Memory edit #22 (added this Part, 2026-05-11) formalizes
the three personas as STANDING discipline — every major
session runs them proactively, not only when Ken reminds.

### Fixes shipped this Part

**Bob walkthrough — 1 shipped, 1 deferred:**
- **B-2 SHIPPED** — `/backup-keys` paired-readonly
  explanation card with `web+morphit://backup-keys` phone
  deep-link.  4 locale keys × 10 = 40 new strings.
- **B-3 DEFERRED to Part 120** — paired Bob in
  `/chat/[peer]` sees hardcoded English `(encrypted)`
  for every past message.  Needs i18n threading into
  chatService.ts; three-option fix plan filed in
  REVISIT §A.
- **B-1 + B-4 through B-15 verified clean.**

**Sally (user) walkthrough — 2 shipped:**
- **S-11 SHIPPED** — `FundsSentModal.svelte` inline
  txid help line (Memory #21 teach-jargon-inline).
- **S-12 SHIPPED** — `Tooltip.svelte` default ariaLabel
  was hardcoded English `'More info'`; now reads
  `a11y.tooltip_more_info`; 3 hardcoded ariaLabel
  overrides on `/post` removed.
- **S-1 through S-10 verified clean.**

**Sally-operator walkthrough — 5 shipped:**
- **So-1 SHIPPED** — vps-bootstrap.sh callout in
  `RUN-A-MORPHIT-NODE.md` §5 + mirror in `OPERATIONS.md`
  preamble (Memory #14).
- **So-2 SHIPPED** — `apps/ops-cli/src/main.ts` JSDoc
  brought to parity with `printHelp()` (8 → 14 listed).
- **So-3 SHIPPED** — `/v1/health?verbose=1` env-opt-in
  callouts in OPERATIONS §0a, LAUNCH-DAY polling-loop,
  POST-LAUNCH-WEEK-ONE top of monitoring.
- **So-4 SHIPPED** — init.ts JSDoc step count 9 → ~17
  with disclaimer pointing at `steps.ts`.
- **So-6 SHIPPED** — RUN-A-MORPHIT-NODE.md §8 systemd
  drop-in callout (override `WorkingDirectory` + create
  `morphit-relay` system user) — this was the most
  consequential operator-facing fix in the Part.
- **So-5 acknowledged out-of-band** — Klingex URL
  verification is operator-action.

**Doc-vs-code drift catches (D-1 through D-15):**

| ID | What was wrong | What it's now |
|---|---|---|
| D-1 | `morphit ops` (with space) — 5 doc locations | `morphit-ops` |
| D-1 | `morphit ops mint-acts` non-existent subcommand | `apps/relay/scripts/mint-acts.ts` script path |
| D-2 | `MORPHIT_INDEXER_FEES_ACCOUNT` ghost env var | `MORPHIT_INDEXER_FEE_RECIPIENT` |
| D-3 | OPERATIONS §32 said Caddy was recommended | Reworded — nginx is recommended |
| D-4 | OPERATIONS.md TOC missing §0a + §41, 4 title mismatches | TOC byte-exact match section headers |
| D-5 | Monorepo install paths inconsistent in OPERATIONS.md | All 5 separate-dir refs → `/opt/morphit/apps/{relay,indexer}` |
| D-6 | PRE-LAUNCH wizard step count said 14 | ~17 with `steps.ts` disclaimer |
| D-7 | Fictitious `npm run start -- --dry-run` flag | `timeout 5 npm run start \|\| true` (exercises Zod) |
| D-8 | Stale schema v29 in PRE-LAUNCH | v31 (Part 113 added Signal C) |
| D-9 | Klingex URL `public-api.klingex.com/ticker/blurt` | `klingex.io/api/v1/ticker/BLURT_USDT` |
| D-10 | Fictitious backup cron `/opt/morphit-indexer/scripts/backup.sh` | systemd timer + `/usr/local/lib/morphit/morphit-backup.sh` |
| D-11 | 4 fictitious `/v1/health` diagnostics field paths | Real fields: `lag_blocks`, `diagnostics.operator_balances`, `/v1/release` for treasury, `status` |
| D-12 | RUN-A-NODE rejected PG 17 ("15.x or 16.x") | "15.x or higher" + PGDG-repo pointer |
| D-13 | Fictitious operator-register CLI invocation | `npx morphit-ops register` |
| D-14 | `/indexer/v1/health` (wrong nginx path) | `/api/indexer/v1/health` |
| D-15 | Health field `head_lag_blocks` | `lag_blocks` |

**docs/API.md expansion:**
- 6 missing public endpoints documented:
  `/v1/profiles/:account`, `/v1/profiles?accounts=`,
  `/v1/operators`, `/v1/instance/payment-methods`,
  `/v1/activity/volume`, `/v1/attestor-eligibility/:account`,
  `/v1/stranger-fee-quote`.
- New "Intentionally undocumented endpoints" section
  explains why 5 routes are deliberately omitted (need
  client-side crypto context to be useful).

**Persona-walkthrough smoke (path 2 from Ken's discretion
call):**
- `apps/web/scripts/persona-walkthrough-smoke.ts` — 29
  scenarios sentinel-pinning all 19 fixes.  Sentinel-grep
  pattern; ~150 ms runtime.
- Registered in `scripts/run-smokes.sh` after
  `sally-walkthrough-smoke`.
- **Caught one real residual on its first run** that I'd
  missed during the manual doc-audit sweep: a second
  `MORPHIT_INDEXER_FEES_ACCOUNT` occurrence in
  LAUNCH-DAY.md line 200 beyond the one fixed at line 64.
  Exactly the value the sentinel provides.

---

## Where things stand

### Numbers

| Metric | Part 118 | Part 119 final | Δ |
|---|---|---|---|
| Smoke scenarios | 2,322 | **2,351** | +29 (persona-walkthrough smoke) |
| Frontend tests | 591 | 591 | unchanged |
| Indexer tests default | 452 | 452 | unchanged |
| Indexer integration | 81 | 81 | unchanged |
| Relay tests | 244 | 244 | unchanged |
| TypeScript errors | 0 / 8 projects | 0 / 8 projects expected | additive only |
| svelte-check errors | 0 / 0 | 0 / 0 expected | additive only |
| Locale parity (keys × locales) | 2,452 × 10 | **2,458 × 10** | +6 keys, +60 strings |
| Schema version | v31 | v31 | unchanged |
| Sandbox-runnable smokes | 29/32, 335 | **30/33, 364** | +1 runner / +29 scenarios |
| Brag list entries | 270 | **272** | +2 (#271 + #272) |
| Real fix count this Part | n/a | **19** | 7 persona + 12 doc-audit drift |

### Locale parity

Three new key groups added across all 10 locales (en, es,
fr, de, it, pl, ru, fa, zh-CN, zh-HK):

- `backup_keys.paired.{heading,body,deeplink_hint,deeplink_cta}` — B-2 (4 keys)
- `chat.funds_sent.txid_help` — S-11 (1 key)
- `a11y.tooltip_more_info` — S-12 (1 key)

All 6 keys × 10 locales = 60 translated strings, each
translated by hand in the target language.

### Triple-pulse stability

9/9 critical-path smokes pass × 3 pulses:
`i18n-locale-parity`, `i18n-key-coverage`,
`i18n-hardcoded-english`, `paired-readonly-affordance-surfaces`,
`price-model-picker-parity`, `sally-walkthrough`,
`forgejo-not-gitea`, `href-xss`,
**`persona-walkthrough`** (added this Part).

### Sandbox-runnable smokes

30/33 runners pass, 364 scenarios.  Same 3 smokes
require `node_modules` and fail in this sandbox
deterministically (same exclusion as Part 118 — not
regressions):

- `chain-op-verify-smoke`
- `desktop-pairing-crypto-smoke`
- `i18n-formatters-smoke`

These pass in CI where `npm ci` ran.

### Files modified

| Path | Change |
|------|--------|
| `apps/web/src/routes/backup-keys/+page.svelte` | B-2: paired-readonly explanation card + isPairedReadOnly import |
| `apps/web/src/lib/components/FundsSentModal.svelte` | S-11: txid help line under input |
| `apps/web/src/lib/components/Tooltip.svelte` | S-12: i18n-aware default ariaLabel |
| `apps/web/src/routes/post/+page.svelte` | S-12: removed 3 hardcoded ariaLabel props |
| `apps/web/src/lib/i18n/locales/{en,es,fr,de,it,pl,ru,fa,zh-CN,zh-HK}.json` | 60 new translated strings |
| `apps/web/scripts/persona-walkthrough-smoke.ts` | NEW: 29-scenario sentinel-grep smoke pinning all 19 fixes |
| `scripts/run-smokes.sh` | Registered persona-walkthrough-smoke after sally-walkthrough |
| `docs/RUN-A-MORPHIT-NODE.md` | So-1 (vps-bootstrap), So-6 (systemd drop-ins), D-1, D-10, D-11, D-12, D-13, D-14, D-15 |
| `docs/OPERATIONS.md` | So-1 mirror, So-3 verbose-health, D-1, D-2, D-3, D-4 (TOC), D-5 (paths), D-11 (health fields) |
| `docs/LAUNCH-DAY.md` | So-3, D-2, D-11 |
| `docs/POST-LAUNCH-WEEK-ONE.md` | So-3, D-6 (Klingex URL), D-7 (backup recipe), D-8 (health fields) |
| `docs/PRE-LAUNCH-CHECKLIST.md` | D-6 (step count), D-7 (--dry-run), D-8 (schema v31) |
| `apps/ops-cli/src/main.ts` | So-2: JSDoc 8 → 14 subcommands |
| `apps/ops-cli/src/commands/init.ts` | So-4: step count 9 → ~17 |
| `docs/API.md` | 6 new public endpoints + intentionally-undocumented section |
| `docs/AUDIT-2026-05.md` | Part 119 entry + follow-up extension COMPLETE |
| `docs/REVISIT-LIST.md` | Part 119 + follow-up maintained line; §A public-API CLOSED; new §A entry for B-3 |
| `MORPHIT-BRAG-LIST.md` | Entries #271 (persona walk-throughs) + #272 (doc audit); trailer 270 → 272 |
| `TARBALL.md` | This file |

### Files NOT modified

- `apps/web/src/lib/chat/chatService.ts` — B-3 deferred to focused Part 120 (architectural refactor)
- Shipped systemd unit files at `ops/systemd/*.service` — kept as-is; operator drop-in pattern documented in RUN-A-MORPHIT-NODE.md §8 per Memory #14 (decided NOT to change them because canonical morphit.io operator may install at `/opt/morphit-relay` with dedicated user — the unit file is right for them)
- No schema migration
- No ADR changes
- No relay/indexer code changes
- No CI config (smoke registered in `run-smokes.sh` which CI already executes)

---

## How to verify the work in this tarball

After extracting:

```bash
# 1. Persona-walkthrough smoke pins all 19 fixes
cd apps/web && tsx scripts/persona-walkthrough-smoke.ts
# Expected: ✓ all 29 persona-walkthrough scenarios passed

# 2. Triple-pulse critical paths
cd apps/web && for i in 1 2 3; do
  ok=0; bad=0
  for s in scripts/i18n-locale-parity-smoke.ts scripts/i18n-key-coverage-smoke.ts scripts/i18n-hardcoded-english-smoke.ts scripts/paired-readonly-affordance-surfaces-smoke.ts scripts/price-model-picker-parity-smoke.ts scripts/sally-walkthrough-smoke.ts scripts/forgejo-not-gitea-smoke.ts scripts/href-xss-smoke.ts scripts/persona-walkthrough-smoke.ts; do
    if tsx "$s" 2>/dev/null | grep -q "^✓ all"; then ok=$((ok+1)); else bad=$((bad+1)); fi
  done
  echo "pulse $i: $ok ok, $bad bad"
done
# Expected: pulse 1-3 all "9 ok, 0 bad"

# 3. Locale parity 2,458 × 10
cd apps/web && tsx scripts/i18n-locale-parity-smoke.ts
# Expected: ✓ all 10 scenarios passed

# 4. Verify Part 119 content in meta-docs
grep "Last maintained" docs/REVISIT-LIST.md | head -1   # → Part 119 + follow-up
head -3 TARBALL.md                                       # → Part 119 (final)
grep -c "^272\\." MORPHIT-BRAG-LIST.md                   # → 1
tail -1 MORPHIT-BRAG-LIST.md | head -c 40                # → *272 specific

# 5. Verify AUDIT-2026-05.md has Part 119 entry + follow-up
grep -c "^## Part 119" docs/AUDIT-2026-05.md             # → 1
grep -c "Part 119 follow-up" docs/AUDIT-2026-05.md       # ≥ 1

# 6. Naming-policy regression check (Memory #16)
cd apps/web && tsx scripts/forgejo-not-gitea-smoke.ts
# Expected: ✓ all 3 scenarios passed
```

If any check fails, the tarball is bad — don't proceed.

---

## For the next session — Part 120

### Required pickup (B-3 chat encrypted-placeholder, blocked by this session)

Paired Bob in `/chat/[peer]` currently sees the hardcoded
English string `(encrypted)` for every message in history,
defined as `const ENCRYPTED_PLACEHOLDER = '(encrypted)'`
at `apps/web/src/lib/chat/chatService.ts:297`.  Two
violations simultaneously:

- Locale-parity: hardcoded English leaks to 9 other
  locales for paired AND locked sessions.
- Grandma-friendliness (Memory #21): no inline teaching
  about why decryption isn't happening here.

**Three fix options (full detail in REVISIT-LIST.md §A):**

- **(a)** Thread an i18n callback through
  `ChatControllerDeps` — architectural change.
- **(b)** Return a structured discriminated union
  `{ text } | { decryptedKind: 'paired' | 'locked' | 'failed' }`
  and localize in ConversationView — preferred, keeps
  service layer pure.
- **(c)** Smallest fix: keep service-layer contract
  intact, localize the placeholder upstream in
  ConversationView using `$_('chat.message.encrypted_placeholder_paired')`
  / `_locked` / `_failed`.  Risk: two sources of truth.

Suggested i18n keys (3 × 10 = 30 new strings):

- `chat.message.encrypted_placeholder_paired`
- `chat.message.encrypted_placeholder_locked`
- `chat.message.encrypted_placeholder_failed`

### Standing discipline reminders for fresh session

Every major session:

1. **Three persona walk-throughs** (Memory edit #22) —
   Bob, Sally, Sally-operator end-to-end, proactively,
   at the top of the session.  Even if REVISIT-LIST
   looks clean, the personas surface UX gaps it doesn't
   catch.

2. **Three priorities** (Memory #19/#20/#21) hold
   throughout — privacy #1, decentralization #2,
   grandma-friendliness #3.

3. **Locale parity × 10** (Memory #8) — every user-
   facing text edit translated into all 10 locales in
   the same turn, no exceptions.

4. **Same-turn ALL-files-update** (Memory #14) — code
   change ⇒ doc update ⇒ ADR/FAQ/brag/REVISIT/locale
   JSON/CI config all in one work unit.

5. **Verify, don't assume** (Memory #11) — check git
   log, check live code state, check what the smoke
   actually asserts; never claim "shipped" without
   the call-site + runner-config + end-to-end-test
   triplet (Memory #10 WIRE EVERYTHING).

6. **Tarball every turn** (Memory #9) — TARBALL.md
   updated every turn, not just at checkpoints.  This
   file is the source-of-truth handoff so a fresh
   session can resume EXACTLY.

7. **Doc-vs-code drift** is the most common silent
   failure mode.  Part 119 caught 12 drift bugs in
   operator docs.  The persona-walkthrough smoke and
   periodic line-by-line audits are how we keep this
   class of bug rare.

---

## Memory facts re-confirmed at top of session

(Per Memory #7 / Memory #11 — these are easy to forget
mid-session and the wrong assumption costs hours of
rework.)

- **Treasury account** is `@morphit-fees`, NOT
  `@morphit`.  The latter is the project's chain-ops
  posting account; the former receives listing fees.
- **The env var that names the fees account** is
  `MORPHIT_INDEXER_FEE_RECIPIENT` (singular FEE,
  RECIPIENT suffix).  `MORPHIT_INDEXER_FEES_ACCOUNT` is
  a ghost — operators setting it have their value
  silently ignored.  Part 119 drift catch D-2.
- **BLURT-paid fees** split 90/10 operator/treasury.
  **BTC/XMR-paid fees** split 100/0 treasury/operator.
  NOT 50/50.
- **BLURT inflation rate** is 7.6% annually as of
  2026-05-03.  Do NOT hardcode an APR in docs/brag-
  list — the live helper is at
  `apps/web/src/lib/blurt/apr.ts`.
- **Matrix notation**: `@user:server` is a user MXID
  (private DM, E2E-encrypted, used for security
  disclosure).  `#room:server` is a public room
  alias.  A blanket `@` → `#` replacement would route
  security disclosures to a public room — push back
  if asked again.
- **`git.agorise.net/agorise/morphit`** is LIVE.
  Matrix DM `@agorise:matrix.org` AND public room
  `#agorise:matrix.org` are BOTH monitored.
- **Forgejo, NEVER the predecessor product** (Memory #16).
- **Monero private view key** is NEVER published
  anywhere — not on chain, not in APIs, not in logs,
  not in release ops.  View keys stay env-only on the
  operator's box.
- **Three CLOSED items** that are NOT TODOs anymore
  (don't re-list them in future tarballs):
  - `CHANGE_ME_BEFORE_PRODUCTION` is a denylist by
    design.
  - `package-lock.json` IS committed at workspace
    root.
  - CI already runs svelte-check via `npm run check`.
- **Schema version** is v31 (Part 113 added Signal C
  one-way pile-on detection).  Part 119 drift catch D-8
  surfaced PRE-LAUNCH-CHECKLIST.md was stale at v29.
- **ops-cli binary** is `morphit-ops` (single
  hyphenated token).  `morphit ops` (with space) is a
  typo — Part 119 drift catch D-1 fixed 5 occurrences.
- **`/v1/health` real fields** are `status` ("ok" |
  "degraded"), `lag_blocks` (top-level), `stale`, plus
  the verbose-mode `diagnostics.{operator_balances,
  price, explorers, sse_subscribers, last_error,
  started_at}`.  Field paths in operator docs
  pre-Part-119 referenced 4 nonexistent paths; D-11
  fixed them.

---

## Cross-session handoff confirmation

This tarball represents the complete Part 119 final
state.

- ✓ Every fix on disk has been verified by re-grep.
- ✓ persona-walkthrough smoke green (29/29).
- ✓ Locale parity holds at 2,458 × 10 keys.
- ✓ Triple-pulse stable: 9/9 critical-path smokes × 3
  pulses.
- ✓ Sandbox-runnable smokes 30/33, 364 scenarios.
- ✓ AUDIT-2026-05.md Part 119 entry + follow-up
  extension written with full drift catalog + pattern
  lessons.
- ✓ REVISIT-LIST.md maintained line covers initial 7
  persona fixes + 12 doc-audit drift catches; §A
  public-API decision CLOSED; new §A entry for B-3
  follow-up to Part 120.
- ✓ MORPHIT-BRAG-LIST.md entries #271 (persona walks)
  + #272 (doc audit) added; trailer 270 → 272.
- ✓ TARBALL.md (this file) rewritten for Part 119
  final with verification commands and Part 120
  pickup pointer.
- ✓ Memory facts re-confirmed at top.
- ✓ No stale references anywhere — naming-policy
  smoke clean, persona-walkthrough smoke clean,
  locale-parity smoke clean.

**Safe to leave this chat.  Fresh chat extracts
`morphit-audit-2026-05-119.tar.gz`, reads this file, and
resumes EXACTLY where Part 119 final left off.**

The first thing the fresh session should do, per Memory
edit #22, is plan the three persona walk-throughs for
Part 120 — Bob first (his deferred B-3 chat encrypted-
placeholder is the leading concrete fix), then Sally,
then Sally-as-operator.

---

## What's not done yet (Part 120 continued)

Still ahead in this Part:

- **39 docs/*.md files line-by-line read** still pending (read so far: ADDING-A-COIN, ARCHITECTURE).  Remaining: AUDIT-FINDINGS, AUDIT-2026-05-FINAL-REPORT, AUTOMATION-AUDIT, BATCH-PROFILES-DESIGN, BETA-INCIDENT-RUNBOOK, CHAT-CRYPTO, CHAT-UI-DESIGN, CONTRIBUTING-TRANSLATIONS, FEES-AND-REWARDS, GRANDMA-FRIENDLY-INVESTIGATION, INTEGRATION-TEST-HARNESS-DESIGN, LOCK-SESSION-DESIGN, METADATA-LEAK-CATALOG, NEW-ISSUE-FOUND, NOTIFICATIONS-DESIGN, OPERATOR-TRUST-DESIGN, PER-LOCALE-PRERENDERING-DESIGN, PHASE-3a-DESIGN, PHASE-3b-DESIGN, PHASE-3b-STATUS, PHASE-3c-STATUS, PHASE-4-BACKLOG, PHASE-5-BACKLOG, PHASE-5-PLAN, PHASE-F-AUDIT, PHASE-G-PREP-AUDIT, PLAN, PRICE-SOURCES-RESEARCH, REVIEW-PHASE1, REVIEW-PHASE2, SECURITY (1192 lines), SERVICE-WORKER-CACHING-DESIGN, SWITCHING-NETWORKS, SYNDICATION-CHECKPOINT, UX-STANDARD.
- **22 ADRs** in docs/adr/ not yet read.
- **Persona-walkthrough-smoke extension** for the Part 120 catches (D-16 LAUNCH-DAY verbose warning, D-17 ARCHITECTURE Go→TypeScript drift, D-18 ADDING-A-COIN schema-file location, D-19 ARCHITECTURE no payment-watcher, etc.).
- **AUDIT-2026-05.md Part 120 entry** + **REVISIT-LIST.md Part 120 maintained line** + **MORPHIT-BRAG-LIST.md entry #273** pending until Part 120 is fully closed.

The fresh session that picks this up should:
1. Extract this tarball.
2. Continue reading remaining docs starting at AUDIT-FINDINGS.md (alphabetical pick-up).
3. Fix as they go (same pattern as Parts 119 + this checkpoint).
4. Tarball at the end of each turn per Ken's preference.
5. When all 39 + 22 ADRs are done, write the consolidated Part 120 entry across all four meta-docs in one work unit per Memory #14.

## How to verify this checkpoint

```bash
# Persona-walkthrough smoke green
cd apps/web && tsx scripts/persona-walkthrough-smoke.ts
# Expected: ✓ all 29 persona-walkthrough scenarios passed

# Naming-policy smoke green
cd apps/web && tsx scripts/forgejo-not-gitea-smoke.ts
# Expected: ✓ all 3 scenarios passed

# Verify the 6 fix-groups landed
grep -L "diagnostics.indexer\|diagnostics.relay\|diagnostics.treasury" docs/LAUNCH-DAY.md
# (Expected: no output — those substrings no longer appear in the non-historical sections of LAUNCH-DAY)
# Wait — the explanatory note at lines 318-328 still names them in the disclaimer context.
# The right check is that the verbose-mode WARNING at top doesn't use them:
grep -A1 "Sally-operator finding So-3 (Part 119)" docs/LAUNCH-DAY.md | head -5
# Expected: should now say "diagnostics block (containing operator_balances, price, explorers...)"

grep -c "Node.js / TypeScript (tsx)" docs/ARCHITECTURE.md
# Expected: ≥ 2 (relay + indexer service specs)

grep -c "payment-watcher" docs/ARCHITECTURE.md
# Expected: 1 (the explicit "There is NO separate payment-watcher service" line)

grep -c "moneroProofVerifier.ts" docs/ADDING-A-COIN.md
# Expected: 1

# SYNDICATION-DESIGN.md should be gone:
test ! -f docs/SYNDICATION-DESIGN.md && echo "deletion confirmed"

# REVISIT-LIST.md pointer updated:
grep -B0 -A2 "Syndicate-to-community" docs/REVISIT-LIST.md | head -5
# Expected: now points at SYNDICATION-CHECKPOINT.md, not SYNDICATION-DESIGN.md
```
