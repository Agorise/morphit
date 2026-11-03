# Adding a coin to Morphit

The playbook for adding a cryptocurrency to Morphit, for a transparent coin
(like Litecoin or Solana) and for a privacy coin (like Monero, Zcash or Pirate
Chain). It has three parts:

1. **What we need from the coin's community** before any code is written.
2. **How the repo tells you what to change**: the compiler and the checks find
   every place a coin has to reach; you follow their messages.
3. **The checklist**, step by step, with the check that holds each step.

Sibling maintainer docs: [`ADDING-A-WORKSPACE.md`](./ADDING-A-WORKSPACE.md)
for adding `apps/*` or `packages/*`; [`LOCALE-GRADUATION.md`](./LOCALE-GRADUATION.md)
for graduating a `PLANNED_LOCALES` entry to `SUPPORTED_LOCALES`.

If you maintain or represent a cryptocurrency project and want yours added:
read part 1, send us the requested data, and we take it from there. Reach the
Agorise team via the contact URL in your local Morphit instance's footer.

---

## 1. What we need from the coin community

A request to add a coin should arrive with the following information, so
nothing is guessed mid-implementation.

### Required

1. **Ticker symbol.** The 3–5 character all-caps form (BTC, XMR, ARRR). It must
   not collide with a listed coin or with a fiat currency code.
2. **Full name.** How the coin is known in prose ("Bitcoin", "Pirate Chain").
   Used in pickers, tooltips, FAQ entries, the README and the brag list.
3. **One-line description.** At most 120 characters, plain prose, no slogans.
   Users see it when picking a coin in the order form.
4. **Logo.** One SVG: square viewBox, vector only (no embedded raster images),
   no `<text>` (outline any lettering), legible at 16×16 px, under 64 KB (all
   coin icons together have a size budget; smaller is better).
5. **Address format.** Enough to write a permissive shape check: the prefix
   (`1`/`3`/`bc1` for BTC, `4`/`8` for XMR, `zs`/`t1` for ZEC...), the length
   range and the character set (Base58, bech32, hex...). Morphit checks shape
   only; checksums are the wallet's job.
6. **Transaction ID format.** Length and character set.
7. **Decimals.** The smallest unit (BTC 8, XMR 12, ETH 18). Drives amount
   rounding, input precision and the amount jitter.
8. **A block explorer.** A public, maintained explorer with a stable URL for a
   transaction (`https://explorer.example/tx/{txid}`): the default link shown
   next to a transaction ID in chat. If one serves over Tor or I2P, its
   `.onion` / `.i2p` address too (pages opened over Tor or I2P link only to
   those).
9. **A payment URI scheme**, if the coin has one (`bitcoin:`, `monero:`,
   `solana:`): the chat offers a "pay with wallet" link.
10. **Privacy properties.** Does the chain hide sender, receiver and amount
    for every payment, only for shielded addresses, through built-in mixing,
    or not at all? Which protocol-level privacy features exist (shielded
    pools, CoinJoin, MWEB...)? Does a fresh address per payment come from
    subaddresses, HD derivation, or is the address the account?

### Conditional

