# Morphit v1.0.0-beta.40

This release rounds off the two-factor and first-order screens, makes a handful of mobile
views read better, and fixes a couple of small layout glitches. Node operators also get a
quick health readout for the server itself. It also rolls out the welcome mat for traders
and trading bots, lets you link a photo of what you're trading straight from your Blurt
blog, and trims what the first screen has to load.

As always, Morphit keeps no data about you, and there's no sign-up or ID check. If you're
already signed in, your account, keys, and balances carry over untouched. This release
changes no third-party dependencies.

## Two-factor sign-in

- **Codes with a space now work.** Some authenticator apps (Aegis, for example) show your
  6-digit code as "123 456" with a space in the middle. The setup screen used to silently
  refuse to submit when that space was present, so the code looked "rejected" even though
  it was right. It now accepts the code however your app formats it.
- **Tidier setup screen.** On the two-factor setup screen the QR code is centred, the
  secret has a **Copy** button that confirms with a brief "Copied", the code box shows a
  clear focus ring, and the expandable help sections use Morphit's own green instead of an
  off-brand colour.

## Signing in on another device

- **"Sign in to another device" is now in the menu.** If you're signed in on your phone,
  you can sign in on a computer without typing anything: on the desktop open the QR
  sign-in screen, then on your phone tap your avatar (top-right), choose **Sign in to
  another device**, and point its camera at the code. The option was always described on
  the desktop screen but wasn't actually in the app yet — now it is, and the on-screen
  instructions match what you'll see.

## On your phone

- **Whole-number balances.** On a phone, your BLURT and Blurt Power balances now show as
  round numbers with no decimals and no thousands separators, so they fit cleanly in the
  narrow three-column card instead of getting squeezed. On a tablet or computer you still
  see the full precise amount.
- **The first-buy welcome reads full-width.** The "Your first trade is on us" message on
  the orderbook used to get crammed into a narrow column next to the gift icon on phones.
  It now spans the full width of the card, so it's comfortable to read.

## Posting and reviewing an order

- **Your order summary now sits above the final step.** When you reach the review step,
  the plain-language summary of what you're posting appears at the top, right where you're
  looking, instead of only further down the page.
- **First buy hides fee choices that don't apply.** On your very first order — a free buy
  of BLURT where the listing fee is waived — Morphit no longer shows the other
  fee-payment options that wouldn't make sense yet. On later orders you still get the full
  choice of how to cover the fee.

## Security keys

- **Tidier setup screens.** When you register or change a hardware security key (like a
  YubiKey) in Settings, the add / require / remove forms are now centred and easier to
  read, the danger warnings are clearly boxed in red, and — if you've already registered
  an account — the password prompt is labelled with your own **@name** so it's obvious
  whose password it wants.

## Blocked accounts

- **No more text jump on Refresh.** Tapping **Refresh** on the Blocked accounts list used
  to nudge the explanation underneath it sideways for a moment and leave it slightly out
  of place. The text now stays put, lined up the same as the rest of your settings.

## For node operators

- **See the server's health at a glance.** `morphit-ops health` now has a **System**
  section showing the machine's CPU, memory, and disk usage (the disk figure matches
  `df -h /`). It's a quick gut-check — a nearly full disk or a pegged CPU is often the
  real reason an indexer starts lagging. Like the price-feed details, these numbers are
  read straight off your own box and are never exposed on the public `/v1/health` page.

## For traders and trading bots

- **Morphit is built for market makers.** A new FAQ entry — *"Can I market-make or run a
  trading bot on Morphit?"* — spells out what was already true: there's no maker or taker
  fee (just the flat listing fee of about $0.12 per order, with no withdrawal fee, limit,
  or waiting period); the `spread` price model pins your order a set percentage off the
  live market mid (say, `market ± 0.5%`) and re-prices itself as the world price moves;
  and because every order is a plain on-chain operation that you can read over the
  read-only tools and RSS feed, a bot needs no API key, no account approval, no KYC, and
  never hands custody of your funds to the instance. The arbitrage entry now points here
  too.
- **Clearer competitor list.** The arbitrage FAQ now names Hive-Engine (HE) alongside the
  other exchanges when explaining where BLURT trades.

## Showing what you're trading

- **Link a photo from your Blurt blog.** If you put an https link to an image hosted on
  Blurt's own image servers (`img.blurt.blog` or `imgp.blurt.blog`) in an order's terms,
  it now shows up as a tidy link that opens in a new tab when clicked. The picture is
  never loaded into the page automatically, so simply *viewing* an order never reveals
  anyone's IP address — and the link opens with no referrer, so the image host can't tell
  which order page you came from. Any other kind of link in the terms stays plain text, so
  public order terms can't be turned into a place to drop arbitrary links. (Chat already
  links shared addresses the same safe way.)

## A lighter first screen

- **Footer network icons load only when needed.** The Tor, I2P, and ENS icons in the page
  footer now wait until you scroll near them before loading, instead of being fetched the
  moment the page opens. It shaves a little off the very first screen, especially on a
  phone or over Tor. If you browse with JavaScript turned off, the icons still appear.
