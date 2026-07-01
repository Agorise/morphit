# Morphit v1.0.0-beta.42

This release is a broad round of polish across the parts of Morphit you touch most: placing
an order, reading your balance, browsing the block explorer, and chatting with a
counterparty. Nothing about how trades or fees work has changed — most of this is clearer
wording, plainer screens, and a couple of fixes to states that looked broken but weren't.
There's also one new convenience: you can now claim pending Blurt rewards right from your
balance card.

As always, Morphit keeps no data about you, and there's no sign-up or ID check. If you're
already signed in, your account, keys, and balances carry over untouched. This release
changes no third-party dependencies.

## Placing an order is clearer

- **Plainer first step.** The opening choice now reads "I want to buy" / "I want to sell"
  rather than mentioning "crypto."
- **Friendlier asset picker.** The assets you can trade are now listed alphabetically, each
  with its own coin icon, and a short plain-language explainer appears when you hover (or tap
  on a phone) — the separate little ⓘ bubbles are gone.
- **More helpful limits.** If you accidentally set a minimum higher than your maximum, the
  notice now appears right above the price section in clear red, with an offer to swap them.
  "Leave blank for no limit" now shows under both the minimum and maximum fields.
- **Top-up lands ready to go.** "Top up BLURT" now opens the order form pre-filled with a
  sensible small minimum — about five dollars' worth, shown in your preferred currency — and
  a hint telling you so, instead of a fixed figure.
- **Gentle hover cues.** The buy/sell choices and asset blocks now highlight softly in
  Morphit green when you point at them; locked or already-selected ones correctly stay put.

## Your balance card

- **Claim your rewards.** If you have unclaimed Blurt rewards, a line now appears on your
  balance card showing the amounts, with a "Claim now" button. Claiming animates your
  balance up to its new total. (On a paired read-only device the line still shows, as
  information, but claiming happens from your main signed-in device.)
- **Tap to see exact amounts (mobile).** On a phone, the rounded balance figures can now be
  tapped to reveal the exact amount.
- **Tidier layout.** Top-up sits on the left, Export (now with a download icon) on the
  right, with the clutter removed. The "earning interest" line reads "Earning X% APR."

## The block explorer reads like a sentence

- **Plain-language activity.** Instead of raw operation names, the explorer now describes
  what happened: "@alice sent 55 BLURT to @bob (with memo)," "@alice replied to @bob,"
  "@alice downvoted @bob," "@newuser account created," and so on. For privacy, a transfer
  only notes *that* a memo was attached — never its contents.

## Chat

- **Dark mode on mobile.** Several chat surfaces that didn't fully respect dark mode on a
  phone now do.
- **Clearer "turn on notifications."** When the "Turn on chat notifications" prompt can't
  enable them, it now tells you exactly why — for example, that you declined the browser
  permission, or that this instance hasn't switched on push delivery — with a proper warning
  icon, instead of one vague message. (If your operator hasn't enabled push, the in-tab
  notifications still work.)

## Settings — blocked accounts

- **Always current.** The blocked-accounts list now refreshes the moment you open Settings,
  so it always reflects who you've currently blocked. Previously it could look empty after
  navigating away and back until you pressed Refresh. Blocking and unblocking are also more
  robust against a brief list flicker if you act while the list is still loading.

## Plainer wording throughout

- **"Blockchain," not jargon.** Many spots that said "the Blurt blockchain" now simply say
  "blockchain," and there's a new, plain-English "Blockchain" entry in the glossary.
  Delegation is explained more simply, too.
- **Identity labels.** Where a person's public posting key is shown next to their name, the
  shortened key now sits on its own line beneath the name rather than crowding it.

## Smaller fixes

- A currency / exchange-rate handling fix, and some orderbook and settings polish.
- The "announce my first trade" prompt now appears only on a genuine first trade.
- The backup-keys page dropped a redundant line of copy.

## For node operators

- **The reward-claim feature touches the indexer.** Your instance's balance endpoint now
  reports any pending reward amounts, and `claim_reward_balance` was added to the
  same-origin broadcast allow-list so claiming never falls back to a privacy-leaking direct
  RPC call. These come with the usual `morphit-ops upgrade`; no configuration or migration
  steps are required.
- **Web push reminder.** The clearer chat-notification message makes it obvious when push
  isn't available. If you want chat push notifications to work for your users, set the VAPID
  environment variables as described in OPERATIONS.md §42 (generate them once with
  `scripts/generate-vapid-keys.sh`). Without them, the relay simply reports push as
  unavailable and clients fall back to in-tab notifications.