11. **Memo / destination tag.** Whether a payment can carry one. Morphit does
    not carry memos for external coins; a coin that needs one to reach a
    custodial account (XRP's destination tag) gets a warning to share a
    self-custody address instead.
12. **Freeze or censorship powers.** If an issuer or foundation can freeze
    funds, the coin gets a privacy-warning chip (as USDT, USDC and DAI do).

### Out of scope (don't send these)

- Marketing copy (we write our own), banner ads or sponsorship offers.
- Fiat conversion rates: users agree on prices person to person.
- Wallet endorsements: guides name protocols, not wallets, except where a
  wallet is the only practical way to use a feature.

### What we will NOT do

- Add a coin without all the required inputs.
- Add a coin whose address format is unstable or under consensus debate.
- Add a coin that needs a per-coin library over 50 KB in the browser.
- Add a coin whose main use is a centralized exchange's internal token.
- Let a new coin pay listing fees. Fees are paid in BLURT, BTC or XMR only:
  the `fee_method` enum of the order op is frozen at
  `blurt | btc | xmr | waived_first_buy`, and two checks hold it there
  (`fee-method-enum-frozen-smoke`, `first-buy-waiver-payment-agnostic-smoke`).
  Every new coin is **trade-only** (`canPayListingFee: false`, "Category B").

---

## 2. How the repo tells you what to change

You do not need to find the places a coin appears. Three layers find them:

1. **The compiler.** The canonical registry derives the coin types
   (`AssetTicker`, `NativeCoinTicker`), and every map keyed by them, in the
   indexer, the client, the web app and morphit-ops, carries a set-equality
   check (`SameTickerSet`). Every per-coin `if` chain in the chat code ends in
   a `never` check. Add the coin to the registry and run the typecheck: each
   error names one place to fill in.
2. **The per-coin checks** (`bash scripts/run-smokes.sh` runs them all). They
   read the registry and fail, by name, for each missing per-coin text, icon,
   payment rail, price slot, wizard description, explorer setting.
3. **`scripts/coin-completeness-smoke.ts`**, for what the first two cannot
   see: every list of coins in prose and configuration (README, docs,
   llms.txt, the media kit, the comparison image, locale texts, the env
   example, comments), every coin count ("16 tradable assets"), and the
   per-coin settings in files the compiler does not reach.

Before you start, print the whole to-do list for an addition:

```bash
COIN_COMPLETENESS_SHOW=1 npx tsx scripts/coin-completeness-smoke.ts
```

Its self-test adds two made-up coins (a transparent TSTC and a private PRVC)
and prints every place they would have to reach. Lines marked `[A]` are lists,
`[B]` texts that walk every coin, `[C]` per-coin settings, `[D]` counts.

When everything is done, all three are green with your coin in the registry.

---

## 3. The checklist

Paths are from the repo root. `<T>` is the ticker (`XYZ`), `<t>` the same in
lower case (`xyz`). Each step names the check that fails until it is done.

### Step 1 — The canonical registry

File: `packages/asset-registry/src/index.ts`.

1. Add `'<T>'` to `ASSET_TICKERS` (before `'BARTER'`, which stays last).
2. Add an entry to `ASSETS`, after the last coin. Copy the closest existing
   coin and change every field:

   ```ts
   Object.freeze({
   	ticker: 'XYZ',
   	decimals: 8,
   	isCoordinationChain: false,
   	canBeTraded: true,
   	canPayListingFee: false, // every new coin is trade-only
   	supportedNetworks: ['mainnet'],
   	defaultNetwork: 'mainnet',
   	privacyWarningKey: null, // or an i18n key under assets.privacy_warnings
   	privacyFeatures: {
   		freshAddressAdvice: 'hd-derived', // 'subaddress' | 'hd-derived' | 'account-reuse'
   		optInPrivacyTech: null, // or e.g. ['shielded-pools']
   		privacyGuideKey: 'xyz'
   	},
   	addressShape: /^xyz1[02-9ac-hj-np-z]{38,87}$/
   })
   ```

   `optInPrivacyTech` takes protocol names from a fixed enum (`mweb`,
   `cashfusion`, `coinjoin`, `payjoin`, `privatesend`, `shielded-pools`,
   `csppmix`). A new protocol: extend the enum here and in
   `docs/adr/0026-transparent-chain-privacy-framework.md`, and add
   `privacy.opt_in_tech.<tech>.{name,explain}` in all 10 locales.

3. Classify the coin in `COIN_PRIVACY_CLASS` (the file stops compiling until
   you do):

   | class | meaning | today |
   |---|---|---|
   | `private-by-default` | every payment hides sender, receiver and amount | XMR, ARRR |
   | `opt-in-shielded` | transparent unless the wallet uses shielded addresses | ZEC |
   | `opt-in-mixing` | a transparent chain with mixing built into the coin | DASH, DCR |
   | `transparent` | every payment readable on chain (wallet tools like CoinJoin or MWEB don't count) | the rest |

   The first three are Morphit's **privacy coins**. The class decides which
   lists the coin joins (the privacy FAQ, the metadata-leak catalog, the
   comparison image), and `asset-registry-smoke` checks it agrees with
   `optInPrivacyTech`.

4. A multi-network token (one ticker on several chains, like USDT) is a
   bigger change: add it to `MULTI_NETWORK_TICKERS`, list its networks, set
   `defaultNetwork: null`, and follow the USDT/USDC/DAI pattern in
   `apps/web/src/lib/assets/networks.ts` and the per-network explorer
   settings (ADR-0023, ADR-0028, ADR-0029). The rest of this checklist
   assumes a coin with a chain of its own.

Check: `npx tsx packages/asset-registry/scripts/asset-registry-smoke.ts`, and
the address-overlap check (`address-shape-overlap-smoke`): if the new shape
overlaps another coin's (two coins sharing a format, as BTC and its forks
can), document the overlap there.

### Step 2 — Let the compiler list the code sites

Run the typecheck of every app:

```bash
for d in apps/indexer apps/ops-cli packages/indexer-client apps/mcp-server apps/relay apps/matrix-bot packages/asset-registry; do (cd $d && npx tsc --noEmit -p .); done
(cd apps/web && npx svelte-check)
```

Each error is one place. With the coin only in the canonical registry, they
are (`CHAT_TICKERS_ARE_THE_REGISTRY` in `apps/web/src/lib/chat/payload.ts`
among them, until the next paragraph's step):

- **Indexer** — `apps/indexer/src/config/index.ts`: the env var
  `MORPHIT_FRONTEND_<T>_CHAT_LINK_URL` (zod schema), the `Config` field and
  its mapping; `apps/indexer/src/api/instance.ts`: `chat_link_urls.<t>` in
  `InstanceResponse` and in the response body.
- **Client** — `packages/indexer-client/src/index.ts`: the same field in its
  copy of `InstanceResponse`.
- **morphit-ops** — `apps/ops-cli/src/init/steps.ts`:
  `DEFAULT_<T>_CHAT_LINK_URL`, the `ChatLinkExplorersResult` field and the
  wizard prompt (`editChatLinkUrl('<T> block explorer URL', ...)`). The list
  of single-network coins in that step's help text is not code: Step 8's
  check names it.
- **Web** — `apps/web/src/lib/stores/instance.ts` (the store's
  `chat_link_urls`), `apps/web/src/lib/explorer/urls.ts` and
  `apps/web/src/lib/explorer/urlsCore.ts` (`BUNDLED_<T>_CHAT_LINK_URL`, the
  coin's default explorer), `apps/web/src/lib/explorer/hiddenExplorers.ts`
  (Tor / I2P explorers; `[]` when there are none: then pages opened over Tor
  or I2P show no link for this coin), `apps/web/src/lib/prices/index.ts` (a
  price slot; `null` when no price source covers the coin), and the order
  page's FAQ map in `apps/web/src/routes/[lang]/post/+page.svelte`.

Then add `'<t>'` to the `ChatAssetTicker` union in
`apps/web/src/lib/chat/payload.ts` and run `svelte-check` again. The chat's
exhaustive checks now name the rest:

- `jitterAmountForAsset` — the amount jitter. Pick the jitter function by the
  coin's units (the 8-decimal UTXO coins share one; XMR, SOL, ETH and XRP
  have their own). Add the coin's line to the jitter FAQ (Step 6).
- `isValidAddress` / `isValidTxid` — the chat's address and transaction-ID
  checks.
- `buildPaymentUri` — the wallet link (`<scheme>:<address>?amount=`), or
  just the address when the coin has no URI scheme.
- `explorerLinkForTxid` in `apps/web/src/lib/components/ChatMessage.svelte`.
- The cheat-sheet order (`SHEET_ORDER` in
  `apps/web/src/routes/[lang]/cheat-sheet/+page.svelte`).
- `CHAT_PAYMENT_METHOD` in `apps/web/src/lib/chat/payload.ts` — the coins a
  chat address or "funds sent" message may name (both encoders and the
  decoder read it).
- `SAMPLES` in `apps/web/src/lib/chat/everyCoinRoundTrip.test.ts` — one
  well-formed address and transaction ID for the coin; the test then proves
  its chat messages encode and decode.
- The test tables keyed by coin in
  `apps/web/src/lib/explorer/hiddenExplorers.test.ts`.

Then the tests and checks that pin a coin list on purpose, so an addition is
seen: `apps/indexer/scripts/asset-registry-smoke.ts` (the full ticker list and
the chat union), `apps/ops-cli/scripts/disabled-assets-wizard-smoke.ts` (the
trade-only list), `apps/ops-cli/scripts/init-smoke.ts` (the wizard's answers
fixture), and the specimens in
`packages/asset-registry/scripts/address-shape-overlap-smoke.ts`.

### Step 3 — The web registry, icon, payment rail

1. **Web registry** — `apps/web/src/lib/assets/registry.ts`: a validator
   (`const validateXyz: AddressValidator = (s) => XYZ_RE.test(s);`) and an
   entry in `ASSETS` (`ticker`, `displayTicker`, `displayName`,
   `oneLineDescription`, `logoSvgPath: '/icons/icon-<t>.svg'`, an
   `accentClass` no other coin uses, `decimals`, `supportsMemo: false`,
   `addressValidator`, `canBeUsedForListingFee: false`, `canBeTraded: true`,
   `supportedNetworks`, `defaultNetwork`, `privacyWarningKey`). Checks:
   `apps/indexer/scripts/asset-registry-smoke.ts`,
   `asset-accent-class-uniqueness-smoke`, `asset-select-coverage-smoke`.
2. **Icon** — `apps/web/static/icons/icon-<t>.svg`, with `role="img"`, an
   `aria-label` and a `<title>` naming the coin. Check:
   `network-icon-coverage-smoke`.
3. **Chat pickers** — add the coin to `ALL_METHODS` in
   `apps/web/src/lib/components/AddressShareModal.svelte` and
   `apps/web/src/lib/components/FundsSentModal.svelte`. Check:
   `asset-tab-completeness-smoke`.
4. **Payment rail** — every coin is also a way to pay for something else: a
   `pay_<t>` entry in `apps/web/src/lib/payments/registry.ts` (with
   `assetExclusion: '<T>'`, placed in alphabetical order of its `name`,
   ignoring case: `payments-smoke`), the same key in `RESERVED_CANONICAL_KEYS` in
   `apps/indexer/src/indexer/handlers/operatorPaymentMethod.ts`, and
   `payment_method.pay_<t>.description` in all 10 locales. Checks:
   `payment-rail-coverage-parity-smoke`, `reserved-keys-parity-smoke`,
   `payment-method-i18n-parity-smoke`, coin-completeness `[C]`.

### Step 4 — morphit-ops, the env file, the matrix bot

- `apps/ops-cli/src/init/steps.ts`: a `CATEGORY_B_DESCRIPTIONS` entry (what
  operators read when choosing which trade-only coins to accept). Checks:
  `disabled-assets-wizard-smoke`, `category-b-descriptions-parity-smoke`.
- `apps/ops-cli/src/init/render.ts`: the line
  `MORPHIT_FRONTEND_<T>_CHAT_LINK_URL=` and the default in the comment block
  above it (`#   <T>:  https://...`).
- `apps/ops-cli/src/commands/init.ts`: the summary line
  (`<T> chat-link URL:  ${answers.chatLinkExplorers.<t>}`).
- `ops/env/indexer.env.example`: the commented
  `MORPHIT_FRONTEND_<T>_CHAT_LINK_URL` line and a
  `MORPHIT_INDEXER_DISABLED_ASSETS` example.
- `apps/matrix-bot/scripts/api-response-shape-smoke.ts`: `<t>:` in
  `ChatLinkUrlsSchema`.

Check: coin-completeness `[C]` lists each one it cannot find.

### Step 5 — Operator docs

`docs/OPERATIONS.md`:

- the coin's chat-link setting, `MORPHIT_FRONTEND_<T>_CHAT_LINK_URL`, with
  its bundled default, in "Single-network chat-link explorer URL overrides
  for the other coins";
- the coin in at least one `MORPHIT_INDEXER_DISABLED_ASSETS` example, and in
  the lists of trade-only and single-network coins.

Checks: `operator-doc-per-asset-coverage-smoke`,
`operator-doc-per-asset-config-example-coverage-smoke`,
`frontend-chatlink-env-doc-parity-smoke`, coin-completeness `[A]` `[C]`.

### Step 6 — Texts, in all 10 locales

Locales: `apps/web/src/lib/i18n/locales/{en,es,fr,de,it,pl,ru,fa,zh-CN,zh-HK}.json`.
Spanish, French and German must be real translations, not copies of the
English (`per-asset-key-family-native-locale-floor-smoke`,
`what-is-asset-faq-native-locale-floor-smoke`).

Per coin:

- `faq.entries.what_is_<t>` (`q` and `a`), plus the key in `FAQ_KEYS` and
  `FAQ_RELATED` in `apps/web/src/lib/utils/faqIndex.ts`
  (`faq-per-tradable-asset-parity-smoke`).
- `post_order.form.asset_explainer.<t>`, `cheat_sheet.section_assets.<t>`.
- `privacy.guides.<t>.one_line`, `.intro`, `.meta_description` (the coin's
  privacy guide page, `/privacy/<t>`).
- `chat.address.pill_method_<t>`, `chat.funds_sent.pill_title_<t>`,
  `chat.address.address_invalid_<t>`, `chat.address.address_placeholder_<t>`.
  The pill is the coin's brand name, the same in every language: add
  `pill_method_<t>` for es, fr and de to the ALLOW_LIST of
  `apps/web/scripts/i18n-translation-completeness-smoke.ts`, as for the other
  coins.

  Check for all of these: `per-asset-mandatory-family-i18n-parity-smoke`,
  `i18n-translation-completeness-smoke`.

Texts that walk every coin (coin-completeness `[A]` and `[B]` name them):

- `faq.entries.monero_amount_jitter.a` — the coin's maximum jitter, on the
  line of the coins that share its units, or a line of its own.
- `privacy.index_intro` — a transparent-by-default coin goes in its
  `{coins:…}` list; a private-by-default or shielded coin is described in the
  prose after it, as Zcash and Pirate Chain are.
- `faq.entries.why_usdt_warning.a` — the `{coins:…}` list of coins no company
  can freeze (the single-network coins transparent by default).

Most copy names the coins through tokens the site fills in from the registry
(`{coins}`, `{coins:-blurt}`, `{coin_count}`), and those need no edit.

### Step 7 — A privacy coin, in addition

For a coin classed anything but `transparent`:

- **Privacy FAQ** — `faq.entries.privacy_coins_onchain.a` in every locale:
  add `<t>` to `{coins:xmr,zec,arrr,dash,dcr}`, and the ticker to the
  sentence naming the privacy coins that never pay a listing fee ("never in
  ZEC, ARRR, DASH or DCR"). Checks: coin-completeness `[A]` `[C]`.
- **Metadata-leak catalog** — section 3 of `docs/METADATA-LEAK-CATALOG.md`
  lists the privacy coins; give the coin its row wherever the section
  compares them.
- **Comparison image** — the "Privacy coins first-class (XMR/ZEC/...)" line in
  `scripts/comparison-image/build_comparison.py`.
- **Explorer links** — a shielded or private-by-default coin's explorer shows
  little; say so in the coin's privacy guide, as ZEC's and ARRR's do.
- **Fresh addresses** — if the coin uses subaddresses like Monero, consider
  the subaddress tip in `AddressShareModal.svelte` (today it fires for XMR
  addresses starting with `4`); it is not required.
- **Jitter** — a coin that hides amounts on chain still gets the amount
  jitter: the amount travels through chats, screenshots and exchanges.

### Step 8 — Lists, counts and generated files

Run `npx tsx scripts/coin-completeness-smoke.ts` and work through what it
lists. With a new coin it names, among others:

- `README.md` (line 3, and the single-network list further down),
  `apps/web/static/llms.txt`, `scripts/build-llms-full.mjs`,
  `scripts/build-mediakit.sh`;
- `docs/API.md`, `docs/SECURITY.md`, `docs/FEES-AND-REWARDS.md`,
  `docs/OPERATIONS.md`;
- `docs/MORPHIT-BRAG-LIST.md`: every "16 tradable assets" and every list
  (`brag-list-claim-parity-smoke` pins some counts too);
- comments that list coin sets in code (the jitter, explorer and payload
  code);
- the comparison image: a `('<Name> (<T>)', [...])` row under "Assets &
  fiat". Fill the other columns (what each compared platform supports) from
  their own sites, not by guess.

Then rebuild what is generated from those sources and commit the results:

```bash
node scripts/build-llms-full.mjs
node scripts/build-sitemap.mjs
python3 scripts/comparison-image/build_comparison.py
bash scripts/build-mediakit.sh
```

Checks: `llms-full-freshness-smoke`, `seo-url-consistency-smoke` (the new
`/privacy/<t>` page in the sitemap), `comparison-image-freshness-smoke`,
`mediakit-freshness-smoke`.

Optional: add the coin's name and ticker to the protected usernames in
`apps/relay/src/policy/highValueName.ts`.

### Step 9 — Tests, ADR, release notes

- Unit tests for the address validator (accepts real addresses, refuses the
  near misses and the other coins' formats).
- A brag-list entry for the coin, and the checks in
  `apps/web/scripts/wiring-completeness-smoke.ts` that tie its claims to the
  code (ticker, payment rail, explorer).
- An ADR, `docs/adr/00NN-<coin>-addition.md`, in the style of ADR-0030 to
  ADR-0036: why this coin, which explorer and why, address
  format, privacy class.
- Release notes for the release that ships it.

Run everything: the typecheck (Step 2), `bash scripts/run-smokes.sh`, the unit
tests of each app, and the integration tests.

### Step 10 — Shipping a coin to the federation

An indexer refuses an order in a coin its version does not know
(`asset_invalid`), and a barter listing that accepts one
(`accepted_assets_entry_unknown`, or `accepted_assets_too_many` when it accepts
more coins than that version knew). Until a Morphit site upgrades to the release
with the coin, orders in it do not show there.

When that site upgrades, its indexer replays those orders at boot
(`reapplyObsoleteRejections` in
`apps/indexer/src/indexer/reconcileUpgrade.ts`), with the BLURT that paid
their fees. Each is judged as of its own position in the chain, in the order the
live pass applied ops (its Sybil tier counts only the orders created before it that
were made in the 24 hours before it or still live then), together with the
replace, cancel, complete and fee attestation ops that ran after it (also those in
an earlier transaction of its own block: a block's orders run first) and were
refused because the order was missing, in one transaction. A passing database
trouble undoes that transaction and the account waits for the next boot whole.
The replay covers every coin the new version knows, not only the newest. An
order in a ticker no version knows is never replayed. On a site that indexed
such orders with v1.21.7 or older, they show at the first restart after the
background back-fill (oldest block first) has recorded their fee transfers.

A replay cannot undo what the lagging site applied meanwhile: the same
account's later orders were priced without the refused one (and a first-buy
waiver may have gone to one of them), a fee transaction
ID a later order claimed stays with it, a permlink the account used again for a
later order stays that order's (the refused one stays refused), loyalty
milestones keep the order in
which that site verified the fees, and chat messages, feature bids and reviews
that cite a refused order stay refused there. Only accounts that used the coin while the site lagged are affected.

So the order of a release matters: publish, upgrade the sites, then announce
the coin.
