# Morphit v1.0.0-beta.46

A large privacy, correctness, and polish release rolling up several batches of
work on top of beta.45. Two changes stand out. First, **your browser no longer
talks to any third-party Blurt node** — every chain read and write now goes
through your own Morphit instance, so outside node operators never see your IP
or what you're doing. Second, **paying a listing fee in Blurt now works** — it
was being rejected by the chain before, and that's fixed. Alongside those,
federated operators now earn their share of Blurt listing fees directly at the
moment of each order, the home and orderbook pages are far more discoverable,
and the orderbook, explorer, chat, post, and onboarding screens all get a round
of fixes. **Recommended for all operators.**

## Added

- **Independent payment verification.** When someone pays you in Blurt inside
  chat, the confirmation now offers an optional "Verify on block explorer" link.
  It opens an independent, third-party Blurt explorer so a cautious seller can
  confirm a payment landed on-chain without having to trust the instance
  operator. It's opt-in (opening it reveals your IP to that explorer, by your
  choice), so it stays off unless you use it.

- **Search inside an order's details.** The orderbook gains an "Order details"
  search box that filters the listings you're viewing by the free text sellers
  write in their terms — in any language or script — and highlights the words
  you searched for. It's an instant, on-page filter, so it never triggers a new
  network request.

- **Clearer transaction data in the explorer.** The block explorer's
  transaction view now pretty-prints structured data that used to appear as one
  long escaped line, making Morphit operations much easier to read.

## Changed

- **Your browser never contacts a Blurt node directly.** Previously a few
  actions — broadcasting a signed transaction, checking a payment, verifying a
  chat identity, and the settings page's node-health card — reached out to
  public Blurt nodes straight from your browser, which leaked your IP and your
  activity to operators Morphit doesn't control. All of that now routes through
  your own instance instead. The single deliberate exception is release
  verification, which stays direct on purpose: it's an anti-tamper check, and it
  would be meaningless if it trusted the very instance it's meant to verify. For
  the same reason, the new "Verify on block explorer" link above lets you
  independently confirm a large Blurt payment yourself.

- **Federated operators earn their Blurt listing-fee share directly.** When a
  buyer pays a listing fee in Blurt, the payment now splits at that moment — the
  operator of the instance receives their 90% into the account they've
  configured, and 10% goes to the canonical Morphit treasury, all in a single
  transaction. (On the canonical instance, or when an operator hasn't set a
  valid account, it simply collects as one payment to the treasury.) This
  replaces the older forwarded-payout mechanism, which only settled correctly
  when one party ran both the treasury and the relay. Fees paid in BTC or XMR
  continue to go entirely to the canonical accounts.

- **Much better discoverability.** The home and orderbook pages have rewritten
  titles, descriptions, and keywords aimed at what people actually search for
  now that LocalMonero, LocalBitcoins, AgoraDesk, and Paxful have all shut
  down — a no-KYC, peer-to-peer, over-the-counter way to buy and sell Monero and
  Bitcoin. All of it is fully translated into every supported language.

- **The Blurt listing-fee step reads more clearly.** The wording on the post
  page around paying in Blurt, the Monero fee hint (which now reminds you to
  include your payment proof), and the "posted by" summary shown while you sign
  are all tidied up, and the account-password prompt now names the account
  you're signed in as.

- **Onboarding, chat, and settings polish.** The import tabs are readable
  against their background, the YubiKey enrollment form is centered, chat's
  send button lines up with the composer, a one-time "Chat Security" reminder
  dot is easier to notice, and the node-health card in settings explains in
  plain language that your instance handles all Blurt traffic for you.

## Fixed

- **Paying a listing fee in Blurt no longer fails.** A Blurt-paid order, feature
  bid, or stranger-message fee was being rejected by the chain because the
  order and its fee payment were signed at two different permission levels in a
  single transaction, which Blurt doesn't allow. Orders, bids, and fees paid in
  Blurt now go through correctly, while paths that don't pay a Blurt fee are
  unchanged. If you'd previously only tested with BTC/XMR fees or the first-buy
  waiver, Blurt-fee orders will now work.

- **No more red flash on the orderbook.** A brief "indexer unreachable" error
  card could flash on the orderbook while the first data loaded and then vanish.
  That transient flash is gone; a genuine, lasting connection problem still
  shows — now as a calm, non-alarming notice with a retry.

- **A clearer message when your browser blocks web push.** If notifications
  can't be enabled because a privacy browser or an ad/tracker blocker is
  blocking web push (a common situation with Brave Shields or uBlock Origin),
  the app now says so plainly instead of suggesting you simply try again.

- **A stray autofill highlight and a couple of small layout issues** on the post
  and settings pages are corrected.

---

*Morphit is non-custodial and no-KYC: it never holds your funds and never asks
for identity documents. This is beta software under active development — please
report anything that looks wrong.*
