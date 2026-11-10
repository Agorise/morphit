# Morphit v1.24.0

Three new coins: **Hive (HIVE)**, **Steem (STEEM)** and **BitShares (BTS)**, with HIVE and STEEM
payments checked live in the chat. And BLURT's price now comes from the Cexius exchange as well as
from Blurt's own price service.

This release contains everything in v1.23.5. The deadline v1.23.5 set still stands: every site must
run v1.23.5 or later (so this release is fine) before **2026-11-22 00:00 UTC**.

## For people using the site

**You can buy and sell HIVE, STEEM and BTS.** They are trade-only, like every coin added after BLURT,
BTC and XMR: you can trade them, but listing fees are still paid in BLURT, BTC or XMR.

These three chains are cousins of Blurt, and four things about them matter when you trade:

- **The address is the account name** (like `alice`), as on Blurt. The same name can belong to
  someone else on Blurt, Hive, Steem or BitShares, so the chat card always names the coin.
- **Pay with the trade's memo.** The account is the same in every trade, so when a seller shares
  it, the chat adds a short random memo for that trade (as it does for BLURT), and the buyer puts it
  on the transfer. That is what ties the payment to the trade.
- **Share your own account, never an exchange's.** An exchange credits a deposit only by its own
  memo, and the trade's memo takes its place. The chat card, the FAQ and the order form say so.
- **Send the coin itself.** Liquid HIVE or STEEM, not HIVE Power, Steem Power, HBD or SBD; BTS
  itself, not bitUSD or another BitShares token.

**HIVE and STEEM payments are checked in the chat**, as BTC and XMR payments are. When the buyer
records the payment with its transaction id, the seller's screen shows it arriving and how deep it
is: it must reach the account shared in the chat, with the trade's memo and the amount asked, in a
block newer than the account share. A payment into that account without the memo, such as someone
else's, is shown as not this trade's. Blocks come every 3 seconds, so the chat asks every few seconds; a payment counts as
confirmed only once its block can no longer be undone (a few seconds on Hive, about a minute on
Steem), and only then does the chat offer to send the other side. A BTS payment is not checked: the
seller checks in his wallet that it carries the trade's memo. The FAQ entries say so for each coin, and the Hive and Steem privacy guides
say that the site's server (never the browser) asks those chains' public nodes about the
transaction. The FAQ's tip on reaching other coin communities names Hive, Steem and BitShares too.

In a coin-for-coin trade, a seller paid in one of these coins can give the same account again (for
other coins the site asks for an address never shared before, since a payment to an old address
cannot be told apart from an earlier one). For HIVE and STEEM the window says the chat checks the
payment by its transaction id and memo; for BTS it says to check in the wallet that the payment came
in now, with the memo and the amount asked. A buyer sharing his own account to receive is not shown
these seller notes.

