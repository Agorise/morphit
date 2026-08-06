# Morphit v1.0.0-beta.44

A big round of chat and trust improvements. The headline: you can now export any
conversation as a locked, court-ready PDF whose every message is anchored to the
blockchain — real recourse if a trade ever goes sideways. Chat also got noticeably
faster, the chat page was rebuilt to be clearer, traders now carry a reputation
score (not just a trade count), and dates everywhere are now unambiguous UTC.
Nothing about how trades or fees work has changed.

As always, Morphit keeps no data about you, and there's no sign-up or ID check. If
you're already signed in, your account, keys, and balances carry over untouched.
This release adds one new dependency — the jsPDF library that builds the chat
export — and it's fetched only at the moment you actually export a conversation, so
it costs nothing until you use it.

## Prove what was agreed — export a chat as a court-ready record

- **One-tap, tamper-resistant export.** Open a conversation's ⋯ menu and choose
  "Export chat." Morphit builds a locked PDF (view / print / copy only — not
  editable) containing every message, each with its UTC timestamp and its Blurt
  transaction ID as a "Blockchain proof."
- **Anchored to the chain, not to trust in the file.** Because each line cites its
  on-chain transaction, anyone — a mediator, a small-claims court — can independently
  re-verify it against the public blockchain. A plain-language page inside the PDF
  explains exactly how. Editing a line would break the match.
- **Peace of mind.** It can't force a dishonest counterparty to do the right thing,
  but it replaces "he said / she said" with a permanent record built to hold up
  outside Morphit. The export happens entirely on your device from your already-
  decrypted messages — no plaintext ever leaves your browser.

## A reputation score, not just a trade count

- **A 0–5 score alongside the trade count.** Each trader now shows two separate
  signals: how *much* they've traded (the count) and how *good* that history is (a
  0–5 reputation score). The score rewards sustained good behaviour and resists a
  newcomer looking like a veteran off a single glowing review.
- **It can't be bought with volume.** The score shrinks a thin rating toward neutral
  and only grants an experience/recency bonus once the rating is already above
  neutral — so a high-volume scammer stays low. As with the underlying rating, the
  math is transparent: the public reputation endpoint returns the full breakdown so
  anyone can re-derive the number.

## Chat is faster and clearer

- **Messages appear in seconds.** New messages now show up in roughly 3–6 seconds
  instead of waiting the ~45–60 seconds it used to take for the chain to finalize.
  Nothing about the encryption or on-chain durability changed — you just see the
  message sooner.
- **A rebuilt chat page.** The header now reads "Chatting with" and shows your
  counterparty's avatar, name, shortened posting key, and the order it's about (with
  a link straight to that order). Each run of messages is labelled with the sender's
  cryptographic identity, so you can confirm who you're talking to at every turn.
- **Tap a message for its exact time**, in the same day-first UTC format used
  everywhere else.
- **Action buttons that fit the trade.** "Share address" and the payment button now
  appear only when they apply to your side of the trade. "Mark funds sent" is now
  "Pay now," and for a Blurt payment it's sent straight from the app — no copying a
  transaction ID by hand.
- **Block moved into the menu.** "Block / Unblock" is now a tidy option in the ⋯
  menu instead of a standalone button.
- **Better on mobile.** The composer and Send button sit on one line, the chat fills
  the screen with the box always visible, and your own sent messages read correctly
  when you come back to a conversation.

## Placing and editing an order

- **Cleaner order cards.** Browse cards are a single tidy column: the reputation
  score and trade count sit under the trader, the price model ("Fixed price" /
  "Market rate") shows at a glance, and a stablecoin's network is shown as a compact
  chip. The "Message" button stacks with the trader's name; the hide control tucks
  into the corner.
- **The edit-order page actually saves now.** Fields that can't be changed after
  posting (side, asset, currency, network) are shown as a locked summary instead of
  looking editable, so a change can't silently fail. The still-editable fields got
  the same helpful hints as the posting form.
- **Selling reads like selling**, and the post button reads "Pay and Post this order"
  so it's clear the listing fee is part of the same step. "Cash machine with code"
  (cardless ATM) is a selectable payment method.

## Timestamps everywhere are now UTC

- **One unambiguous format.** Dates and times across the site — pages, the chat
  export, everywhere — now read like "30 June, 2026 @ 16:45:18 UTC": day-first, the
  month in your language, a 24-hour clock, a literal UTC label, and seconds. No more
  guessing whose time zone a timestamp is in.

## Fixes and polish across the app

- **Fresh look.** The interface font is now Comfortaa.
- **Right controls on the right devices.** "Sign in to another device" and "Use
  phone instead" now appear only where they make sense (phone vs. desktop), including
  on touch-screen laptops.
- **Explorer tidy-ups.** Transaction pages now fill in their details instead of
  showing placeholders; account pages round long balances on mobile with tap-to-
  reveal and show a trader's custom avatar; the "tx:" / "block:" labels are readable
  and only the ID itself is a link.
- **Homepage & navigation.** The "Start trading" prompt no longer shows when you're
  already signed in but locked; the language switcher sits neatly in the footer; a
  logged-out "Message @username" click lands on sign-in, not onboarding.

## Under the hood

- **Hardened the PDF export.** The chat export uses a current, advisory-free release
  of its PDF engine (jsPDF 4.2.1) — chosen specifically so a court-facing document
  isn't built on a component with known vulnerabilities.
- **Push-notification reliability.** A malformed push key on an operator's instance
  is now caught and reported, and push is disabled rather than failing silently.
- **Leaner pages.** The heavy PDF and key-derivation code no longer loads on every
  page — it's fetched only when needed.
