# Morphit v1.0.0-beta.33

This release fixes a balance display that could get stuck showing an old number,
adds an at-a-glance fiat value next to your BLURT, greets you by name on the
welcome-back screen and lets you sign out from there, smooths out signing in and
getting set up, and gives operators a proper menu for managing payment methods.

Nothing here changes how trading works or what anything costs, and Morphit still
keeps no data about you. If you're already signed in, your account, keys, and
balances carry over untouched.

## Your wallet

- **Fixed: your balance no longer gets stuck on an old number.** The balance card
  is meant to update on its own every few seconds, but a caching rule could keep
  serving a stale value — especially when the network was flaky — so a deposit or
  transfer might not show up for a long time. Balances are now treated as live data:
  the card refetches instead of coasting on a cached number.

- **The refresh button now forces a real, live update.** Tapping refresh used to be
  answerable from that same short-lived cache, and a tap that landed during the
  automatic refresh could be swallowed entirely (the icon spun but nothing
  refetched). It now does a hard refresh that bypasses every cache and reads your
  balance straight from the chain, every time.

- **An approximate fiat value next to your BLURT.** When your operator runs a price
  feed, your liquid BLURT balance now shows a rough value beside it, e.g. `(~$10.00
  usd)`. If the price feed isn't available, the line is simply left off rather than
  showing anything misleading.

## Signing in

- **The welcome-back screen greets you by name.** When you return to a device that
  remembers you, the heading now reads "Welcome back @yourname" so it's clear which
  account you're about to unlock.

- **Sign out right from the welcome-back screen.** There's now a Sign out button next
  to Unlock — the same one, with the same confirmation, that you'd use from the
  account menu — so you can switch away from a remembered account without unlocking
  it first.

- **Importing from a seed phrase finds your account name for you.** A seed phrase
  carries your keys but not your account name. Morphit now looks the name up for you
  from any key you import — seed phrase, key file, or posting key — and signs you in
  when it matches exactly one account, falling back to asking only if the lookup is
  ambiguous or unavailable. As before, that lookup goes through your operator's own
  node and never reaches a third party directly.

- **You land where you were going.** If you're sent to the unlock screen because you
  tried to open a page while locked, unlocking now takes you to that page instead of
  dropping you on the home screen.

## Getting set up

- **A clear prompt when you're not signed in.** A site-wide banner now explains the
  accountless state and links you to the right next step, instead of leaving you to
  guess where to start.

## For operators

- **Manage payment methods is now an interactive menu.** The "Manage payment methods"
  item in `morphit-ops` previously just printed the list and dropped you back at the
  shell. It now opens a list / add / remove menu that prompts you for each field and
  signs the on-chain change for you — no need to remember the command-line flags. The
  scriptable `payment-method add | remove | list` commands still work exactly as
  before.

- As with recent betas, **this release changes no third-party dependencies.**

## Under the hood

- The balance and welcome-back changes ship with regression tests, including a
  tamper-checked guard that fails if the balance cache is ever loosened back to a
  stale-serving window, and a check that keeps the operator menu wired to the
  interactive payment-method flow. A fresh five-persona walkthrough and a focused
  deep-deep review confirmed the changed sign-in and operator surfaces end to end.