Transaction links open hivescan.info for Hive (run by Hive's core developers), steemscan.com for
Steem and bitshareschain.com for BitShares. No Tor or I2P explorer of these chains is known, so a
page opened over Tor or I2P shows no link for them. The amount jitter adds up to 0.099 HIVE or
STEEM, and up to 0.00999 BTS. Each coin has a FAQ entry and a privacy guide in all 10 languages. An order in another coin
can also name Hive, Steem or BitShares as a way to pay. Hive and Steem account names are checked by
the chains' own rule (each part between dots has at least 3 characters).
Their dollar values come from CoinGecko and CryptoCompare, so a site reached only over Tor and I2P
shows them without one.

**BLURT's price.** It used to come from api.blurt.blog alone whenever that answered. Now the site
also asks the Cexius exchange, which trades BLURT for USDT, and uses the average of the two (either
one alone when the other is down, and api.blurt.blog's alone when the two are more than 50% apart,
so one odd trade on a small market cannot move it). The FAQ "Where does the BLURT price come from?" says so. The
price only shapes the BLURT fee quote and the dollar figures: every site still checks fees against
the minimum set on the Blurt chain.

## For operators

Upgrade as usual. The three coins are on by default; to hide them on your site, add them to
`MORPHIT_INDEXER_DISABLED_ASSETS` (for example `"HIVE,STEEM,BTS"`). Their explorer links can be
changed with `MORPHIT_FRONTEND_HIVE_CHAT_LINK_URL`, `MORPHIT_FRONTEND_STEEM_CHAT_LINK_URL` and
`MORPHIT_FRONTEND_BTS_CHAT_LINK_URL` (point each only at an explorer of that chain: the three share
Blurt's transaction-id format); `morphit-ops init` asks for them with the other explorers.

**Until a site upgrades, it does not show HIVE, STEEM or BTS orders**, and its chat shows such an
address message as plain text. When it upgrades, its indexer picks up the orders it refused, as it
did for eCash (ECX) in v1.22.0. So upgrade before these orders appear; then announce the coins.

**HIVE and STEEM payment checks.** Your indexer answers the chat's payment check for these two coins
by asking their public API nodes: `MORPHIT_INDEXER_HIVE_PAYMENT_NODES` (five HAfAH services, plain
GET) and `MORPHIT_INDEXER_STEEM_PAYMENT_NODES` (five JSON-RPC nodes); `docs/OPERATIONS.md` lists
the defaults. Two operators must agree. If you firewall the indexer's outbound traffic, allow those
hosts; set one empty to turn that coin's check off. A site reached only over Tor and I2P asks none of
them (no hidden Hive or Steem node is known): there the chat says after a few minutes that it can't
check the payment, and the seller checks his wallet.

**Cexius.** Your indexer now asks `https://cexius.com/api/v2/markets/BLURT-USDT/tickers` with
`api.blurt.blog` every price cycle (USD sites only; a site reached only over Tor and I2P asks
neither). To leave Cexius out, set `MORPHIT_INDEXER_CEXIUS_BASE_URL=` (empty) in the indexer's env
file. If you firewall the indexer's outbound traffic, allow `cexius.com`. `morphit-ops health`
shows BLURT's source as `primary_avg` while both answer, and each one's own price on its own line;
two markets a few percent apart is normal, so that shows no warning. When the two are more than 50%
apart, api.blurt.blog's price is used alone (`blurt_price_feed`).

The cross-source disagreement monitor (defense C, advisory only) now compares the native price
against a price from these primary sources and from the BTC/XMR pricenodes too. Before, it compared
only while the aggregator median was serving, which on a healthy node was almost never, so it could
not see anything.

New signups can no longer take the account name `bitshares` (`hive` and `steem` were already
protected).

## For developers

- ADR-0054 records the decisions, with the facts checked in each chain's code (account-name rules,
  decimals) and on the explorers named, and the owner's survey of BitShares markets and explorers.
- The registry has HIVE and STEEM (3 decimals, Blurt's account-name shape) and BTS (5 decimals,
  bitshares-core's `is_valid_name`: 1-63 characters), each `transparent`, `account-reuse`,
  trade-only. `address-shape-overlap-smoke` documents their overlaps: Blurt, Hive and Steem accept
  the same names, and the BTS rule also accepts every all-lowercase bech32 or CashAddr string.
- Hive and Steem names follow `is_valid_account_name` (steemit/steem
  libraries/protocol/authority.cpp, kept by Hive): parts of at least 3 between dots. The registry,
  the chat validators and `/v1/payment-check` use it.
- The chat: `isValidHiveSteemAccount`, `isValidBtsAccount`, 40-hex transaction ids,
  `jitterHiveSteemAmount` and `jitterBtsAmount`, and the bare account name as the payment link
  (wallets agree on no payment URI). Each such address card carries
  `chat.address.account_coin_warning`. `ACCOUNT_NAME_COIN` (a full map over the chat tickers) names
  the coins whose address is an account name; the address-share window exempts them, as it did
  BLURT, from the never-shared rule of v1.21.17, and shows their invalid-name error from 3
  characters on. The payload's `memo` (BLURT-only before) is accepted for every `ACCOUNT_NAME_COIN`;
  the window generates it for all four and requires it where a crypto-for-crypto seller is paid;
  the card shows it as the required memo (`memo_required_explain` now names the coin).
- `COIN_QUOTE_IDS` has the three (CoinGecko `hive`, `steem`, `bitshares`; CryptoCompare `HIVE`,
  `STEEM`, `BTS`); they are not in `PRICENODE_COINS`.
- `CompositeCachedPriceSource` takes a `primaryBlend`: sources asked together first, their plausible
  answers combined with `aggregateRobust` and committed as `primary_avg` (or under the one that
  answered); `primaryUpstreams` keep their one-by-one order after it. BLURT's blend is
  `blurt_price_feed` and `cexius` (`cexiusFetcher.ts`: the market's `last` price, only from a ticker
  that names the market asked for and quotes USDT). Answers more than `BLEND_MAX_SPREAD` (50%)
  apart are not averaged: the first source in the list is committed alone. A hidden-only node does
  not use the blend.
- `fee/grapheneTxCheck.ts`: the HIVE / STEEM payment lookup behind `/v1/payment-check`. Hive over
  HAfAH (`/transactions/<id>`, `/headblock`, `/sync-status`), Steem over condenser JSON-RPC
  (`get_transaction`, `get_dynamic_global_properties`, `get_block_header`); `EndpointPool.quorumCall`
  over operators, the quorum lowered by URLs, never by operators; only `transfer` operations to the
  account in the coin itself carrying the ask's `memo` (`otherMemo` / `memo_mismatch` for one
  without it); the depth counted to 3 only from an irreversible block. A node that cannot be
  reached, is too slow (the answer is read in full within the timeout) or answers 408 / 429 / 5xx
  throws `TRANSPORT_FAILURE` / `HTTP <status>`, so the pool cools it; "not found" is an agreed value
  that ends the round; HAfAH is asked for the head and the irreversible block only when it has the
  transaction. The web watcher sends the ask's memo, marks a HIVE / STEEM payment short of that
  depth `pending` (verdict `checking`), an ask without a memo `unbound` (verdict `unasked`) and a
  transfer without it `wrongMemo` (`chat.payment_check.wrong_memo`); it asks every 6 s, and after 3
  minutes of "not found" (5 for BTC / XMR) lets the seller settle it from his wallet. The
  address-share window shows `chat.address.reuse_account_checked_body` (HIVE / STEEM) or
  `reuse_account_body` (BTS) only where a crypto-for-crypto seller is paid.
- The coin pickers showed "Hive (HIVE) (HIVE)", and since v1.21 / v1.22 "Ripple (XRP) (XRP)" and
  "eCash (ECX) (ECX)": those display names no longer carry the ticker the pickers add, and
  `asset-select-coverage-smoke` checks it.
- `price-primary-fallback-smoke` now runs the real factory against stubbed price hosts and checks
  the precedence; it used to match the factory's source text.
- New tests: `apps/web/src/lib/chat/grapheneCoins.test.ts` (13),
  `apps/web/src/lib/components/chatMessageGraphene.test.ts` (4),
  `apps/web/src/lib/components/AddressShareModal.account.test.ts` (7),
  `apps/indexer/test/indexer/price/cexiusBlend.test.ts` (13),
  `apps/indexer/test/indexer/fee/grapheneTxCheck.test.ts` (28); `paymentChecks.test.ts` has 8 more
  and `ConversationView.auditFlows.test.ts` two (a HIVE payment through the chat, with someone
  else's payment cited; a BTS payment settled from the wallet); the round-trip and hidden-explorer
  tests cover the three coins.

## For monitoring scripts: changed JSON

- `GET /v1/instance` `chat_link_urls` gains `hive`, `steem` and `bts` (a template, or `null` for the
  bundled default).
- Orders, the orderbook and RSS can carry `"asset": "HIVE"`, `"STEEM"` or `"BTS"`; a barter
  listing's `accepted_assets` can include them.
- `GET /v1/payment-check` takes `asset=hive|steem` with a 40-hex `txid`, the account name as
  `address` and the ask's `memo`; its `asset` can be `hive` or `steem`, and a `found` answer can
  carry `memo_mismatch: true`.
- An order's `payment_methods` can include `pay_hive`, `pay_steem` and `pay_bts`.
- `GET /v1/listing-fee` `asset_prices_usd` can include `HIVE`, `STEEM` and `BTS`.
- The BLURT price's `source` (the verbose health endpoint's `diagnostics.price`, and `morphit-ops
  health --json`) can be `primary_avg` or `cexius`, besides `blurt_price_feed`.
