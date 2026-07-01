# Morphit v1.0.0-beta.31

This release makes publishing to the chain more private and more reliable, fixes a
settings bug that could show you another account's profile, polishes the sign-in and
locked-screen experience, unifies the navigation arrows, fixes the desktop update
banner, and clears out some obsolete account-creation machinery for operators.

Nothing here changes how trading works, what anything costs, or what data Morphit
keeps (still none of it). If you're already signed in, your account, keys, and
balances carry over untouched.

## Privacy and reliability

- **Publishing to the chain now goes through your operator's own node.** Previously,
  every action you published — placing or editing an order, sending a chat message,
  updating your profile, leaving feedback — was sent straight from your browser to a
  third-party Blurt node. That leaked your IP address and your exact action to a node
  Morphit doesn't control, and it broke entirely if that node went down or changed
  its settings. Now those writes travel through the same node that already serves the
  app, so outsiders never see your connection, and if anything does go wrong you get
  the real reason instead of a generic "couldn't broadcast" message. This matches how
  reading already worked, and it falls back to the old path automatically if your
  operator's node is briefly unreachable, so it can never be less reliable than
  before.

- **Fixed: switching accounts could show the previous account's profile.** If you
  signed out and back in as a different account, the Settings page could show the
  earlier account's display name, short bio, and links. Profile drafts are now kept
  separately per account, the leftover shared drafts are cleared, and the form fills
  in from what's actually on chain for the account you're signed in as.

- **Clearer connection errors in Settings.** The RPC-endpoint panel in Settings now
  tells you *why* a node isn't responding — "Timed out", "Unreachable", or the HTTP
  error — instead of only showing it as failing.

## Signing in

- **The header button says "Unlock" when your keys are saved.** On a device that
  remembers your keys, the top-right button now reads "Unlock" (and takes you to the
  welcome-back screen) instead of "Start", which looked as if you had no account. A
  brand-new device still says "Start".

- **Refreshing a locked page sends you home.** If you refresh, lock, or arrive on a
  page that needs you signed in — settings, posting, chat, backups, two-factor —
  while your session is locked, you now land on the homepage with that "Unlock"
  button, instead of being stranded on an empty page.

- **The password field is focused and ready.** On the welcome-back screen you can now
  just type your password and press Enter; the field is focused automatically.

- **Matching icons on the sign-in buttons.** The "sign in with your keys" and "use my
  phone" buttons now use crisp matching icons.

## Your profile, orders, and settings

- **Save-locally buttons everywhere they belong.** The blurt.media and Nostr fields
  now each have a "Save locally only" button alongside "Save & broadcast", matching
  the short-bio field.

- **Small fixes:** the blurt.media and Nostr inputs now show one clear colour per
  state instead of a doubled border, profile icons are spaced consistently, and the
  balance refresh button always shows a visible spin when you tap it.

- **Clearer "My Orders" when you're signed out.** If you open your orders page before
  signing in — or on a locked device — the page now explains what to do in its own
  words (with both a "create an account" and an "I already have an account" option),
  rather than borrowing the wording from the order-posting screen. A locked device
  never reveals your past trades.

## Getting around

- **Unified navigation arrows.** The back and forward arrows across the app now share
  one consistent style — they slide in the direction they point and turn green on
  hover, with no underline — matching the "Learn more" arrows on the homepage. They
  also point the correct way in right-to-left languages.

- **A tidier sign-up intro.** The introductory explanation now appears only on the
  first sign-up step instead of repeating on every step.

## Updates

- **Fixed the "update available" banner on desktop.** The banner could get stuck or
  reload the page on its own. Now it only reloads when you choose "Load it now", the
  "Later" button simply dismisses it for the session, and it reappears on its own if
  a newer version is deployed.

## Help / FAQ

- **FAQ links now scroll to the right place.** Footer links into the FAQ (such as the
  AGPL-3.0 and API links) now smoothly scroll to and open the article they point at,
  even for articles far down the page.

- **A safer seed-import button.** On the import screen, the "Unlock my account" button
  now activates only when you've entered exactly twelve words, so a stray paste can't
  light it up prematurely.

## For operators

- **Footer addresses show only what you've configured.** The Tor, i2p, Lokinet, Nostr,
  and ENS pills in the footer now appear only for the networks you've actually set,
  instead of showing greyed-out placeholders for the ones you haven't.

- **ENS links to the bare name.** An advertised ENS address now links to the bare name
  (e.g. `morphit.eth`), which ENS-aware browsers resolve directly with no centralized
  gateway.

- **Removed the obsolete weekly ACT-minting machinery.** Since beta.28, account
  creation pays the chain's creation fee inline with a direct `account_create` op, so
  the old weekly "mint Account Creation Tokens" ceremony no longer exists. This
  release removes the leftovers that still referred to it: two dead systemd unit
  templates, a dead helper script entry, and stale instructions in the launch
  checklist, automation notes, security notes, and the Ansible deployment role that
  told you to run a command that no longer exists. **What you need to do is unchanged
  and simpler:** keep `@morphit-relay` funded with enough liquid BLURT to cover
  signups (about 100 BLURT per account). If you're upgrading from an older deploy that
  set up the weekly timer, you can remove the `morphit-relay-mint-acts` service and
  timer; they do nothing now.

- As with recent betas, **this release changes no third-party dependencies.**

## Under the hood

- **A fresh, independent code review** re-ran the full test, type-check, and
  security-smoke suites from a clean slate and confirmed everything passes, including
  a close look at the new same-origin publishing path (it only forwards the
  operations Morphit actually uses, the transaction stays signed entirely on your
  device, and it's rate-limited) and the per-account profile fix.
