# Morphit v1.22.0

A new coin: **eCash (ECX)**, the 2026 hard fork of Bitcoin with drivechains.
Nothing about fees changes: ECX is trade-only, and listing fees are still paid in
BLURT, BTC or XMR.

## For people using the site

**You can buy and sell eCash (ECX).** It is a separate coin that split off from
Bitcoin on 29 October 2026. It is not XEC (an older coin also called eCash), and not
wECX (a wrapped token on Solana). The site always shows it as "eCash (ECX)".

Two things are particular to eCash, and the site says so wherever ECX is paid (the
chat card, the FAQ, the eCash privacy guide, the order form):

- **An eCash address is also a Bitcoin address.** Pay ECX from an eCash wallet: a
  Bitcoin wallet would send bitcoin to the same address. For this reason there is no
  "pay with wallet" link for ECX.
- **Coins held before the split exist on both chains,** and so can coins received
  since from such coins. Sent without replay protection, an eCash payment from those
  coins can also go out on Bitcoin, and a bitcoin payment can spend the ECX. The
  eCash node's own wallet adds no protection unless set up to, so the site says to
  split those coins before trading.

Transaction links for ECX open eCash explorers only (explorer.ecash.com, and
explorer.blockfab.org as the second choice). A page opened over Tor or I2P shows no
link for ECX: no Tor or I2P eCash explorer is known yet.

## For operators

Upgrade as usual. ECX is on by default, like every trade-only coin; to hide it on
your site, add `ECX` to `MORPHIT_INDEXER_DISABLED_ASSETS` (since 1 November 2026 a
switched-off coin is hidden, not refused: its orders are still indexed, as on every
site). Its explorer link can be changed with
`MORPHIT_FRONTEND_ECX_CHAT_LINK_URL` (point it only at an eCash explorer, never a
Bitcoin one); `morphit-ops init` asks for it with the other explorers.

**Until a site upgrades, it does not show ECX orders**, and its chat shows an ECX
address message as plain text. When the site upgrades, its indexer picks up the ECX
orders it refused, with the BLURT that paid their listing fees, together with their
later edits, cancellations and completions. This works the same for any coin added
later. An order in a ticker that no version knows is never picked up.

**Upgrade before ECX orders appear.** A site that lagged cannot fully catch up for
the accounts that used ECX meanwhile: their other orders were priced without the ECX
order (and loyalty milestones follow the order in which that site saw the fees), an
ECX order whose permlink the account used again stays refused there, and chat
messages, featured-slot bids and reviews about an ECX order stay missing there.
A site still on v1.21.7 or older shows those orders after a restart once its
background back-fill has recorded their fee transfers (it works from the oldest block
up, so the newest orders come last).

The operator docs now name every coin's explorer setting
(`MORPHIT_FRONTEND_<TICKER>_CHAT_LINK_URL`); seven coins were covered only by a
pattern. The env example no longer calls six coins "all trade-only assets".

## For developers

- ADR-0053 records the eCash decisions, with the facts checked in eCash's node code
  (tag `ecash-v1.2.0-core32.1`). One of them differs from eCash's published
  integration notes: the replay marker the code accepts is `nLockTime =
  499,999,998`, not 499,999,999.
- `docs/ADDING-A-COIN.md` is rewritten as a step-by-step checklist, for a transparent
  coin and for a privacy coin.
- The upgrade replay (`reconcileUpgrade.ts`) judges a refused order as of its own
  position in the chain, in the order the live pass applied ops (a block's orders
  before its cancellations): its Sybil tier counts only the account's orders created
  before it that were made in the 24 hours before it or still live at that point,
  and the first-buy check only the orders created before it
  (`OpContext.judgedOutOfOrder`, `countForSybilTierAtPosition`). Before, the account's later orders counted too,
  and so did ended orders whose `updated_at` moved later, and an order that paid its
  fee could be stored underpaid. The order and its later edits and cancellations are
  healed in one transaction (a crash between the two left the cancellation refused
  for good). Only dependents refused for the missing order are replayed. A handler that
  throws is refused as the live pass refuses it (`handler_threw:…` /
  `handler_aborted_tx`); anything else that fails (a passing database trouble, a
  lost connection) undoes the heal for the next boot, and that account waits whole
  (as does one whose order's fee transfers are not recorded yet), so its later
  orders are never judged without it. Both scans are read until done, and orders
  in an added coin have their own: rows of the
  older v1.19 scan, which this version still refuses, could fill its batch at every
  boot. It replays orders in any coin this version knows, not only ECX.
- The registry classifies how private each coin's chain is (`COIN_PRIVACY_CLASS`).
  Every map keyed by coin, in the indexer, the client, the web app and morphit-ops,
  fails to compile until it carries a new coin, and every per-coin branch of the chat
  code ends in an exhaustive check.
- The chat's address and "funds sent" messages read one compile-checked table of
  coins (`CHAT_PAYMENT_METHOD`). The encoders and the decoder each had a hand-written
  list before, which a new coin could miss silently. A new test round-trips both
  messages for every coin.
- A new check, `scripts/coin-completeness-smoke.ts`, holds every list of coins in
  the docs, the README, llms.txt, the media kit, the comparison image, the locale
  texts, the env example and the SQL schema to the registry, and every coin count. A
  list that leaves coins out passes only when those coins stand right after words
  that leave them out ("every coin but", "except", "refuse", a DISABLED_ASSETS
  setting; "refuse" and the like only as a command, and with no negation before
  them: "older nodes refused ECX" and "no longer refuse ECX" leave nothing out),
  and a count one above the number of coins only where its sentence counts barter.
  `COIN_COMPLETENESS_SHOW=1` prints everything an addition has to touch.
- The release-notes count check reads only the current release's notes; older
  notes stay as they were written.

## For monitoring scripts: changed JSON

- `GET /v1/instance` `chat_link_urls` gains `ecx` (a template, or `null` for the
  bundled default).
- Orders, the orderbook and RSS can carry `"asset": "ECX"`; a barter listing's
  `accepted_assets` can include `ECX`.
